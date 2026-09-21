/**
 * @file
 * Which device classes a node can actually serve, and how that gets
 * from the node to TopoLVM.
 *
 * lvmd is handed a list of device classes and refuses to start unless
 * every volume group in it exists on the node it's running on. That's
 * fine on a cluster where every machine has the same disks in it and
 * wrong everywhere else — and "everywhere else" is most of a community
 * cloud, which tends to be built out of whatever hardware people have.
 * A node with SSDs and no spinning disks is a perfectly good node for
 * the classes it does have, and refusing to serve any of them because
 * it can't serve all of them is the wrong blast radius.
 *
 * The chart's way out is "additionalConfigs": several lvmd DaemonSets,
 * each with its own device classes and its own nodeSelector, which the
 * chart requires to be non-overlapping. Only one lvmd can be used per
 * node — topolvm-node is given a single socket path — so the configs
 * have to be one per *combination* of classes rather than one per
 * class.
 *
 * That combination is what's called a shape here. Nodes are labelled
 * with theirs once their volume groups exist, the values file is
 * rendered from the shapes actually found in the cluster, and each
 * shape gets an lvmd config naming only the classes it can serve.
 *
 * A single label holding the whole set, rather than one label per
 * class, is what keeps the selectors non-overlapping: a selector is an
 * AND of labels, so a config asking for "has ssd and has hdd" would
 * also match a node that has those plus a third class, and two configs
 * would fight over it. An exact shape can only match one.
 *
 * This is a stopgap. The better fix is upstream — see the note in
 * TopoLVM.values.yaml — after which the whole mechanism can go.
 */

// Where labels describing a node's storage live. Namespaced like the
// GPU labels, so it's clear which labels this installer owns.
export const STORAGE_PREFIX = "storage.community-cloud.technology";

// The label holding the whole set of classes a node serves
export const CLASSES_LABEL = `${STORAGE_PREFIX}/classes`;

// What separates the classes inside that label. A dot rather than a
// hyphen because the class names have hyphens in them: "ssd-sata" and
// "ssd-cache" joined by hyphens would be one long ambiguous string.
const SHAPE_SEPARATOR = ".";

// The nodes TopoLVM runs on at all. Every lvmd config carries this as
// well as its shape, so a node that isn't storage-local is never
// selected by any of them.
export const STORAGE_NODE_SELECTOR: Record<string, string> = {
  "node-role.kubernetes.io/storage-local": "storage-local",
};

/**
 * The same thing in the form "kubectl -l" wants.
 */
export const STORAGE_ROLE_SELECTOR = Object.entries(STORAGE_NODE_SELECTOR)
  .map(([name, value]) => `${name}=${value}`)
  .join(",");

/**
 * The shape of a node, from the classes it serves.
 *
 * Sorted, so that two nodes with the same disks get the same shape
 * whatever order their disks were found in, and de-duplicated, so
 * that two disks of one class don't name it twice.
 *
 * @param classes
 * @returns
 */
export function buildShape(classes: string[]): string {
  return [...new Set(classes)].sort().join(SHAPE_SEPARATOR);
}

/**
 * The classes a shape is made of.
 *
 * @param shape
 * @returns
 */
export function readShape(shape: string): string[] {
  return shape.split(SHAPE_SEPARATOR).filter((name) => name !== "");
}

/**
 * Whether a shape is something Kubernetes will accept as a label
 * value, which caps it at 63 characters.
 *
 * Four classes of the lengths we use come to well under that, so this
 * is really a guard against a values file that has grown a great many
 * device classes rather than a case anyone will hit.
 *
 * @param shape
 * @returns
 */
export function isUsableShape(shape: string): boolean {
  return shape.length > 0 && shape.length <= 63 && /^[a-z0-9]([-_.a-z0-9]*[a-z0-9])?$/.test(shape);
}

/**
 * The nodeSelector for one shape.
 *
 * @param shape
 * @returns
 */
export function buildShapeSelector(shape: string): Record<string, string> {
  return { ...STORAGE_NODE_SELECTOR, [CLASSES_LABEL]: shape };
}

/**
 * The shape of each storage node in the cluster, as an earlier
 * command found it.
 *
 * Absent when nothing has looked yet, which is the first install and
 * the case everything here has to degrade to.
 *
 * @param context
 * @returns
 */
export function getStorageShapes(context: any): Record<string, string> {
  const shapes = context?.storageShapes;

  return shapes !== undefined && shapes !== null && typeof shapes === "object"
    ? shapes
    : {};
}
