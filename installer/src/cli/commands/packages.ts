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

/**
 * Something that can be installed.
 *
 * - chart: where the chart comes from. "repo" is the Helm repository
 *   URL and "name" the chart within it.
 * - version: the chart version. Left unset, Helm takes the newest one,
 *   which makes an install depend on the day it was run — worth
 *   pinning once a cluster is real.
 * - namespace: where the release goes
 * - valuesFile: a values file shipping with the repository, relative
 *   to its root. Rendered as a template first, so it can refer to the
 *   configuration through ".Values".
 * - requires: packages that have to be installed before this one.
 *   Pulled in automatically when this package is enabled.
 * - manifests: manifests belonging to this package that aren't part of
 *   its chart, such as the CloudNativePG Database an application needs
 *   before it can start. Recorded here so the ordering is written
 *   down; applying them isn't wired up yet.
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
    // The version k8s/certs and K3sInstallation.ts were written against
    version: "v1.19.2",
    namespace: "cert-manager",
    valuesFile: "k8s/certs/CertManager.values.yaml",
  },
  {
    name: "cloudnative-pg",
    description: "The Postgres operator every database in the cluster runs on",
    chart: { repo: "https://cloudnative-pg.github.io/charts", name: "cloudnative-pg" },
    namespace: "cnpg-system",
  },
  {
    name: "authentik",
    description: "Single sign on",
    chart: { repo: "https://charts.goauthentik.io", name: "authentik" },
    namespace: "cc-office",
    valuesFile: "k8s/apps/authentik/Authentik.values.yaml",

    // Its chart ships a Postgres and a Redis; the values file turns
    // both off and points it at the cluster's own. That only works if
    // CloudNativePG is there first.
    requires: ["cloudnative-pg"],

    // The database, its owner and the secret the chart mounts. Not
    // applied yet, recorded so the ordering is known.
    manifests: {
      before: [
        "k8s/apps/authentik/Authentik.database.yaml",
        "k8s/apps/authentik/Authentik.storage.yaml",
      ],
    },
  },
  {
    name: "topolvm",
    description: "Node local storage, backed by LVM",
    chart: { repo: "https://topolvm.github.io/topolvm", name: "topolvm" },
    namespace: "topolvm-system",
    valuesFile: "k8s/storage/TopoLVM/TopoLVMValues.yaml",
    requires: ["cert-manager"],
  },
  {
    name: "headlamp",
    description: "A web interface for the cluster",
    chart: { repo: "https://kubernetes-sigs.github.io/headlamp/", name: "headlamp" },
    namespace: "cc-office",
    valuesFile: "k8s/apps/headlamp/Headlamp.values.yaml",
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
