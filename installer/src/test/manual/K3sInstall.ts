/**
 * @file
 * Run a K3s install against a node, by hand.
 *
 * Not a test: it needs a real node, so it is run directly rather than
 * by "bun test".
 *
 *   bun src/test/manual/K3sInstall.ts cc.config.json <node>
 */
import { runBundle } from "../../runners/runPipeline.ts";

const configPath = process.argv[2];
const nodeName = process.argv[3];

if (configPath === undefined || nodeName === undefined) {
  console.error("Usage: bun src/test/manual/K3sInstall.ts <config> <node>");
  process.exit(1);
}

await runBundle("k3s", nodeName, configPath);
