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
import { isIP } from "node:net";

import { FAILURE, SUCCESS } from "../util/chalk.ts";
import { CommandBundle, CommandResult } from "../cli/commands/CommandBundle.ts";
import { CommandPurpose } from "../cli/commands/Command.ts";
import { PreflightCommands } from "../cli/commands/Preflight.ts";
import { getNodeName } from "../cli/commands/K3s.ts";
import { PLUGIN_HINT, getPackage, getPackageSelections } from "../cli/commands/packages.ts";
import {
  CLUSTER_GROUP_PREFIX,
  DEFAULT_CLUSTER_ADMIN_GROUP,
  getSignInClients,
  signsInThroughAuthentik,
} from "../cli/commands/ClusterSignIn.ts";
import { checkMailConfig, getMailSecurity, getNamespaceMail } from "../util/mail.ts";
import { checkDnsConfig } from "../util/dns.ts";
import { checkSchema } from "../util/configSchema.ts";
import CloudConfig from "../util/CloudConfig.ts";
import { loadPlugins } from "../plugins/registry.ts";
import { GatewayMode, K3SInstallationType, NodeRole } from "../util/types.ts";
import { connectToNode, NodeConnection } from "./nodeConnection.ts";
import { displayNode, getDisplayNames } from "../pipeline/fleet.ts";

/**
 * Options for a preflight.
 *
 * - node: check this node only
 * - verbose: print each command's output as well as the report
 * - configOnly: check the configuration and stop, without connecting
 *   to any node. For a file being written somewhere the nodes can't be
 *   reached from, or before they exist.
 */
export interface PreflightOptions {
  node?: string;
  verbose?: boolean;
  timeout?: string;
  configOnly?: boolean;
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

  // Values of the wrong type or outside what's allowed, before anything
  // below reads them and draws conclusions
  for (const problem of checkSchema(config.getConfig()).problems) {
    say(problem);
  }

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

  // The addresses a node registers on go straight to K3s, which takes
  // only an IP and says what it made of anything else in its own logs.
  // Two nodes on one address would each be the other to Cilium.
  const registered = new Map<string, string>();
  for (const node of nodes) {
    for (const key of ["nodeIp", "nodeExternalIp"]) {
      const address = node[key];

      if (address === undefined) {
        continue;
      }

      if (typeof address !== "string" || isIP(address) === 0) {
        say(`Node "${node.name}" has a "${key}" of ${JSON.stringify(address)}, which isn't an IP address. K3s takes an address here, not a name.`);
        continue;
      }

      if (key === "nodeIp") {
        const already = registered.get(address);
        if (already !== undefined) {
          say(`"${node.name}" and "${already}" both register on ${address}, so the rest of the cluster couldn't tell them apart.`);
        }
        registered.set(address, node.name);
      }
    }
  }

