/**
 * @file
 * The Storage page's tabs, each a route of its own: Buckets at
 * /storage, and Users, SeaweedFS's S3Identities, at /storage/users. The
 * namespace filter goes along when switching.
 */
export const STORAGE_TABS = ["buckets", "users"] as const;
export type StorageTab = (typeof STORAGE_TABS)[number];

export const STORAGE_TAB_LABELS: Record<StorageTab, string> = {
  buckets: "Buckets",
  users: "Users",
};

/**
 * Where a tab is, keeping the namespace being shown.
 *
 * @param tab
 * @param namespace
 * @returns
 */
export function storageTabHref(tab: StorageTab, namespace?: string): string {
  const path = tab === "buckets" ? "/storage" : `/storage/${tab}`;
  return namespace ? `${path}?namespace=${encodeURIComponent(namespace)}` : path;
}
