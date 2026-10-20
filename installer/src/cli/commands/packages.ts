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
 */
import CloudConfig from "../../util/CloudConfig.ts";
import { SecretDefinition } from "./Secrets.ts";
import type { AuthentikClient } from "./Authentik.ts";
import type { GateDefinition } from "./OAuth2Proxy.ts";

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
  values?: string[];
  authentik?: AuthentikClient;
  mail?: boolean;
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
  },
  {
    name: "cloudnative-pg",
    description: "The Postgres operator every database in the cluster runs on",
    chart: { repo: "https://cloudnative-pg.github.io/charts", name: "cloudnative-pg" },
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
    name: "invoice-ninja",
    description: "Invoicing, quotes and payments, signed into through Authentik",
    namespace: "cc-office",

    // Not for its Postgres, which it can't use — Invoice Ninja runs on
    // MySQL or MariaDB only, and brings its own. For the cc-office
    // namespace, which arrives with CloudNativePG.
    requires: ["cloudnative-pg"],
    after: ["authentik"],

    // No chart: the image is PHP-FPM and its workers, expecting a web
    // server beside it, and the manifests that arrange that are ours
    manifests: {
      // The namespace again, for the label the cluster Gateway looks
      // for. A cluster whose CloudNativePG went in before that label
      // was added has a cc-office without it, and a ListenerSet there
      // is refused. Applying it is otherwise a no-op.
      before: ["embed://apps/office/Office.namespace.yaml"],

      after: [
        "embed://apps/invoice-ninja/InvoiceNinja.database.yaml",
        "embed://apps/invoice-ninja/InvoiceNinja.storage.yaml",
        "embed://apps/invoice-ninja/InvoiceNinja.config.yaml",
        "embed://apps/invoice-ninja/InvoiceNinja.yaml",
        "embed://apps/invoice-ninja/InvoiceNinja.network.yaml",
      ],
    },

    secrets: [
      {
        name: "invoice-ninja-db",
        description: "the account Invoice Ninja uses in its MariaDB",
        username: "invoiceninja",
      },
      {
        name: "invoice-ninja-db-root",
        description: "MariaDB's root account, which nothing uses day to day",
        username: "root",
      },

      // Laravel encrypts with AES-256 and takes a key of exactly 32
      // bytes, which sixteen random bytes in hex are. A phrase is the
      // wrong length, and the app won't start on one. Changing it
      // later makes every stored gateway credential unreadable, which
      // is the other reason it is only ever made once.
      {
        name: "invoice-ninja-app-key",
        description: "the key Invoice Ninja encrypts stored credentials with",
        keyBytes: 16,
      },

      // The first account, made on first start. Its address is the
      // cluster's admin address; signing in through Authentik with
      // that address links the two.
      {
        name: "invoice-ninja-admin",
        description: "the first Invoice Ninja account's password",
      },
      {
        name: "invoice-ninja-oidc",
        description: "the client Invoice Ninja signs in to Authentik as",
      },
    ],

    rollout: ["statefulset/invoice-ninja-mariadb", "deployment/invoice-ninja"],
    mail: true,
    values: ["domain.invoicing", "domain.auth", "domain.main", "adminEmail"],

    authentik: {
      blueprint: "embed://apps/invoice-ninja/InvoiceNinja.blueprint.yaml",
      secret: "invoice-ninja-oidc",
      slug: "invoice-ninja",
    },
  },
  {
    name: "documenso",
    description: "Document signing, signed into through Authentik",
    namespace: "cc-office",

    // Its database is in cc-postgres, and so are the documents: with
    // no object storage in the cluster yet, Documenso keeps uploads in
    // the database, which is its default and needs no volume
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
    name: "headlamp",
    description: "A web interface for the cluster",
    chart: { repo: "https://kubernetes-sigs.github.io/headlamp/", name: "headlamp" },
    namespace: "cc-office",
    valuesFile: "embed://apps/headlamp/Headlamp.values.yaml",
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
        `"${name}" isn't a package Community Cloud knows about. Either use one of: ${packageCatalogue.map((entry) => entry.name).join(", ")}, or give it a "repo" and a "chart" in the configuration.`,
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
