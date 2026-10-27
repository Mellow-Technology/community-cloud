/**
 * @file
 * What can be installed into a cluster, and what each thing needs
 * first.
 *
 * There are two halves to this and they belong in different places.
 * What a package *is* — which chart, from which repository, into which
 * namespace, and what has to exist before it — is a property of the
 * software and lives here. Which packages a particular cluster wants,
 * and any versions or values it pins, is a property of that cluster
 * and lives in its configuration.
 *
 * The dependencies are the reason this file exists rather than a flat
 * list. Community Cloud runs one Postgres, through CloudNativePG, and
 * the charts that ship their own are configured to use it instead. So
 * enabling Authentik has to mean installing CloudNativePG first,
 * whether or not anyone remembered to ask for it.
 *
 * Where a package goes follows from what it's for:
 *
 * - cc-office is for the applications the cluster is there to run,
 *   and the things they share — the one Postgres, Redis and RabbitMQ.
 * - community-cloud is for what runs the cluster itself: operators,
 *   and tools for running it, like Headlamp. An operator serves every
 *   namespace, so it doesn't belong in any one application's.
 * - An operator goes in a namespace of its own instead when its
 *   project says to install it there (cert-manager, cnpg-system,
 *   rabbitmq-system, topolvm-system, tailscale), or when it's made to
 *   run one copy per namespace it serves.
 *
 * So an operator and what it runs are two packages whenever they're in
 * different namespaces: a package's rollout, readiness and credentials
 * are all looked for in its one namespace. See "mattermost-operator"
 * and "mattermost".
 */
import CloudConfig from "../../util/CloudConfig.ts";
import { MailSecurity } from "../../util/mail.ts";
import { SecretDefinition } from "./Secrets.ts";
import type { AuthentikClient } from "./Authentik.ts";
import type { GateDefinition } from "./OAuth2Proxy.ts";
import { CLUSTER_CLIENT_ID } from "./ClusterSignIn.ts";

/**
 * Something that can be installed.
 *
 * - chart: where the chart comes from. "repo" is the Helm repository
 *   URL and "name" the chart within it. Left out for an application
 *   that has no chart worth using, which is then nothing but its
 *   manifests — "before" and "after" still run in that order, with
 *   the credentials between them.
 * - version: the chart version. Left unset, Helm takes the newest one,
 *   which makes an install depend on the day it was run — worth
 *   pinning once a cluster is real.
 * - namespace: where the release goes
 * - valuesFile: the values file, as an embed:// path for one shipping
 *   with the installer or a plain path for one on this machine.
 *   Rendered as a template first, so it can refer to the
 *   configuration through ".Values".
 * - valuesSource: values built in code rather than read from a file,
 *   for a package made from the configuration rather than written
 *   down — one ExternalDNS per provider and namespace, say, where the
 *   values are the only thing that differs. Takes the place of
 *   "valuesFile".
 * - requires: packages that have to be installed before this one.
 *   Pulled in automatically when this package is enabled.
 * - manifests: manifests belonging to this package that aren't part of
 *   its chart, such as the CloudNativePG Database an application needs
 *   before it can start. Those in "before" are applied ahead of the
 *   chart and those in "after" once it's installed. Rendered as
 *   templates, like everything else in k8s/.
 * - secrets: credentials the package's manifests refer to but which
 *   can't be written down in them. Generated and created between the
 *   chart and the "after" manifests, so a manifest naming one finds it
 *   already there. Created once and then left alone, so re-running an
 *   install doesn't change the password half the cluster is using.
 * - after: packages that, when they're being installed too, have to
 *   go first — without being pulled in when they aren't. For a
 *   dependency on something that may have been installed some other
 *   way: Authentik comes from a plugin, or by hand, and an
 *   application that signs in through it can't require a package the
 *   catalogue may never have heard of.
 * - rollout: the workloads that have to come up before the package
 *   counts as installed, as "deployment/name" or "statefulset/name".
 *   A chart is checked through Helm; this is how a package without
 *   one is.
 * - ready: what the package asks an operator for that isn't a
 *   workload — a SeaweedFS cluster, a bucket, the keys to it — as
 *   "resource/name", with the group spelled out so the name can't
 *   be mistaken for another project's. Waited for until the operator
 *   marks it Ready, ahead of the rollout, since the workloads are
 *   what use it.
 * - serverSideApply: apply its manifests server-side. For vendored
 *   operator manifests whose CRDs are too large for client-side
 *   apply's annotation.
 * - values: the configuration values its templates can't do without,
 *   as paths under "values". A template renders a missing value as
 *   nothing at all, which for a hostname is a route that matches no
 *   request and a certificate for no name — so preflight looks for
 *   these before anything is installed.
 * - authentik: the single sign on client the package signs in with.
 *   "blueprint" is an Authentik blueprint describing the provider and
 *   the application, and "secret" the credentials it's given — see
 *   Authentik.ts.
 * - mail: whether it sends email. If the configuration has a mail
 *   server, its credentials are put in the package's namespace, as
 *   the Secret "cc-smtp", before its manifests are applied — see
 *   Mail.ts. Its templates read the rest from ".Values.mail".
 * - mailSecurity: the kinds of connection it can make to a mail
 *   server, when it can't make them all. Preflight says so when its
 *   namespace's server wants one it can't.
 * - gate: an oauth2-proxy in front of the package, for something with
 *   no sign in of its own — see OAuth2Proxy.ts. Its Deployment, its
 *   credentials and its client in Authentik are all made from this;
 *   the package's own route has to point at it.
 */
