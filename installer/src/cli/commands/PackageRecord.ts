/**
 * @file
 * Tell the cluster what's installed on it, and how to use it.
 *
 * Nothing in a cluster says which of its Deployments add up to Plane,
 * where Plane is reached, or that its first administrator's password
 * is in the Secret "plane-admin". The installer knows all of that, from
 * the catalogue in packages.ts, and forgets it the moment it exits. So
 * every package's install leaves a record of it behind: a ConfigMap
 * in community-cloud called "cc-package-<name>", labelled
 * "community-cloud.technology/package", with the whole record as JSON
 * under "record.json".
 *
 * Meteorologist reads these. Its Office page is the records with an
 * application in them: where each one is, how people sign in, its
 * health from the workloads named here, and, for someone allowed to
 * read the Secret, the administrator's password. The record names the
 * Secret rather than holding the password, so a ConfigMap anyone can
 * read gives nothing away, and who sees the password is the cluster's
 * RBAC's to decide.
 *
 * Every package gets one, application or not. What's installed, at
 * which version, and what to wait for are what anything installing
 * packages later, Meteorologist included, will need to know.
 *
 * Requires:
 * - a running cluster with a readable kubeconfig
 */
import { stringify } from "yaml";

import { CommandPurpose, CommandSpec, CommandTarget, OutputType } from "./Command.ts";
import CloudConfig from "../../util/CloudConfig.ts";
import { buildKubeEnv } from "../../util/kube.ts";
import { quoteForShell } from "../../util/shell.ts";
import { INSTALLER_VERSION } from "./ClusterConfig.ts";
import { getGateName, readValue } from "./OAuth2Proxy.ts";
import { CLUSTER_NAMESPACE, PackageDefinition, resolveInstallOrder } from "./packages.ts";

// What finds them. A label rather than a name pattern, so a reader can
// ask the API server for exactly these.
export const RECORD_LABEL = "community-cloud.technology/package";

// The one key the record is under. One document rather than a key per
// field, so it's read back in the shape it was written in.
export const RECORD_KEY = "record.json";

// Raised when the record changes shape in a way a reader would notice
export const RECORD_VERSION = 1;

// Read from a credential when the package doesn't say otherwise. Every
// generated Secret has its secret under this key.
const DEFAULT_CREDENTIAL_KEY = "password";

/**
 * What's recorded about an application's administrator.
 */
export type RecordedAdmin =
  | { secret: { namespace: string; name: string; key: string }; login?: string }
  | { how: string };

/**
 * What's recorded about a package.
 */
export interface PackageRecord {
  version: number;
  name: string;
  description: string;
  namespace: string;
  chart?: { repo: string; name: string; version?: string };
  rollout: string[];
  ready: string[];
  installer: string;
  updated: string;
  app?: {
    title: string;
    url: string;
    signIn: string;
    admin?: RecordedAdmin;
    note?: string;
  };
}

/**
 * The name of a package's record.
 *
 * @param name
 * @returns
 */
export function getRecordName(name: string): string {
  return `cc-package-${name}`;
}

/**
 * What to record about a package, against a configuration.
 *
 * @param definition
 * @param config
 * @returns
 */
export function buildPackageRecord(definition: PackageDefinition, config: CloudConfig): PackageRecord {
  const { app, chart, gate } = definition;
  const needer = `${definition.name}'s record`;

  const record: PackageRecord = {
    version: RECORD_VERSION,
    name: definition.name,
    description: definition.description,
    namespace: definition.namespace,
    // The gate's Deployment counts as the package's, as it does when
    // the install waits for it
    rollout: [...(definition.rollout ?? []), ...(gate !== undefined ? [`deployment/${getGateName(gate)}`] : [])],
    ready: definition.ready ?? [],
    installer: INSTALLER_VERSION,
    updated: new Date().toISOString(),
  };

  if (chart !== undefined) {
    record.chart = { ...chart, ...(definition.version !== undefined ? { version: definition.version } : {}) };
  }

  if (app !== undefined) {
    const { admin } = app;

    record.app = {
      title: app.title,
      url: `https://${readValue(config, app.url, needer)}/`,
      signIn: app.signIn,
      ...(admin === undefined
        ? {}
        : "how" in admin
          ? { admin: { how: admin.how } }
          : {
              admin: {
                secret: {
                  namespace: definition.namespace,
                  name: admin.secret,
                  key: admin.key ?? DEFAULT_CREDENTIAL_KEY,
                },
                ...(admin.login !== undefined ? { login: readValue(config, admin.login, needer) } : {}),
              },
            }),
      ...(app.note !== undefined ? { note: app.note } : {}),
    };
  }

  return record;
}

/**
 * A package's record, as the ConfigMap it's kept in.
 *
 * @param definition
 * @param config
 * @returns
 */
export function buildPackageRecordManifest(definition: PackageDefinition, config: CloudConfig): string {
  const document = {
    apiVersion: "v1",
    kind: "ConfigMap",
    metadata: {
      name: getRecordName(definition.name),
      namespace: CLUSTER_NAMESPACE,
      labels: {
        "app.kubernetes.io/managed-by": "community-cloud",
        "app.kubernetes.io/part-of": "community-cloud",
        [RECORD_LABEL]: definition.name,
      },
    },
    data: {
      [RECORD_KEY]: JSON.stringify(buildPackageRecord(definition, config), null, 2),
    },
  };

  return [
    "# Managed by Community Cloud",
    "# What the installer installed, written each time it does. Edited",
    "# here it will be overwritten.",
    stringify(document),
  ].join("\n");
}

/**
 * Write a package's record.
 *
 * Its namespace is made if need be: an application in cc-office can
 * be the first thing installed that has a record, ahead of anything
 * that lives in community-cloud. Made rather than applied, since the
 * namespace carries labels other manifests own.
 *
 * @param definition
 * @returns
 */
export function buildRecordCommand(definition: PackageDefinition): CommandSpec {
  const namespace = quoteForShell(CLUSTER_NAMESPACE);

  return {
    name: `record-${definition.name}`,
    description: `Record ${definition.name} as installed`,
    purpose: CommandPurpose.Apply,
    runOn: CommandTarget.ControlPlane,
    env: buildKubeEnv,
    command: [
      `kubectl get namespace ${namespace} > /dev/null 2>&1 || kubectl create namespace ${namespace} || { echo "Couldn't make the ${CLUSTER_NAMESPACE} namespace" >&2; exit 1; }`,
      `kubectl apply -f - || { echo "Couldn't record ${definition.name}" >&2; exit 1; }`,
    ],
    stdin: (config: CloudConfig) => buildPackageRecordManifest(definition, config),
    output: OutputType.Raw,
  };
}

/**
 * Write the record of every package the configuration enables, and
 * nothing else.
 *
 * For a cluster whose packages were installed before there were
 * records, or by hand: it says what's there without installing it all
 * again. Assumes what's enabled is installed, as the install would
 * have left it.
 *
 * @param config
 * @returns
 */
export function PackageRecordCommands(config: CloudConfig): CommandSpec[] {
  return resolveInstallOrder(config).map(buildRecordCommand);
}
