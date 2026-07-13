import Command, { OutputType } from "./Command.ts";
import { CommandBundle } from "./CommandBundle.ts";

const bundle = new CommandBundle();

/**
 * Find disks that can be used with LVM.
 */
bundle.add(
  new Command({
    name: "install-k3s-agent",
    description: "Install K3s agent on the node",
    command: (context) => {
      const { k3sUrl, k3sToken } = context;
      return `curl - sfL https://get.k3s.io | K3S_URL=${k3sUrl} K3S_TOKEN=${k3sToken} INSTALL_K3S_EXEC="agent --flannel-iface=tailscale0" sh -`;
    },
    output: OutputType.Json,
  }),
);

export const K3sBundle = bundle;
