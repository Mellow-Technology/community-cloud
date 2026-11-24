/**
 * @file
 * A user's page's tabs, each a route of its own: Edit, for the
 * S3Identity's settings, and Access Keys, for its S3Credentials.
 */
export const USER_TABS = ["edit", "keys"] as const;
export type UserTab = (typeof USER_TABS)[number];

export const USER_TAB_LABELS: Record<UserTab, string> = {
  edit: "Edit",
  keys: "Access Keys",
};

/**
 * Where a user's tab is.
 *
 * @param namespace
 * @param name the S3Identity's resource name
 * @param tab
 * @returns
 */
export function userTabHref(namespace: string, name: string, tab: UserTab): string {
  return `/storage/users/${encodeURIComponent(namespace)}/${encodeURIComponent(name)}/${tab}`;
}
