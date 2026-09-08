import Command, { OutputType } from "./Command.ts";

/**
 * @file
 * Setup registries configuration file
 */


/**
 * Find disks that can be used with LVM.
 */
bundle.add(
  new Command({
    name: "create-k3s-dir",
    description: "Create the K3s configuration directory if it doesn't exist.",
    command: "sudo mkdir /etc/rancher/k3s",
    output: OutputType.Json,
  }),
);

bundle.add(
  new Command({
    name: "create-registries-config",
    description:
      "Create registries.yaml with registries the user has configured",
    preprocessHooks: [],
    command: "",
  }),
);
