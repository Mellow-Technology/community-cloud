/**
 * @file
 * The NVIDIA container runtime.
 *
 * K3s only looks for the runtime as it starts, and it's the gpu bundle
 * that says a node needs it, so most of what can go wrong is order: in
 * the wrong place this still installs, and K3s just never knows. The
 * rest is about nodes this has no business touching.
 *
 * The device plugin fails just as quietly. On the wrong nodes, or under
 * the wrong runtime, it's a cluster with no GPUs in it and nothing
 * reporting a problem.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parse } from "yaml";

import { getBundle, getBundleCommands, getBundleNames } from "../cli/commands/bundles.ts";
import {
  DEVICE_PLUGIN,
  DRIVER_LABEL,
  DevicePluginCommands,
  NvidiaCommands,
  TOOLKIT_VERSION,
} from "../cli/commands/Nvidia.ts";
import { CommandPurpose } from "../cli/commands/Command.ts";
import { getPackage } from "../cli/commands/packages.ts";
import { ADD_NODE_PIPELINE } from "../runners/addNode.ts";
import { INSTALL_PIPELINE } from "../runners/install.ts";
import { renderInstallerFile } from "../util/template.ts";
import { loadFixtureConfig } from "./helpers.ts";

const NVIDIA = { videoDevices: [{ vendor: "nvidia", compute: true }] };
const AMD = { videoDevices: [{ vendor: "amd", compute: true }] };

const named = (name: string) => NvidiaCommands.find((command) => command.name === name)!;

/**
 * A command's shell, as it reaches the node.
 */
function text(name: string, context: any = NVIDIA): string {
  const { command } = named(name) as any;
  const built = typeof command === "function" ? command({}, context, {}) : command;
  return Array.isArray(built) ? built.join("\n") : built;
}

describe("where the runtime goes", () => {
  for (const [name, pipeline] of [
    ["install", INSTALL_PIPELINE],
    ["add-node", ADD_NODE_PIPELINE],
  ] as const) {
    it(`comes after detection in ${name}, which says who needs it`, () => {
      assert.ok(pipeline.includes("nvidia"));
      assert.ok(pipeline.indexOf("gpu") < pipeline.indexOf("nvidia"));
    });

    it(`comes after K3s in ${name}, for the chart to have a cluster`, () => {
      assert.ok(pipeline.indexOf("k3s") < pipeline.indexOf("nvidia"));
      assert.ok(pipeline.indexOf("nodeLabels") < pipeline.indexOf("nvidia"));
    });
  }

  it("has Helm by the time it's in an install", () => {
    assert.ok(INSTALL_PIPELINE.indexOf("cilium") < INSTALL_PIPELINE.indexOf("nvidia"));
    assert.ok(INSTALL_PIPELINE.indexOf("helm") < INSTALL_PIPELINE.indexOf("nvidia"));
  });

  it("has add-node check the node after K3s has been restarted", () => {
    assert.ok(ADD_NODE_PIPELINE.indexOf("nvidia") < ADD_NODE_PIPELINE.indexOf("node-joined"));
  });

  it("is a bundle", () => {
    assert.ok(getBundleNames().includes("nvidia"));
  });
});

describe("which nodes it touches", () => {
  const every = NvidiaCommands.map((command) => command.name);

  it("does nothing on a node with no NVIDIA hardware", () => {
    for (const context of [AMD, { videoDevices: [] }, {}]) {
      for (const name of every) {
        assert.equal(named(name).skipWhen!({}, context), true, name);
      }
    }
  });

  it("does the work on a node that has it", () => {
    assert.equal(named("install-nvidia-container-toolkit").skipWhen!({}, NVIDIA), false);
    assert.equal(named("verify-nvidia-runtime").skipWhen!({}, NVIDIA), false);
  });

  it("looks for hardware itself when it's run alone", () => {
    const names = getBundleCommands(getBundle("nvidia")!, {} as any, {}).map((command: any) => command.name);
    assert.ok(names.indexOf("detect-video-hardware") < names.indexOf("install-nvidia-container-toolkit"));
  });

  it("only looks, rather than changing anything, before it knows", () => {
    const commands = getBundleCommands(getBundle("nvidia")!, {} as any, {}) as any[];
    const first = commands.findIndex((command) => command.name === "install-nvidia-container-toolkit");
    for (const command of commands.slice(0, first)) {
      assert.equal(command.purpose, CommandPurpose.Inspect, command.name);
    }
  });
});

describe("installing it", () => {
  const install = text("install-nvidia-container-toolkit");

  it("pins all four packages to one version", () => {
    assert.match(TOOLKIT_VERSION, /^\d+\.\d+\.\d+-\d+$/);
    for (const name of [
      "nvidia-container-toolkit",
      "nvidia-container-toolkit-base",
      "libnvidia-container-tools",
      "libnvidia-container1",
    ]) {
      assert.ok(install.includes(`${name}=${TOOLKIT_VERSION}`), name);
    }
  });

  it("leaves $(ARCH) for apt rather than the shell", () => {
    assert.match(install, /echo 'deb \[signed-by=[^']*\$\(ARCH\) \/'/);
  });

  it("doesn't touch the driver", () => {
    assert.doesNotMatch(install, /nvidia-driver|ubuntu-drivers|nvidia-headless/);
  });
});

