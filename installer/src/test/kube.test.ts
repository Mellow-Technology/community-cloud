/**
 * @file
 * How commands that talk to the cluster get at a kubeconfig only root
 * can read.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import TerminalCommand from "../cli/commands/TerminalCommand.ts";
import { TerminalCommandSpec } from "../cli/commands/Command.ts";
import { CLUSTER_TOOLS, buildKubeEnv } from "../util/kube.ts";
import { configFrom } from "./helpers.ts";

const CONFIG = configFrom({ nodes: [] });

/**
 * The shell a command would send, without sending it.
 */
async function built(spec: Partial<TerminalCommandSpec>): Promise<string> {
  let text = "";
  const command = new TerminalCommand({ name: "t", description: "", ...spec } as TerminalCommandSpec);

  command.setQuiet(true);
  command.setExecFunction(async (sent: string) => {
    text = sent;
    return { stdout: "", stderr: "" };
  });

  await command.exec(CONFIG, {} as any, {});
  return text;
}

describe("a command that talks to the cluster", () => {
  it("runs every cluster tool through sudo, with the kubeconfig passed along", async () => {
    const text = await built({ env: buildKubeEnv, command: "kubectl get nodes" });

    for (const tool of CLUSTER_TOOLS) {
      assert.match(text, new RegExp(`${tool}\\(\\) \\{ sudo -n -H env KUBECONFIG="\\$KUBECONFIG"`));
    }

    // The functions have to exist before the command uses them
    assert.ok(text.indexOf("kubectl()") < text.indexOf("kubectl get nodes"));
  });

  it("passes on everything else it was given too", async () => {
    const text = await built({
      env: (config: any) => ({ ...buildKubeEnv(config), HELM_NAMESPACE: "x" }),
      command: "helm list",
    });

    assert.match(text, /env KUBECONFIG="\$KUBECONFIG" HELM_NAMESPACE="\$HELM_NAMESPACE"/);
  });

  it("is left alone when it already runs as root", async () => {
    const text = await built({ env: buildKubeEnv, command: "kubectl get nodes", sudo: true });
    assert.ok(!text.includes("kubectl()"));
  });
});

describe("a command that doesn't", () => {
  it("is left alone", async () => {
    const text = await built({ command: "uname -a" });
    assert.ok(!text.includes("sudo"));
  });
});