  // Display names are only printed, but two nodes printed the same are
  // two nodes nobody can tell apart in a report
  const shown = new Map<string, string>();
  for (const node of nodes) {
    // One that isn't text at all, the schema has already said
    if (typeof node.displayName !== "string") {
      continue;
    }

    if (node.displayName.trim() === "") {
      say(`Node "${node.name}" has a "displayName" that isn't any text. Leave it out to print the node as "${node.name}".`);
      continue;
    }

    const display = node.displayName.trim();
    const already = shown.get(display);
    if (already !== undefined) {
      say(`"${node.name}" and "${already}" are both displayed as "${display}", so nothing the installer prints could tell them apart.`);
    }
    shown.set(display, node.name);
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

  // A mail server that's half described fails later and quietly: mail
  // that never arrives, from an application that says it sent it
  for (const problem of checkMailConfig(config.getConfig())) {
    say(problem);
  }

  // DNS that would let one namespace write another's records, or
  // publish an address nobody outside can reach
  const gatewayMode = config.getNetworkSection("gateway").mode ?? GatewayMode.Floating;
  for (const problem of checkDnsConfig(config.getConfig(), gatewayMode)) {
    say(problem);
  }

  // What each enabled package's templates need. Checked here because
  // the alternative is finding out from a route with no hostname.
  // Looked up the way a template sees them: "values" laid over the
  // top of the rest of the configuration.
  const raw = config.getConfig();
  const values = { ...raw, ...(raw.values ?? {}) };
  for (const [name, selection] of Object.entries(getPackageSelections(config))) {
    const definition = getPackage(name);

    if (selection.enabled === false) {
      continue;
    }

    // One the configuration describes itself is a chart of its own
    if (definition === undefined) {
      if (selection.chart === undefined) {
        say(`"${name}" is enabled under "packages" and isn't a package Community Cloud knows about. ${PLUGIN_HINT}`);
      }
      continue;
    }

    // A gate needs its hostname and Authentik's, whether or not the
    // package's own templates do
    const needed = [
      ...(definition.values ?? []),
      ...(definition.gate !== undefined ? [definition.gate.hostname, "domain.auth"] : []),
    ];

    for (const path of new Set(needed)) {
      const value = path
        .split(".")
        .reduce((current: any, part) => (current === undefined || current === null ? undefined : current[part]), values);

      if (value === undefined || value === null || value === "") {
        say(`${name} needs "values.${path}", and it isn't set. Its manifests would render without it and apply as though nothing were wrong.`);
      }
    }

    // A connection it can't make fails as a hang, from an application
    // that says the mail is on its way
    const mail = definition.mail === true ? getNamespaceMail(raw, definition.namespace) : undefined;
    if (mail !== undefined && definition.mailSecurity !== undefined) {
      const security = getMailSecurity(mail);

      if (!definition.mailSecurity.includes(security)) {
        say(`${name} can't send mail with "security" ${security}, which ${definition.namespace}'s mail server is set to. It can use: ${definition.mailSecurity.join(", ")}.`);
      }
    }
  }

  // Signing in to the cluster through Authentik. A client the API
  // server can't make sense of stops it starting, which is a long way
  // from here to find out.
  if (signsInThroughAuthentik(config)) {
    for (const client of getSignInClients(config)) {
      if (typeof client?.application !== "string" || !/^[a-z0-9_-]+$/.test(client.application) || typeof client?.clientId !== "string" || client.clientId === "") {
        say(`"k3s.signInClients" has ${JSON.stringify(client)}, which needs an "application" slug and a "clientId".`);
      }
    }

    // Only members of a k8s-* group get in, so an administrators' group
    // named otherwise is one whose members are bound to cluster-admin
    // and can never sign in to use it
    const adminGroup = raw.values?.clusterAdminGroup ?? DEFAULT_CLUSTER_ADMIN_GROUP;
    if (typeof adminGroup !== "string" || !adminGroup.startsWith(CLUSTER_GROUP_PREFIX)) {
      say(`"values.clusterAdminGroup" is ${JSON.stringify(adminGroup)}, and only members of a group starting "${CLUSTER_GROUP_PREFIX}" may sign in to the cluster, so its members never could.`);
    }
  }

  return problems;
}

/**
 * Things in a configuration worth knowing about that don't stop an
 * install.
 *
 * Mostly settings that look meaningful and are ignored — a key that's
 * almost the right name — where everything still works, just not
 * because of the setting somebody thinks is doing it.
 *
 * @param config
 * @returns
 */
export function findConfigurationWarnings(config: CloudConfig): string[] {
  // Keys nothing reads, and older ones with somewhere better to be
  const warnings: string[] = [...checkSchema(config.getConfig()).warnings];
  const nebula = config.getNetworkSection("nebula");

  // "id" reads like the network's ID, and the setting is "networkID".
  // With a network name as well, the name finds it and nothing goes
  // wrong; without one the network can't be found at all, which the
  // Nebula bundles say for themselves.
  if (nebula !== undefined && nebula !== null && nebula.id !== undefined) {
    const fallback =
      nebula.networkID !== undefined
        ? `"networkID" is set as well, and is what's used`
        : nebula.network !== undefined
          ? `the network is found by its name, "${nebula.network}", instead`
          : "with no \"network\" or \"networkID\" either, there's no way to find the network";

    warnings.push(
      `"network.nebula.id" isn't a setting, so it's ignored — the network's ID goes in "networkID". For now ${fallback}.`,
    );
  }

  return warnings;
}

/**
 * Print what findConfigurationWarnings says.
 *
 * @param config
 */
export function printConfigurationWarnings(config: CloudConfig) {
  for (const warning of findConfigurationWarnings(config)) {
    console.log(`  ${chalk.yellow("⚠️ ")} ${warning}`);
  }
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
    console.log(`  ${SUCCESS} describes a cluster that could exist`);
  }
  else {
    for (const problem of configProblems) {
      console.log(`  ${FAILURE} ${problem.what}`);
    }
  }

  printConfigurationWarnings(config);

  if (options.configOnly === true) {
    console.log(
      configProblems.length === 0
        ? `\n${chalk.green("The configuration is ready to install.")} ${chalk.dim("No nodes were checked.")}\n`
        : `\n${chalk.red(`${configProblems.length} thing${configProblems.length === 1 ? "" : "s"} to fix`)} in the configuration.\n`,
    );

    if (configProblems.length > 0) {
      process.exitCode = 1;
    }

    return;
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

  const displayNames = getDisplayNames(config);

  for (const node of nodes) {
    console.log(`\n${chalk.bold(`── ${displayNode(displayNames, node.name)} ──`)}`);

    let connection: NodeConnection;
    try {
      connection = await connectToNode(config, node.name, {
        timeout: getConnectTimeout(options),
      });
    } catch (error: any) {
      console.log(`  ${FAILURE} can't be reached: ${error.message}`);
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
          console.log(`  ${FAILURE} ${chalk.yellow(name)}: ${why}`);
          problems.push({ where: node.name, what: `${name}: ${why}` });
        }
      }

      const failed = bundle.getFailedCommands().length;
      if (failed === 0) {
        console.log(`  ${SUCCESS} ready`);
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