export interface PackageDefinition {
  name: string;
  description: string;
  chart?: { repo: string; name: string };
  version?: string;
  namespace: string;
  releaseName?: string;
  valuesFile?: string;
  valuesSource?: (config: CloudConfig, context: any) => string;
  requires?: string[];
  after?: string[];
  manifests?: { before?: string[]; after?: string[] };
  secrets?: SecretDefinition[];
  rollout?: string[];
  ready?: string[];
  serverSideApply?: boolean;
  values?: string[];
  authentik?: AuthentikClient;
  mail?: boolean;
  mailSecurity?: MailSecurity[];
  gate?: GateDefinition;

  // Which plugin contributed this, when one did
  plugin?: string;
}

/**
 * What a configuration says about a package.
 *
 * "true" is shorthand for enabling it with everything else left as it
 * comes. The other fields override the catalogue, and a package the
 * catalogue has never heard of can be described entirely here.
 */
export interface PackageSelection {
  enabled?: boolean;
  version?: string;
  namespace?: string;
  releaseName?: string;

  // Relative to the working directory, unlike the catalogue's, which
  // is relative to the repository
  valuesFile?: string;

  // For a package that isn't in the catalogue
  repo?: string;
  chart?: string;
  description?: string;
  requires?: string[];
}

// Where what runs the cluster goes: the cluster Gateway, and the
// operators that don't ask for a namespace of their own
export const CLUSTER_NAMESPACE = "community-cloud";

/**
 * The packages Community Cloud knows how to install.
 *
 * A starting point rather than a closed list: anything here can be
 * overridden from a configuration, and anything missing can be added
 * there without touching this file.
 *
 * Versions are mostly unset on purpose. Pinning one here would be
 * guessing on behalf of every cluster, and an unpinned chart is at
 * least honest about tracking the newest release.
 */
