/**
 * @file
 * Install/Remove Helm Packages
 *
 * The charts a cluster runs come from its configuration, and what each
 * chart is comes from the catalogue in packages.ts. This turns the two
 * into an ordered set of Helm commands.
 *
 * Everything runs on the control plane: Helm needs a kubeconfig, and
 * so does anything it does.
 *
 * Values files are rendered before they're sent. The ones in k8s/ are
 * templates, so a chart can be handed the cluster's own domain or the
 * address of its API server without that being written down twice.
 */
import { CommandPurpose, CommandSpec, CommandTarget, OutputType } from "./Command.ts";
import CloudConfig from "../../util/CloudConfig.ts";
import {
  getWaitSeconds,
  quoteForShell,
  waitUntil,
  writeFileCommand,
} from "../../util/shell.ts";
import { renderInstallerFile } from "../../util/template.ts";
import { buildKubeEnv } from "../../util/kube.ts";
import { CLASSES_LABEL, STORAGE_ROLE_SELECTOR, readShape } from "../../util/storage.ts";
import { field, readLines, readRecordsOfKind } from "./output.ts";
import { buildHelmEnv } from "./Helm.install.ts";
import {
  buildCreateSecretCommand,
  buildVerifySecretsCommand,
} from "./Secrets.ts";
import {
  PackageDefinition,
  getPackageSelections,
  packageCatalogue,
  resolveInstallOrder,
  resolvePackage,
} from "./packages.ts";
import {
  blueprintFromFile,
  buildApplyBlueprintCommand,
  buildRequireAuthentikCommand,
  buildVerifyAuthentikCommand,
} from "./Authentik.ts";
import {
  buildApplyMailSecretCommand,
  buildVerifyMailReachableCommand,
  buildVerifyMailSecretCommand,
} from "./Mail.ts";
import {
  buildGateBlueprint,
  buildGateManifest,
  getGateClient,
  getGateName,
  getGateSecrets,
} from "./OAuth2Proxy.ts";

// Where rendered values files are put on the control plane. They can
// carry secrets, so the directory is the installing user's own.
const WORK_DIR = "/tmp/cc-helm";

// A package that has a chart, which is the only kind the Helm
// commands below can do anything with
type ChartedPackage = PackageDefinition & {
  chart: NonNullable<PackageDefinition["chart"]>;
};

// How long to give a chart to come up
const READY_TIMEOUT = "10m";

// How long to keep trying a manifest that belongs to a chart just
// installed. The resource types it uses arrive with that chart, and
// an operator's webhook is ready a moment after its deployment is.
const MANIFEST_TIMEOUT_SECONDS = 120;

/**
 * Ask the cluster which device classes each storage node can serve.
 *
 * TopoLVM's values are rendered from the answer: lvmd refuses to
 * start unless every volume group it's told about is on the node it
 * landed on, so a cluster of unlike machines needs one lvmd per
 * combination of classes. The combinations can't come from the
 * configuration, which knows what disks were asked for rather than
 * what was found, so they come from the labels the lvm bundle left on
 * the nodes.
 *
 * A cluster with no labels yet is the ordinary first install, not a
 * failure. Every node is then offered every class, which is what
 * happened before this existed.
 */
const readStorageShapesCommand: CommandSpec = {
  name: "read-storage-shapes",
  description: "Find out which device classes each storage node can serve",
  purpose: CommandPurpose.Inspect,
  runOn: CommandTarget.ControlPlane,
  env: buildKubeEnv,
  command: [
    `kubectl get nodes -l ${quoteForShell(STORAGE_ROLE_SELECTOR)} -o jsonpath='{range .items[*]}{.metadata.name}|{.metadata.labels.${CLASSES_LABEL.replace(/\./g, "\\.")}}{"\\n"}{end}' 2>/dev/null || true`,
  ],
  output: OutputType.Raw,
  saveToContext: (output: any) => {
    const shapes: Record<string, string> = {};
    const unlabelled: string[] = [];

    for (const line of readLines(output)) {
      const [name, shape] = line.split("|");

      if (name === undefined || name === "") {
        continue;
      }

      if (shape === undefined || shape === "") {
        unlabelled.push(name);
        continue;
      }

      shapes[name] = shape;
    }

    const found = Object.entries(shapes);

    if (found.length === 0) {
      console.log(
        "  No storage node says which device classes it serves, so every one will be offered all of them. Run the lvm and nodeLabels bundles against a node to narrow that down.",
      );
    } else {
      for (const [name, shape] of found) {
        console.log(`  ${name}: ${readShape(shape).join(", ")}`);
      }

      if (unlabelled.length > 0) {
        console.log(
          `  Offered every device class, because nothing has said otherwise: ${unlabelled.join(", ")}`,
        );
      }
    }

    return { storageShapes: shapes };
  },
};

