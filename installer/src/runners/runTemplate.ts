/**
 * @file
 * Render a Kubernetes manifest template with values from a Community
 * Cloud configuration file and hand the result to kubectl.
 */
import { readFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import os from "os";

import { CommandBundle } from "../cli/commands/CommandBundle.ts";
import {
  KUBECTL_MANIFEST_COMMAND,
  KubeCtlCommands,
  KubeCtlOperation,
} from "../cli/commands/KubeCtl.ts";
import RemoteHost from "../remote/RemoteHost.ts";
import CloudConfig from "../util/CloudConfig.ts";
import { execWithInput } from "../util/exec.ts";
import { renderTemplate } from "../util/template.ts";

// The port a K3s API server listens on unless it's
// been configured to do otherwise
const DEFAULT_K8S_API_PORT = "6443";

/**
 * Options for a template run.
 *
 * - operation: the kubectl operation, apply or delete. Defaults to apply
 * - node: run kubectl on this node over SSH rather than locally
 * - namespace: a namespace to scope the operation to
 * - dryRun: render the template and print it without running kubectl
 */
export interface RunTemplateOptions {
  operation?: string;
  node?: string;
  namespace?: string;
  dryRun?: boolean;
}

/**
 * Apply template values from a Community Cloud
 * configuration file and then use kubectl to
 * apply or delete them
 *
 * @param yamlFilePath
 * @param configPath
 * @param options
 * @returns the rendered manifest
 */
export async function runTemplate(
  yamlFilePath: string,
  configPath: string,
  options: RunTemplateOptions = {},
): Promise<string> {
  const operation = parseOperation(options.operation);

  // Load the configuration
  const config = new CloudConfig();
  await config.loadConfigFromFile(configPath);

  // Substitute the configured values into the template
  const manifest = await renderTemplateFile(yamlFilePath, config);

  // On a dry run we show what we would have sent to
  // kubectl and stop there
  if (options.dryRun) {
    console.log(manifest);
    return manifest;
  }

  // Instantiate the context
  // The kubectl command reads the operation and the
  // namespace from here
  let context = {
    operation,
    namespace: options.namespace !== undefined ? options.namespace : null,
    templatePath: yamlFilePath,
    nodeName: options.node !== undefined ? options.node : null,
    node: null,
  };

  const bundle = new CommandBundle(config, KubeCtlCommands, context);

  // Don't use SSH if we're running directly
  // on the host already, or if no node was named at all
  const { node: nodeName } = options;
  const hostname = os.hostname();
  if (nodeName === undefined || hostname === nodeName) {
    // The manifest goes to kubectl on stdin
    bundle.setExec(execWithInput(manifest));
    await bundle.runAllCommands();
  } else {
    // Retrieve the node configuration
    const nodeInfo = config.getNode(nodeName);
    if (nodeInfo === null) {
      throw new Error(
        `Couldn't find node "${nodeName}" in the specified configuration. Was the name misspelled?`,
      );
    }

    // Add node information to the context
    context.node = nodeInfo;

    // Connect to the node via SSH
    const node = new RemoteHost({
      host: nodeInfo.address,
      username: nodeInfo.username,
      keyFile: nodeInfo.keyFile,
      port: nodeInfo.port,
    });
    await node.connect();

    try {
      // Same as locally, the manifest goes over on stdin
      bundle.setExec((command: string) => node.exec(command, undefined, manifest));
      await bundle.runAllCommands();
    } finally {
      // Disconnect from the node
      await node.disconnect();
    }
  }

  // A bundle logs command failures rather than throwing, so we
  // check the result to make sure we don't report a success we
  // didn't have
  const result = bundle.getResults()[KUBECTL_MANIFEST_COMMAND];
  if (result === undefined || result.error) {
    throw new Error(
      `Failed to ${operation} the manifest rendered from "${yamlFilePath}".`,
    );
  }

  return manifest;
}

/**
 * Read a template file and substitute the values from
 * the configuration into it.
 *
 * @param yamlFilePath
 * @param config
 * @returns
 */
async function renderTemplateFile(
  yamlFilePath: string,
  config: CloudConfig,
): Promise<string> {
  const filePath = isAbsolute(yamlFilePath)
    ? yamlFilePath
    : join(process.cwd(), yamlFilePath);

  let fileContents = null;
  try {
    fileContents = await readFile(filePath, { encoding: "utf8" });
  } catch (e: any) {
    throw new Error(
      `Couldn't read the template file "${yamlFilePath}": ${e.message}`,
    );
  }

  try {
    return renderTemplate(fileContents, buildTemplateValues(config));
  } catch (e: any) {
    throw new Error(
      `Couldn't render the template "${yamlFilePath}": ${e.message}`,
    );
  }
}

/**
 * Build the value set handed to the template renderer.
 *
 * The manifests in k8s/ are written Helm style, so everything they
 * reference is reached through ".Values". Values come from the
 * "values" section of the configuration when there is one and from
 * the top level of the configuration otherwise, which lets a
 * configuration keep its values alongside its node list or in a
 * section of their own.
 *
 * @param config
 * @returns
 */
function buildTemplateValues(config: CloudConfig) {
  const rawConfig = config.getConfig();
  const values = {
    ...rawConfig,
    ...(rawConfig.values !== undefined ? rawConfig.values : {}),
  };

  // The API server lives on the control plane node, so we derive it
  // rather than make a configuration repeat what the node list
  // already says
  if (values.k8sApiServer === undefined) {
    const controlPlane = getControlPlaneHost(config);
    if (controlPlane !== undefined) {
      values.k8sApiServer = controlPlane.address;
    }
  }

  if (values.k8sApiPort === undefined) {
    values.k8sApiPort = DEFAULT_K8S_API_PORT;
  }

  return { Values: values };
}

/**
 * Look up the control plane node, tolerating a configuration
 * that doesn't describe any nodes at all. Manifests that don't
 * reference the API server should still render for those.
 *
 * @param config
 * @returns
 */
function getControlPlaneHost(config: CloudConfig) {
  try {
    return config.getControlPlaneHost();
  } catch {
    return undefined;
  }
}

/**
 * Check that the requested operation is one we support.
 *
 * @param operation
 * @returns
 */
function parseOperation(operation?: string): KubeCtlOperation {
  if (operation === undefined) {
    return KubeCtlOperation.Apply;
  }

  const operations = Object.values(KubeCtlOperation);
  if (!operations.includes(operation as KubeCtlOperation)) {
    throw new Error(
      `"${operation}" isn't a supported kubectl operation. Supported operations are: ${operations.join(", ")}.`,
    );
  }

  return operation as KubeCtlOperation;
}
