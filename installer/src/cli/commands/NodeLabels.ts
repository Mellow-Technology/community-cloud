/**
 * @file
 * Commands for labeling nodes
 */
import { CommandSpec, OutputType } from "./Command.ts";


export const NodeLabelCommands: CommandSpec[] = [
  {
    name: "apply-node-roles",
    description: "Label nodes with configured labels",
    command: (config, context) => {
      // Get the labels
      const nodeRoleLabels = context.node.labels.map((role: string) => {
        return `node-role.kubernetes.io/${role}=${role}`;
      });

      // Produce the kubectl command
      return `kubectl label node ${context.node.name} ${nodeRoleLabels.join(" ")}`
    },
    output: OutputType.Raw
  }
];