/**
 * Check Helm is there before asking it for anything.
 */
export const checkHelmAvailableCommand: CommandSpec = {
  name: "check-helm-available",
  purpose: CommandPurpose.Require,
  description: "Check Helm is installed on the control plane",
  runOn: CommandTarget.ControlPlane,
  env: buildHelmEnv,
  command:
    'command -v helm > /dev/null 2>&1 || { echo "Helm isn\'t installed on the control plane. Run the \\"helm\\" bundle first." >&2; exit 1; }\nhelm version --short',
  output: OutputType.Raw,
};

/**
 * The release name for a package, which is its own name unless it
 * asked for something else.
 *
 * @param definition
 * @returns
 */
function getReleaseName(definition: PackageDefinition): string {
  return toKubernetesName(
    definition.releaseName !== undefined ? definition.releaseName : definition.name,
  );
}

/**
 * Turn a package name into something Helm and Kubernetes will accept.
 *
 * A package from a plugin carries the plugin's name and a colon, which
 * is right for telling two packages apart and is not a character
 * allowed in a release name, a repository alias or a label value. The
 * colon becomes a hyphen and everything else unacceptable goes the
 * same way.
 *
 * @param name
 * @returns
 */
function toKubernetesName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9.-]+/g, "-")
    .replace(/^[^a-z0-9]+/, "")
    .replace(/[^a-z0-9]+$/, "");
}

/**
 * The name Helm knows the repository by. Derived from the package so
 * two packages from one repository don't add it twice under different
 * names.
 *
 * @param definition
 * @returns
 */
function getRepoName(definition: ChartedPackage): string {
  return toKubernetesName(`cc-${definition.chart.name}`);
}

/**
 * Where a package's rendered values file lands.
 *
 * @param definition
 * @returns
 */
function getValuesPath(definition: PackageDefinition): string {
  return `${WORK_DIR}/${toKubernetesName(definition.name)}.values.yaml`;
}

/**
 * The context to render a package's templates in, which says whose
 * namespace they're for: what's configured per namespace, mail among
 * it, depends on that.
 *
 * @param definition
 * @param context
 * @returns
 */
function forNamespace(definition: PackageDefinition, context: any): any {
  return { ...(context ?? {}), templateNamespace: definition.namespace };
}

/**
 * Whether a package has values to hand its chart, from a file or
 * built in code.
 *
 * @param definition
 * @returns
 */
function hasValues(definition: PackageDefinition): boolean {
  return definition.valuesFile !== undefined || definition.valuesSource !== undefined;
}

/**
 * Add the chart's repository.
 *
 * @param definition
 * @returns
 */
function buildAddRepoCommand(definition: ChartedPackage): CommandSpec {
  const repoName = getRepoName(definition);

  return {
    name: `helm-repo-${definition.name}`,
    description: `Add the Helm repository for ${definition.name}`,
    runOn: CommandTarget.ControlPlane,
    env: buildHelmEnv,
    // --force-update so a repository that's already there is refreshed
    // rather than reported as a conflict
    command: `helm repo add ${quoteForShell(repoName)} ${quoteForShell(definition.chart.repo)} --force-update\nhelm repo update ${quoteForShell(repoName)}`,
    output: OutputType.Raw,
  };
}

/**
 * Put the rendered values file on the control plane.
 *
 * @param definition
 * @returns
 */
function buildWriteValuesCommand(definition: PackageDefinition): CommandSpec {
  const path = getValuesPath(definition);

  return {
    name: `helm-values-${definition.name}`,
    description: `Write the rendered values for ${definition.name}`,
    runOn: CommandTarget.ControlPlane,
    command: [
      `mkdir -p ${WORK_DIR}`,
      `chmod 0700 ${WORK_DIR}`,
      // Values carry database passwords and signing keys, so the file
      // is created with its permissions already on it
      ...writeFileCommand(path, { mode: "0600" }),
      `echo "wrote ${path}"`,
    ],
    // The rendered values go over standard input rather than into the
    // command, so nothing secret in them turns up in a process listing
    // on the control plane or in an error quoting the command back
    stdin: (config: CloudConfig, context: any) =>
      definition.valuesSource !== undefined
        ? definition.valuesSource(config, context)
        : renderInstallerFile(config, definition.valuesFile as string, forNamespace(definition, context)),
    output: OutputType.Raw,
  };
}

