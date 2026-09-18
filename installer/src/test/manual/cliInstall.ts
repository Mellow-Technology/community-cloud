/**
 * @file
 * Install just the pinned Cilium CLI on a node. No cluster involved.
 *
 * Not a test: it needs a real node to talk to, so it is run by hand
 * rather than by "bun test", which is why it lives under manual/.
 *
 *   bun src/test/manual/cliInstall.ts cc.config.json <node>
 */
import { CommandBundle } from "../../cli/commands/CommandBundle.ts";
import CloudConfig from "../../util/CloudConfig.ts";
import { connectToNode } from "../../runners/nodeConnection.ts";
import { CiliumCommands } from "../../cli/commands/Cilium.ts";

const config = new CloudConfig();
await config.loadConfigFromFile(process.argv[2]!);
const nodeName = process.argv[3] ?? "phoenix";
const connection = await connectToNode(config, nodeName);

const wanted = ["get-cilium-cli-version", "install-cilium-cli"];
const bundle = new CommandBundle(
  config,
  CiliumCommands.filter((c: any) => wanted.includes(c.name)),
  { nodeName, node: connection.node },
);
bundle.setExec(connection.exec);
bundle.setControlPlaneExec(connection.exec);

try { await bundle.runAllCommands(); } finally { await connection.disconnect(); }

const results = bundle.getResults();
console.log("\nversion chosen:", (results["get-cilium-cli-version"]?.stdout ?? "").trim());
console.log("what installed:", (results["install-cilium-cli"]?.stdout ?? "").trim().split("\n").pop());
process.exit(bundle.hasFailed() ? 1 : 0);
