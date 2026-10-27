/**
 * @file
 * The shape of the cluster's SeaweedFS: how many masters, how many
 * volume servers, and how many copies of everything it keeps.
 *
 * The default is the smallest cluster the operator makes, one of each
 * and one copy, which is where most clusters start. A cluster with the
 * nodes for it can ask for more under "storage.objectStorage", and the
 * manifest reads the answer back as template values.
 *
 * Copies are only worth having on different machines, so the volume
 * servers are kept one to a node, and asking for more copies than
 * there are volume servers is refused rather than left to SeaweedFS to
 * fail at the first write.
 */

/**
 * What the configuration says, under "storage.objectStorage".
 *
 * - masters: how many masters. One, or an odd number for them to agree
 *   on a leader among.
 * - volumeServers: how many volume servers, each on a node of its own
 * - copies: how many copies of each object, one per volume server
 */
export interface ObjectStorageShape {
  masters: number;
  volumeServers: number;
  copies: number;
}

const DEFAULT_SHAPE: ObjectStorageShape = { masters: 1, volumeServers: 1, copies: 1 };

// SeaweedFS's replication setting is three digits: extra copies in
// other data centers, in other racks, and on other servers in the same
// rack. A cluster here is one data center and one rack, so the copies
// beyond the first are all of the last kind.
const MAX_COPIES = 10;

/**
 * The shape the configuration asks for, filled in from the defaults.
 *
 * Anything that isn't a sensible count is refused with the key named,
 * rather than being rendered into a manifest the operator would take.
 *
 * @param rawConfig
 * @returns
 */
export function getObjectStorageShape(rawConfig: any): ObjectStorageShape {
  const configured = rawConfig?.storage?.objectStorage ?? {};
  const shape = { ...DEFAULT_SHAPE };

  for (const key of Object.keys(DEFAULT_SHAPE) as (keyof ObjectStorageShape)[]) {
    const value = configured[key];
    if (value === undefined || value === null) {
      continue;
    }

    if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
      throw new Error(`"storage.objectStorage.${key}" is ${JSON.stringify(value)}, and has to be a whole number above zero.`);
    }

    shape[key] = value;
  }

  // Two masters can't outvote each other, so a second is no help
  if (shape.masters % 2 === 0) {
    throw new Error(`"storage.objectStorage.masters" is ${shape.masters}. Masters elect a leader by majority, so it has to be odd: 1, 3 or 5.`);
  }

  if (shape.copies > shape.volumeServers || shape.copies > MAX_COPIES) {
    throw new Error(`"storage.objectStorage.copies" is ${shape.copies}, with ${shape.volumeServers} volume server(s). Each copy is on a volume server of its own, so there can't be more copies than servers.`);
  }

  return shape;
}

/**
 * SeaweedFS's replication setting for a number of copies.
 *
 * @param copies
 * @returns
 */
export function replicationFor(copies: number): string {
  return `00${copies - 1}`;
}

/**
 * The template values the SeaweedFS manifest reads.
 *
 * @param rawConfig
 * @returns
 */
export function buildObjectStorageValues(rawConfig: any): Record<string, unknown> {
  const shape = getObjectStorageShape(rawConfig);

  return {
    objectStorageShape: {
      masters: shape.masters,
      volumeServers: shape.volumeServers,
      replication: replicationFor(shape.copies),
    },
  };
}