/**
 * The name a manifest goes by, from its path.
 *
 * @param manifest
 * @returns
 */
function getManifestName(manifest: string): string {
  const file = manifest.split("/").pop() ?? manifest;
  return file.replace(/\.ya?ml$/, "").toLowerCase().replace(/[^a-z0-9]+/g, "-");
}

/**
 * Apply a manifest that belongs to a package but isn't in its chart.
 *
 * Charts don't cover everything. An application needs a database
 * before it starts, and the database is a resource belonging to an
 * operator installed earlier — which no chart of the application's own
 * would know how to ask for.
 *
 * It's written to a file first rather than piped straight in, because
 * this is a thing worth retrying and standard input can only be read
 * once. The resource types these use arrive with the chart installed
 * moments earlier, and an operator's admission webhook is reachable a
 * little after its deployment reports ready, so the first apply can
 * lose that race. Retrying costs nothing; failing on it costs an
 * install.
 *
 * @param definition
 * @param manifest the template's path, which also names the command
 * @param when
 * @param render what produces the manifest, when it's built rather
 *   than read from a template — a gate's, for one
 * @returns
 */
function buildManifestCommand(
  definition: PackageDefinition,
  manifest: string,
  when: string,
  render: (config: CloudConfig, context: any) => string = (config, context) =>
    renderInstallerFile(config, manifest, forNamespace(definition, context)),
): CommandSpec {
  const path = `${WORK_DIR}/${toKubernetesName(definition.name)}-${getManifestName(manifest)}.yaml`;
  const quoted = quoteForShell(path);

  // Server-side for a package that asks: a client-side apply keeps
  // the whole object in an annotation, which can't hold more than
  // 256 KB, and some operators' CRDs are larger than that. Taking
  // over the fields a client-side apply or a person set is what
  // re-running an install should do anyway.
  const apply = definition.serverSideApply === true ? "kubectl apply --server-side --force-conflicts" : "kubectl apply";

  return {
    name: `helm-manifest-${when}-${definition.name}-${getManifestName(manifest)}`,
    description: `Apply ${manifest.split("/").pop()} for ${definition.name}`,
    purpose: CommandPurpose.Apply,
    runOn: CommandTarget.ControlPlane,
    env: buildHelmEnv,
    command: (_config: CloudConfig, context: any) => [
      `mkdir -p ${WORK_DIR}`,
      `chmod 0700 ${WORK_DIR}`,
      // These carry the credentials an application connects with
      ...writeFileCommand(path, { mode: "0600" }),
      // Retried quietly, then once more in the open so a real failure
      // says why rather than just running out of attempts. The flag is
      // what stops a successful apply being done twice, which would
      // report every resource as "unchanged" the moment after
      // creating it.
      "applied=",
      waitUntil(
        `{ ${apply} -f ${quoted} && applied=yes; }`,
        getWaitSeconds(context, MANIFEST_TIMEOUT_SECONDS),
      ),
      `[ "$applied" = "yes" ] || ${apply} -f ${quoted} || { echo "Couldn't apply ${manifest} for ${definition.name}" >&2; rm -f ${quoted}; exit 1; }`,
      `rm -f ${quoted}`,
    ],
    stdin: render,
    output: OutputType.Raw,
  };
}

/**
 * Make a package's namespace, if it isn't there already.
 *
 * For a chart whose credentials go in its own namespace: they're made
 * before the chart, which is otherwise what would make it.
 *
 * @param definition
 * @returns
 */
function buildEnsureNamespaceCommand(definition: PackageDefinition): CommandSpec {
  const namespace = quoteForShell(definition.namespace);

  return {
    name: `namespace-${definition.name}`,
    description: `Make the ${definition.namespace} namespace for ${definition.name}`,
    purpose: CommandPurpose.Apply,
    runOn: CommandTarget.ControlPlane,
    env: buildKubeEnv,
    command: `kubectl get namespace ${namespace} > /dev/null 2>&1 || kubectl create namespace ${namespace} || { echo "Couldn't make the ${definition.namespace} namespace" >&2; exit 1; }`,
    output: OutputType.Raw,
  };
}

