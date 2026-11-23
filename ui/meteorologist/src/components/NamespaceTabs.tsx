"use client";

/**
 * @file
 * The namespace page's tabs, with the one shown kept in the address,
 * so a link (or a reload after saving) lands on the same tab.
 *
 * A page passes the panels it has. Choosing one of those only changes
 * the address; choosing one it doesn't have goes to where that tab is,
 * which is how Applications, a route of its own, sits among the rest.
 */
import { useRouter } from "next/navigation";
import type { ReactNode } from "react";
import { Tabs } from "gui-mellow/Tabs";

import { NAMESPACE_TABS, TAB_LABELS, namespaceTabHref, type NamespaceTab } from "@/lib/namespace/tabs";

/**
 * @param props
 * @param props.namespace
 * @param props.selected the tab the address asks for
 * @param props.panels the content of each tab this page has
 * @returns
 */
export function NamespaceTabs({
  namespace,
  selected,
  panels,
}: {
  namespace: string;
  selected: NamespaceTab;
  panels: Partial<Record<NamespaceTab, ReactNode>>;
}) {
  const router = useRouter();

  return (
    <Tabs<NamespaceTab>
      label="Namespace"
      defaultValue={selected}
      onChange={(tab) => {
        const href = namespaceTabHref(namespace, tab);
        if (panels[tab] !== undefined) {
          // Every panel here is already rendered, so there's nothing to
          // fetch again
          window.history.replaceState(null, "", href);
        } else {
          router.push(href);
        }
      }}
      tabs={NAMESPACE_TABS.map((tab) => ({ value: tab, label: TAB_LABELS[tab], content: panels[tab] ?? null }))}
    />
  );
}
