/**
 * @file
 * The office applications: where each one is, whether it's up, how
 * people sign in, and how an administrator gets in.
 *
 * Made from the records the installer leaves of each package it
 * installs (see src/lib/office.ts), so it lists what was installed,
 * not what happens to be running. A password is never part of the
 * page; AdminCredential reads it on request, as whoever asks.
 */
import type { Metadata } from "next";
import { Card } from "gui-mellow/Card";
import { Grid } from "gui-mellow/Grid";

import { AdminCredential } from "@/components/AdminCredential";
import { DetailList } from "@/components/DetailList";
import { ErrorNotice } from "@/components/ErrorNotice";
import { HealthBadge } from "@/components/HealthBadge";
import { PageHeader } from "@/components/PageHeader";
import styles from "@/components/page.module.scss";
import { getKube } from "@/lib/kube";
import { isForbidden, settle } from "@/lib/kube/client";
import {
  RECORD_NAMESPACE,
  SIGN_IN_LABELS,
  officeApps,
  officeHealth,
  readPackageRecords,
  type OfficeRecord,
} from "@/lib/office";

export const metadata: Metadata = { title: "Office" };

/**
 * How an administrator gets in.
 *
 * @param props
 * @param props.record
 * @returns
 */
function Administrator({ record }: { record: OfficeRecord }) {
  const { admin } = record.app;
  if (admin === undefined || "how" in admin) {
    return <>{admin?.how}</>;
  }
  return (
    <>
      {admin.login !== undefined && <span className={`${styles.mono} ${styles.login}`}>{admin.login}</span>}
      <AdminCredential packageName={record.name} label={admin.login !== undefined ? "password" : "token"} />
    </>
  );
}

/**
 * @returns
 */
export default async function OfficePage() {
  const kube = await getKube();
  const records = await settle(() => readPackageRecords(kube));
  const apps = records.ok ? officeApps(records.value) : [];

  // Each namespace's workloads once, however many applications are in it
  const namespaces = [...new Set(apps.map((record) => record.namespace))];
  const workloads = new Map(
    await Promise.all(
      namespaces.map(async (namespace) => [namespace, await settle(() => kube.listWorkloads(namespace))] as const),
    ),
  );
  const healthOf = (record: OfficeRecord) => {
    const found = workloads.get(record.namespace);
    return found?.ok ? officeHealth(record, found.value) : undefined;
  };

  return (
    <>
      <PageHeader
        eyebrow="Community Cloud"
        title="Office"
        description="The applications this cluster runs for its people, and how to get into each one."
      />

      {!records.ok ? (
        isForbidden(records.error) ? (
          <p className={styles.empty}>
            What&apos;s installed is recorded in the {RECORD_NAMESPACE} namespace, which only cluster admins can read.
          </p>
        ) : (
          <ErrorNotice error={records.error} title="Couldn't read what's installed" />
        )
      ) : apps.length === 0 ? (
        <p className={styles.empty}>
          No office applications are on record. Each one&apos;s install records it; for a cluster installed before that,
          run{" "}
          <code className={styles.mono}>community-cloud run-bundle package-records &lt;server&gt; cc.config.json</code>.
        </p>
      ) : (
        <Grid min="320px" gap={4}>
          {apps.map((record) => {
            const health = healthOf(record);
            return (
              <Card key={record.name} title={record.app.title}>
                <DetailList
                  items={[
                    {
                      label: "Address",
                      value: (
                        <a href={record.app.url} target="_blank" rel="noreferrer">
                          {record.app.url.replace(/^https?:\/\//, "").replace(/\/$/, "")}
                        </a>
                      ),
                    },
                    { label: "Health", value: health && <HealthBadge health={health} showMessage /> },
                    { label: "Sign in", value: SIGN_IN_LABELS[record.app.signIn] },
                    { label: "Administrator", value: record.app.admin && <Administrator record={record} /> },
                    { label: "Note", value: record.app.note },
                    { label: "Version", value: record.chartVersion },
                    {
                      label: "Recorded",
                      value:
                        record.updated && new Date(record.updated).toLocaleDateString("en", { dateStyle: "medium" }),
                    },
                  ]}
                />
              </Card>
            );
          })}
        </Grid>
      )}
    </>
  );
}