/**
 * Install or upgrade the chart.
 *
 * "upgrade --install" rather than "install", so running this against a
 * cluster that already has the chart brings it in line with the
 * configuration instead of failing.
 *
 * @param definition
 * @returns
 */
function buildInstallCommand(definition: ChartedPackage): CommandSpec {
  return {
    name: `helm-install-${definition.name}`,
    description: `Install ${definition.name}: ${definition.description}`,
    runOn: CommandTarget.ControlPlane,
    env: buildHelmEnv,
    command: () => {
      const args = [
        "helm upgrade --install",
        quoteForShell(getReleaseName(definition)),
        quoteForShell(`${getRepoName(definition)}/${definition.chart.name}`),
        `--namespace ${quoteForShell(definition.namespace)}`,
        "--create-namespace",
        `--timeout ${READY_TIMEOUT}`,
        "--wait",
      ];

      if (definition.version !== undefined) {
        args.push(`--version ${quoteForShell(definition.version)}`);
      }

      if (hasValues(definition)) {
        args.push(`--values ${getValuesPath(definition)}`);
      }

      return args.join(" ");
    },
    output: OutputType.Raw,
  };
}

/**
 * Check the release is actually there and healthy.
 *
 * @param definition
 * @returns
 */
function buildVerifyCommand(definition: PackageDefinition): CommandSpec {
  const release = quoteForShell(getReleaseName(definition));
  const namespace = quoteForShell(definition.namespace);

  return {
    name: `helm-verify-${definition.name}`,
    purpose: CommandPurpose.Verify,
    description: `Verify ${definition.name} is deployed`,
    runOn: CommandTarget.ControlPlane,
    env: buildHelmEnv,
    command: [
      `state=$(helm status ${release} --namespace ${namespace} -o json 2>/dev/null | tr -d " \\n" | sed -n 's/.*"status":"\\([a-z]*\\)".*/\\1/p')`,
      `echo "${definition.name}: $state"`,
      `[ "$state" = "deployed" ] || { echo "${definition.name} is \\"$state\\", not deployed" >&2; helm status ${release} --namespace ${namespace} >&2; exit 1; }`,
    ],
    output: OutputType.Raw,
  };
}

/**
 * Wait for a package's own workloads to come up.
 *
 * A Settle rather than a Verify, because the first start can be slow
 * for reasons that are nobody's fault: Lago migrates its database
 * before it starts, and that takes minutes on a quiet machine.
 *
 * @param definition
 * @returns
 */
function buildRolloutCommand(definition: PackageDefinition): CommandSpec {
  const namespace = quoteForShell(definition.namespace);
  const workloads = definition.rollout ?? [];

  return {
    name: `rollout-${definition.name}`,
    description: `Wait for ${definition.name} to come up`,
    purpose: CommandPurpose.Settle,
    runOn: CommandTarget.ControlPlane,
    env: buildKubeEnv,
    command: workloads.map(
      (workload) =>
        `kubectl -n ${namespace} rollout status ${quoteForShell(workload)} --timeout=${READY_TIMEOUT} || { echo "${workload} in ${definition.namespace} didn't come up" >&2; kubectl -n ${namespace} get pods >&2; exit 1; }`,
    ),
    output: OutputType.Raw,
  };
}

/**
 * Check a package's own workloads are up, without waiting for them.
 *
 * What stands in for "helm status" for a package without a chart.
 *
 * @param definition
 * @returns
 */
function buildVerifyRolloutCommand(definition: PackageDefinition): CommandSpec {
  const namespace = quoteForShell(definition.namespace);

  return {
    name: `verify-rollout-${definition.name}`,
    description: `Verify ${definition.name} is running`,
    purpose: CommandPurpose.Verify,
    runOn: CommandTarget.ControlPlane,
    env: buildKubeEnv,
    command: [
      "failed=",
      ...(definition.rollout ?? []).flatMap((workload) => [
        `counts=$(kubectl -n ${namespace} get ${quoteForShell(workload)} -o jsonpath='{.status.readyReplicas}/{.spec.replicas}' 2>/dev/null)`,
        // An empty ready count is none ready, which is how Kubernetes
        // reports it rather than as a zero
        `case "$counts" in`,
        `  "") echo "  ${workload}: missing" >&2; failed=yes ;;`,
        `  /*) echo "  ${workload}: none ready" >&2; failed=yes ;;`,
        `  *) ready=\${counts%/*}; wanted=\${counts#*/}; if [ "$ready" -ge "$wanted" ]; then echo "  ${workload}: $counts ready"; else echo "  ${workload}: only $counts ready" >&2; failed=yes; fi ;;`,
        "esac",
      ]),
      `[ -z "$failed" ] || { echo "${definition.name} isn't fully running" >&2; exit 1; }`,
    ],
    output: OutputType.Raw,
  };
}

