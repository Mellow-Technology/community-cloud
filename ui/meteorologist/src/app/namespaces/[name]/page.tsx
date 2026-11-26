/**
 * @file
 * One namespace, in tabs: General (its capabilities, its Postgres, what
 * it's using and its settings), Environment (values its applications
 * share), DNS (the providers publishing it),
 * Forges (its GitLab connections), and Agents (tokens for managing its
 * applications over MCP). Applications, the other tab, is a
 * route of its own: ./applications/page.tsx.
 */
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Card } from "gui-mellow/Card";
import { Grid } from "gui-mellow/Grid";
import { Stat } from "gui-mellow/Stat";
import { StatusDot } from "gui-mellow/StatusDot";
import { Table } from "gui-mellow/Table";

import { AgentTokens } from "@/components/AgentTokens";
import { CapabilitySwitch } from "@/components/CapabilitySwitch";
import { DetailList } from "@/components/DetailList";
import { ErrorNotice } from "@/components/ErrorNotice";
import { GitLabBuilds } from "@/components/GitLabBuilds";
import { GitLabConnections } from "@/components/GitLabConnections";
import { NamespaceDns } from "@/components/NamespaceDns";
import { NamespaceHeader } from "@/components/NamespaceHeader";
import { SharedEnvironment, type SharedValue } from "@/components/SharedEnvironment";
import { NamespaceSettingsForm } from "@/components/NamespaceSettingsForm";
import { NamespaceTabs } from "@/components/NamespaceTabs";
import { PageHeader } from "@/components/PageHeader";
import styles from "@/components/page.module.scss";
import { CAPABILITIES, hasCapability } from "@/lib/capabilities";
import { getPublicUrl } from "@/lib/config";
import { SHARED_ENV, sharedValueUsers } from "@/lib/environment";
import { BUILDS_CONFIG_MAP, buildSettingsFrom, includeUrl } from "@/lib/gitlab/builds";
import { connectionsIn } from "@/lib/gitlab/connections";
import { getKube } from "@/lib/kube";
import { isForbidden, isNotFound, settle } from "@/lib/kube/client";
import type { PostgresCluster } from "@/lib/kube/types";
import {
  DEFAULT_SERVICE_ACCOUNT,
  PULL_SECRET_TYPE,
  SETTINGS_NAME,
  describePlacement,
  toNamespaceForm,
} from "@/lib/namespace/settings";
import { namespacesAllowing } from "@/lib/namespace/access";
import { namespaceTab } from "@/lib/namespace/tabs";
import { quotaFigures } from "@/lib/namespace/usage";
import { POSTGRES_CLUSTER, POSTGRES_STORAGE, postgresDatabase } from "@/lib/postgres";
import { GROUP, PLURAL } from "@/lib/webapp/types";

/**
 * @param props
 * @param props.params
 * @returns
 */
export async function generateMetadata({ params }: { params: Promise<{ name: string }> }): Promise<Metadata> {
  return { title: decodeURIComponent((await params).name) };
}

/**
 * Whether CloudNativePG says a Cluster is up.
 *
 * @param cluster
 * @returns
 */
function postgresTone(cluster: PostgresCluster): "success" | "warning" {
  const ready = cluster.status?.readyInstances ?? 0;
  return ready > 0 && ready >= (cluster.spec?.instances ?? 1) ? "success" : "warning";
}

/**
 * @param props
 * @param props.params
 * @returns
 */
