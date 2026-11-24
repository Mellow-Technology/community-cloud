"use client";

/**
 * @file
 * A user's page's tabs. Each is a route of its own, so choosing one
 * goes there; the one shown is the page's own content.
 */
import { useRouter } from "next/navigation";
import type { ReactNode } from "react";
import { Tabs } from "gui-mellow/Tabs";

import { USER_TABS, USER_TAB_LABELS, userTabHref, type UserTab } from "@/lib/storage/userTabs";

/**
 * @param props
 * @param props.namespace
 * @param props.name the S3Identity's resource name
 * @param props.selected the tab this page is
 * @param props.children this tab's content
 * @returns
 */
export function UserTabs({
  namespace,
  name,
  selected,
  children,
}: {
  namespace: string;
  name: string;
  selected: UserTab;
  children: ReactNode;
}) {
  const router = useRouter();
  return (
    <Tabs<UserTab>
      label="User"
      value={selected}
      onChange={(tab) => {
        if (tab !== selected) {
          router.push(userTabHref(namespace, name, tab));
        }
      }}
      tabs={USER_TABS.map((tab) => ({
        value: tab,
        label: USER_TAB_LABELS[tab],
        content: tab === selected ? children : null,
      }))}
    />
  );
}
