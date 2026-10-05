/**
 * @file
 * How much storage each service in the cluster asks for.
 *
 * The space on a node's disks is shared between everything that
 * claims a volume there — the database, the object store, whatever
 * comes next — and the sizes they ask for used to be written into
 * each one's manifest. That's three files to read to find out what a
 * cluster will try to take, and nowhere to see that the total won't
 * fit. A claim bigger than the volume group behind it doesn't fail,
 * it waits: the pod sits Pending and an install that waits for it
 * never finishes.
 *
 * So the sizes live together, under "storage.allocations", and each
 * manifest reads its own back as a template value. Only the cluster
 * wide storage section is read. A node's own storage section is about
 * its disks, and a database is the same size whichever node it lands
 * on.
 *
 * Sizes are whole GiB, the same unit as "minimumSizeGb", rather than
 * Kubernetes quantities. A number can be checked, and adding them up
 * against what the disks hold is the obvious next thing to want.
 */

/**
 * A service that claims storage.
 *
 * - key: what it's called under "storage.allocations"
 * - value: the template value its manifest reads the size from
 * - defaultGb: what it gets when the configuration doesn't say
 */
export interface Allocation {
  key: string;
  value: string;
  description: string;
  defaultGb: number;
}

export const ALLOCATIONS: Allocation[] = [
  {
    key: "databaseGb",
    value: "databaseVolumeSize",
    description: "The shared Postgres cluster",
    // What the database was given before this was configurable, so an
    // existing cluster asks for what it already has
    defaultGb: 30,
  },
  {
    key: "objectStorageGb",
    value: "objectStorageVolumeSize",
    description: "SeaweedFS, the S3-compatible object store",
    // Modest, because the claim can be grown later and never shrunk.
    // Too large and it can't be placed on a smaller node at all.
    defaultGb: 50,
  },
];

/**
 * The size each service gets, in GiB.
 *
 * Anything that isn't a whole number of GiB above zero is refused
 * with the key named, rather than being rendered into a manifest
 * Kubernetes would reject — or worse, accept.
 *
 * @param rawConfig
 * @returns
 */
export function getAllocations(rawConfig: any): Record<string, number> {
  const storage = rawConfig?.storage;
  const configured =
    storage !== undefined && storage !== null && storage.allocations !== undefined && storage.allocations !== null
      ? storage.allocations
      : {};

  const sizes: Record<string, number> = {};

  for (const allocation of ALLOCATIONS) {
    const size = configured[allocation.key];

    if (size === undefined || size === null) {
      sizes[allocation.key] = allocation.defaultGb;
      continue;
    }

    if (!isUsableSize(size)) {
      throw new Error(
        `"storage.allocations.${allocation.key}" is ${JSON.stringify(size)}. It's a size in GiB, and has to be a whole number above zero.`,
      );
    }

    sizes[allocation.key] = size;
  }

  return sizes;
}

/**
 * The template values the manifests read, as Kubernetes quantities.
 *
 * @param rawConfig
 * @returns
 */
export function buildAllocationValues(rawConfig: any): Record<string, string> {
  const sizes = getAllocations(rawConfig);

  return Object.fromEntries(
    ALLOCATIONS.map((allocation) => [allocation.value, `${sizes[allocation.key]}Gi`]),
  );
}

/**
 * Whether a size is one a volume can be.
 *
 * @param size
 * @returns
 */
export function isUsableSize(size: unknown): size is number {
  return typeof size === "number" && Number.isInteger(size) && size > 0;
}