const builtInPackages: PackageDefinition[] = [
  {
    name: "cert-manager",
    description: "Issues and renews TLS certificates",
    chart: { repo: "https://charts.jetstack.io", name: "cert-manager" },
    // 1.21 or later. The values file configures Gateway API support
    // under "config.gatewayAPI", and that nested shape only exists
    // from 1.21 — 1.20 and earlier take a flat "enableGatewayAPI" and
    // reject the nested one outright, failing to parse their own
    // configuration and crashlooping with "unknown field gatewayAPI".
    version: "v1.21.2",
    namespace: "cert-manager",
    valuesFile: "embed://certs/CertManager.values.yaml",

    // The issuer every application's certificate comes from. Its
    // resource type arrives with the chart.
    manifests: {
      after: ["embed://certs/ClusterIssuer.yaml"],
    },

    // Let's Encrypt's account is in the admin's name
    values: ["adminEmail"],
  },
  {
    name: "cloudnative-pg",
    description: "The Postgres operator every database in the cluster runs on",
    chart: { repo: "https://cloudnative-pg.github.io/charts", name: "cloudnative-pg" },
    // Pinned. Upgrading the operator restarts every Postgres it runs,
    // so it should be an upgrade somebody chose. 0.29 is operator 1.30,
    // the first with the DatabaseRole that Office.roles.yaml uses.
    version: "0.29.1",
    namespace: "cnpg-system",

    // The shared cluster asks for "cc-local-ssd-fast", so the storage
    // has to be there first or its volume waits forever
    requires: ["topolvm"],

    // The namespace and the shared Postgres cluster every application
    // connects to. They belong here rather than in each application's
    // list: three of them need "cc-postgres", and it should be made
    // once, by whatever put the operator there.
    manifests: {
      // The namespace is ahead of the chart because nothing about it
      // needs the chart, and the credentials below have to go
      // somewhere before the roles that use them are applied
      before: ["embed://apps/office/Office.namespace.yaml"],

      after: [
        "embed://apps/office/Office.database.yaml",

        // After the cluster, since a role belongs to one
        "embed://apps/office/Office.roles.yaml",
      ],
    },

    // What the roles in Office.roles.yaml authenticate with. One per
    // role, named as that role's manifest says to look for it.
    //
    // The username isn't generated for these. CloudNativePG compares
    // the username in the Secret against the role's own name and
    // refuses the role if they differ, so it has to be the Postgres
    // name — "twenty_crm" and not "twenty-crm", underscores and all.
    // Only the password is invented.
    //
    // The label is what makes changing one of these afterwards work.
    // The part of CloudNativePG that talks to Postgres deliberately
    // can't read Secrets — that would mean reading every Secret in
    // the namespace — so the operator watches them on its behalf and
    // pokes the role when one changes. It only watches the ones
    // carrying "cnpg.io/reload". Without it the first password is
    // applied, because the role is being retried until its Secret
    // turns up, and no later one ever is: the role is settled, and
    // nothing tells it otherwise.
    secrets: [
      {
        name: "twenty-crm",
        description: "the Twenty CRM database role",
        namespace: "cc-office",
        username: "twenty_crm",
        labels: { "cnpg.io/reload": "true" },
      },
      {
        name: "mattermost",
        description: "the Mattermost database role",
        namespace: "cc-office",
        username: "mattermost",
        labels: { "cnpg.io/reload": "true" },
      },
      {
        name: "authentik-db",
        description: "the Authentik database role",
        namespace: "cc-office",
        username: "authentik",
        labels: { "cnpg.io/reload": "true" },
      },
    ],
  },
  {
    name: "authentik",
    description: "Single sign on, for the applications and for the cluster itself",
    chart: { repo: "https://charts.goauthentik.io", name: "authentik" },
    // Pinned. Authentik migrates its database on start and has no way
    // back, so an upgrade should be one somebody chose.
    version: "2026.5.3",
    namespace: "cc-office",
    valuesFile: "embed://apps/authentik/Authentik.values.yaml",

    // Its database is in cc-postgres, with the role CloudNativePG's
    // package makes, and its files in a bucket in SeaweedFS
    requires: ["cloudnative-pg", "seaweedfs"],

    manifests: {
      // What the chart's pods read as they start: the namespace, for
      // the label the cluster Gateway looks for, the database, and the
      // bucket, whose keys the SeaweedFS operator writes into the
      // Secret "authentik-s3"
      before: [
        "embed://apps/office/Office.namespace.yaml",
        "embed://apps/authentik/Authentik.database.yaml",
        "embed://apps/authentik/Authentik.storage.yaml",
      ],

      after: ["embed://apps/authentik/Authentik.network.yaml"],
    },

    ready: ["buckets.seaweed.seaweedfs.com/authentik", "s3credentials.seaweed.seaweedfs.com/authentik"],
    mail: true,

    // The secret key signs its sessions, and replacing it signs
    // everybody out, so it's the configuration's to keep rather than
    // made afresh
    values: ["domain.auth", "domain.storage", "authentik.secretKey"],
  },
  {
    name: "documenso",
    description: "Document signing, signed into through Authentik",
    namespace: "cc-office",

    // Its database is in cc-postgres, and so are the documents:
    // Documenso keeps uploads in the database by default, which needs
    // no volume and no bucket, and means cc-postgres's backups are
    // its backups
    requires: ["cloudnative-pg"],
    after: ["authentik"],

    // No chart from the project; the image is one process
    manifests: {
      // The namespace again, for the label the cluster Gateway looks
      // for. A cluster whose CloudNativePG went in before that label
      // was added has a cc-office without it, and a ListenerSet there
      // is refused. Applying it is otherwise a no-op.
      before: ["embed://apps/office/Office.namespace.yaml"],

      after: [
        "embed://apps/documenso/Documenso.database.yaml",
        "embed://apps/documenso/Documenso.config.yaml",
        "embed://apps/documenso/Documenso.yaml",
        "embed://apps/documenso/Documenso.network.yaml",
      ],
    },

    secrets: [
      // Its role in cc-postgres. Declared here rather than with the
      // roles in Office.roles.yaml, unlike the applications that came
      // before it, because this can be installed on its own into a
      // cluster whose CloudNativePG went in long ago — and that
      // install has to bring its own role, or Documenso has nothing to
      // connect as. The username and label are as Office.roles.yaml
      // explains.
      {
        name: "documenso-db",
        description: "the Documenso database role",
        username: "documenso",
        labels: { "cnpg.io/reload": "true" },
      },

      // Documenso wants each of these to be at least 32 characters.
      // The two encryption keys protect what it stores — losing them
      // loses that — which is the other reason they're made once.
      {
        name: "documenso-session",
        description: "the key Documenso signs sessions with",
        keyBytes: 32,
      },
      {
        name: "documenso-encryption",
        description: "the key Documenso encrypts what it stores with",
        keyBytes: 32,
      },
      {
        name: "documenso-encryption-secondary",
        description: "Documenso's second encryption key, for rotating the first",
        keyBytes: 32,
      },
      {
        name: "documenso-oidc",
        description: "the client Documenso signs in to Authentik as",
      },

      // What it signs completed documents with. Self-signed, so a PDF
      // reader shows the signature as valid but not from anyone it
      // already trusts; a certificate from a trusted authority can be
      // put in this Secret in its place, keeping the same two keys.
      {
        name: "documenso-signing",
        description: "the certificate Documenso signs completed documents with",
        certificate: { commonName: "Community Cloud Documenso", days: 3650 },
      },
    ],

    rollout: ["deployment/documenso"],
    mail: true,
    values: ["domain.signing", "domain.auth", "domain.main"],

    authentik: {
      blueprint: "embed://apps/documenso/Documenso.blueprint.yaml",
      secret: "documenso-oidc",
      slug: "documenso",
    },
  },
  {
    name: "rabbitmq-operator",
    description: "The RabbitMQ operators, and the one RabbitMQ the applications in cc-office share",
    namespace: "rabbitmq-system",

    // Its webhooks' certificates come from cert-manager, and the shared
    // cluster's queues are on "cc-local-ssd-fast"
    requires: ["cert-manager", "topolvm"],

    // No chart: the RabbitMQ team publishes the operators as plain
    // manifests, vendored here at pinned versions
    manifests: {
      // cc-office, for the shared cluster, which goes in it
      before: ["embed://apps/office/Office.namespace.yaml"],

      after: [
        "embed://mq/RabbitMQ/RabbitMQ.cluster-operator.yaml",
        "embed://mq/RabbitMQ/RabbitMQ.topology-operator.yaml",

        // Once the operator's webhook answers, which the retries in
        // applying a manifest wait out
        "embed://apps/office/RabbitmqCluster.yaml",
      ],
    },
    serverSideApply: true,

    // The operators. The cluster they run is in cc-office, and the
    // applications that use it wait for it, as they do for the Redis.
    rollout: ["deployment/rabbitmq-cluster-operator", "deployment/messaging-topology-operator"],
  },
  {
    name: "redis-operator",
    description: "The Redis operator, and the one Redis the applications in cc-office share",
    chart: { repo: "https://ot-container-kit.github.io/helm-charts/", name: "redis-operator" },
    // Pinned, so installing an application that needs Redis doesn't
    // also upgrade the operator under every Redis in the cluster
    version: "0.24.0",
    namespace: CLUSTER_NAMESPACE,

    // The Redis asks for "cc-local-ssd-fast", as the databases do
    requires: ["topolvm"],

    manifests: {
      // The operator runs the cluster, so it's in community-cloud; the
      // Redis is in cc-office, with the applications using it, and its
      // password has to have somewhere to go before it does
      before: ["embed://apps/office/Office.namespace.yaml"],
      after: ["embed://apps/office/RedisStandalone.yaml"],
    },

    // Every application in cc-office reaches the one Redis, and so
    // does anything else that gets into the namespace. A password
    // keeps that to the ones handed it.
    secrets: [
      {
        name: "cc-redis",
        description: "the password for the Redis in cc-office",
        namespace: "cc-office",
      },
    ],
  },
  {
    name: "lago",
    description: "Billing: plans, subscriptions, usage and invoices",
    namespace: "cc-office",

    // Its database is in cc-postgres, its queues in the shared Redis,
    // and its files in a bucket in SeaweedFS
    requires: ["cloudnative-pg", "redis-operator", "seaweedfs"],

    // No chart: the manifests that put it on the cluster's Postgres,
    // Redis and SeaweedFS are ours
    manifests: {
      // The namespace again, for the label the cluster Gateway looks
      // for, as for Documenso
      before: ["embed://apps/office/Office.namespace.yaml"],

      after: [
        "embed://apps/lago/Lago.database.yaml",
        "embed://apps/lago/Lago.bucket.yaml",
        "embed://apps/lago/Lago.config.yaml",
        "embed://apps/lago/Lago.pdf.yaml",
        "embed://apps/lago/Lago.yaml",
        "embed://apps/lago/Lago.front.yaml",
        "embed://apps/lago/Lago.network.yaml",
      ],
    },

    secrets: [
      // Its role in cc-postgres, brought with it as Documenso's is
      {
        name: "lago-db",
        description: "the Lago database role",
        username: "lago",
        labels: { "cnpg.io/reload": "true" },
      },

      // Rails signs cookies with the first, and Active Record encrypts
      // stored credentials — payment providers' keys among them — with
      // the other three. Losing those loses what they encrypted, which
      // is the other reason they're made once.
      {
        name: "lago-secret-key-base",
        description: "the key Lago signs cookies with",
        keyBytes: 64,
      },
      {
        name: "lago-encryption-primary",
        description: "the key Lago encrypts what it stores with",
        keyBytes: 32,
      },
      {
        name: "lago-encryption-deterministic",
        description: "the key Lago encrypts what it searches by with",
        keyBytes: 32,
      },
      {
        name: "lago-encryption-salt",
        description: "the salt Lago derives its encryption keys with",
        keyBytes: 32,
      },

      // What it signs sessions with. Replacing it signs everybody out.
      {
        name: "lago-rsa",
        description: "the key Lago signs sessions with",
        privateKey: { bits: 2048 },
      },

      // The first account, made on first start, with the cluster's
      // admin address
      {
        name: "lago-admin",
        description: "the first Lago account's password",
      },
    ],

    // The Redis first: the operator makes it, so nothing about
    // installing the operator waited for it
    rollout: [
      "statefulset/redis",
      "deployment/lago-pdf",
      "deployment/lago",
      "deployment/lago-worker",
      "deployment/lago-clock",
      "deployment/lago-front",
    ],

    // Its bucket, and the keys to it the API and worker are given.
    // With the group spelled out, since "bucket" alone is a name more
    // than one project's resources answer to.
    ready: ["buckets.seaweed.seaweedfs.com/lago", "s3credentials.seaweed.seaweedfs.com/lago"],
    mail: true,

    // Rails is only given STARTTLS, and has no way to be told to
    // start with TLS. With a server that expects it, mail would hang.
    mailSecurity: [MailSecurity.StartTls, MailSecurity.None],

    values: ["domain.billing", "domain.billingApi", "domain.main", "adminEmail"],
  },
  {
    name: "twenty",
    description: "A CRM",
    namespace: "cc-office",

    // Its database is in cc-postgres, with the role CloudNativePG's
    // package makes, its queues in the shared Redis, and its files in
    // a bucket in SeaweedFS
    requires: ["cloudnative-pg", "redis-operator", "seaweedfs"],

    // No chart: the project's runs its own database and Redis
    manifests: {
      // The namespace again, for the label the cluster Gateway looks
      // for, as for Documenso
      before: ["embed://apps/office/Office.namespace.yaml"],

      after: [
        "embed://apps/twenty/Twenty.database.yaml",
        "embed://apps/twenty/Twenty.storage.yaml",
        "embed://apps/twenty/Twenty.config.yaml",
        "embed://apps/twenty/Twenty.yaml",
        "embed://apps/twenty/Twenty.network.yaml",
      ],
    },

    secrets: [
      // What it signs tokens with. Replacing it signs everybody out.
      {
        name: "twenty-crm-app-secret",
        description: "the key Twenty signs sessions with",
        keyBytes: 32,
      },

      // What it encrypts stored credentials with. Losing it loses
      // those, which is why it's apart from the one above. A cluster
      // moving from an older key can add it as
      // twenty-crm-fallback-encryption-key, which Twenty reads when
      // this one doesn't fit; see Twenty.yaml.
      {
        name: "twenty-crm-encryption-key",
        description: "the key Twenty encrypts stored credentials with",
        keyBytes: 32,
      },
    ],

    // The Redis first, as for Lago, then its bucket, then its own
    ready: ["buckets.seaweed.seaweedfs.com/twenty-crm", "s3credentials.seaweed.seaweedfs.com/twenty-crm"],
    rollout: ["statefulset/redis", "deployment/twenty-crm", "deployment/twenty-crm-worker"],

    // Twenty starts with TLS only on port 465, and upgrades with
    // STARTTLS anywhere else, so every kind of server works on its
    // usual port
    mail: true,

    values: ["domain.crm"],
  },
  {
    name: "plane",
    description: "Projects, issues and docs",
    namespace: "cc-office",

    // Its database is in cc-postgres, its cache in the shared Redis,
    // its job queue in the shared RabbitMQ, and its files in a bucket
    // in SeaweedFS
    requires: ["cloudnative-pg", "redis-operator", "rabbitmq-operator", "seaweedfs"],

    // No chart: the project's runs its own database, Redis, RabbitMQ
    // and MinIO, and stamps every pod with the time so each upgrade
    // restarts all of them
    manifests: {
      // The namespace again, for the label the cluster Gateway looks
      // for, as for Documenso
      before: ["embed://apps/office/Office.namespace.yaml"],

      after: [
        "embed://apps/plane/Plane.database.yaml",
        "embed://apps/plane/Plane.queue.yaml",
        "embed://apps/plane/Plane.bucket.yaml",
        "embed://apps/plane/Plane.config.yaml",
        "embed://apps/plane/Plane.yaml",
        "embed://apps/plane/Plane.mcp.yaml",
        "embed://apps/plane/Plane.network.yaml",
      ],
    },

    secrets: [
      // Its role in cc-postgres, brought with it as Lago's is
      {
        name: "plane-db",
        description: "the Plane database role",
        username: "plane",
        labels: { "cnpg.io/reload": "true" },
      },

      // What it signs sessions with, and what the settings it keeps in
      // its database are encrypted with — the mail password among
      // them. Losing it loses those.
      {
        name: "plane-secret-key",
        description: "the key Plane signs and encrypts with",
        keyBytes: 32,
      },

      // What the API and the live server prove themselves to each
      // other with
      {
        name: "plane-live-secret-key",
        description: "the key Plane's live server and API share",
        keyBytes: 32,
      },

      // The first administrator, made by the install with the
      // cluster's admin address; see Plane.config.yaml
      {
        name: "plane-admin",
        description: "Plane's first administrator's password",
      },
    ],

    // The shared Redis and RabbitMQ first, since the operators make
    // them; then its vhost, user, bucket and keys; then its own
    ready: [
      "vhosts.rabbitmq.com/plane",
      "users.rabbitmq.com/plane",
      "permissions.rabbitmq.com/plane",
      "buckets.seaweed.seaweedfs.com/plane-uploads",
      "s3credentials.seaweed.seaweedfs.com/plane",
    ],
    rollout: [
      "statefulset/redis",
      "statefulset/rabbitmq-server",
      "deployment/plane-api",
      "deployment/plane-worker",
      "deployment/plane-beat",
      "deployment/plane-live",
      "deployment/plane-web",
      "deployment/plane-space",
      "deployment/plane-admin",
      "deployment/plane-mcp",
    ],
    mail: true,

    values: ["domain.plane", "adminEmail"],
  },
  {
    name: "mattermost-operator",
    description: "The Mattermost operator, which runs Mattermost installations in any namespace",
    chart: { repo: "https://helm.mattermost.com", name: "mattermost-operator" },
    // Pinned, so the operator and the version of Mattermost.yaml it
    // understands move together
    version: "1.0.5",
    namespace: CLUSTER_NAMESPACE,
    releaseName: "mattermost-operator",
    valuesFile: "embed://apps/mattermost/Mattermost.values.yaml",
  },
  {
    name: "mattermost",
    description: "Team chat",
    namespace: "cc-office",

    // Its database is in cc-postgres, with the role CloudNativePG's
    // package makes, and its files in a bucket in SeaweedFS. The
    // operator runs it.
    requires: ["cloudnative-pg", "seaweedfs", "mattermost-operator"],

    // No chart: the operator is a package of its own, in
    // community-cloud. The installation it runs, and what that needs,
    // are ours.
    manifests: {
      // The namespace again, for the label the cluster Gateway looks
      // for, as for Documenso
      before: ["embed://apps/office/Office.namespace.yaml"],

      after: [
        "embed://apps/mattermost/Mattermost.database.yaml",
        "embed://apps/mattermost/Mattermost.storage.yaml",
        "embed://apps/mattermost/Mattermost.yaml",
        "embed://apps/mattermost/Mattermost.network.yaml",
      ],
    },

    secrets: [
      // The operator takes a database as one whole connection string,
      // so it's built from the role's credentials rather than made up
      {
        name: "mattermost-db",
        description: "how Mattermost connects to its database",
        connectionString: { role: "mattermost", database: "mattermost", key: "DB_CONNECTION_STRING" },
      },
    ],

    // Its bucket and the keys to it, then the server the operator
    // makes from Mattermost.yaml
    ready: ["buckets.seaweed.seaweedfs.com/mattermost", "s3credentials.seaweed.seaweedfs.com/mattermost"],
    rollout: ["deployment/mattermost"],

    values: ["domain.mattermost"],
  },
  {
    name: "picoclaw",
    description: "An AI agent with a web console, behind Authentik",
    namespace: "cc-office",

    // Its gate signs in through Authentik, which goes first when it's
    // being installed too
    after: ["authentik"],

    manifests: {
      // The namespace again, for the label the cluster Gateway looks
      // for, as for Documenso
      before: ["embed://apps/office/Office.namespace.yaml"],

      after: [
        "embed://apps/picoclaw/Picoclaw.storage.yaml",
        "embed://apps/picoclaw/Picoclaw.config.yaml",
        "embed://apps/picoclaw/Picoclaw.yaml",
        "embed://apps/picoclaw/Picoclaw.network.yaml",
      ],
    },

    secrets: [
      // The console asks for this once someone is through the gate.
      // Without it Picoclaw makes up a new one on every start.
      {
        name: "picoclaw-launcher",
        description: "the token Picoclaw's console asks for",
        keyBytes: 24,
      },
    ],

    // Its agents run commands, so the console is only for people
    // Authentik lets through, with nothing public in it
    gate: {
      name: "picoclaw",
      title: "Picoclaw",
      hostname: "domain.agent",
      upstream: "http://picoclaw:18800",
    },

    rollout: ["deployment/picoclaw"],
    values: ["domain.agent"],
  },
  {
    name: "topolvm",
    description: "Node local storage, backed by LVM",
    chart: { repo: "https://topolvm.github.io/topolvm", name: "topolvm" },
    namespace: "topolvm-system",
    valuesFile: "embed://storage/TopoLVM/TopoLVM.values.yaml",
    requires: ["cert-manager"],

    // The chart installs the driver; the classes that expose it are
    // ours. Without them a PVC asking for "cc-local-ssd-fast" waits
    // for a class nothing will ever create.
    manifests: {
      after: [
        "embed://storage/StorageClass/cc-local-ssd-fast.yaml",
        "embed://storage/StorageClass/cc-local-ssd-sata.yaml",
      ],
    },
  },
  {
    name: "seaweedfs",
    description: "S3-compatible object storage, and the buckets applications keep files in",
    chart: { repo: "https://seaweedfs.github.io/seaweedfs-operator/", name: "seaweedfs-operator" },
    // Pinned, unlike most. The operator is young and its resources
    // still change between releases, and the ones this relies on —
    // buckets, and the keys to them — are among the newest.
    version: "0.1.43",
    namespace: "seaweedfs",

    // Not "seaweedfs", which is what the SeaweedFS chart this replaced
    // was installed as. Upgrading that release to this chart would have
    // Helm delete the old cluster, its volume claim included.
    releaseName: "seaweedfs-operator",

    // Its volumes are claims on "cc-local-ssd-fast", which wait
    // forever for a class nothing has made
    requires: ["topolvm"],

    // The chart is the operator. The cluster it runs, which
    // namespaces may keep buckets in it, and the way in from outside
    // are ours.
    manifests: {
      // Ahead of the chart, which would otherwise make the namespace
      // without the label the cluster Gateway looks for
      before: ["embed://storage/SeaweedFS/SeaweedFS.namespace.yaml"],

      after: [
        "embed://storage/SeaweedFS/SeaweedFS.yaml",
        "embed://storage/SeaweedFS/SeaweedFS.network.yaml",
      ],
    },

    ready: ["seaweeds.seaweed.seaweedfs.com/seaweed"],

    // The hostname browsers reach S3 on, for the links applications
    // sign for their buckets
    values: ["domain.storage"],
  },
  {
    name: "headlamp",
    description: "A web interface for the cluster, signed into through Authentik",
    chart: { repo: "https://kubernetes-sigs.github.io/headlamp/", name: "headlamp" },
    version: "0.46.0",
    // A tool for running the cluster, not one of the applications on it
    namespace: CLUSTER_NAMESPACE,
    valuesFile: "embed://apps/headlamp/Headlamp.values.yaml",

    // It signs in through Authentik, which goes first when it's being
    // installed too. Enabling it also has K3s's API server trust
    // Authentik, which is what lets Headlamp act as whoever signed in;
    // see ClusterSignIn.ts.
    after: ["authentik"],

    manifests: {
      // The namespace, which the gateway bundle makes too, for the label
      // the cluster Gateway looks for; and the plugins, which Headlamp
      // mounts and won't start without
      before: [
        "embed://networking/cilium/gateway/Gateway.namespace.yaml",
        "embed://apps/headlamp/Headlamp.plugins.yaml",
      ],

      after: [
        "embed://apps/headlamp/Headlamp.rbac.yaml",
        "embed://apps/headlamp/Headlamp.network.yaml",
      ],
    },

    secrets: [
      // The username is the client ID, and it's fixed: the API server
      // is told it when K3s is installed. Only the secret is made up.
      {
        name: "headlamp-oidc",
        description: "the client Headlamp signs in to Authentik as",
        username: CLUSTER_CLIENT_ID,
      },
    ],

    authentik: {
      blueprint: "embed://apps/headlamp/Headlamp.blueprint.yaml",
      secret: "headlamp-oidc",
      slug: CLUSTER_CLIENT_ID,
    },

    values: ["domain.headlamp", "domain.auth"],
  },
  {
    name: "tailscale-operator",
    description: "Exposes cluster services on a tailnet",
    chart: { repo: "https://pkgs.tailscale.com/helmcharts", name: "tailscale-operator" },
    namespace: "tailscale",
  },
];

