/**
 * @file
 * Allows running of kubectl
 */
import { OutputType } from "./Command.ts";


export const KubeCtlCommands = [
  {
    name: "install-k3s-agent",
    description: "Install K3s agent on the node",
    command: (config) => {
      const k3sUrl = config.getControlPlaneUrl();
      const k3sToken = config.config.k3s.token;

        const operation = "apply";

      // We use stdin
      return `kubectl ${operation} -f -`;
    },
    output: OutputType.Raw,
  },
]
