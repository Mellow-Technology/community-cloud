"use client";

/**
 * @file
 * The namespace page's tabs, with the one shown kept in the address,
 * so a link (or a reload after saving) lands on the same tab.
 */
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { Tabs } from "gui-mellow/Tabs";

import { NAMESPACE_TABS, TAB_LABELS, type NamespaceTab } from "@/lib/namespace/tabs";

/**
 * @param props
 * @param props.selected the tab the address asks for
 * @param props.panels each tab's content
 * @returns
 */
export function NamespaceTabs({
  selected,
  panels,
}: {
  selected: NamespaceTab;
  panels: Record<NamespaceTab, ReactNode>;
}) {
  const pathname = usePathname();

  return (
    <Tabs<NamespaceTab>
      label="Namespace"
      defaultValue={selected}
      // Only the address changes; every panel is already rendered, so
      // there's nothing to fetch again
      onChange={(tab) => window.history.replaceState(null, "", tab === "general" ? pathname : `${pathname}?tab=${tab}`)}
      tabs={NAMESPACE_TABS.map((tab) => ({ value: tab, label: TAB_LABELS[tab], content: panels[tab] }))}
    />
  );
}