/**
 * Wait for what a package asked an operator for.
 *
 * Some of what a package applies is a request rather than a workload:
 * a bucket, the keys to it, a whole SeaweedFS cluster. The operator
 * says when it has done what was asked by setting the resource's
 * "Ready" condition, which is a thing "rollout status" can't see.
 *
 * @param definition
 * @returns
 */
function buildReadyCommand(definition: PackageDefinition): CommandSpec {
  const namespace = quoteForShell(definition.namespace);

  return {
    name: `ready-${definition.name}`,
    description: `Wait for what ${definition.name} asked for to be ready`,
    purpose: CommandPurpose.Settle,
    runOn: CommandTarget.ControlPlane,
    env: buildKubeEnv,
    command: (definition.ready ?? []).map(
      (resource) =>
        `kubectl -n ${namespace} wait ${quoteForShell(resource)} --for=condition=Ready --timeout=${READY_TIMEOUT} || { echo "${resource} in ${definition.namespace} isn't ready" >&2; kubectl -n ${namespace} describe ${quoteForShell(resource)} >&2; exit 1; }`,
    ),
    output: OutputType.Raw,
  };
}

/**
 * Check what a package asked an operator for is ready, without
 * waiting for it.
 *
 * @param definition
 * @returns
 */
function buildVerifyReadyCommand(definition: PackageDefinition): CommandSpec {
  const namespace = quoteForShell(definition.namespace);

  return {
    name: `verify-ready-${definition.name}`,
    description: `Verify what ${definition.name} asked for is ready`,
    purpose: CommandPurpose.Verify,
    runOn: CommandTarget.ControlPlane,
    env: buildKubeEnv,
    command: [
      "failed=",
      ...(definition.ready ?? []).flatMap((resource) => [
        `state=$(kubectl -n ${namespace} get ${quoteForShell(resource)} -o jsonpath='{.status.conditions[?(@.type=="Ready")].status}' 2>/dev/null)`,
        `case "$state" in`,
        `  True) echo "  ${resource}: ready" ;;`,
        `  "") echo "  ${resource}: missing, or not reporting yet" >&2; failed=yes ;;`,
        `  *) echo "  ${resource}: not ready" >&2; failed=yes ;;`,
        "esac",
      ]),
      `[ -z "$failed" ] || { echo "Not everything ${definition.name} asked for is ready" >&2; exit 1; }`,
    ],
    output: OutputType.Raw,
  };
}

/**
 * How to tell whether a package is on the cluster at all.
 *
 * Its Helm release, for a package that's a chart. For one that's only
 * manifests, the first workload it says to wait for: what makes it an
 * application rather than a few objects. A package with neither has
 * nothing that says it's there, and isn't asked about.
 *
 * @param definition
 * @returns a shell test that succeeds when it's there, and what's
 *   missing when it isn't
 */
export function buildPresenceProbe(
  definition: PackageDefinition,
): { probe: string; missing: string } | undefined {
  const namespace = quoteForShell(definition.namespace);

  if (definition.chart !== undefined) {
    const release = getReleaseName(definition);
    return {
      probe: `helm status ${quoteForShell(release)} --namespace ${namespace} > /dev/null 2>&1`,
      missing: `there's no Helm release "${release}" in ${definition.namespace}`,
    };
  }

  const workload = definition.rollout?.[0];
  if (workload !== undefined) {
    return {
      probe: `kubectl -n ${namespace} get ${quoteForShell(workload)} > /dev/null 2>&1`,
      missing: `there's no ${workload} in ${definition.namespace}`,
    };
  }

  return undefined;
}

/**
 * The name of a package's check that it's installed.
 *
 * @param definition
 * @returns
 */
function getPresenceCheckName(definition: PackageDefinition): string {
  return `verify-installed-${definition.name}`;
}

