/**
 * @file
 * A pretend cluster, held in memory, for working on Meteorologist
 * without one.
 *
 * It holds a few namespaces and applications chosen to show every
 * state the pages have to draw: an application that's healthy, one
 * mid-migration, one blocked because its namespace can't have buckets,
 * one Cirrus hasn't looked at yet. A namespace has a Postgres that's
 * up, another one still starting, and a third a quota too small for
 * one. The office applications are a few of the installer's records,
 * with one of each kind of administrator: a password to show, one
 * the viewer isn't allowed to see, and one nobody was made. Changes
 * made through the pages
 * stick until the server restarts, so the forms can be tried end to
 * end. Nothing here ever reaches a real API server.
 *
 * The store hangs off globalThis so it survives Next reloading this
 * module in development.
 */
import { getCapability } from "../capabilities";
import type { NodeUsage } from "../cluster";
import { DNS_API_VERSION, DNS_KIND, DNS_NAMESPACE, type DnsProvider } from "../dns/types";
import { CONNECTION_LABEL, URL_ANNOTATION } from "../gitlab/connections";
import { RECORD_KEY, RECORD_LABEL, RECORD_NAMESPACE, type PackageRecord } from "../office";
import { parseQuantity } from "../quantity";
import type { Bucket, S3CredentialsSummary, S3Identity } from "../storage/types";
import { API_VERSION, GROUP, KIND, PLURAL, type WebApplication } from "../webapp/types";
import { KubeError, type KubeClient } from "./client";
import type {
  Certificate,
  Condition,
  ConfigMap,
  LimitRange,
  Namespace,
  PostgresCluster,
  ResourceQuota,
  ServiceAccount,
  Workload,
} from "./types";

interface FixtureStore {
  namespaces: Map<string, Namespace>;
  webapps: Map<string, WebApplication>;
  // By namespace/name
  secrets: Map<string, FixtureSecret>;
  dnsProviders: Map<string, DnsProvider>;
  quotas: Map<string, ResourceQuota>;
  limitRanges: Map<string, LimitRange>;
  serviceAccounts: Map<string, ServiceAccount>;
  postgres: Map<string, PostgresCluster>;
  certificates: Map<string, Certificate>;
  configMaps: Map<string, ConfigMap>;
  buckets: Map<string, Bucket>;
  s3Identities: S3Identity[];
  s3Credentials: S3CredentialsSummary[];
  workloads: Map<string, Workload>;
  regions: string[];
  version: number;
}

/**
 * A Secret, as far as the pretend cluster keeps one.
 */
interface FixtureSecret {
  type: string;
  data: Record<string, string>;
  labels?: Record<string, string>;
  annotations?: Record<string, string>;
  creationTimestamp: string;
  // Refused to whoever asks, as RBAC would refuse someone who isn't a
  // cluster admin
  forbidden?: boolean;
}

// How often a watch looks for changes
const WATCH_INTERVAL_MS = 500;

// When the fixtures were "made", so ages on the page look plausible
const CREATED = "2026-10-01T09:00:00Z";

/**
 * A namespace with the given labels.
 *
 * @param name
 * @param labels
 * @returns
 */
function namespace(
  name: string,
  labels: Record<string, string> = {},
  annotations: Record<string, string> = {},
): Namespace {
  return {
    metadata: {
      name,
      labels: { "kubernetes.io/metadata.name": name, ...labels },
      annotations,
      creationTimestamp: CREATED,
    },
    status: { phase: "Active" },
  };
}

/**
 * The Postgres Cirrus would have made in a namespace.
 *
 * @param namespaceName
 * @param phase
 * @param ready
 * @returns
 */
function postgres(namespaceName: string, phase: string, ready: number): PostgresCluster {
  return {
    metadata: { name: "cirrus-postgres", namespace: namespaceName, creationTimestamp: CREATED },
    spec: { instances: 1, storage: { size: "20Gi", storageClass: "cc-local-ssd-fast" } },
    status: { phase, instances: 1, readyInstances: ready },
  };
}

/**
 * The Certificate cert-manager would have made for an application.
 *
 * @param namespaceName
 * @param app
 * @param condition how it's going
 * @returns
 */
function certificate(namespaceName: string, app: string, condition: Condition): Certificate {
  return {
    metadata: { name: `${app}-tls`, namespace: namespaceName, creationTimestamp: CREATED },
    spec: { secretName: `${app}-tls`, issuerRef: { kind: "ClusterIssuer", name: "cc-lets-encrypt" } },
    status: {
      conditions: [condition],
      ...(condition.type === "Ready" ? { notAfter: "2099-01-01T00:00:00Z", renewalTime: "2098-12-02T00:00:00Z" } : {}),
    },
  };
}

/**
 * A node as its kubelet would report it.
 *
 * @param name
 * @param cores its capacity
 * @param memory GiB of capacity
 * @param usedCores
 * @param usedMemory GiB in use
 * @returns
 */
function fixtureNode(name: string, cores: number, memory: number, usedCores: number, usedMemory: number): NodeUsage {
  return {
    name,
    cpuCores: cores,
    memoryBytes: memory * 2 ** 30,
    summary: {
      cpu: { usageNanoCores: usedCores * 1e9 },
      memory: { rssBytes: usedMemory * 2 ** 30 },
      network: { interfaces: [{ name: "defined1", rxBytes: cores * 61 * 2 ** 30, txBytes: cores * 23 * 2 ** 30 }] },
    },
  };
}

/**
 * The labels that turn a capability on.
 *
 * @param ids
 * @returns
 */
function capabilityLabels(...ids: Array<"gateway" | "buckets">): Record<string, string> {
  return Object.fromEntries(ids.map((id) => [getCapability(id).label, getCapability(id).value]));
}

/**
 * One of the installer's package records, as it writes them.
 *
 * @param record
 * @returns
 */
function packageRecord(record: Omit<PackageRecord, "description"> & { description?: string }): ConfigMap {
  const { chartVersion, ...rest } = record;
  return {
    metadata: {
      name: `cc-package-${record.name}`,
      namespace: RECORD_NAMESPACE,
      labels: { [RECORD_LABEL]: record.name },
    },
    data: {
      [RECORD_KEY]: JSON.stringify({
        version: 1,
        description: "",
        ...rest,
        ...(chartVersion !== undefined ? { chart: { version: chartVersion } } : {}),
        installer: "1.0.0",
      }),
    },
  };
}

/**
 * A workload with so many replicas ready.
 *
 * @param kind
 * @param name
 * @param ready
 * @param desired
 * @returns
 */
function workload(kind: Workload["kind"], name: string, ready: number, desired = 1): Workload {
  return { kind, name, namespace: "cc-office", ready, desired };
}

