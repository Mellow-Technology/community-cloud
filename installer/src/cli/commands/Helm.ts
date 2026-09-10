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
import { CommandSpec, CommandTarget, OutputType } from "./Command.ts";
import CloudConfig from "../../util/CloudConfig.ts";
import { quoteForShell } from "../../util/shell.ts";
import { renderRepoFile } from "../../util/template.ts";
import { buildHelmEnv } from "./Helm.install.ts";
import {
  PackageDefinition,
  getPackageSelections,
  resolveInstallOrder,
  valuesFileIsFromConfig,
} from "./packages.ts";

// Where rendered values files are put on the control plane. They can
// carry secrets, so the directory is the installing user's own.
const WORK_DIR = "/tmp/cc-helm";

// How long to give a chart to come up
const READY_TIMEOUT = "10m";

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
 * @param fromConfig
 * @returns
 */
function buildWriteValuesCommand(
  definition: PackageDefinition,
  fromConfig: boolean,
): CommandSpec {
  return {
    name: `helm-values-${definition.name}`,
    description: `Write the rendered values for ${definition.name}`,
    runOn: CommandTarget.ControlPlane,
    command: (config: CloudConfig) => {
      const rendered = renderRepoFile(config, definition.valuesFile as string, fromConfig);
      const path = getValuesPath(definition);

      return [
        `mkdir -p ${WORK_DIR}`,
        `chmod 0700 ${WORK_DIR}`,
        `printf '%s' ${quoteForShell(rendered)} > ${path}`,
        `chmod 0600 ${path}`,
        `echo "wrote ${path}"`,
      ].join("\n");
    },
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
    description: `Verify ${definition.name} is deployed`,
    runOn: CommandTarget.ControlPlane,
    env: buildHelmEnv,
    command: [
      `status=$(helm status ${release} --namespace ${namespace} -o json 2>/dev/null | tr -d " \\n" | sed -n 's/.*"status":"\\([a-z]*\\)".*/\\1/p')`,
      `echo "${definition.name}: $status"`,
      `[ "$status" = "deployed" ] || { echo "${definition.name} is \\"$status\\", not deployed" >&2; helm status ${release} --namespace ${namespace} >&2; exit 1; }`,
    ].join("\n"),
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
  const selections = getPackageSelections(config);
  const ordered = resolveInstallOrder(config);

  if (ordered.length === 0) {
    return [
      {
        name: "no-packages-configured",
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
      description: "Check Helm is installed on the control plane",
      runOn: CommandTarget.ControlPlane,
      env: buildHelmEnv,
      command:
        'command -v helm > /dev/null 2>&1 || { echo "Helm isn\'t installed on the control plane. Run the \\"helm\\" bundle first." >&2; exit 1; }\nhelm version --short',
      output: OutputType.Raw,
    },
  ];

  for (const definition of ordered) {
    commands.push(buildAddRepoCommand(definition));

    if (definition.valuesFile !== undefined) {
      commands.push(
        buildWriteValuesCommand(definition, valuesFileIsFromConfig(selections[definition.name])),
      );
    }

    commands.push(buildInstallCommand(definition));
    commands.push(buildVerifyCommand(definition));
  }

  return commands;
}
