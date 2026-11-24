/**
 * @file
 * SeaweedFS's S3 users, across namespaces or in one: how many, and a
 * table of each with where its keys are and which buckets it may use.
 */
import Link from "next/link";
import { Grid } from "gui-mellow/Grid";
import { Stat } from "gui-mellow/Stat";
import { StatusDot } from "gui-mellow/StatusDot";
import { Table } from "gui-mellow/Table";

import { ErrorNotice } from "@/components/ErrorNotice";
import { HealthBadge } from "@/components/HealthBadge";
import styles from "@/components/page.module.scss";
import { getKube } from "@/lib/kube";
import { settle } from "@/lib/kube/client";
import type { Namespace } from "@/lib/kube/types";
import { acrossNamespaces } from "@/lib/namespace/access";
import { BUCKET_PHASE_ORDER, bucketHealth, bucketHref, bucketManager, bucketName } from "@/lib/storage/present";
import { bucketsFor, identityName, isDisabled, keysFor, userEditHref } from "@/lib/storage/users";
import { secretLabel } from "@/lib/storage/types";

/**
 * @param props
 * @param props.namespace only this namespace's users, read in one
 * @param props.namespaces otherwise, every namespace to read across
 * @returns
 */
export async function UserList({ namespace, namespaces = [] }: { namespace?: string; namespaces?: Namespace[] }) {
  const kube = await getKube();
  const across = <T,>(read: (namespace?: string) => Promise<T[]>) =>
    settle(() => (namespace ? read(namespace) : acrossNamespaces(namespaces, read)));
  // Buckets from every namespace the person can see, since a user may
  // be given access to a bucket in any of them
  const [identities, credentials, buckets] = await Promise.all([
    across((each) => kube.listS3Identities(each)),
    across((each) => kube.listS3Credentials(each)),
    settle(() => acrossNamespaces(namespaces, (each) => kube.listBuckets(each))),
  ]);

  if (!identities.ok) {
    return <ErrorNotice error={identities.error} title="Couldn't list users" />;
  }
  if (identities.value.length === 0) {
    return <p className={styles.empty}>No users {namespace ? `in ${namespace}` : "yet"}.</p>;
  }

  const users = identities.value.toSorted(
    (a, b) =>
      (a.metadata.namespace ?? "").localeCompare(b.metadata.namespace ?? "") ||
      a.metadata.name.localeCompare(b.metadata.name),
  );
  const disabled = users.filter(isDisabled).length;
  const withKeys = credentials.ok
    ? users.filter((user) => keysFor(user, credentials.value).length > 0).length
    : undefined;

  return (
    <>
      <div className={styles.stats}>
        <Grid min="180px" gap={4}>
          <Stat label="Users" value={users.length} />
          {withKeys !== undefined && <Stat label="With keys" value={withKeys} total={users.length} meter={false} />}
          <Stat label="Disabled" value={disabled} />
        </Grid>
      </div>

      {!credentials.ok && <ErrorNotice error={credentials.error} title="Couldn't list users' keys" />}
      {!buckets.ok && <ErrorNotice error={buckets.error} title="Couldn't list buckets" />}

      <Table
        columns={[
          { label: "Name", sortable: true },
          ...(namespace ? [] : [{ label: "Namespace", sortable: true }]),
          { label: "Status", sortable: true },
          "Keys",
          "Buckets",
          "Looked after by",
        ]}
        rows={users.map((user) => {
          const health = bucketHealth(user);
          const name = identityName(user);
          const keys = credentials.ok ? keysFor(user, credentials.value) : [];
          const usable = buckets.ok ? bucketsFor(user, buckets.value) : [];
          const manager = bucketManager(user);
          const account = user.spec.account;
          return [
            {
              value: user.metadata.name,
              display: (
                <>
                  <Link href={userEditHref(user)}>{user.metadata.name}</Link>
                  {name !== user.metadata.name && <span className={styles.detail}>{name} in SeaweedFS</span>}
                  {account?.displayName && <span className={styles.detail}>{account.displayName}</span>}
                </>
              ),
            },
            ...(namespace ? [] : [user.metadata.namespace ?? ""]),
            isDisabled(user)
              ? { value: -1, display: <StatusDot tone="neutral">Disabled</StatusDot> }
              : { value: BUCKET_PHASE_ORDER.indexOf(health.state), display: <HealthBadge health={health} /> },
            keys.length === 0 ? (
              <span key="keys" className={styles.detail}>
                None
              </span>
            ) : (
              <span key="keys">
                {keys.map((each) => (
                  <code key={each.name} className={styles.code}>
                    {secretLabel(each)}
                  </code>
                ))}
              </span>
            ),
            usable.length === 0 ? (
              ""
            ) : (
              <span key="buckets">
                {usable.map(({ bucket, actions }) => (
                  <span key={`${bucket.metadata.namespace}/${bucket.metadata.name}`} className={styles.detail}>
                    <Link href={bucketHref(bucket)}>{bucketName(bucket)}</Link>: {actions.join(", ")}
                  </span>
                ))}
              </span>
            ),
            manager === undefined ? (
              ""
            ) : manager.href ? (
              <Link key="manager" href={manager.href}>
                {manager.name}
              </Link>
            ) : manager.kind === "installer" ? (
              "The installer"
            ) : (
              (manager.name ?? "")
            ),
          ];
        })}
      />
    </>
  );
}