/**
 * A Bucket as SeaweedFS's operator would have it, Ready and counted
 * unless told otherwise.
 *
 * @param namespace
 * @param name
 * @param parts
 * @param parts.labels
 * @param parts.ownerReferences
 * @param parts.spec
 * @param parts.status
 * @returns
 */
function fixtureBucket(
  namespace: string,
  name: string,
  parts: {
    labels?: Record<string, string>;
    ownerReferences?: Bucket["metadata"]["ownerReferences"];
    spec?: Partial<Bucket["spec"]>;
    status?: Bucket["status"];
  },
): Bucket {
  const spec: Bucket["spec"] = {
    clusterRef: { name: "seaweed", namespace: "seaweedfs" },
    anonymousRead: false,
    objectLock: false,
    reclaimPolicy: "Retain",
    versioning: "Off",
    ...parts.spec,
  };
  const quota = spec.quota?.size === undefined ? undefined : parseQuantity(String(spec.quota.size));
  return {
    apiVersion: "seaweed.seaweedfs.com/v1",
    kind: "Bucket",
    metadata: {
      name,
      namespace,
      generation: 1,
      resourceVersion: "1",
      creationTimestamp: CREATED,
      labels: parts.labels,
      ownerReferences: parts.ownerReferences,
    },
    spec,
    status: {
      bucketName: spec.name ?? name,
      phase: "Ready",
      versioning: spec.versioning,
      objectLockEnabled: spec.objectLock,
      observedGeneration: 1,
      conditions: [{ type: "Ready", status: "True", reason: "Reconciled", lastTransitionTime: CREATED }],
      ...(quota === undefined ? {} : { quota: { enforced: spec.quota?.enforce ?? true, sizeBytes: quota } }),
      ...parts.status,
      usage: parts.status?.usage ? { lastUpdated: CREATED, ...parts.status.usage } : undefined,
    },
  };
}

/**
 * An S3Identity as SeaweedFS's operator would have it: Ready, its user
 * named for the resource unless it says otherwise.
 *
 * @param namespace
 * @param name
 * @param parts
 * @param parts.labels
 * @param parts.ownerReferences
 * @param parts.spec
 * @returns
 */
function fixtureIdentity(
  namespace: string,
  name: string,
  parts: {
    labels?: Record<string, string>;
    ownerReferences?: S3Identity["metadata"]["ownerReferences"];
    spec?: Partial<S3Identity["spec"]>;
  } = {},
): S3Identity {
  const spec: S3Identity["spec"] = {
    seaweedRef: { name: "seaweed", namespace: "seaweedfs" },
    disabled: false,
    reclaimPolicy: "Delete",
    ...parts.spec,
  };
  return {
    apiVersion: "seaweed.seaweedfs.com/v1",
    kind: "S3Identity",
    metadata: {
      name,
      namespace,
      generation: 1,
      resourceVersion: "1",
      creationTimestamp: CREATED,
      labels: parts.labels,
      ownerReferences: parts.ownerReferences,
    },
    spec,
    status: {
      identityName: spec.name ?? name,
      phase: "Ready",
      observedGeneration: 1,
      conditions: [{ type: "Ready", status: "True", reason: "Reconciled", lastTransitionTime: CREATED }],
    },
  };
}

/**
 * A key pair as SeaweedFS's operator would report it: Ready, with an
 * access key's ID. Made-up IDs, nothing real.
 *
 * @param namespace
 * @param name
 * @param identity
 * @param secretName
 * @param accessKey
 * @returns
 */
function fixtureCredentials(
  namespace: string,
  name: string,
  identity: string,
  secretName: string,
  accessKey: string,
): S3CredentialsSummary {
  return {
    namespace,
    name,
    identity,
    secretName,
    accessKeyField: "accessKey",
    secretKeyField: "secretKey",
    accessKey,
    phase: "Ready",
    reclaimPolicy: "Delete",
    createdAt: CREATED,
  };
}

/**
 * The cluster as it starts.
 *
 * @returns
 */