/**
 * Everything that can be installed: what shipped, plus what plugins
 * added.
 */
// Said wherever a package isn't found, since the likeliest reason for
// one that's spelled right is a plugin that isn't loaded: its packages
// only exist once it is, and having the file isn't enough
export const PLUGIN_HINT =
  'If it comes from a plugin, enable the plugin under "plugins" — a plugin\'s packages only exist once it\'s loaded, and being in ~/.community-cloud/plugins isn\'t enough.';

export const packageCatalogue: PackageDefinition[] = [...builtInPackages];

/**
 * Add a package from a plugin.
 *
 * @param definition
 * @param plugin the plugin adding it
 */
export function registerPackage(definition: PackageDefinition, plugin: string) {
  const existing = getPackage(definition.name);

  if (existing !== undefined) {
    throw new Error(
      existing.plugin === undefined
        ? `The plugin "${plugin}" tried to add a package called "${definition.name}", which is one this installer ships. A plugin can add packages and can't replace them.`
        : `The plugin "${plugin}" has two packages called "${definition.name}".`,
    );
  }

  packageCatalogue.push({ ...definition, plugin });
}

/**
 * Forget every package a plugin added.
 */
export function resetPackages() {
  packageCatalogue.length = 0;
  packageCatalogue.push(...builtInPackages);
}

