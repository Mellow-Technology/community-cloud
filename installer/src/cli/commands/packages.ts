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

/**
 * Something that can be installed.
 *
 * - chart: where the chart comes from. "repo" is the Helm repository
 *   URL and "name" the chart within it.
 * - version: the chart version. Left unset, Helm takes the newest one,
 *   which makes an install depend on the day it was run — worth
 *   pinning once a cluster is real.
 * - namespace: where the release goes
 * - valuesFile: the values file, as an embed:// path for one shipping
 *   with the installer or a plain path for one on this machine.
 *   Rendered as a template first, so it can refer to the
 *   configuration through ".Values".
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
 */
export interface PackageDefinition {
  name: string;
  description: string;
  chart: { repo: string; name: string };
  version?: string;
  namespace: string;
  releaseName?: string;
  valuesFile?: string;
  requires?: string[];
  manifests?: { before?: string[]; after?: string[] };
  secrets?: SecretDefinition[];
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
export const packageCatalogue: PackageDefinition[] = [
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
    name: "authentik",
    description: "Single sign on",
    chart: { repo: "https://charts.goauthentik.io", name: "authentik" },
    namespace: "cc-office",
    valuesFile: "embed://apps/authentik/Authentik.values.yaml",

    // Its chart ships a Postgres and a Redis; the values file turns
    // both off and points it at the cluster's own. That only works if
    // CloudNativePG is there first.
    requires: ["cloudnative-pg"],

    // The database, its owner and the secret the chart mounts. The
    // resource types are CloudNativePG's, which "requires" above has
    // already put in place by the time these are applied.
    manifests: {
      before: [
        "embed://apps/authentik/Authentik.database.yaml",

        // Authentik.storage.yaml is deliberately not here. It's an
        // ObjectBucketClaim against the "cc-s3-storage" class, which
        // needs an object bucket provisioner — Garage or Rook — and
        // nothing in this catalogue installs one. Applying it would
        // fail on a missing resource type. Put it back when object
        // storage becomes a package.
      ],
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
 * nothing is installed before the things it depends on. A package
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

    visiting.delete(name);
    done.add(name);
    ordered.push(definition);
  };

  for (const name of enabled) {
    visit(name, []);
  }

  return ordered;
}