function seed(): FixtureStore {
  const namespaces = [
    namespace("cc-office", {
      ...capabilityLabels("gateway", "buckets"),
      "app.kubernetes.io/managed-by": "community-cloud",
    }),
    namespace("team-shop", {
      ...capabilityLabels("gateway"),
      "placement.community-cloud.technology/region": "sea",
      "placement.community-cloud.technology/affinity": "required",
    }),
    namespace("sandbox"),
    namespace("kube-system"),
  ];

  const condition = (type: string, ok: boolean, reason: string, message = "") => ({
    type,
    status: ok ? ("True" as const) : ("False" as const),
    reason,
    message,
    observedGeneration: 1,
    lastTransitionTime: "2026-10-27T08:00:00Z",
  });

  const webapps: WebApplication[] = [
    {
      apiVersion: API_VERSION,
      kind: KIND,
      metadata: { name: "shop", namespace: "team-shop", generation: 1, creationTimestamp: CREATED, uid: "fixture-1" },
      spec: {
        image: { repository: "registry.gitlab.com/acme/shop", tag: "main" },
        replicas: 2,
        port: 3000,
        healthCheck: { path: "/healthz" },
        hostnames: ["shop.example.org"],
        postgres: {},
        env: [
          { name: "NODE_ENV", value: "production" },
          { name: "STRIPE_KEY", valueFrom: { secretKeyRef: { name: "shop-stripe", key: "key" } } },
        ],
        resources: { requests: { cpu: "100m", memory: "256Mi" }, limits: { memory: "512Mi" } },
        migrations: { command: ["npm", "run", "migrate"], timeoutSeconds: 600 },
        source: {
          gitlab: {
            url: "https://gitlab.com",
            project: "acme/shop",
            ref: "main",
            tokenSecret: { name: "shop-gitlab-token", key: "token" },
            imageTag: "{commit_sha}",
          },
        },
      },
      status: {
        observedGeneration: 1,
        conditions: [
          condition("Provisioned", true, "Provisioned"),
          condition("WebhookRegistered", true, "Registered"),
          condition("ReleaseChecked", true, "Checked"),
          condition("RolledOut", true, "RolledOut"),
          condition("Healthy", true, "PodsReady"),
          condition("Ready", true, "Ready"),
        ],
        release: {
          commit: "9f2c1e4b7a",
          tag: "9f2c1e4b7a",
          digest: "sha256:4be2a1c0de",
          repository: "registry.gitlab.com/acme/shop",
        },
        deployedImage: "registry.gitlab.com/acme/shop@sha256:4be2a1c0de",
        url: "https://shop.example.org",
        webhook: { hookId: 4242, url: "https://cirrus.example.org/hooks/gitlab/team-shop/shop" },
        lastChecked: "2026-10-27T08:55:00Z",
      },
    },
    {
      apiVersion: API_VERSION,
      kind: KIND,
      metadata: { name: "plane", namespace: "cc-office", generation: 1, creationTimestamp: CREATED, uid: "fixture-2" },
      spec: {
        // No port: Cirrus reads it from the image
        image: { repository: "makeplane/plane-backend", tag: "v1.2.0" },
        hostnames: ["plane.example.org"],
        postgres: {},
        bucket: { quota: "20Gi" },
        rabbitmq: {},
        migrations: { command: ["./bin/docker-entrypoint-migrator.sh"] },
      },
      status: {
        observedGeneration: 1,
        conditions: [
          condition("Provisioned", true, "Provisioned"),
          condition("RolledOut", false, "Migrating", "running plane-migrate-7c1d for makeplane/plane-backend:v1.2.0"),
          // The old image's pods, still serving while the migration runs
          condition("Healthy", true, "PodsReady"),
          condition("Ready", false, "NotReady"),
        ],
        port: 8000,
        imagePorts: [{ image: "makeplane/plane-backend:v1.2.0", port: 8000 }],
        deployedImage: "makeplane/plane-backend:v1.1.4",
        migrationJob: "plane-migrate-7c1d",
        url: "https://plane.example.org",
      },
    },
    {
      apiVersion: API_VERSION,
      kind: KIND,
      metadata: { name: "files", namespace: "team-shop", generation: 1, creationTimestamp: CREATED, uid: "fixture-3" },
      spec: {
        image: { repository: "ghcr.io/acme/files", tag: "latest" },
        bucket: {},
        volumes: [
          { name: "uploads", mountPath: "/srv/files/uploads", size: "200Gi", type: "hdd" },
          { name: "thumbs", mountPath: "/srv/files/thumbs", size: "10Gi" },
          { name: "scratch", mountPath: "/tmp/scratch", size: "512Mi", type: "ram" },
        ],
      },
      status: {
        observedGeneration: 1,
        conditions: [
          condition(
            "Provisioned",
            false,
            "Blocked",
            "namespace team-shop isn't labelled storage.community-cloud.technology/buckets=true, so it can't have buckets",
          ),
          condition("RolledOut", false, "WaitingForDependencies"),
          condition("Ready", false, "NotReady"),
        ],
      },
    },
    {
      apiVersion: API_VERSION,
      kind: KIND,
      // Rolled out, then one of its pods started crash looping, and its
      // token can't register a webhook: degraded, and polling only
      metadata: { name: "api", namespace: "team-shop", generation: 1, creationTimestamp: CREATED, uid: "fixture-5" },
      spec: {
        image: { repository: "registry.gitlab.com/acme/api", tag: "main" },
        replicas: 2,
        port: 8080,
        source: {
          gitlab: {
            project: "acme/api",
            tokenSecret: { name: "shop-gitlab-token", key: "token" },
            imageTag: "{short_sha}",
          },
        },
      },
      status: {
        observedGeneration: 1,
        conditions: [
          condition("Provisioned", true, "Provisioned"),
          condition(
            "WebhookRegistered",
            false,
            "NotRegistered",
            "forge: saving the webhook on acme/api was refused (403 Forbidden): the token's scope allows it, but its user doesn't: it needs the Maintainer role on the project, or above. GitLab said: 403 Forbidden",
          ),
          condition("ReleaseChecked", true, "Checked"),
          condition("RolledOut", true, "RolledOut"),
          condition(
            "Healthy",
            false,
            "PodsDegraded",
            "1 of 2 pods ready. api-5d8f7c9b4-x2kqp: CrashLoopBackOff (last OOMKilled, exit code 137)",
          ),
          condition("Ready", true, "Ready"),
        ],
        release: {
          commit: "c41e9a02",
          tag: "c41e9a02",
          digest: "sha256:91ab77e0f3",
          repository: "registry.gitlab.com/acme/api",
        },
        deployedImage: "registry.gitlab.com/acme/api@sha256:91ab77e0f3",
        port: 8080,
        lastChecked: "2026-10-27T08:50:00Z",
      },
    },
    {
      apiVersion: API_VERSION,
      kind: KIND,
      metadata: { name: "notes", namespace: "sandbox", generation: 1, creationTimestamp: CREATED, uid: "fixture-4" },
      spec: { image: { repository: "ghcr.io/acme/notes", tag: "0.1.0" } },
    },
  ];

  return {
    namespaces: new Map(namespaces.map((ns) => [ns.metadata.name, ns])),
    webapps: new Map(webapps.map((app) => [key(app.metadata.namespace ?? "", app.metadata.name), app])),
    secrets: new Map<string, FixtureSecret>([
      [
        "cc-office/methods-s3",
        {
          type: "Opaque",
          data: { accessKey: "FXMETHODS00000000001", secretKey: "fixture-secret-for-methods" },
          creationTimestamp: CREATED,
        },
      ],
      [
        "team-shop/shop-gitlab-token",
        {
          type: "Opaque",
          data: { token: "glpat-fixture" },
          labels: { [CONNECTION_LABEL]: "true" },
          annotations: { [URL_ANNOTATION]: "https://gitlab.com" },
          creationTimestamp: CREATED,
        },
      ],
      [
        "team-shop/pull-registry-gitlab-com",
        {
          type: "kubernetes.io/dockerconfigjson",
          // Made by hand, so without Meteorologist's annotation: the
          // form has to read the registry out of it
          data: { ".dockerconfigjson": JSON.stringify({ auths: { "https://registry.gitlab.com": {} } }) },
          creationTimestamp: CREATED,
        },
      ],
      [
        `${DNS_NAMESPACE}/cirrus-dns-acme`,
        { type: "Opaque", data: { CF_API_TOKEN: "fixture" }, creationTimestamp: CREATED },
      ],
      [
        "cc-office/projectsend-admin",
        {
          type: "kubernetes.io/basic-auth",
          data: { username: "fixture", password: "correct horse battery staple" },
          creationTimestamp: CREATED,
        },
      ],
      [
        "cc-office/plane-admin",
        {
          type: "kubernetes.io/basic-auth",
          data: { username: "fixture", password: "never shown" },
          creationTimestamp: CREATED,
          forbidden: true,
        },
      ],
      [
        "cc-office/picoclaw-launcher",
        {
          type: "kubernetes.io/basic-auth",
          data: { username: "fixture", password: "pc-fixture-token" },
          creationTimestamp: CREATED,
        },
      ],
    ]),
    dnsProviders: new Map([
      [
        "acme",
        {
          apiVersion: DNS_API_VERSION,
          kind: DNS_KIND,
          metadata: { name: "acme", generation: 1, creationTimestamp: CREATED },
          spec: {
            provider: "cloudflare",
            domains: ["example.org"],
            namespaces: ["cc-office", "team-shop"],
            credentialsSecret: "cirrus-dns-acme",
            policy: "sync",
          },
          status: {
            observedGeneration: 1,
            conditions: [condition("Ready", true, "Ready")],
            instances: [
              { namespace: "cc-office", deployment: "cirrus-dns-acme-cc-office", ready: true },
              { namespace: "team-shop", deployment: "cirrus-dns-acme-team-shop", ready: true },
            ],
          },
        },
      ],
    ]),
    quotas: new Map([
      [
        "sandbox/community-cloud",
        {
          metadata: { name: "community-cloud", namespace: "sandbox" },
          spec: { hard: { "requests.cpu": "1", "limits.memory": "2Gi", "requests.storage": "10Gi" } },
          status: {
            hard: { "requests.cpu": "1", "limits.memory": "2Gi", "requests.storage": "10Gi" },
            used: { "requests.cpu": "100m", "limits.memory": "256Mi", "requests.storage": "0" },
          },
        },
      ],
    ]),
    limitRanges: new Map([
      [
        "sandbox/community-cloud",
        {
          metadata: { name: "community-cloud", namespace: "sandbox" },
          spec: {
            limits: [
              {
                type: "Container",
                default: { memory: "512Mi" },
                defaultRequest: { cpu: "100m", memory: "128Mi" },
              },
            ],
          },
        },
      ],
    ]),
    serviceAccounts: new Map(
      namespaces.map((ns) => [
        key(ns.metadata.name, "default"),
        {
          metadata: { name: "default", namespace: ns.metadata.name },
          ...(ns.metadata.name === "team-shop" ? { imagePullSecrets: [{ name: "pull-registry-gitlab-com" }] } : {}),
        },
      ]),
    ),
    postgres: new Map([
      ["team-shop/cirrus-postgres", postgres("team-shop", "Cluster in healthy state", 1)],
      ["cc-office/cirrus-postgres", postgres("cc-office", "Setting up primary", 0)],
    ]),
    certificates: new Map([
      ["team-shop/shop-tls", certificate("team-shop", "shop", { type: "Ready", status: "True", reason: "Ready" })],
      [
        "cc-office/plane-tls",
        certificate("cc-office", "plane", {
          type: "Issuing",
          status: "False",
          reason: "Failed",
          message:
            'The certificate request has failed to complete and will be retried: Failed to wait for order resource "plane-tls-1-1" to become ready: order is in "invalid" state',
        }),
      ],
    ]),
    configMaps: new Map(
      [
        packageRecord({
          name: "authentik",
          namespace: "cc-office",
          chartVersion: "2026.5.3",
          rollout: [],
          updated: CREATED,
          app: {
            title: "Authentik",
            url: "https://auth.example.test/",
            signIn: "own",
            admin: {
              how: "The administrator, akadmin, is given a password on Authentik's initial setup page, /if/flow/initial-setup/, the first time it's opened. Anyone in the authentik Admins group administers it too.",
            },
          },
        }),
        packageRecord({
          name: "projectsend",
          namespace: "cc-office",
          rollout: ["statefulset/redis", "deployment/projectsend"],
          updated: CREATED,
          app: {
            title: "ProjectSend",
            url: "https://files.example.test/",
            signIn: "authentik",
            admin: {
              secret: { namespace: "cc-office", name: "projectsend-admin", key: "password" },
              login: "admin@example.test",
            },
            note: "The administrator can also sign in through Authentik, with an Authentik account that has the same address.",
          },
        }),
        packageRecord({
          name: "plane",
          namespace: "cc-office",
          rollout: ["deployment/plane-web", "deployment/plane-api"],
          updated: CREATED,
          app: {
            title: "Plane",
            url: "https://plane.example.test/",
            signIn: "own",
            admin: {
              secret: { namespace: "cc-office", name: "plane-admin", key: "password" },
              login: "admin@example.test",
            },
            note: "The instance's own settings are at /god-mode/, for the same account.",
          },
        }),
        packageRecord({
          name: "twenty",
          namespace: "cc-office",
          rollout: ["deployment/twenty-server", "deployment/twenty-worker"],
          updated: CREATED,
          app: {
            title: "Twenty",
            url: "https://crm.example.test/",
            signIn: "own",
            admin: {
              how: "The first person to sign up makes the workspace, and administers it. They invite everyone else from its settings.",
            },
          },
        }),
        packageRecord({
          name: "picoclaw",
          namespace: "cc-office",
          rollout: ["deployment/picoclaw", "deployment/picoclaw-gate"],
          updated: CREATED,
          app: {
            title: "Picoclaw",
            url: "https://agent.example.test/",
            signIn: "gate",
            admin: { secret: { namespace: "cc-office", name: "picoclaw-launcher", key: "password" } },
          },
        }),
        // Not an application, so not on the Office page
        packageRecord({ name: "cert-manager", namespace: "cert-manager", chartVersion: "v1.19.1", rollout: [] }),
      ].map((each) => [key(RECORD_NAMESPACE, each.metadata.name), each]),
    ),
    buckets: new Map(
      [
        fixtureBucket("cc-office", "authentik", {
          labels: { "app.kubernetes.io/managed-by": "community-cloud" },
          spec: {
            access: [{ user: "authentik", actions: ["Read", "Write", "List", "Tagging"] }],
            quota: { size: "20Gi", enforce: true },
            anonymousRead: true,
          },
          status: { usage: { sizeBytes: 563160, objectCount: 41 } },
        }),
        fixtureBucket("cc-office", "methods", {
          labels: { "app.kubernetes.io/managed-by": "community-cloud" },
          spec: {
            access: [{ user: "methods", actions: ["Read", "Write", "List", "Tagging"] }],
            quota: { size: "20Gi", enforce: true },
          },
          status: { usage: { sizeBytes: 4975208, objectCount: 230 } },
        }),
        fixtureBucket("cc-office", "cc-office-plane", {
          ownerReferences: [
            { apiVersion: "community-cloud.technology/v1alpha1", kind: "WebApplication", name: "plane" },
          ],
          spec: {
            name: "cc-office-plane",
            access: [{ user: "cc-office-plane", actions: ["Read", "Write", "List", "Tagging"] }],
            quota: { size: "20Gi", enforce: true },
          },
          status: { usage: { sizeBytes: 15.2 * 1024 ** 3, objectCount: 18210 } },
        }),
        fixtureBucket("cc-office", "archive", {
          spec: {
            name: "cc-office-archive",
            access: [{ user: "reporting", actions: ["Read", "List"] }],
            versioning: "Enabled",
            objectLock: true,
            reclaimPolicy: "Retain",
            placement: { replication: "001" },
          },
          status: {
            phase: "Failed",
            conditions: [
              {
                type: "Ready",
                status: "False",
                reason: "CreateFailed",
                message: "object lock needs a bucket made with it from the start",
                lastTransitionTime: CREATED,
              },
            ],
          },
        }),
        fixtureBucket("seaweedfs", "toadbase", {
          spec: { access: [{ user: "anvAdmin", actions: ["Admin"] }] },
          status: { usage: { sizeBytes: 5433028304, objectCount: 1204 } },
        }),
      ].map((each) => [key(each.metadata.namespace ?? "", each.metadata.name), each]),
    ),
    s3Identities: [
      fixtureIdentity("cc-office", "authentik", { labels: { "app.kubernetes.io/managed-by": "community-cloud" } }),
      fixtureIdentity("cc-office", "methods", { labels: { "app.kubernetes.io/managed-by": "community-cloud" } }),
      fixtureIdentity("cc-office", "cc-office-plane", {
        ownerReferences: [{ apiVersion: "community-cloud.technology/v1alpha1", kind: "WebApplication", name: "plane" }],
      }),
      fixtureIdentity("cc-office", "reporting", {
        spec: { account: { displayName: "Reporting jobs", email: "ops@example.test" } },
      }),
      fixtureIdentity("seaweedfs", "anvadmin", { spec: { name: "anvAdmin" } }),
      fixtureIdentity("seaweedfs", "old-backups", { spec: { disabled: true } }),
    ],
    s3Credentials: [
      fixtureCredentials("cc-office", "authentik", "authentik", "authentik-s3", "FXAUTHENTIK000000001"),
      fixtureCredentials("cc-office", "methods", "methods", "methods-s3", "FXMETHODS00000000001"),
      fixtureCredentials("cc-office", "cc-office-plane", "cc-office-plane", "plane-s3", "FXPLANE000000000001"),
      {
        ...fixtureCredentials("seaweedfs", "anvadmin", "anvadmin", "seaweedfs-legacy-anvadmin", "FXANVADMIN000000001"),
        secretNamespace: "community-cloud",
        reclaimPolicy: "Retain",
      },
    ],
    workloads: new Map(
      [
        workload("statefulset", "redis", 1),
        workload("deployment", "projectsend", 1),
        workload("deployment", "plane-web", 1),
        workload("deployment", "plane-api", 1, 2),
        workload("deployment", "twenty-server", 1),
        workload("deployment", "twenty-worker", 1),
        workload("deployment", "picoclaw", 0),
        workload("deployment", "picoclaw-gate", 1),
      ].map((each) => [key(each.namespace, `${each.kind}/${each.name}`), each]),
    ),
    regions: ["fra", "sea"],
    version: 100,
  };
}

