"use client";

/**
 * @file
 * The Storage page's tabs. Each is a route of its own, so choosing one
 * goes there; the one shown is the page's own content.
 */
import { useRouter } from "next/navigation";
import type { ReactNode } from "react";
import { Tabs } from "gui-mellow/Tabs";

import { STORAGE_TABS, STORAGE_TAB_LABELS, storageTabHref, type StorageTab } from "@/lib/storage/tabs";

/**
 * @param props
 * @param props.selected the tab this page is
 * @param props.namespace the namespace being shown, to keep
 * @param props.children this tab's content
 * @returns
 */
export function StorageTabs({
  selected,
  namespace,
  children,
}: {
  selected: StorageTab;
  namespace?: string;
  children: ReactNode;
}) {
  const router = useRouter();
  return (
    <Tabs<StorageTab>
      label="Storage"
      value={selected}
      onChange={(tab) => {
        if (tab !== selected) {
          router.push(storageTabHref(tab, namespace));
        }
      }}
      tabs={STORAGE_TABS.map((tab) => ({
        value: tab,
        label: STORAGE_TAB_LABELS[tab],
        content: tab === selected ? children : null,
      }))}
    />
  );
}
