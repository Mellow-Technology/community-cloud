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
  resolveInstallOrder,
} from "./packages.ts";

// Where rendered values files are put on the control plane. They can
// carry secrets, so the directory is the installing user's own.
const WORK_DIR = "/tmp/cc-helm";

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
 * The release name for a package, which is its own name unless it
 * asked for something else.
 *
 * @param definition
 * @returns
 */
function getReleaseName(definition: PackageDefinition): string {
  return definition.releaseName !== undefined ? definition.releaseName : definition.name;
}

/**
 * The name Helm knows the repository by. Derived from the package so
 * two packages from one repository don't add it twice under different
 * names.
 *
 * @param definition
 * @returns
 */
function getRepoName(definition: PackageDefinition): string {
  return `cc-${definition.chart.name}`;
}

/**
 * Where a package's rendered values file lands.
 *
 * @param definition
 * @returns
 */
function getValuesPath(definition: PackageDefinition): string {
  return `${WORK_DIR}/${definition.name}.values.yaml`;
}

/**
 * Add the chart's repository.
 *
 * @param definition
 * @returns
 */
function buildAddRepoCommand(definition: PackageDefinition): CommandSpec {
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
      renderInstallerFile(config, definition.valuesFile as string, context),
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
 * @param manifest
 * @param when
 * @returns
 */
function buildManifestCommand(
  definition: PackageDefinition,
  manifest: string,
  when: string,
): CommandSpec {
  const path = `${WORK_DIR}/${definition.name}-${getManifestName(manifest)}.yaml`;
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
    stdin: (config: CloudConfig, context: any) =>
      renderInstallerFile(config, manifest, context),
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
function buildInstallCommand(definition: PackageDefinition): CommandSpec {
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

      if (definition.valuesFile !== undefined) {
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
    {
      name: "check-helm-available",
      purpose: CommandPurpose.Require,
      description: "Check Helm is installed on the control plane",
      runOn: CommandTarget.ControlPlane,
      env: buildHelmEnv,
      command:
        'command -v helm > /dev/null 2>&1 || { echo "Helm isn\'t installed on the control plane. Run the \\"helm\\" bundle first." >&2; exit 1; }\nhelm version --short',
      output: OutputType.Raw,
    },
    readStorageShapesCommand,
  ];

  for (const definition of ordered) {
    // What the chart needs to find already there. Authentik's database
    // is the example: the chart won't come up without one, and the
    // resource type it's written in arrives with CloudNativePG, which
    // the ordering above has already installed.
    for (const manifest of definition.manifests?.before ?? []) {
      commands.push(buildManifestCommand(definition, manifest, "before"));
    }

    commands.push(buildAddRepoCommand(definition));

    if (definition.valuesFile !== undefined) {
      commands.push(buildWriteValuesCommand(definition));
    }

    commands.push(buildInstallCommand(definition));

    // The credentials the manifests below refer to. Ahead of them,
    // because a role whose Secret isn't there yet is a role that
    // doesn't get made, and behind the chart, because the namespaces
    // these go in belong to the package rather than to this step.
    const secrets = definition.secrets ?? [];
    for (const secret of secrets) {
      commands.push(buildCreateSecretCommand(secret, definition.namespace));
    }

    // And what belongs with it but isn't in it
    for (const manifest of definition.manifests?.after ?? []) {
      commands.push(buildManifestCommand(definition, manifest, "after"));
    }

    if (secrets.length > 0) {
      commands.push(
        buildVerifySecretsCommand(secrets, definition.namespace, definition.name),
      );
    }

    commands.push(buildVerifyCommand(definition));
  }

  return commands;
}
