import { OutputType } from "./Command.ts";


export const K3sCommands = [
  {
    name: "install-k3s-agent",
    description: "Install K3s agent on the node",
    command: (config) => {
      const k3sUrl = config.getControlPlaneUrl();
      const k3sToken = config.config.k3s.token;
      return `curl -sfL https://get.k3s.io | K3S_URL=${k3sUrl} K3S_TOKEN=${k3sToken} INSTALL_K3S_EXEC="agent --flannel-iface=tailscale0" sh -`;
    },
    output: OutputType.Raw,
  },
]