/**
 * Check a package is on the cluster, before asking how it is.
 *
 * Straight after installing it, it always is. The point is everything
 * else: a check-up of a cluster where a package the configuration
 * enables isn't there at all. Without this every check it has fails
 * in turn — no secrets, no rollout, no sign-in — and none of them says
 * the one thing that's true, which is that it isn't installed. With
 * it, that's said once, and the rest are skipped.
 *
 * @param definition
 * @returns nothing for a package there's no way of asking about
 */
function buildPresenceCommand(definition: PackageDefinition): CommandSpec | undefined {
  const presence = buildPresenceProbe(definition);
  if (presence === undefined) {
    return undefined;
  }

  return {
    name: getPresenceCheckName(definition),
    description: `Verify ${definition.name} is installed`,
    purpose: CommandPurpose.Verify,
    runOn: CommandTarget.ControlPlane,
    env: buildHelmEnv,
    command: [
      `${presence.probe} || { echo "${definition.name} isn't installed: ${presence.missing}. Install it with the helm-charts bundle or \"run-bundle ${definition.name}\", or take it out of \"packages\" if it isn't wanted." >&2; exit 1; }`,
      `echo "${definition.name} is installed"`,
    ],
    output: OutputType.Raw,
  };
}

/**
 * Skip a check when its package turned out not to be installed.
 *
 * @param spec
 * @param definition
 * @returns
 */
function whenInstalled(spec: CommandSpec, definition: PackageDefinition): CommandSpec {
  const original = spec.skipWhen;
  const presence = getPresenceCheckName(definition);

  return {
    ...spec,
    skipWhen: (config: CloudConfig, context: any, results: any) =>
      results?.[presence]?.error === true ||
      (typeof original === "function" && original(config, context, results) === true),
  };
}

/**
 * Everything that installs one package, in order.
 *
 * Shared by the bundle that installs every configured package and by
 * the bundles that install one on its own, so the two can't come to
 * disagree about what installing a package means.
 *
 * @param definition
 * @param madeSecrets credentials already made earlier in the same
 *   run, keyed by namespace and name — and the mail server's, by
 *   namespace — so a credential two packages both need is made once.
 *   Added to as this goes.
 * @returns
 */