/**
 * How an application is filed in the store.
 *
 * @param namespace
 * @param name
 * @returns
 */
function key(namespace: string, name: string): string {
  return `${namespace}/${name}`;
}

/**
 * Labels or annotations with a merge patch applied: null removes.
 *
 * @param current
 * @param patch
 * @returns
 */
function merged(
  current: Record<string, string> | undefined,
  patch: Record<string, string | null>,
): Record<string, string> {
  const result = { ...current };
  for (const [name, value] of Object.entries(patch)) {
    if (value === null) {
      delete result[name];
    } else {
      result[name] = value;
    }
  }
  return result;
}

/**
 * What's in one namespace of a store map, or in all of them.
 *
 * @param map
 * @param namespace
 * @returns
 */
function inNamespace<T extends { metadata: { namespace?: string } }>(map: Map<string, T>, namespace?: string): T[] {
  return [...map.values()].filter((item) => namespace === undefined || item.metadata.namespace === namespace);
}

/**
 * The store, made on first use.
 *
 * @returns
 */
function store(): FixtureStore {
  const holder = globalThis as typeof globalThis & { __meteorologistFixtures?: FixtureStore };
  // A store from before this module last changed shape is started
  // again rather than read half-formed
  if (holder.__meteorologistFixtures?.buckets === undefined) {
    holder.__meteorologistFixtures = seed();
  }
  return holder.__meteorologistFixtures;
}

