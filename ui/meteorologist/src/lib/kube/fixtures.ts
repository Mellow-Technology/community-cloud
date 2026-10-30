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
import { API_VERSION, KIND, type WebApplication } from "../webapp/types";
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
    namespace("team-shop", capabilityLabels("gateway"), {
      "scheduler.alpha.kubernetes.io/node-selector": "topology.kubernetes.io/region=sea",
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
          condition("RolledOut", true, "RolledOut"),
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
        image: { repository: "makeplane/plane-backend", tag: "v1.2.0" },
        port: 8000,
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
          condition("Ready", false, "NotReady"),
        ],
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
      metadata: { name: "notes", namespace: "sandbox", generation: 1, creationTimestamp: CREATED, uid: "fixture-4" },
      spec: { image: { repository: "ghcr.io/acme/notes", tag: "0.1.0" } },
    },
  ];

  return {
    namespaces: new Map(namespaces.map((ns) => [ns.metadata.name, ns])),
    webapps: new Map(webapps.map((app) => [key(app.metadata.namespace ?? "", app.metadata.name), app])),
    secrets: new Map<string, FixtureSecret>([
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
        { type: "kubernetes.io/dockerconfigjson", data: {}, creationTimestamp: CREATED },
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
  if (holder.__meteorologistFixtures?.configMaps === undefined) {
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
 * The in-memory client.
 *
 * @returns
 */
export function fixtureClient(): KubeClient {
  return {
    listNamespaces: async () => copy([...store().namespaces.values()]),

    getNamespace: async (name) => copy(requireNamespace(name)),

    patchNamespaceLabels: async (name, patch) => {
      const ns = requireNamespace(name);
      ns.metadata.labels = merged(ns.metadata.labels, patch);
      return copy(ns);
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
