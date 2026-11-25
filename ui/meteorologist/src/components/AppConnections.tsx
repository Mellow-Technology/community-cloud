/**
 * @file
 * An application's connections to ServiceOfferings, and the offering
 * it makes of itself with who's connected to it, on its page.
 */
import Link from "next/link";
import { StatusDot } from "gui-mellow/StatusDot";
import { Table } from "gui-mellow/Table";

import styles from "@/components/page.module.scss";
import formStyles from "@/components/WebApplicationForm.module.scss";
import { settle } from "@/lib/kube/client";
import type { KubeClient } from "@/lib/kube/client";
import { envPrefix } from "@/lib/webapp/form";
import type { ServiceOffering } from "@/lib/offerings/types";
import type { WebApplication } from "@/lib/webapp/types";

/**
 * @param props
 * @param props.app
 * @param props.kube
 * @returns
 */
export async function AppConnections({ app, kube }: { app: WebApplication; kube: KubeClient }) {
  const namespace = app.metadata.namespace ?? "";
  const connections = app.spec.connections ?? [];
  if (connections.length === 0 && app.spec.offers === undefined) {
    return null;
  }
  // Only the namespaces it connects to and its own, each read once
  const namespaces = [...new Set([namespace, ...connections.map((each) => each.namespace ?? namespace)])];
  const listed = await Promise.all(namespaces.map((each) => settle(() => kube.listServiceOfferings(each))));
  const offerings: ServiceOffering[] = listed.flatMap((each) => (each.ok ? each.value : []));
  const find = (offeringNamespace: string, name: string) =>
    offerings.find((each) => each.metadata.namespace === offeringNamespace && each.metadata.name === name);
  const own = app.spec.offers !== undefined ? find(namespace, app.metadata.name) : undefined;

  return (
    <>
      {connections.length > 0 && (
        <section className={styles.section}>
          <h2 className={styles.heading}>Connects to</h2>
          <Table
            columns={["Service", "Variables", "URL", "Status"]}
            rows={connections.map((connection) => {
              const offeringNamespace = connection.namespace ?? namespace;
              const offering = find(offeringNamespace, connection.offering);
              const shared =
                offering === undefined ||
                offeringNamespace === namespace ||
                (offering.spec.shareWith ?? []).includes(namespace);
              const ready =
                offering?.status?.conditions?.find((condition) => condition.type === "Ready")?.status === "True";
              return [
                <span key="service">
                  {offering?.spec.title ?? connection.offering}
                  <span className={styles.detail}>
                    {offeringNamespace}/{connection.offering}
                  </span>
                </span>,
                <code key="env">{envPrefix(connection.name || connection.offering)}_*</code>,
                offering?.status?.uri ? <code key="uri">{offering.status.uri}</code> : "",
                offering === undefined ? (
                  <StatusDot key="status" tone="warning">
                    Not found, or not visible to you
                  </StatusDot>
                ) : !shared ? (
                  <StatusDot key="status" tone="danger">
                    Not shared with {namespace}
                  </StatusDot>
                ) : (
                  <StatusDot key="status" tone={ready ? "success" : "warning"}>
                    {ready ? "Ready" : "Not ready"}
                  </StatusDot>
                ),
              ];
            })}
          />
        </section>
      )}

      {app.spec.offers !== undefined && (
        <section className={styles.section}>
          <h2 className={styles.heading}>Offered as</h2>
          <p className={formStyles.note}>
            <strong>{own?.spec.title ?? app.spec.offers.title ?? app.metadata.name}</strong>
            {own?.status?.uri && (
              <>
                {" "}
                at <code>{own.status.uri}</code>
              </>
            )}
            , to {namespace}
            {(app.spec.offers.shareWith ?? []).length > 0 && ` and ${app.spec.offers.shareWith!.join(", ")}`}.
            {app.spec.offers.description && <> {app.spec.offers.description}</>}
          </p>
          {own?.status?.consumers?.length ? (
            <Table
              columns={["Connected", "Namespace", ""]}
              rows={own.status.consumers.map((consumer) => [
                <Link key="app" href={`/apps/${consumer.namespace}/${consumer.name}`}>
                  {consumer.name}
                </Link>,
                consumer.namespace,
                consumer.allowed ? "" : "Not shared with its namespace, so refused",
              ])}
            />
          ) : (
            <p className={styles.empty}>Nothing connects to it yet.</p>
          )}
        </section>
      )}
    </>
  );
}
