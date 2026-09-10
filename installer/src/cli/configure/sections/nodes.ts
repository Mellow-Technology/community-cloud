/**
 * @file
 * The machines the cluster runs on.
 *
 * This is the section with real consequences: a node's roles decide
 * what gets scheduled onto it, its type decides whether it's a server
 * or an agent, and its address is what the installer will try to SSH
 * to. So it's a list you manage rather than a run of questions —
 * adding one node to an eight node cluster shouldn't mean answering
 * forty prompts.
 */
import { checkbox, confirm, input, select } from "@inquirer/prompts";

import {
  ConfigDraft,
  ConfigSection,
  NOTHING_SET,
  countOf,
  readPath,
  required,
  validateNodeName,
  writePath,
} from "../section.ts";
import { K3SInstallationType, NodeRole } from "../../../util/types.ts";

/**
 * What each role is for, so the checkbox is readable by someone who
 * hasn't memorised the list.
 */
const ROLE_DESCRIPTIONS: Record<string, string> = {
  [NodeRole.Worker]: "General purpose workloads",
  [NodeRole.WorkerGPU]: "Workloads needing a GPU. Added automatically when one is detected.",
  [NodeRole.Gateway]: "Publicly routable, carries traffic into the cluster",
  [NodeRole.Lighthouse]: "Helps nodes find each other across networks",
  [NodeRole.StorageLocal]: "Node local storage, through TopoLVM",
  [NodeRole.StorageDistributed]: "Takes part in a distributed storage pool",
  [NodeRole.Storage]: "Runs the storage controllers",
};

/**
 * The nodes in a draft.
 *
 * @param draft
 * @returns
 */
function getNodes(draft: ConfigDraft): any[] {
  const nodes = readPath(draft, "nodes");
  // Empty entries have crept into configurations before now
  return Array.isArray(nodes) ? nodes.filter((node) => node !== null && typeof node === "object" && Object.keys(node).length > 0) : [];
}

/**
 * Ask about one node, starting from whatever it already says.
 *
 * @param draft
 * @param node
 * @returns
 */
async function askAboutNode(draft: ConfigDraft, node: any = {}): Promise<any> {
  const answers: any = { ...node };

  answers.name = (
    await input({
      message: "Node name, as the cluster will know it",
      default: node.name,
      validate: validateNodeName,
    })
  ).trim().toLowerCase();

  answers.address = (
    await input({
      message: "How should the installer reach it over SSH? (hostname, IP, or a ~/.ssh/config alias)",
      default: node.address !== undefined ? node.address : answers.name,
      validate: required("an address"),
    })
  ).trim();

  const apiAddress = (
    await input({
      message: "Address other nodes use to reach it, if different (leave blank to use the above)",
      default: node.apiAddress !== undefined ? node.apiAddress : "",
    })
  ).trim();
  if (apiAddress !== "") {
    answers.apiAddress = apiAddress;
  }
  else {
    delete answers.apiAddress;
  }

  const username = (
    await input({
      message: "SSH username (leave blank to use whatever ~/.ssh/config says)",
      default: node.username !== undefined ? node.username : "",
    })
  ).trim();
  if (username !== "") {
    answers.username = username;
  }
  else {
    delete answers.username;
  }

  answers.type = await select({
    message: "Is this a K3s server or an agent?",
    default: node.type !== undefined ? node.type : K3SInstallationType.Agent,
    choices: [
      {
        name: "Server (control plane)",
        value: K3SInstallationType.Server,
        description: "Runs the Kubernetes API. A cluster needs at least one.",
      },
      {
        name: "Agent (worker)",
        value: K3SInstallationType.Agent,
        description: "Joins the cluster and runs workloads.",
      },
    ],
  });

  answers.roles = await checkbox({
    message: "What is this node for?",
    choices: Object.values(NodeRole).map((role) => ({
      name: role,
      value: role,
      description: ROLE_DESCRIPTIONS[role],
      checked: Array.isArray(node.roles) ? node.roles.includes(role) : role === NodeRole.Worker,
    })),
  });

  answers.gateway = answers.roles.includes(NodeRole.Gateway);

  const regions = Array.isArray(readPath(draft, "regions")) ? (readPath(draft, "regions") as any[]) : [];
  if (regions.length > 0) {
    answers.region = await select({
      message: "Which region is it in?",
      default: node.region,
      choices: regions.map((region: any) => ({ name: region.name, value: region.value })),
    });

    answers.zone = (
      await input({
        message: "Which zone? A single physical location within the region",
        default: node.zone !== undefined ? node.zone : `${answers.region}-0`,
        validate: required("a zone"),
      })
    ).trim();
  }

  // Roles moved out of "labels", which is now free-form. Anything left
  // in the old shape would be read as roles, so it's cleared once the
  // roles have been asked about properly.
  if (Array.isArray(answers.labels)) {
    delete answers.labels;
  }

  return answers;
}

export const nodesSection: ConfigSection = {
  name: "nodes",
  title: "Nodes",

  describe: (draft) => {
    const nodes = getNodes(draft);

    if (nodes.length === 0) {
      return NOTHING_SET;
    }

    const servers = nodes.filter((node) => node.type === K3SInstallationType.Server).length;
    return `${countOf(nodes.length, "node")}, ${countOf(servers, "server")}`;
  },

  run: async (draft: ConfigDraft) => {
    const nodes = getNodes(draft);

    let done = false;
    while (!done) {
      const choices: any[] = nodes.map((node, index) => ({
        name: `${node.name}  (${node.type ?? "no type"}, ${Array.isArray(node.roles) ? node.roles.join(" ") : "no roles"})`,
        value: `edit:${index}`,
      }));

      choices.push({ name: "＋ Add a node", value: "add" });

      if (nodes.length > 0) {
        choices.push({ name: "－ Remove a node", value: "remove" });
      }

      choices.push({ name: "Done with nodes", value: "done" });

      const action = await select({
        message: nodes.length === 0 ? "No nodes yet" : `${countOf(nodes.length, "node")} configured`,
        choices,
      });

      if (action === "done") {
        done = true;
        continue;
      }

      if (action === "add") {
        nodes.push(await askAboutNode(draft));
        continue;
      }

      if (action === "remove") {
        const index = await select({
          message: "Which node should go?",
          choices: nodes.map((node, position) => ({ name: node.name, value: position })),
        });

        const confirmed = await confirm({
          message: `Remove ${nodes[index].name}? This only changes the configuration; the machine is left alone.`,
          default: false,
        });

        if (confirmed) {
          nodes.splice(index, 1);
        }

        continue;
      }

      const index = Number.parseInt(action.split(":")[1] as string, 10);
      nodes[index] = await askAboutNode(draft, nodes[index]);
    }

    writePath(draft, "nodes", nodes);

    // A cluster with no server has nothing to install onto, and it's
    // better to say so now than when the first bundle runs
    if (nodes.length > 0 && !nodes.some((node) => node.type === K3SInstallationType.Server)) {
      console.log("\n  ⚠️  None of these nodes is a server, so there's no control plane. Mark one as a server before installing.\n");
    }
  },
};