export default async function NamespacePage({
  params,
  searchParams,
}: {
  params: Promise<{ name: string }>;
  searchParams: Promise<{ tab?: string }>;
}) {
  const name = decodeURIComponent((await params).name);
  const { tab } = await searchParams;
  const kube = await getKube();
  const found = await settle(() => kube.getNamespace(name));

  if (!found.ok) {
    if (isNotFound(found.error)) {
      notFound();
    }
    return (
      <>
        <PageHeader title={name} back={{ href: "/namespaces", label: "Namespaces" }} />
        <ErrorNotice error={found.error} title="Couldn't read this namespace" />
      </>
    );
  }

  const namespace = found.value;
  const [
    quotas,
    limitRange,
    serviceAccount,
    secrets,
    clusters,
    apps,
    regions,
    dns,
    builds,
    labelling,
    limiting,
    deploying,
    agents,
    binding,
    sharedConfig,
    sharedSecretKeys,
    changingConfig,
  ] = await Promise.all([
    settle(() => kube.listResourceQuotas(name)),
    settle(() => kube.getLimitRange(name, SETTINGS_NAME)),
    settle(() => kube.getServiceAccount(name, DEFAULT_SERVICE_ACCOUNT)),
    settle(() => kube.listSecrets(name)),
    settle(() => kube.listPostgresClusters(name)),
    settle(() => kube.listWebApplications(name)),
    settle(() => kube.listRegions()),
    settle(() => kube.listDnsProviders()),
    settle(() => kube.getConfigMap(name, BUILDS_CONFIG_MAP)),
    namespacesAllowing(kube, { verb: "patch", resource: "namespaces" }, [name]),
    namespacesAllowing(kube, { verb: "patch", resource: "resourcequotas" }, [name]),
    namespacesAllowing(kube, { verb: "create", resource: PLURAL, group: GROUP }, [name]),
    settle(() => kube.listAgents(name)),
    namespacesAllowing(kube, { verb: "create", resource: "rolebindings", group: "rbac.authorization.k8s.io" }, [name]),
    settle(() => kube.getConfigMap(name, SHARED_ENV)),
    settle(() => kube.listSecretKeys(name, SHARED_ENV)),
    // Saving writes a ConfigMap or a Secret, which "edit" may
    namespacesAllowing(kube, { verb: "update", resource: "secrets" }, [name]),
  ]);
  const appList = apps.ok ? apps.value : [];
  const sharedValues: SharedValue[] = [
    ...Object.entries((sharedConfig.ok ? sharedConfig.value?.data : undefined) ?? {}).map(([key, value]) => ({
      key,
      kind: "config" as const,
      value,
      usedBy: sharedValueUsers(appList, key),
    })),
    ...((sharedSecretKeys.ok ? sharedSecretKeys.value : undefined) ?? []).map((key) => ({
      key,
      kind: "secret" as const,
      usedBy: sharedValueUsers(appList, key),
    })),
  ].sort((a, b) => a.key.localeCompare(b.key));
  const canLabel = labelling.size > 0;
  // Saving the settings writes the namespace and its quota, so it
  // takes both. The "edit" role has neither, on purpose: a team
  // shouldn't be able to raise its own limits.
  const canChangeSettings = canLabel && limiting.size > 0;
  const connections = secrets.ok ? connectionsIn(secrets.value) : [];
  const buildSettings = builds.ok ? buildSettingsFrom(builds.value) : undefined;
  const usedBy: Record<string, string[]> = {};
  for (const app of apps.ok ? apps.value : []) {
    const secret = app.spec.source?.gitlab?.tokenSecret.name;
    if (secret !== undefined) {
      (usedBy[secret] ??= []).push(app.metadata.name);
    }
  }

  const ours = quotas.ok ? quotas.value.find((quota) => quota.metadata.name === SETTINGS_NAME) : undefined;
  const postgres = clusters.ok
    ? clusters.value.find((cluster) => cluster.metadata.name === POSTGRES_CLUSTER)
    : undefined;
  const usingPostgres = apps.ok ? apps.value.filter((app) => app.spec.postgres !== undefined) : [];
  const settingsReadable = quotas.ok && limitRange.ok && serviceAccount.ok;
  const usage = quotaFigures(ours);

  return (
    <>
      <NamespaceHeader name={name} canDeploy={deploying.size > 0} />

      <NamespaceTabs
        namespace={name}
        selected={namespaceTab(tab)}
        panels={{
          general: (
            <>
              <Grid min="300px" gap={5}>
                <Card title="Capabilities" level={2}>
                  <DetailList
                    items={CAPABILITIES.map((capability) => ({
                      label: capability.title,
                      value: (
                        <CapabilitySwitch
                          namespace={name}
                          capability={capability.id}
                          enabled={hasCapability(namespace.metadata.labels, capability)}
                          readOnly={!canLabel}
                        />
                      ),
                    }))}
                  />
                  <DetailList items={[{ label: "Region", value: describePlacement(namespace.metadata) }]} />
                </Card>

                <Card title="Postgres server" level={2}>
                  {!clusters.ok ? (
                    <ErrorNotice error={clusters.error} title="Couldn't look for it" />
                  ) : postgres ? (
                    <DetailList
                      items={[
                        {
                          label: "State",
                          value: (
                            <StatusDot tone={postgresTone(postgres)}>
                              {postgres.status?.phase ?? "Not started yet"}
                            </StatusDot>
                          ),
                        },
                        {
                          label: "Instances",
                          value: `${postgres.status?.readyInstances ?? 0} of ${postgres.spec?.instances ?? 1} ready`,
                        },
                        { label: "Volume", value: postgres.spec?.storage?.size },
                        { label: "Host", value: <code>{`${POSTGRES_CLUSTER}-rw.${name}.svc`}</code> },
                        {
                          label: "Databases",
                          value: usingPostgres.length
                            ? usingPostgres
                                .map((app) => `${postgresDatabase(app.metadata.name)}, for ${app.metadata.name}`)
                                .join("; ")
                            : "None yet",
                        },
                      ]}
                    />
                  ) : (
                    <p className={styles.empty}>
                      None yet. Cirrus starts <code>{POSTGRES_CLUSTER}</code>, with a {POSTGRES_STORAGE} volume, when
                      the first application here asks for a database, and every later one gets a database of its own on
                      it. It stays when the applications go.
                    </p>
                  )}
                </Card>
              </Grid>

              {usage.length > 0 && (
                <section className={styles.section}>
                  <h2 className={styles.heading}>Usage</h2>
                  <Grid min="180px" gap={4}>
                    {usage.map((each) => (
                      <Stat
                        key={each.key}
                        label={each.label}
                        value={each.used}
                        total={each.limit}
                        unit={each.unit}
                        meter={each.comparable}
                      />
                    ))}
                  </Grid>
                </section>
              )}

              {quotas.ok && quotas.value.some((quota) => quota.metadata.name !== SETTINGS_NAME) && (
                <section className={styles.section}>
                  <h2 className={styles.heading}>Other quotas</h2>
                  <p className={styles.empty}>Made outside Meteorologist, and left as they are. They apply too.</p>
                  <Table
                    columns={["Quota", "Limits"]}
                    rows={quotas.value
                      .filter((quota) => quota.metadata.name !== SETTINGS_NAME)
                      .map((quota) => [
                        quota.metadata.name,
                        Object.entries(quota.spec?.hard ?? {})
                          .map(([key, value]) => `${key}=${value}`)
                          .join(", "),
                      ])}
                  />
                </section>
              )}

              <section className={styles.section}>
                <h2 className={styles.heading}>Settings</h2>
                {!canChangeSettings ? (
                  <p className={styles.empty}>
                    The region, limits and default registries here are set by a cluster admin.
                  </p>
                ) : settingsReadable ? (
                  <NamespaceSettingsForm
                    initial={toNamespaceForm(name, namespace.metadata, ours, limitRange.value, serviceAccount.value)}
                    existing={{
                      pullSecrets: secrets.ok
                        ? secrets.value
                            .filter((secret) => secret.type === PULL_SECRET_TYPE)
                            .map((secret) => secret.name)
                        : [],
                      hasPostgres: postgres !== undefined,
                      storageUsed: ours?.status?.used?.["requests.storage"],
                    }}
                    regions={regions.ok ? regions.value : []}
                  />
                ) : (
                  <ErrorNotice
                    error={[quotas, limitRange, serviceAccount].find((read) => !read.ok)?.error}
                    title="Couldn't read this namespace's settings"
                  />
                )}
              </section>
            </>
          ),
          dns: (
            <section className={styles.section}>
              <h2 className={styles.heading}>DNS</h2>
              {dns.ok ? (
                <NamespaceDns namespace={name} providers={dns.value} />
              ) : isForbidden(dns.error) ? (
                <p className={styles.empty}>
                  DNS providers belong to the whole cluster, so only cluster admins see and change them.
                </p>
              ) : (
                <ErrorNotice error={dns.error} title="Couldn't list DNS providers" />
              )}
            </section>
          ),
          forges: (
            <>
              {secrets.ok ? (
                <GitLabConnections namespace={name} connections={connections} usedBy={usedBy} />
              ) : isForbidden(secrets.error) ? (
                <p className={styles.empty}>
                  GitLab connections are kept in Secrets, and you don&apos;t have access to the Secrets in this
                  namespace.
                </p>
              ) : (
                <ErrorNotice error={secrets.error} title="Couldn't list this namespace's Secrets" />
              )}
              {builds.ok ? (
                <GitLabBuilds
                  namespace={name}
                  configured={buildSettings !== undefined}
                  build={buildSettings?.build ?? {}}
                  projects={Object.entries(buildSettings?.projects ?? {}).map(([project, build]) => ({
                    project,
                    build,
                  }))}
                  exampleUrls={
                    buildSettings && {
                      dockerfile: includeUrl(getPublicUrl(), "dockerfile", name, buildSettings.key, "group/project"),
                      bake: includeUrl(getPublicUrl(), "bake", name, buildSettings.key, "group/project"),
                    }
                  }
                />
              ) : (
                <ErrorNotice error={builds.error} title="Couldn't read this namespace's GitLab build settings" />
              )}
            </>
          ),
          environment:
            sharedConfig.ok || sharedSecretKeys.ok ? (
              <SharedEnvironment namespace={name} values={sharedValues} canEdit={changingConfig.size > 0} />
            ) : (
              <ErrorNotice error={sharedConfig.error} title="Couldn't read this namespace's shared environment" />
            ),
          agents: agents.ok ? (
            <AgentTokens
              namespace={name}
              agents={agents.value}
              canManage={binding.size > 0}
              publicUrl={getPublicUrl()}
            />
          ) : isForbidden(agents.error) ? (
            <p className={styles.empty}>
              Agents are ServiceAccounts, and you don&apos;t have access to the ServiceAccounts in this namespace.
            </p>
          ) : (
            <ErrorNotice error={agents.error} title="Couldn't list this namespace's agents" />
          ),
        }}
      />
    </>
  );
}