/**
 * Now, as the API server writes times.
 *
 * @returns
 */
function now(): string {
  return new Date().toISOString().replace(/\.\d+Z$/, "Z");
}

/**
 * A copy, so callers can't change the store by changing what they got.
 *
 * @param value
 * @returns
 */
function copy<T>(value: T): T {
  return structuredClone(value);
}

/**
 * A namespace from the store, or the 404 the API server would give.
 *
 * @param name
 * @returns
 */
function requireNamespace(name: string): Namespace {
  const found = store().namespaces.get(name);
  if (found === undefined) {
    throw new KubeError(404, `namespaces "${name}" not found`, "NotFound");
  }
  return found;
}

/**
 * The client as someone would have it who's been given the "edit" role
 * in some namespaces and nothing else: the shape of what RBAC lets
 * them do, including the 403s for anything cluster-wide.
 *
 * @param client
 * @param allowed the namespaces they have access to
 * @returns
 */
export function limitedToNamespaces(client: KubeClient, allowed: string[]): KubeClient {
  const refuse = (resource: string, namespace?: string): never => {
    const where = namespace === undefined ? "at the cluster scope" : `in the namespace "${namespace}"`;
    throw new KubeError(403, `${resource} is forbidden: User "fixture" cannot do that ${where}`, "Forbidden");
  };
  const within = (resource: string, namespace: string | undefined) => {
    if (namespace === undefined || !allowed.includes(namespace)) {
      refuse(resource, namespace);
    }
  };
  // A read that takes an optional namespace, refused without one
  const scoped =
    <T>(resource: string, read: (namespace?: string) => Promise<T>) =>
    async (namespace?: string) => {
      within(resource, namespace);
      return read(namespace);
    };

  return {
    ...client,
    canI: async ({ verb, resource, group, namespace }) =>
      namespace !== undefined &&
      allowed.includes(namespace) &&
      // What the "edit" role has, as Cirrus's aggregated roles extend it
      (resource === "secrets" || (group === GROUP && resource === PLURAL)) &&
      verb !== "impersonate",
    listNamespaces: async () => refuse("namespaces"),
    getNamespace: async (name) => {
      within("namespaces", name);
      return client.getNamespace(name);
    },
    patchNamespaceLabels: async (name) => refuse("namespaces", name),
    patchNamespaceAnnotations: async (name) => refuse("namespaces", name),
    createNamespace: async () => refuse("namespaces"),
    listRegions: async () => refuse("nodes"),
    getClusterUsage: async () => refuse("nodes"),
    listDnsProviders: async () => refuse("dnsproviders"),
    applyResourceQuota: async (quota) => refuse("resourcequotas", quota.metadata.namespace),
    applyLimitRange: async (limitRange) => refuse("limitranges", limitRange.metadata.namespace),
    listResourceQuotas: scoped("resourcequotas", client.listResourceQuotas),
    listPostgresClusters: scoped("clusters", client.listPostgresClusters),
    listCertificates: scoped("certificates", client.listCertificates),
    listWebApplications: scoped("webapplications", client.listWebApplications),
    listConfigMaps: async (namespace, labelSelector) => {
      within("configmaps", namespace);
      return client.listConfigMaps(namespace, labelSelector);
    },
    getConfigMap: async (namespace, name) => {
      within("configmaps", namespace);
      return client.getConfigMap(namespace, name);
    },
    saveConfigMap: async (configMap) => {
      within("configmaps", configMap.metadata.namespace);
      return client.saveConfigMap(configMap);
    },
    listWorkloads: async (namespace) => {
      within("deployments", namespace);
      return client.listWorkloads(namespace);
    },
    listSecrets: async (namespace) => {
      within("secrets", namespace);
      return client.listSecrets(namespace);
    },
    listBuckets: scoped("buckets", client.listBuckets),
    getBucket: async (namespace, name) => {
      within("buckets", namespace);
      return client.getBucket(namespace, name);
    },
    createBucket: async (bucket) => {
      within("buckets", bucket.metadata.namespace);
      return client.createBucket(bucket);
    },
    replaceBucket: async (bucket) => {
      within("buckets", bucket.metadata.namespace);
      return client.replaceBucket(bucket);
    },
    deleteBucket: async (namespace, name) => {
      within("buckets", namespace);
      return client.deleteBucket(namespace, name);
    },
    listS3Identities: scoped("s3identities", client.listS3Identities),
    listS3Credentials: scoped("s3credentials", client.listS3Credentials),
    createS3Credentials: async (credentials) => {
      within("s3credentials", credentials.namespace);
      return client.createS3Credentials(credentials);
    },
    deleteS3Credentials: async (namespace, name) => {
      within("s3credentials", namespace);
      return client.deleteS3Credentials(namespace, name);
    },
    getS3Identity: async (namespace, name) => {
      within("s3identities", namespace);
      return client.getS3Identity(namespace, name);
    },
    createS3Identity: async (identity) => {
      within("s3identities", identity.metadata.namespace);
      return client.createS3Identity(identity);
    },
    replaceS3Identity: async (identity) => {
      within("s3identities", identity.metadata.namespace);
      return client.replaceS3Identity(identity);
    },
    getWebApplication: async (namespace, name) => {
      within("webapplications", namespace);
      return client.getWebApplication(namespace, name);
    },
    createWebApplication: async (app) => {
      within("webapplications", app.metadata.namespace);
      return client.createWebApplication(app);
    },
    watchWebApplications: async (scope, onChange, onEnd) => {
      within("webapplications", scope.namespace);
      return client.watchWebApplications(scope, onChange, onEnd);
    },
  };
}

