/**
 * @file
 * Commands for setting up [Cilium](https://cilium.io/)
 */
import { CommandSpec, OutputType } from "./Command.ts";


const ciliumCommands: CommandSpec[] = [
  // TODO: Include Rasberry Pi support
  // Need to add some code for conditional
  // command running
  // {
  //   name: "install-rasberry-pi-deps",
  //   command: "sudo apt install linux-modules-extra-raspi"
  // },
  {
    name: "get-cilium-cli-version",
    description: "Find disks that can be used with LVM for node local storage.",
    command: "curl -s https://raw.githubusercontent.com/cilium/cilium-cli/main/stable.txt",
    output: OutputType.Json,
    postProcessHooks: [findCandidateDisks],
    // configure,
  },
  {
    name: "get-cpu-architecture",
    description: "Get the CPU architecture so that we can download the correct CLI package"
    command: "uname -m",
  },
  {
    name: "download-cilium",
    command: (context) => `curl -L --fail --remote-name-all https://github.com/cilium/cilium-cli/releases/download/${context.CILIUM_CLI_VERSION}/cilium-linux-${context.CLI_ARCH}.tar.gz{,.sha256sum}`,
  },
  {
    name: "verifiy-download",
    command: "sha256sum --check cilium-linux-${CLI_ARCH}.tar.gz.sha256sum",
  },
  {
    name: "install-cilium-cli",
    command: "sudo tar xzvfC cilium-linux-${CLI_ARCH}.tar.gz /usr/local/bin"
  },
  {
    name: "remove-cli-tarball",
    command: "rm cilium-linux-${CLI_ARCH}.tar.gz{,.sha256sum}"

  },
  {
    name: "install-cilium",
    command: 'cilium install --version 1.19.6 --set=ipam.operator.clusterPoolIPv4PodCIDRList="10.42.0.0/16" --set gatewayAPI.enabled=true --set envoy.securityContext.capabilities.keepCapNetBindService=true'
  },
  {
    name: "verify-cilum-cli",
    command: "cilium status --wait"
  }
]
