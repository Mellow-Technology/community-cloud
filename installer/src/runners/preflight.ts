/**
 * @file
 * Whether this configuration could be installed, before installing it.
 *
 * Two kinds of thing go wrong and only one of them needs a node. A
 * configuration naming no server, or a gateway node with no address,
 * is wrong on its own and can be said so without connecting to
 * anything. A kernel without the congestion control it's about to be
 * asked for is only findable by going and looking.
 *
 * Both are checked here, configuration first, because there's no point
 * connecting to five machines to find out the configuration never
 * described a cluster.
 *
 * Nothing here changes anything: the commands are all Require, which
 * is enforced rather than assumed.
 */
import chalk from "chalk";

import { CommandBundle, CommandResult } from "../cli/commands/CommandBundle.ts";
import { CommandPurpose } from "../cli/commands/Command.ts";
import { PreflightCommands } from "../cli/commands/Preflight.ts";
import { getNodeName } from "../cli/commands/K3s.ts";
import CloudConfig from "../util/CloudConfig.ts";
import { loadPlugins } from "../plugins/registry.ts";
import { K3SInstallationType, NodeRole } from "../util/types.ts";
import { connectToNode, NodeConnection } from "./nodeConnection.ts";

/**
 * Options for a preflight.
 *
 * - node: check this node only
 * - verbose: print each command's output as well as the report
 */
export interface PreflightOptions {
  node?: string;
  verbose?: boolean;
  timeout?: string;
}

// How long to give a node to answer before calling it unreachable. A
// walk across every node shouldn't spend the SSH default on each one
// that's switched off.
const DEFAULT_CONNECT_TIMEOUT_SECONDS = 8;

/**
 * Something that would stop an install.
 */
interface Problem {
  where: string;
  what: string;
}

/**
 * The nodes a configuration describes.
 *
 * @param config
 * @returns
 */
function getConfiguredNodes(config: CloudConfig): any[] {
  const { nodes } = config.getConfig();
  return Array.isArray(nodes) ? nodes : [];
}

// The structured token K3s issues: K10, a hex CA hash, then the user
// and password. Anything not starting "K10" is a plain shared secret
// and is taken as it is.
const STRUCTURED_TOKEN = /^K10[0-9a-f]{64}::[^:]+:.+$/;

/**
 * Whether K3s will accept this as a token.
 *
 * @param token
 * @returns
 */
function isUsableToken(token: string): boolean {
  return !token.startsWith("K10") || STRUCTURED_TOKEN.test(token);
}

/**
 * Check the configuration describes a cluster that could exist.
 *
 * None of this needs a node, which is the point: a configuration with
 * no server in it is wrong whether or not any of the machines answer.
 *
 * @param config
 * @returns everything wrong with it
 */
export function checkConfiguration(config: CloudConfig): Problem[] {
  const problems: Problem[] = [];
  const nodes = getConfiguredNodes(config);

  const say = (what: string) => problems.push({ where: "configuration", what });

  if (nodes.length === 0) {
    say('No nodes. Add them under "nodes", or run "community-cloud configure".');
    return problems;
  }

  // Exactly one server is what the rest of this assumes: the control
  // plane URL, the kubeconfig, where every kubectl command runs
  const servers = nodes.filter((node: any) => node.type === K3SInstallationType.Server);
  if (servers.length === 0) {
    say(`No node has a type of "${K3SInstallationType.Server}", so there's no control plane to install or to run kubectl on.`);
  }
  else if (servers.length > 1) {
    say(`${servers.length} nodes are servers (${servers.map((node: any) => node.name).join(", ")}). Only the first is used, so the others would be installed as servers of their own clusters.`);
  }

  const { token } = config.getConfig().k3s ?? {};
  if (token === undefined || token === "") {
    say('No K3s token under "k3s.token". The server and every agent need the same one to form a cluster.');
  }
  else if (!isUsableToken(token)) {
    // K3s treats a token beginning "K10" as the structured form and
    // takes it apart; one that looks like that and isn't fails when
    // the server starts, with "failed to normalize server token" and
    // nothing about where it came from. That is a long way from here
    // and a poor place to find out.
    say(
      'The K3s token starts with "K10", which K3s reads as its structured form — K10<CA hash>::<user>:<password> — and this one isn\'t that shape. Either use a token K3s issued, or use any other string as a shared secret.',
    );
  }

  // Names have to survive becoming Kubernetes node names
  const seen = new Map<string, string>();
  for (const node of nodes) {
    const name = getNodeName({ node });

    if (name === undefined) {
      // K3s falls back to whatever the machine calls itself, so this
      // installs fine. What it breaks is everything afterwards that
      // has to name the node — labelling it, giving it a role —
      // because the configuration can't say what it ended up as.
      say(`Node "${node.name}" has no name or address that can be a Kubernetes node name, so K3s will register it under its own hostname. The install works, but nothing can label it afterwards. Set "nodeName" on it.`);
      continue;
    }

    const already = seen.get(name);
    if (already !== undefined) {
      say(`"${node.name}" and "${already}" both register as "${name}", so the second would take over the first's place in the cluster.`);
    }
    seen.set(name, node.name);

    if (node.address === undefined || node.address === "") {
      say(`Node "${node.name}" has no address, so there's no way to reach it.`);
    }
  }

  // A gateway needs somewhere for the traffic to arrive
  const gateways = nodes.filter(
    (node: any) =>
      node.gateway === true ||
      (Array.isArray(node.roles) && node.roles.includes(NodeRole.Gateway)),
  );
  const gateway = config.getNetworkSection("gateway");
  const external = config.getNetworkSection("externalIPs");
  const hasAddresses =
    (Array.isArray(gateway.addresses) && gateway.addresses.length > 0) ||
    Object.keys(external).length > 0;

  if (gateways.length > 0 && !hasAddresses) {
    say(`${gateways.map((node: any) => node.name).join(", ")} ${gateways.length === 1 ? "is a gateway" : "are gateways"}, but no addresses are configured for them to hand out. Add them under "network.gateway.addresses".`);
  }

  if (hasAddresses && gateways.length === 0) {
    say('There are gateway addresses configured, but no node is marked as a gateway. Set "gateway": true on the nodes that can be reached from outside.');
  }

  return problems;
}