/**
 * Read the packages section of a configuration.
 *
 * @param config
 * @returns
 */
export function getPackageSelections(
  config: CloudConfig,
): Record<string, PackageSelection> {
  const { packages } = config.getConfig();

  if (packages === undefined || packages === null) {
    return {};
  }

  const selections: Record<string, PackageSelection> = {};
  for (const [name, selection] of Object.entries(packages)) {
    // The key this file has always carried a "description" string,
    // which isn't a package
    if (typeof selection === "string") {
      continue;
    }

    selections[name] = selection === true ? { enabled: true } : (selection as PackageSelection);
  }

  return selections;
}

/**
 * Find a package in the catalogue.
 *
 * @param name
 * @returns
 */
export function getPackage(name: string): PackageDefinition | undefined {
  return packageCatalogue.find((definition) => definition.name === name);
}

/**
 * Merge what the catalogue knows with what a configuration asked for.
 *
 * @param name
 * @param selection
 * @returns
 */
export function resolvePackage(
  name: string,
  selection: PackageSelection = {},
): PackageDefinition {
  const catalogued = getPackage(name);

  if (catalogued === undefined) {
    // Not in the catalogue, so the configuration has to say everything
    if (selection.repo === undefined || selection.chart === undefined) {
      throw new Error(
        `"${name}" isn't a package Community Cloud knows about. Either use one of: ${packageCatalogue.map((entry) => entry.name).join(", ")}, or give it a "repo" and a "chart" in the configuration. ${PLUGIN_HINT}`,
      );
    }

    return {
      name,
      description: selection.description !== undefined ? selection.description : name,
      chart: { repo: selection.repo, name: selection.chart },
      version: selection.version,
      namespace: selection.namespace !== undefined ? selection.namespace : name,
      releaseName: selection.releaseName,
      valuesFile: selection.valuesFile,
      requires: selection.requires,
    };
  }

  return {
    ...catalogued,
    version: selection.version !== undefined ? selection.version : catalogued.version,
    namespace: selection.namespace !== undefined ? selection.namespace : catalogued.namespace,
    releaseName:
      selection.releaseName !== undefined ? selection.releaseName : catalogued.releaseName,
    valuesFile:
      selection.valuesFile !== undefined ? selection.valuesFile : catalogued.valuesFile,
    requires: selection.requires !== undefined ? selection.requires : catalogued.requires,
  };
}

