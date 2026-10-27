/**
 * @file
 * Every namespace, and the Community Cloud capabilities each has.
 *
 * The capabilities are labels other manifests select on, so this page
 * explains each before listing them: someone toggling one should know
 * what it lets in, and what turning it off takes away.
 */
import type { Metadata } from "next";
import Link from "next/link";
import { Button } from "gui-mellow/Button";
import { Card } from "gui-mellow/Card";
import { Grid } from "gui-mellow/Grid";
import { Table } from "gui-mellow/Table";

import { CapabilitySwitch } from "@/components/CapabilitySwitch";
import { ErrorNotice } from "@/components/ErrorNotice";
import { PageHeader } from "@/components/PageHeader";
import styles from "@/components/page.module.scss";
import { CAPABILITIES, hasCapability } from "@/lib/capabilities";
import { getKube } from "@/lib/kube";
import { settle } from "@/lib/kube/client";

export const metadata: Metadata = { title: "Namespaces" };

/**
 * @returns
 */
export default async function NamespacesPage() {
  const kube = await getKube();
  const [namespaces, apps] = await Promise.all([
    settle(() => kube.listNamespaces()),
    settle(() => kube.listWebApplications()),
  ]);

  const appCounts = new Map<string, number>();
  if (apps.ok) {
    for (const app of apps.value) {
      const namespace = app.metadata.namespace ?? "";
      appCounts.set(namespace, (appCounts.get(namespace) ?? 0) + 1);
    }
  }

  return (
    <>
      <PageHeader
        eyebrow="Cluster"
        title="Namespaces"
        description="What each namespace may use. Capabilities are labels on the namespace that the cluster's shared services look for."
        actions={<Button href="/namespaces/new">New namespace</Button>}
      />

      <Grid min="280px" gap={4}>
        {CAPABILITIES.map((capability) => (
          <Card key={capability.id} title={capability.title} level={2}>
            <p>{capability.explanation}</p>
            <p className={styles.code}>
              <code>
                {capability.label}={capability.value}
              </code>
            </p>
          </Card>
        ))}
      </Grid>

      <section className={styles.section}>
        {namespaces.ok ? (
          <Table
            caption="Namespaces you can see"
            columns={[
              { label: "Namespace", sortable: true },
              ...CAPABILITIES.map((capability) => capability.title),
              { label: "Applications", numeric: true },
            ]}
            rows={namespaces.value
              .toSorted((a, b) => a.metadata.name.localeCompare(b.metadata.name))
              .map((ns) => {
                const name = ns.metadata.name;
                const count = appCounts.get(name) ?? 0;
                return [
                  {
                    value: name,
                    display: (
                      <Link href={`/namespaces/${encodeURIComponent(name)}`} className={styles.mono}>
                        {name}
                      </Link>
                    ),
                  },
                  ...CAPABILITIES.map((capability) => ({
                    value: hasCapability(ns.metadata.labels, capability) ? 1 : 0,
                    display: (
                      <CapabilitySwitch
                        namespace={name}
                        capability={capability.id}
                        enabled={hasCapability(ns.metadata.labels, capability)}
                      />
                    ),
                  })),
                  {
                    value: count,
                    display:
                      count > 0 ? <Link href={`/apps?namespace=${encodeURIComponent(name)}`}>{count}</Link> : "0",
                  },
                ];
              })}
          />
        ) : (
          <ErrorNotice error={namespaces.error} title="Couldn't list namespaces" />
        )}
      </section>
    </>
  );
}
