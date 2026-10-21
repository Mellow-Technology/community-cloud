/**
 * @file
 * How the cluster talks to itself: the CNI, the mesh that carries
 * traffic between sites, and the kernel settings underneath both.
 */
import { input, password, select } from "@inquirer/prompts";

import {
  ConfigDraft,
  ConfigSection,
  NOTHING_SET,
  readPath,
  writePath,
} from "../section.ts";
import { API_KEY_ENV, DEFAULT_ROLE } from "../../commands/NebulaNetwork.ts";

export const networkingSection: ConfigSection = {
  name: "networking",
  title: "Networking",

  describe: (draft) => {
    const parts = [];

    const congestion = readPath(draft, "network.congestionControl");
    if (congestion !== undefined) {
      parts.push(`${congestion} congestion control`);
    }

    const kubeProxy = readPath(draft, "network.cilium.kubeProxyReplacement");
    if (kubeProxy !== undefined) {
      parts.push(kubeProxy === false ? "kube-proxy runs as usual" : "Cilium replaces kube-proxy");
    }

    const nebula = readPath(draft, "network.nebula.network");
    if (nebula !== undefined) {
      parts.push(`Nebula on "${nebula}"`);
    }

    return parts.length > 0 ? parts.join(", ") : NOTHING_SET;
  },

  run: async (draft: ConfigDraft) => {
    const congestionControl = await select({
      message: "TCP congestion control for the nodes",
      default: readPath(draft, "network.congestionControl") ?? "bbr",
      choices: [
        {
          name: "BBR (Recommended)",
          value: "bbr",
          description:
            "Paces itself on measured bandwidth and round trip time. Holds throughput up over links that lose the occasional packet, which is most links between sites.",
        },
        {
          name: "CUBIC",
          value: "cubic",
          description:
            "The Linux default. Backs off hard on any packet loss, whether or not congestion caused it.",
        },
      ],
    });
    writePath(draft, "network.congestionControl", congestionControl);
    writePath(draft, "network.qdisc", congestionControl === "bbr" ? "fq" : readPath(draft, "network.qdisc"));

    const kubeProxyReplacement = await select({
      message: "Should Cilium replace kube-proxy?",
      default: readPath(draft, "network.cilium.kubeProxyReplacement") === false ? "no" : "yes",
      choices: [
        {
          name: "Yes - Cilium's eBPF datapath does the job (Recommended)",
          value: "yes",
          description: "K3s is installed without a kube-proxy and Cilium takes over.",
        },
        {
          name: "No - run kube-proxy as usual",
          value: "no",
        },
      ],
    });
    writePath(draft, "network.cilium.kubeProxyReplacement", kubeProxyReplacement === "yes");

    // Nebula, through Defined Networking
    const useNebula = await select({
      message:
        "Should nodes be joined to a Nebula mesh? (https://www.defined.net) This is how nodes in different places reach each other.",
      default: readPath(draft, "network.nebula.network") !== undefined ? "yes" : "no",
      choices: [
        { name: "Yes", value: "yes" },
        { name: "No", value: "no" },
      ],
    });

    if (useNebula === "yes") {
      const network = await input({
        message: "Name of the network, as it appears at admin.defined.net",
        default: readPath(draft, "network.nebula.network"),
      });
      writePath(draft, "network.nebula.network", network.trim());

      console.log(`
  The API key needs the networks:list, roles:list, roles:create,
  hosts:list, hosts:create and hosts:enroll scopes. Leave it blank to
  keep it out of the configuration file and supply it through the
  ${API_KEY_ENV} environment variable instead.
`);

      const apiKey = await password({
        message: "Defined Networking API key (blank to leave it out)",
        mask: true,
      });

      if (apiKey.trim() !== "") {
        writePath(draft, "network.nebula.apiKey", apiKey.trim());
      }

      writePath(
        draft,
        "network.nebula.defaultRole",
        readPath(draft, "network.nebula.defaultRole") ?? DEFAULT_ROLE,
      );
    }
  },
};
