/**
 * @file
 * The namespace page's tabs, and reading the one asked for from the
 * address. Apart from the tabs component so the server can use them.
 *
 * Most are panels of the one page, picked by ?tab=. Applications is a
 * route of its own, /namespaces/<name>/applications, since it's the
 * applications list with live updates rather than a part of the
 * namespace's page.
 */
export const NAMESPACE_TABS = ["general", "applications", "dns", "forges", "agents"] as const;
export type NamespaceTab = (typeof NAMESPACE_TABS)[number];

export const TAB_LABELS: Record<NamespaceTab, string> = {
  general: "General",
  applications: "Applications",
  dns: "DNS",
  forges: "Forges",
  agents: "Agents",
};

// What tabs used to be called, so links made before still land
const RENAMED: Record<string, NamespaceTab> = {
  integration: "forges",
};

/**
 * The tab a ?tab= value means, General for anything else. Applications
 * isn't one: it has its own address.
 *
 * @param value
 * @returns
 */
export function namespaceTab(value: string | undefined): NamespaceTab {
  const tab = RENAMED[value ?? ""] ?? NAMESPACE_TABS.find((each) => each === value);
  return tab === undefined || tab === "applications" ? "general" : tab;
}

/**
 * Where a namespace's tab is.
 *
 * @param namespace
 * @param tab
 * @returns
 */
export function namespaceTabHref(namespace: string, tab: NamespaceTab): string {
  const page = `/namespaces/${encodeURIComponent(namespace)}`;
  if (tab === "general") return page;
  if (tab === "applications") return `${page}/applications`;
  return `${page}?tab=${tab}`;
}