/**
 * Whether a values file came from the configuration rather than from
 * the catalogue, which decides what a relative path is relative to:
 * the working directory for one, the repository for the other.
 *
 * @param selection
 * @returns
 */
export function valuesFileIsFromConfig(selection: PackageSelection = {}): boolean {
  return selection.valuesFile !== undefined;
}

/**
 * Work out what to install, and in what order.
 *
 * Everything enabled, plus anything those packages require, sorted so
 * nothing is installed before the things it depends on — or before
 * anything it asked to come "after" that is also enabled. A package
 * pulled in as a dependency is reported as such, since being installed
 * without having been asked for is worth saying out loud.
 *
 * @param config
 * @returns
 */
export function resolveInstallOrder(config: CloudConfig): PackageDefinition[] {
  const selections = getPackageSelections(config);

  const enabled = Object.entries(selections)
    .filter(([, selection]) => selection.enabled !== false)
    .map(([name]) => name);

  const ordered: PackageDefinition[] = [];
  const done = new Set<string>();
  const visiting = new Set<string>();

  const visit = (name: string, path: string[]) => {
    if (done.has(name)) {
      return;
    }

    if (visiting.has(name)) {
      throw new Error(
        `The packages depend on each other in a loop: ${[...path, name].join(" → ")}.`,
      );
    }

    visiting.add(name);

    const definition = resolvePackage(name, selections[name]);
    for (const required of definition.requires !== undefined ? definition.requires : []) {
      if (!enabled.includes(required) && !done.has(required)) {
        console.log(`  ${required} will be installed because ${name} requires it`);
      }

      visit(required, [...path, name]);
    }

    // Only when it's being installed anyway. Anything else is either
    // there already or not this installer's to put there.
    for (const preceding of definition.after !== undefined ? definition.after : []) {
      if (enabled.includes(preceding)) {
        visit(preceding, [...path, name]);
      }
    }

    visiting.delete(name);
    done.add(name);
    ordered.push(definition);
  };

  for (const name of enabled) {
    visit(name, []);
  }

  return ordered;
}