export function buildPackageCommands(
  definition: PackageDefinition,
  madeSecrets: Set<string> = new Set(),
): CommandSpec[] {
  const commands: CommandSpec[] = [];

  const { authentik, gate } = definition;

  // Said before anything is installed, so an application isn't left
  // running with nothing anyone can sign in to it through
  if (authentik !== undefined || gate !== undefined) {
    commands.push(buildRequireAuthentikCommand(definition.name));
  }

  // What the chart needs to find already there. Authentik's database
  // is the example: the chart won't come up without one, and the
  // resource type it's written in arrives with CloudNativePG, which
  // the ordering has already installed.
  for (const manifest of definition.manifests?.before ?? []) {
    commands.push(buildManifestCommand(definition, manifest, "before"));
  }

  // The credentials the chart and the manifests below refer to. Ahead
  // of both, because a role whose Secret isn't there yet is a role
  // that doesn't get made, and a pod whose Secret isn't there yet
  // never starts — which a chart installed with --wait then waits on
  // until it gives up. Headlamp reads its client's credentials as it
  // starts, for one.
  const secrets = [
    ...(definition.secrets ?? []),
    ...(gate !== undefined ? getGateSecrets(gate) : []),
  ];
  // A chart's namespace would otherwise only be made by the chart,
  // which now comes after its credentials
  if (definition.chart !== undefined && secrets.some((secret) => secret.namespace === undefined)) {
    commands.push(buildEnsureNamespaceCommand(definition));
  }

  for (const secret of secrets) {
    const where = `${secret.namespace ?? definition.namespace}/${secret.name}`;

    if (madeSecrets.has(where)) {
      continue;
    }

    madeSecrets.add(where);
    commands.push(buildCreateSecretCommand(secret, definition.namespace));
  }

  // Authentik is told about the client as soon as its Secret exists,
  // and before the application starts. oauth2-proxy reads Authentik's
  // discovery document for its application as it starts and gives up
  // if there isn't one, so the other way round is a crash loop that
  // only ends when the back off happens to line up.
  if (authentik !== undefined) {
    commands.push(
      buildApplyBlueprintCommand(
        definition.name,
        authentik,
        definition.namespace,
        blueprintFromFile(authentik.blueprint),
      ),
    );
  }

  if (gate !== undefined) {
    commands.push(
      buildApplyBlueprintCommand(
        `${definition.name}-gate`,
        getGateClient(gate),
        definition.namespace,
        buildGateBlueprint(gate),
      ),
    );
  }

  // The namespace's mail credentials, which the manifests below refer
  // to — or their removal, for a namespace whose mail was taken away.
  // Once per namespace, like the generated credentials above.
  const mailKey = `mail:${definition.namespace}`;
  const sendsMail = definition.mail === true && !madeSecrets.has(mailKey);
  if (sendsMail) {
    madeSecrets.add(mailKey);
    commands.push(buildApplyMailSecretCommand(definition.namespace));
  }

  // The chart, once everything it reads is there
  const { chart } = definition;
  if (chart !== undefined) {
    const charted = { ...definition, chart };
    commands.push(buildAddRepoCommand(charted));

    if (hasValues(definition)) {
      commands.push(buildWriteValuesCommand(definition));
    }

    commands.push(buildInstallCommand(charted));
  }

  // And what belongs with it but isn't in it
  for (const manifest of definition.manifests?.after ?? []) {
    commands.push(buildManifestCommand(definition, manifest, "after"));
  }

  // The gate last, since it only forwards to what's above
  if (gate !== undefined) {
    commands.push(
      buildManifestCommand(
        definition,
        "gate/OAuth2Proxy.yaml",
        "after",
        buildGateManifest(gate, definition.namespace),
      ),
    );
  }

  // Whether it's there at all, and the package's own checks only if
  // it is. The mail checks belong to the namespace rather than to the
  // package, so they're asked either way.
  const presence = buildPresenceCommand(definition);
  if (presence !== undefined) {
    commands.push(presence);
  }

  const ifInstalled = (spec: CommandSpec) =>
    presence !== undefined ? whenInstalled(spec, definition) : spec;

  if (secrets.length > 0) {
    commands.push(
      ifInstalled(buildVerifySecretsCommand(secrets, definition.namespace, definition.name)),
    );
  }

  if (sendsMail) {
    commands.push(buildVerifyMailSecretCommand(definition.namespace));
  }

  // Whether the namespace's mail server can be reached at all
  if (sendsMail) {
    commands.push(buildVerifyMailReachableCommand(definition.namespace));
  }

  if (definition.chart !== undefined) {
    commands.push(ifInstalled(buildVerifyCommand(definition)));
  }

  // Before the workloads, since those are what use it: Lago starts
  // once the keys to its bucket are there
  if ((definition.ready ?? []).length > 0) {
    commands.push(ifInstalled(buildReadyCommand(definition)));
    commands.push(ifInstalled(buildVerifyReadyCommand(definition)));
  }

  // The gate's own Deployment is waited for like the package's
  const rollout = [
    ...(definition.rollout ?? []),
    ...(gate !== undefined ? [`deployment/${getGateName(gate)}`] : []),
  ];
  if (rollout.length > 0) {
    commands.push(ifInstalled(buildRolloutCommand({ ...definition, rollout })));
    commands.push(ifInstalled(buildVerifyRolloutCommand({ ...definition, rollout })));
  }

  if (authentik !== undefined) {
    commands.push(ifInstalled(buildVerifyAuthentikCommand(definition.name, authentik)));
  }

  if (gate !== undefined) {
    commands.push(
      ifInstalled(buildVerifyAuthentikCommand(`${definition.name}-gate`, getGateClient(gate))),
    );
  }

  return commands;
}

/**
 * Say what's on the cluster that the configuration doesn't enable.
 *
 * The other half of the presence checks. Those ask whether what's
 * configured is there; this asks the reverse, of every package in the
 * catalogue that isn't enabled. One installed on its own with
 * run-bundle, or left behind when it was taken out of "packages", is
 * running and nothing else would mention it.
 *
 * A report rather than a check, since it may well be meant: a package
 * installed on its own is still a package somebody wanted.
 *
 * @param config
 * @returns
 */
