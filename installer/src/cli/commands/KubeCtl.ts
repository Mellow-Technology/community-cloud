/**
 * @file
 * Allows running of kubectl
 */
import { CommandSpec, OutputType } from "./Command.ts";

/**
 * The kubectl operations that can be run against a
 * manifest rendered from a template.
 *
 * - apply: create or update the resources in the manifest
 * - delete: remove the resources in the manifest
 */
export enum KubeCtlOperation {
  Apply = "apply",
  Delete = "delete",
}

/**
 * The name of the command which hands a manifest to kubectl.
 * Exported so callers can pick its result out of a bundle.
 */
export const KUBECTL_MANIFEST_COMMAND = "kubectl-manifest";

/**
 * Run kubectl against a manifest.
 *
 * The manifest is read from stdin rather than from a file so that
 * we never have to write a rendered template (which usually contains
 * secrets) to disk. Supplying it is the job of the exec function
 * configured on the bundle, as a bundle only ever hands the command
 * string to that function.
 *
 * Context:
 * - operation: the KubeCtlOperation to run, defaults to apply
 * - namespace: an optional namespace to scope the operation to
 */
export const KubeCtlCommands: CommandSpec[] = [
  {
    name: KUBECTL_MANIFEST_COMMAND,
    description: "Apply or delete a rendered manifest with kubectl",
    command: (config, context) => {
      const operation =
        context.operation !== undefined
          ? context.operation
          : KubeCtlOperation.Apply;

      // Namespaces in the manifest itself win over this,
      // it's only here for manifests that don't specify one
      const namespace =
        context.namespace !== undefined && context.namespace !== null
          ? ` --namespace ${context.namespace}`
          : "";

      // We use stdin
      return `kubectl ${operation}${namespace} -f -`;
    },
    output: OutputType.Raw,
  },
];