/**
 * The in-memory client.
 *
 * @returns
 */
export function fixtureClient(): KubeClient {
  return {
    canI: async () => true,

    listNamespaces: async () => copy([...store().namespaces.values()]),

    listNamespaceNames: async () => [...store().namespaces.keys()],

    // Every change through the pages moves the store's version, so
    // that's what's watched. Cirrus isn't here to change anything else.
    watchWebApplications: async ({ namespace, name }, onChange) => {
      const matching = [...store().webapps.values()].filter(
        (app) =>
          (namespace === undefined || app.metadata.namespace === namespace) &&
          (name === undefined || app.metadata.name === name),
      );
      matching.forEach(() => onChange());
      let seen = store().version;
      const timer = setInterval(() => {
        if (store().version !== seen) {
          seen = store().version;
          onChange();
        }
      }, WATCH_INTERVAL_MS);
      return () => clearInterval(timer);
    },

    getNamespace: async (name) => copy(requireNamespace(name)),

    patchNamespaceLabels: async (name, patch) => {
      const ns = requireNamespace(name);
      ns.metadata.labels = merged(ns.metadata.labels, patch);
      return copy(ns);
    },

    listBuckets: async (namespace) =>
      copy(
        [...store().buckets.values()].filter(
          (bucket) => namespace === undefined || bucket.metadata.namespace === namespace,
        ),
      ),

    getBucket: async (namespace, name) => {
      const found = store().buckets.get(key(namespace, name));
      if (found === undefined) {
        throw new KubeError(404, `buckets.seaweed.seaweedfs.com "${name}" not found`, "NotFound");
      }
      return copy(found);
    },

    // As SeaweedFS's operator would leave it a moment later: Ready, with
    // the name and settings it was asked for
    createBucket: async (bucket) => {
      const namespace = bucket.metadata.namespace ?? "";
      requireNamespace(namespace);
      const id = key(namespace, bucket.metadata.name);
      if (store().buckets.has(id)) {
        throw new KubeError(
          409,
          `buckets.seaweed.seaweedfs.com "${bucket.metadata.name}" already exists`,
          "AlreadyExists",
        );
      }
      store().version += 1;
      const created = fixtureBucket(namespace, bucket.metadata.name, {
        labels: bucket.metadata.labels,
        spec: bucket.spec,
      });
      created.metadata.resourceVersion = String(store().version);
      store().buckets.set(id, created);
      return copy(created);
    },

    replaceBucket: async (bucket) => {
      const id = key(bucket.metadata.namespace ?? "", bucket.metadata.name);
      const existing = store().buckets.get(id);
      if (existing === undefined) {
        throw new KubeError(404, `buckets.seaweed.seaweedfs.com "${bucket.metadata.name}" not found`, "NotFound");
      }
      if (bucket.metadata.resourceVersion !== existing.metadata.resourceVersion) {
        throw new KubeError(409, "the object has been modified", "Conflict");
      }
      store().version += 1;
      const quota = bucket.spec.quota?.size === undefined ? undefined : parseQuantity(String(bucket.spec.quota.size));
      const replaced: Bucket = copy({
        ...existing,
        metadata: {
          ...existing.metadata,
          labels: bucket.metadata.labels,
          annotations: bucket.metadata.annotations,
          generation: (existing.metadata.generation ?? 1) + 1,
          resourceVersion: String(store().version),
        },
        spec: bucket.spec,
        status: {
          ...existing.status,
          versioning: bucket.spec.versioning,
          quota: quota === undefined ? undefined : { enforced: bucket.spec.quota?.enforce ?? true, sizeBytes: quota },
        },
      });
      store().buckets.set(id, replaced);
      return copy(replaced);
    },

    deleteBucket: async (namespace, name) => {
      store().buckets.delete(key(namespace, name));
    },

    listS3Identities: async (namespace) =>
      copy(store().s3Identities.filter((each) => namespace === undefined || each.metadata.namespace === namespace)),

    getS3Identity: async (namespace, name) => {
      const found = store().s3Identities.find(
        (each) => each.metadata.namespace === namespace && each.metadata.name === name,
      );
      if (found === undefined) {
        throw new KubeError(404, `s3identities.seaweed.seaweedfs.com "${name}" not found`, "NotFound");
      }
      return copy(found);
    },

    // As SeaweedFS's operator would leave it a moment later: Ready
    createS3Identity: async (identity) => {
      const namespace = identity.metadata.namespace ?? "";
      requireNamespace(namespace);
      if (
        store().s3Identities.some(
          (each) => each.metadata.namespace === namespace && each.metadata.name === identity.metadata.name,
        )
      ) {
        throw new KubeError(
          409,
          `s3identities.seaweed.seaweedfs.com "${identity.metadata.name}" already exists`,
          "AlreadyExists",
        );
      }
      store().version += 1;
      const created = fixtureIdentity(namespace, identity.metadata.name, {
        labels: identity.metadata.labels,
        spec: identity.spec,
      });
      created.metadata.resourceVersion = String(store().version);
      store().s3Identities.push(created);
      return copy(created);
    },

    replaceS3Identity: async (identity) => {
      const at = store().s3Identities.findIndex(
        (each) =>
          each.metadata.namespace === identity.metadata.namespace && each.metadata.name === identity.metadata.name,
      );
      const existing = store().s3Identities[at];
      if (existing === undefined) {
        throw new KubeError(
          404,
          `s3identities.seaweed.seaweedfs.com "${identity.metadata.name}" not found`,
          "NotFound",
        );
      }
      if (identity.metadata.resourceVersion !== existing.metadata.resourceVersion) {
        throw new KubeError(409, "the object has been modified", "Conflict");
      }
      if ((identity.spec.name ?? "") !== (existing.spec.name ?? "") && (existing.spec.name ?? "") !== "") {
        throw new KubeError(422, "spec.name: identity name is immutable once set", "Invalid");
      }
      store().version += 1;
      const replaced: S3Identity = copy({
        ...existing,
        metadata: {
          ...existing.metadata,
          labels: identity.metadata.labels,
          annotations: identity.metadata.annotations,
          generation: (existing.metadata.generation ?? 1) + 1,
          resourceVersion: String(store().version),
        },
        spec: identity.spec,
      });
      store().s3Identities[at] = replaced;
      return copy(replaced);
    },

    listS3Credentials: async (namespace) =>
      copy(store().s3Credentials.filter((each) => namespace === undefined || each.namespace === namespace)),

    // As SeaweedFS's operator would leave it a moment later: Ready, with
    // a made-up key pair in its Secret
    createS3Credentials: async (credentials) => {
      requireNamespace(credentials.namespace);
      if (
        store().s3Credentials.some((each) => each.namespace === credentials.namespace && each.name === credentials.name)
      ) {
        throw new KubeError(
          409,
          `s3credentials.seaweed.seaweedfs.com "${credentials.name}" already exists`,
          "AlreadyExists",
        );
      }
      store().version += 1;
      const accessKey =
        `FX${String(store().version).padStart(4, "0")}${credentials.name.toUpperCase().replace(/[^A-Z0-9]/g, "")}`.slice(
          0,
          20,
        );
      const created: S3CredentialsSummary = {
        ...fixtureCredentials(
          credentials.namespace,
          credentials.name,
          credentials.identity,
          credentials.secretName,
          accessKey,
        ),
        reclaimPolicy: credentials.reclaimPolicy,
        createdAt: now(),
      };
      store().s3Credentials.push(created);
      store().secrets.set(key(credentials.namespace, credentials.secretName), {
        type: "Opaque",
        data: { accessKey, secretKey: `fixture-secret-for-${credentials.name}` },
        creationTimestamp: now(),
      });
      return copy(created);
    },

    deleteS3Credentials: async (namespace, name) => {
      const found = store().s3Credentials.find((each) => each.namespace === namespace && each.name === name);
      store().s3Credentials = store().s3Credentials.filter((each) => each !== found);
      // The Secret is the S3Credentials', so it goes with it
      if (found?.secretName && !found.secretNamespace) {
        store().secrets.delete(key(namespace, found.secretName));
      }
    },

    listWebApplications: async (namespace) =>
      copy(
        [...store().webapps.values()].filter((app) => namespace === undefined || app.metadata.namespace === namespace),
      ),

    getWebApplication: async (namespace, name) => {
      const found = store().webapps.get(key(namespace, name));
      if (found === undefined) {
        throw new KubeError(404, `webapplications "${name}" not found`, "NotFound");
      }
      return copy(found);
    },

    createWebApplication: async (app) => {
      const namespace = app.metadata.namespace ?? "";
      requireNamespace(namespace);
      const id = key(namespace, app.metadata.name);
      if (store().webapps.has(id)) {
        throw new KubeError(409, `webapplications "${app.metadata.name}" already exists`, "AlreadyExists");
      }
      const created: WebApplication = copy({
        ...app,
        metadata: {
          ...app.metadata,
          generation: 1,
          uid: `fixture-${store().version}`,
          resourceVersion: String((store().version += 1)),
          creationTimestamp: new Date().toISOString(),
        },
      });
      delete created.status;
      store().webapps.set(id, created);
      return copy(created);
    },

    replaceWebApplication: async (app) => {
      const id = key(app.metadata.namespace ?? "", app.metadata.name);
      const existing = store().webapps.get(id);
      if (existing === undefined) {
        throw new KubeError(404, `webapplications "${app.metadata.name}" not found`, "NotFound");
      }
      if (
        app.metadata.resourceVersion !== undefined &&
        existing.metadata.resourceVersion !== undefined &&
        app.metadata.resourceVersion !== existing.metadata.resourceVersion
      ) {
        throw new KubeError(409, "the object has been modified", "Conflict");
      }
      const replaced: WebApplication = copy({
        ...app,
        metadata: {
          ...existing.metadata,
          labels: app.metadata.labels,
          annotations: app.metadata.annotations,
          generation: (existing.metadata.generation ?? 1) + 1,
          resourceVersion: String((store().version += 1)),
        },
        status: existing.status,
      });
      store().webapps.set(id, replaced);
      return copy(replaced);
    },

    // Gone at once, as if Cirrus had already cleaned up
    deleteWebApplication: async (namespace, name) => {
      store().webapps.delete(key(namespace, name));
    },

    createSecret: async (namespace, name, data, labels, type = "Opaque", annotations) => {
      requireNamespace(namespace);
      const id = key(namespace, name);
      if (store().secrets.has(id)) {
        throw new KubeError(409, `secrets "${name}" already exists`, "AlreadyExists");
      }
      store().secrets.set(id, { type, data: { ...data }, labels, annotations, creationTimestamp: now() });
    },

    applySecret: async (namespace, name, data, labels, annotations) => {
      if (namespace !== DNS_NAMESPACE) {
        requireNamespace(namespace);
      }
      const id = key(namespace, name);
      const existing = store().secrets.get(id);
      store().secrets.set(id, {
        type: existing?.type ?? "Opaque",
        data: { ...existing?.data, ...data },
        labels: { ...existing?.labels, ...labels },
        annotations: { ...existing?.annotations, ...annotations },
        creationTimestamp: existing?.creationTimestamp ?? now(),
      });
    },

    readSecretValue: async (namespace, name, secretKey) => {
      const secret = store().secrets.get(key(namespace, name));
      if (secret?.forbidden === true) {
        throw new KubeError(
          403,
          `secrets "${name}" is forbidden: User "fixture" cannot get resource "secrets" in API group "" in the namespace "${namespace}"`,
          "Forbidden",
        );
      }
      return secret?.data[secretKey];
    },

    deleteSecret: async (namespace, name) => {
      store().secrets.delete(key(namespace, name));
    },

    listDnsProviders: async () => copy([...store().dnsProviders.values()]),

    applyDnsProvider: async (provider) => {
      const existing = store().dnsProviders.get(provider.metadata.name);
      const generation = (existing?.metadata.generation ?? 0) + 1;
      const namespaces = provider.spec.namespaces ?? [];
      // As Cirrus would report it, straight away
      store().dnsProviders.set(
        provider.metadata.name,
        copy({
          ...provider,
          metadata: {
            ...existing?.metadata,
            ...provider.metadata,
            generation,
            creationTimestamp: existing?.metadata.creationTimestamp ?? now(),
          },
          spec: { ...existing?.spec, ...provider.spec },
          status: {
            observedGeneration: generation,
            conditions: [
              {
                type: "Ready",
                status: "True",
                reason: "Ready",
                observedGeneration: generation,
                lastTransitionTime: now(),
              },
            ],
            instances: namespaces.map((namespace) => ({
              namespace,
              deployment: `cirrus-dns-${provider.metadata.name}-${namespace}`,
              ready: true,
            })),
          },
        }),
      );
    },

    deleteDnsProvider: async (name) => {
      store().dnsProviders.delete(name);
    },

    patchNamespaceAnnotations: async (name, patch) => {
      const ns = requireNamespace(name);
      ns.metadata.annotations = merged(ns.metadata.annotations, patch);
      return copy(ns);
    },

    createNamespace: async (name, labels, annotations) => {
      if (store().namespaces.has(name)) {
        throw new KubeError(409, `namespaces "${name}" already exists`, "AlreadyExists");
      }
      const created = namespace(name, labels, annotations);
      created.metadata.creationTimestamp = new Date().toISOString();
      store().namespaces.set(name, created);
      // What Kubernetes makes in every namespace, moments later
      store().serviceAccounts.set(key(name, "default"), { metadata: { name: "default", namespace: name } });
      return copy(created);
    },

    whoAmI: async () => ({ username: "fixtures", groups: [] }),

    listRegions: async () => [...store().regions],

    getClusterUsage: async () => ({
      nodes: [fixtureNode("fra-1", 16, 64, 5.2, 38), fixtureNode("sea-1", 8, 32, 1.4, 11)],
      podPhases: [...Array.from({ length: 61 }, () => "Running"), "Succeeded", "Succeeded", "Failed"],
    }),

    listResourceQuotas: async (namespace) => copy(inNamespace(store().quotas, namespace)),

    applyResourceQuota: async (quota) => {
      const namespace = quota.metadata.namespace ?? "";
      requireNamespace(namespace);
      const id = key(namespace, quota.metadata.name);
      const used = store().quotas.get(id)?.status?.used ?? {};
      store().quotas.set(id, copy({ ...quota, status: { hard: quota.spec?.hard, used } }));
    },

    deleteResourceQuota: async (namespace, name) => {
      store().quotas.delete(key(namespace, name));
    },

    getLimitRange: async (namespace, name) => copy(store().limitRanges.get(key(namespace, name))),

    applyLimitRange: async (limitRange) => {
      const namespace = limitRange.metadata.namespace ?? "";
      requireNamespace(namespace);
      store().limitRanges.set(key(namespace, limitRange.metadata.name), copy(limitRange));
    },

    deleteLimitRange: async (namespace, name) => {
      store().limitRanges.delete(key(namespace, name));
    },

    getServiceAccount: async (namespace, name) => copy(store().serviceAccounts.get(key(namespace, name))),

    setImagePullSecrets: async (namespace, name, secrets) => {
      requireNamespace(namespace);
      store().serviceAccounts.set(key(namespace, name), {
        metadata: { name, namespace },
        imagePullSecrets: secrets.map((secret) => ({ name: secret })),
      });
    },

    listSecrets: async (namespace) =>
      [...store().secrets.entries()]
        .filter(([id]) => id.startsWith(`${namespace}/`))
        .map(([id, secret]) => ({
          name: id.slice(namespace.length + 1),
          type: secret.type,
          labels: secret.labels,
          annotations: secret.annotations,
          creationTimestamp: secret.creationTimestamp,
        })),

    listPostgresClusters: async (namespace) => copy(inNamespace(store().postgres, namespace)),

    listCertificates: async (namespace) => copy(inNamespace(store().certificates, namespace)),

    getConfigMap: async (namespace, name) => copy(store().configMaps.get(key(namespace, name))),

    saveConfigMap: async (configMap) => {
      const namespace = configMap.metadata.namespace ?? "";
      requireNamespace(namespace);
      const id = key(namespace, configMap.metadata.name);
      const existing = store().configMaps.get(id);
      if (
        configMap.metadata.resourceVersion === undefined
          ? existing !== undefined
          : existing?.metadata.resourceVersion !== configMap.metadata.resourceVersion
      ) {
        throw new KubeError(
          409,
          existing === undefined
            ? `configmaps "${configMap.metadata.name}" not found`
            : `Operation cannot be fulfilled on configmaps "${configMap.metadata.name}": the object has been modified`,
          "Conflict",
        );
      }
      store().version += 1;
      store().configMaps.set(
        id,
        copy({ ...configMap, metadata: { ...configMap.metadata, resourceVersion: String(store().version) } }),
      );
    },

    listConfigMaps: async (namespace, labelSelector) =>
      copy(
        inNamespace(store().configMaps, namespace).filter(
          // Only "label" and "label=value" selectors, which is all this
          // app asks with
          (each) => {
            const [label = "", value] = labelSelector.split("=");
            const found = each.metadata.labels?.[label];
            return value === undefined ? found !== undefined : found === value;
          },
        ),
      ),

    listWorkloads: async (namespace) =>
      copy([...store().workloads.values()].filter((each) => each.namespace === namespace)),
  };
}