/**
 * How long to wait for a node to answer.
 *
 * @param options
 * @returns milliseconds
 */
function getConnectTimeout(options: PreflightOptions): number {
  const seconds = Number(options.timeout);

  return (Number.isFinite(seconds) && seconds > 0
    ? seconds
    : DEFAULT_CONNECT_TIMEOUT_SECONDS) * 1000;
}

/**
 * Check every node, or one of them.
 *
 * @param configPath
 * @param options
 */
export async function preflight(configPath: string, options: PreflightOptions = {}) {
  const config = new CloudConfig();
  await config.loadConfigFromFile(configPath);
  loadPlugins(config);

  const problems: Problem[] = [];
  let checks = 0;

  // The configuration first, since nothing else matters if it doesn't
  // describe a cluster
  console.log(`\n${chalk.bold("── the configuration ──")}`);
  const configProblems = checkConfiguration(config);
  problems.push(...configProblems);

  if (configProblems.length === 0) {
    console.log(`  ${chalk.green("✓")} describes a cluster that could exist`);
  }
  else {
    for (const problem of configProblems) {
      console.log(`  ${chalk.red("✗")} ${problem.what}`);
    }
  }

  const nodes =
    options.node !== undefined
      ? [config.getNode(options.node)].filter((node) => node !== null)
      : getConfiguredNodes(config);

  if (options.node !== undefined && nodes.length === 0) {
    throw new Error(
      `Couldn't find node "${options.node}" in the specified configuration. Was the name misspelled?`,
    );
  }

  for (const node of nodes) {
    console.log(`\n${chalk.bold(`── ${node.name} ──`)}`);

    let connection: NodeConnection;
    try {
      connection = await connectToNode(config, node.name, {
        timeout: getConnectTimeout(options),
      });
    } catch (error: any) {
      console.log(`  ${chalk.red("✗")} can't be reached: ${error.message}`);
      problems.push({ where: node.name, what: `unreachable: ${error.message}` });
      continue;
    }

    try {
      const bundle = new CommandBundle(config, PreflightCommands, {
        nodeName: node.name,
        node,
        params: [],

        // Nothing has been changed, so there's nothing to wait for
        noWaiting: true,
      })
        .setPurposes([CommandPurpose.Require])
        .setContinueOnFailure()
        .setQuiet(options.verbose !== true)
        .setExec(connection.exec)
        // Nothing here talks to a cluster, and there isn't one yet
        .setControlPlaneExec(connection.exec);

      await bundle.runAllCommands();

      const results = bundle.getResults();
      for (const [name, result] of Object.entries<CommandResult>(results)) {
        if (result.skipped === true) {
          continue;
        }

        checks += 1;
        if (result.error === true) {
          const why = (result.stderr !== "" ? result.stderr : "failed").split("\n")[0];
          console.log(`  ${chalk.red("✗")} ${chalk.yellow(name)}: ${why}`);
          problems.push({ where: node.name, what: `${name}: ${why}` });
        }
      }

      const failed = bundle.getFailedCommands().length;
      if (failed === 0) {
        console.log(`  ${chalk.green("✓")} ready`);
      }
    } finally {
      await connection.disconnect();
    }
  }

  console.log(
    problems.length === 0
      ? `\n${chalk.green(`Ready to install. ${checks} checks across ${nodes.length} node${nodes.length === 1 ? "" : "s"}.`)}\n`
      : `\n${chalk.red(`${problems.length} thing${problems.length === 1 ? "" : "s"} to fix`)} before installing.\n`,
  );

  if (problems.length > 0) {
    process.exitCode = 1;
  }
}
