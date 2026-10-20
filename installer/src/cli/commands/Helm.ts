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
import { readLines } from "./output.ts";
import { buildHelmEnv } from "./Helm.install.ts";
import {
  buildCreateSecretCommand,
  buildVerifySecretsCommand,
} from "./Secrets.ts";
import {
  PackageDefinition,
  getPackageSelections,
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
        `{ kubectl apply -f ${quoted} && applied=yes; }`,
        getWaitSeconds(context, MANIFEST_TIMEOUT_SECONDS),
      ),
      `[ "$applied" = "yes" ] || kubectl apply -f ${quoted} || { echo "Couldn't apply ${manifest} for ${definition.name}" >&2; rm -f ${quoted}; exit 1; }`,
      `rm -f ${quoted}`,
    ],
    stdin: render,
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
      `status=$(helm status ${release} --namespace ${namespace} -o json 2>/dev/null | tr -d " \\n" | sed -n 's/.*"status":"\\([a-z]*\\)".*/\\1/p')`,
      `echo "${definition.name}: $status"`,
      `[ "$status" = "deployed" ] || { echo "${definition.name} is \\"$status\\", not deployed" >&2; helm status ${release} --namespace ${namespace} >&2; exit 1; }`,
    ],
    output: OutputType.Raw,
  };
}

/**
 * Wait for a package's own workloads to come up.
 *
 * A Settle rather than a Verify, because the first start can be slow
 * for reasons that are nobody's fault: Invoice Ninja migrates and
 * seeds its database before it opens a port, and that takes minutes
 * on a quiet machine.
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

  const { chart } = definition;
  if (chart !== undefined) {
    const charted = { ...definition, chart };
    commands.push(buildAddRepoCommand(charted));

    if (hasValues(definition)) {
      commands.push(buildWriteValuesCommand(definition));
    }

    commands.push(buildInstallCommand(charted));
  }

  // The credentials the manifests below refer to. Ahead of them,
  // because a role whose Secret isn't there yet is a role that
  // doesn't get made, and behind the chart, because the namespaces
  // these go in belong to the package rather than to this step.
  const secrets = [
    ...(definition.secrets ?? []),
    ...(gate !== undefined ? getGateSecrets(gate) : []),
  ];
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

  if (secrets.length > 0) {
    commands.push(
      buildVerifySecretsCommand(secrets, definition.namespace, definition.name),
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
    commands.push(buildVerifyCommand(definition));
  }

  // The gate's own Deployment is waited for like the package's
  const rollout = [
    ...(definition.rollout ?? []),
    ...(gate !== undefined ? [`deployment/${getGateName(gate)}`] : []),
  ];
  if (rollout.length > 0) {
    commands.push(buildRolloutCommand({ ...definition, rollout }));
    commands.push(buildVerifyRolloutCommand({ ...definition, rollout }));
  }

  if (authentik !== undefined) {
    commands.push(buildVerifyAuthentikCommand(definition.name, authentik));
  }

  if (gate !== undefined) {
    commands.push(buildVerifyAuthentikCommand(`${definition.name}-gate`, getGateClient(gate)));
  }

  return commands;
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

  return commands;
}