export function buildPackageInventoryCommand(config: CloudConfig): CommandSpec {
  const enabled = new Set(resolveInstallOrder(config).map((definition) => definition.name));
  const selections = getPackageSelections(config);

  const others = packageCatalogue
    .filter((definition) => !enabled.has(definition.name))
    .flatMap((definition) => {
      const resolved = resolvePackage(definition.name, selections[definition.name]);
      const presence = buildPresenceProbe(resolved);
      return presence !== undefined ? [{ name: definition.name, probe: presence.probe }] : [];
    });

  return {
    name: "inventory-packages",
    description: "Report packages on the cluster that the configuration doesn't enable",
    purpose: CommandPurpose.Inspect,
    runOn: CommandTarget.ControlPlane,
    env: buildHelmEnv,
    command: [
      "true",
      ...others.map(({ name, probe }) => `if ${probe}; then echo "unconfigured|${name}"; fi`),
    ],
    output: OutputType.Raw,
    postProcessHooks: [
      (output: any) => readRecordsOfKind(output, "unconfigured").map((fields) => field(fields, 0)),
    ],
    saveToContext: (output: any) => {
      const unconfigured: string[] = output.processed ?? [];

      if (unconfigured.length === 0) {
        console.log(`  Nothing installed that the configuration doesn't enable`);
      }

      for (const name of unconfigured) {
        console.log(
          `  ⚠️  ${name} is installed and isn't enabled under "packages", so nothing else checks it. Enable it there, or ask about it with "doctor -b ${name}".`,
        );
      }

      return { unconfiguredPackages: unconfigured };
    },
  };
}

/**
 * Build a bundle that installs one package and nothing else.
 *
 * Nothing it requires is installed along with it. This is for adding
 * an application to a cluster that already has its foundations, and
 * re-running the whole chart bundle to get one more application would
 * upgrade everything else in passing. What it needs is checked
 * instead, by the package's own commands and the manifests failing
 * to apply.
 *
 * The configuration still counts: a version, a namespace or a values
 * file it gives for the package is used here as it would be by
 * "helm-charts".
 *
 * @param name the package
 * @returns the bundle's commands, as a function of the configuration
 */
export function buildSinglePackageBundle(name: string) {
  return (config: CloudConfig): CommandSpec[] => {
    const definition = resolvePackage(name, getPackageSelections(config)[name]);

    const commands: CommandSpec[] = [
      {
        name: `require-cluster-${name}`,
        purpose: CommandPurpose.Require,
        description: `Check the namespace ${name} goes in is there`,
        runOn: CommandTarget.ControlPlane,
        env: buildKubeEnv,
        command: `kubectl get namespace ${quoteForShell(definition.namespace)} > /dev/null || { echo "There's no ${definition.namespace} namespace to install ${name} into. It comes with ${(definition.requires ?? []).join(", ") || "the cluster's foundations"} — install that first, or use the \\"helm-charts\\" bundle with ${name} enabled, which installs what it needs." >&2; exit 1; }`,
        output: OutputType.Raw,
      },
    ];

    if (definition.chart !== undefined) {
      commands.push(checkHelmAvailableCommand);
    }

    return [...commands, ...buildPackageCommands(definition)];
  };
}

/**
 * Build the bundle that installs a cluster's charts.
 *
 * Built from the configuration rather than fixed, because only the
 * configuration knows which packages a cluster wants — and, through
 * their dependencies, which others come with them.
 *
 * @param config
 * @returns
 */
export function HelmCommands(config: CloudConfig): CommandSpec[] {
  const ordered = resolveInstallOrder(config);

  // Credentials are identified by where they go, not by who asked for
  // them, so two packages naming the same one mean one secret and not
  // two. Without this they produce two commands of the same name — and
  // a command's name is the key its result is kept under, so the
  // second would quietly replace the first.
  const madeSecrets = new Set<string>();

  if (ordered.length === 0) {
    return [
      {
        name: "no-packages-configured",
        purpose: CommandPurpose.Inspect,
        description: "Report that no packages are configured",
        runOn: CommandTarget.ControlPlane,
        command:
          'echo "No packages are enabled in the configuration. Add them under \\"packages\\"."',
        output: OutputType.Raw,
      },
      buildPackageInventoryCommand(config),
    ];
  }

  console.log(`Packages, in the order they'll be installed: ${ordered.map((entry) => entry.name).join(" → ")}`);

  const commands: CommandSpec[] = [
    checkHelmAvailableCommand,
    readStorageShapesCommand,
  ];

  for (const definition of ordered) {
    commands.push(...buildPackageCommands(definition, madeSecrets));
  }

  commands.push(buildPackageInventoryCommand(config));

  return commands;
}