describe("telling K3s", () => {
  const restart = named("restart-k3s-for-nvidia");

  it("leaves a K3s alone once it has the runtime", () => {
    assert.equal(restart.skipWhen!({}, { ...NVIDIA, k3sMissingNvidiaRuntime: [] }), true);
  });

  it("leaves a node without K3s alone", () => {
    assert.equal(restart.skipWhen!({}, NVIDIA), true);
  });

  it("restarts the K3s that hasn't seen it, with a limit on the wait", () => {
    const context = { ...NVIDIA, k3sMissingNvidiaRuntime: ["k3s-agent"] };
    assert.equal(restart.skipWhen!({}, context), false);
    const shell = text("restart-k3s-for-nvidia", context);
    assert.match(shell, /systemctl restart --no-block k3s-agent/);
    assert.doesNotMatch(shell, /restart --no-block k3s /);
  });
});

describe("checking it", () => {
  const verify = text("verify-nvidia-runtime");

  it("changes nothing", () => {
    assert.equal(named("verify-nvidia-runtime").purpose, CommandPurpose.Verify);
    assert.equal(named("check-k3s-nvidia-runtime").purpose, CommandPurpose.Inspect);
  });

  it("fails on a K3s without the runtime", () => {
    assert.match(verify, /grep -q nvidia-container-runtime .*exit 1/);
  });

  it("only warns about a missing driver", () => {
    const line = verify.split("\n").find((each) => each.includes("driver isn't working"))!;
    assert.doesNotMatch(line, /exit 1/);
  });
});

describe("the driver label", () => {
  const skipped = (context: any) => (named("label-nvidia-driver") as any).skipWhen({}, context);

  it("marks a node whose driver answered", () => {
    assert.match(text("label-nvidia-driver", { ...NVIDIA, nvidiaDriverWorking: true, node: { nodeName: "gpu-1" } }), new RegExp(`--overwrite '?${DRIVER_LABEL}=ready`));
  });

  it("takes the label off a node whose driver stopped answering", () => {
    const command = text("label-nvidia-driver", { ...NVIDIA, nvidiaDriverWorking: false, node: { nodeName: "gpu-1" } });
    assert.match(command, new RegExp(`${DRIVER_LABEL}-`));
    assert.doesNotMatch(command, /=ready/);
  });

  it("leaves other nodes alone", () => {
    assert.equal(skipped(AMD), true);
  });

  it("only counts a working driver", () => {
    const [hook] = (named("check-nvidia-driver") as any).postProcessHooks;
    assert.equal(hook({ stdout: "working\n" }), true);
    assert.equal(hook({ stdout: "not working\n" }), false);
  });
});

describe("the device plugin", async () => {
  const config = await loadFixtureConfig();
  const values = parse(
    renderInstallerFile(config, DEVICE_PLUGIN.valuesFile!, { templateNamespace: DEVICE_PLUGIN.namespace }),
  );
  const sharing = parse(values.config.map.default).sharing.timeSlicing;
  const install = DevicePluginCommands.find((command) => command.name === "helm-install-nvidia-device-plugin") as any;

  it("is pinned", () => {
    assert.match(DEVICE_PLUGIN.version!, /^\d+\.\d+\.\d+$/);
  });

  it("comes with the bundle rather than being chosen", () => {
    assert.equal(getPackage("nvidia-device-plugin"), undefined);
  });

  it("runs under the runtime, which isn't the node's default", () => {
    assert.equal(values.runtimeClassName, "nvidia");
  });

  it("only goes where a driver answered", () => {
    assert.deepEqual(values.nodeSelector, { [DRIVER_LABEL]: "ready" });
  });

  it("drops the chart's own rule, which asks for labels nothing here sets", () => {
    assert.ok("affinity" in values);
    assert.equal(values.affinity, null);
  });

  it("shares each card, under the name pods already ask for", () => {
    assert.equal(sharing.resources[0].name, "nvidia.com/gpu");
    assert.ok(sharing.resources[0].replicas > 1);
    assert.equal(sharing.renameByDefault, undefined);
  });

  it("refuses a pod that asks for two turns on a card", () => {
    assert.equal(sharing.failRequestsGreaterThanOne, true);
  });

  it("isn't installed on a cluster with no working card", () => {
    assert.equal(install.skipWhen({}, { nvidiaDriverNodes: [] }, {}), true);
    assert.equal(install.skipWhen({}, {}, {}), true);
  });

  it("is installed once any node has one", () => {
    assert.equal(install.skipWhen({}, { nvidiaDriverNodes: ["node/gpu-1"] }, {}), false);
  });

  it("looks for those nodes after labelling them", () => {
    const names = getBundleCommands(getBundle("nvidia")!, config).map((command) => command.name);
    assert.ok(names.indexOf("label-nvidia-driver") < names.indexOf("find-nvidia-driver-nodes"));
    assert.ok(names.indexOf("find-nvidia-driver-nodes") < names.indexOf("helm-install-nvidia-device-plugin"));
  });
});
