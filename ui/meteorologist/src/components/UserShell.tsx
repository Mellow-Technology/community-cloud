/**
 * @file
 * What both of a user's tabs have around them: the header, a warning
 * when Cirrus or the installer looks after it, what it has (its keys
 * and the buckets it may use), and the tabs.
 */
import Link from "next/link";
import { notFound } from "next/navigation";
import type { ReactNode } from "react";
import { Alert } from "gui-mellow/Alert";
import { Card } from "gui-mellow/Card";

import { DetailList } from "@/components/DetailList";
import { ErrorNotice } from "@/components/ErrorNotice";
import { HealthBadge } from "@/components/HealthBadge";
import { PageHeader } from "@/components/PageHeader";
import { UserTabs } from "@/components/UserTabs";
import styles from "@/components/page.module.scss";
import { isNotFound } from "@/lib/kube/client";
import type { LoadedUser } from "@/lib/storage/loadUser";
import { bucketHealth, bucketHref, bucketManager, bucketName } from "@/lib/storage/present";
import { storageTabHref } from "@/lib/storage/tabs";
import { secretLabel } from "@/lib/storage/types";
import { identityName } from "@/lib/storage/users";
import type { UserTab } from "@/lib/storage/userTabs";

/**
 * @param props
 * @param props.user
 * @param props.tab
 * @param props.children the tab's content
 * @returns
 */
export function UserShell({ user, tab, children }: { user: LoadedUser; tab: UserTab; children: ReactNode }) {
  const back = { href: storageTabHref("users", user.namespace), label: "Users" };
  if (!user.identity.ok) {
    if (isNotFound(user.identity.error)) {
      notFound();
    }
    return (
      <>
        <PageHeader eyebrow={user.namespace} title={user.name} back={back} />
        <ErrorNotice error={user.identity.error} title="Couldn't read this user" />
      </>
    );
  }

  const identity = user.identity.value;
  const userName = identityName(identity);
  const manager = bucketManager(identity);
  const keys = user.keys;
  const buckets = user.buckets;

  return (
    <>
      <PageHeader
        eyebrow={user.namespace}
        title={identity.metadata.name}
        description={identity.spec.account?.displayName}
        back={back}
      />

      {manager?.kind === "application" && (
        <Alert tone="warning" className={styles.stats}>
          Cirrus made this user for {manager.href ? <Link href={manager.href}>{manager.name}</Link> : manager.name}, and
          sets it and its first key again whenever it reconciles the application. What it doesn&apos;t set, such as who
          it&apos;s for or other keys, is kept.
        </Alert>
      )}
      {manager?.kind === "installer" && (
        <Alert tone="warning" className={styles.stats}>
          The installer made this user for one of its packages, and sets it and its first key again the next time it
          runs.
        </Alert>
      )}

      <div className={styles.stats}>
        <Card title="The user" level={2}>
          <DetailList
            items={[
              { label: "In SeaweedFS", value: <code>{userName}</code> },
              {
                label: "Status",
                value: identity.spec.disabled ? (
                  "Disabled"
                ) : (
                  <HealthBadge health={bucketHealth(identity)} showMessage />
                ),
              },
              {
                label: "Keys",
                value:
                  keys === undefined || !keys.ok
                    ? "Couldn't list them"
                    : keys.value.length === 0
                      ? "None: nothing can use it until it has one"
                      : keys.value.map((each) => (
                          <code key={each.name} className={styles.code}>
                            {secretLabel(each)}
                          </code>
                        )),
              },
              {
                label: "Buckets",
                value:
                  buckets === undefined || !buckets.ok
                    ? "Couldn't list them"
                    : buckets.value.length === 0
                      ? "None yet. Give it access on a bucket's page."
                      : buckets.value.map(({ bucket, actions }) => (
                          <span key={`${bucket.metadata.namespace}/${bucket.metadata.name}`} className={styles.detail}>
                            <Link href={bucketHref(bucket)}>{bucketName(bucket)}</Link>: {actions.join(", ")}
                          </span>
                        )),
              },
            ]}
          />
        </Card>
      </div>

      <UserTabs namespace={user.namespace} name={user.name} selected={tab}>
        {children}
      </UserTabs>
    </>
  );
}
