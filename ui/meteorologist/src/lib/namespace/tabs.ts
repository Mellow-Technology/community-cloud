/**
 * @file
 * The namespace page's tabs, and reading the one asked for from the
 * address. Apart from the tabs component so the server can use them.
 */
export const NAMESPACE_TABS = ["general", "dns", "integration"] as const;
export type NamespaceTab = (typeof NAMESPACE_TABS)[number];

export const TAB_LABELS: Record<NamespaceTab, string> = {
  general: "General",
  dns: "DNS",
  integration: "Integration",
};

/**
 * The tab a ?tab= value means, General for anything else.
 *
 * @param value
 * @returns
 */
export function namespaceTab(value: string | undefined): NamespaceTab {
  return NAMESPACE_TABS.find((tab) => tab === value) ?? "general";
}
