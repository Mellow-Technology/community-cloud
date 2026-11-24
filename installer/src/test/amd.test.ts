/**
 * @file
 * AMD's device plugin.
 *
 * There's no runtime to get wrong, so what's left is where the plugin
 * goes. It exits on a node without amdgpu, and a pod that keeps
 * exiting holds up the Helm install waiting for it, so the driver
 * check deciding the label is the part that matters. The rest is
 * about nodes this has no business touching, and about pods getting
 * their card through the plugin rather than by being privileged.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parse, parseAllDocuments } from "yaml";

import { getBundle, getBundleCommands, getBundleNames, getCheckableBundleNames } from "../cli/commands/bundles.ts";
import {
  AmdCommands,
  AmdDevicePluginCommands,
  DEVICE_PLUGIN,
  DRIVER_LABEL,
  DRIVER_STATES,
} from "../cli/commands/Amd.ts";
import { CommandPurpose, CommandScope, CommandTarget } from "../cli/commands/Command.ts";
import { GpuInfoCommands } from "../cli/commands/GpuInfo.ts";
import { CLUSTER_NAMESPACE, getPackage } from "../cli/commands/packages.ts";
import { ADD_NODE_PIPELINE } from "../runners/addNode.ts";
import { INSTALL_PIPELINE } from "../runners/install.ts";
import { renderInstallerFile } from "../util/template.ts";
import { loadFixtureConfig, withoutConsole } from "./helpers.ts";

const AMD = { videoDevices: [{ vendor: "amd", compute: true }] };
const NVIDIA = { videoDevices: [{ vendor: "nvidia", compute: true }] };

const every = [...AmdCommands, ...AmdDevicePluginCommands];
const named = (name: string) => every.find((command) => command.name === name)!;

/**
 * A command's shell, as it reaches the node.
 */
function text(name: string, context: any = AMD): string {
  const { command } = named(name) as any;
  const built = typeof command === "function" ? command({}, context, {}) : command;
  return Array.isArray(built) ? built.join("\n") : built;
}

describe("where the amd bundle goes", () => {
  for (const [name, pipeline] of [
    ["install", INSTALL_PIPELINE],
    ["add-node", ADD_NODE_PIPELINE],
  ] as const) {
    it(`comes after detection and labelling in ${name}`, () => {
      assert.ok(pipeline.includes("amd"));
      assert.ok(pipeline.indexOf("gpu") < pipeline.indexOf("amd"));
      assert.ok(pipeline.indexOf("k3s") < pipeline.indexOf("amd"));
      assert.ok(pipeline.indexOf("nodeLabels") < pipeline.indexOf("amd"));
    });
  }

  it("has Helm by the time it's in an install", () => {
    assert.ok(INSTALL_PIPELINE.indexOf("helm") < INSTALL_PIPELINE.indexOf("amd"));
  });

  it("is checked before add-node says the node has joined", () => {
    assert.ok(ADD_NODE_PIPELINE.indexOf("amd") < ADD_NODE_PIPELINE.indexOf("node-joined"));
  });

  it("is a bundle, and one a check-up asks about", () => {
    assert.ok(getBundleNames().includes("amd"));
    assert.ok(getCheckableBundleNames().includes("amd"));
  });
});

describe("which nodes it touches", () => {
  it("does nothing on a node with no AMD hardware", () => {
    for (const context of [NVIDIA, { videoDevices: [] }, {}]) {
      for (const command of AmdCommands) {
        assert.equal(command.skipWhen!({}, context), true, command.name);
      }
      assert.equal(named("verify-amd-gpus-allocatable").skipWhen!({}, { ...context, amdDriverWorking: true }), true);
    }
  });

  it("ignores display-only AMD hardware", () => {
    const display = { videoDevices: [{ vendor: "amd", compute: false }] };
    assert.equal(named("check-amd-driver").skipWhen!({}, display), true);
  });

  it("does the work on a node that has it", () => {
    for (const command of AmdCommands) {
      assert.equal(command.skipWhen!({}, AMD), false, command.name);
    }
  });

  it("looks for hardware itself when it's run alone", () => {
    const names = getBundleCommands(getBundle("amd")!, {} as any, {}).map((command: any) => command.name);
    assert.ok(names.indexOf("detect-video-hardware") < names.indexOf("check-amd-driver"));
  });

  it("only looks, rather than changing anything, before it knows", () => {
    const commands = getBundleCommands(getBundle("amd")!, {} as any, {}) as any[];
    const first = commands.findIndex((command) => command.name === "label-amd-driver");
    for (const command of commands.slice(0, first)) {
      assert.equal(command.purpose, CommandPurpose.Inspect, command.name);
    }
  });
});

describe("what it does to a node", () => {
  const all = AmdCommands.map((command) => text(command.name, { ...AMD, node: { nodeName: "gpu-1" } })).join("\n");

  it("installs nothing, and restarts nothing", () => {
    // The warnings name amdgpu-dkms, as something someone could install
    assert.doesNotMatch(all, /\bapt(-get)? |\bdkms |\bmodprobe\b|\bsystemctl\b|\bamdgpu-install /);
  });
});

describe("the driver check", () => {
  const check = text("check-amd-driver");
  const [hook] = (named("check-amd-driver") as any).postProcessHooks;
  const save = named("check-amd-driver").saveToContext as Function;

  it("asks what the plugin asks: a bound card, /dev/kfd, and a GPU KFD can compute on", () => {
    assert.match(check, /\/sys\/module\/amdgpu\/drivers\/pci:amdgpu\//);
    assert.match(check, /\[ ! -c \/dev\/kfd \]/);
    assert.match(check, /\/sys\/class\/kfd\/kfd\/topology\/nodes\/\*\/gpu_id/);
  });

  it("only counts a working driver", () => {
    assert.equal(save({ processed: hook({ stdout: "working\n" }) }).amdDriverWorking, true);
    for (const state of ["no-driver", "no-kfd", "no-compute", "something else"]) {
      assert.equal(save({ processed: hook({ stdout: `${state}\n` }) }).amdDriverWorking, false, state);
    }
  });

  it("changes nothing", () => {
    assert.equal(named("check-amd-driver").purpose, CommandPurpose.Inspect);
    assert.equal(named("verify-amd-driver").purpose, CommandPurpose.Verify);
  });

  it("only warns about a driver that doesn't work", () => {
    const verify = text("verify-amd-driver");
    assert.doesNotMatch(verify, /exit 1/);
    for (const state of Object.keys(DRIVER_STATES)) {
      assert.match(verify, new RegExp(`  ${state}\\) echo`), state);
    }
  });

  it("says to run the bundle again, for every way it can fail", () => {
    for (const [state, message] of Object.entries(DRIVER_STATES)) {
      if (state !== "working") {
        assert.match(message, /left out of the device plugin/, state);
      }
    }
  });
});

describe("the driver label", () => {
  const node = { node: { nodeName: "gpu-1" } };

  it("marks a node whose driver answered", () => {
    assert.match(
      text("label-amd-driver", { ...AMD, ...node, amdDriverWorking: true }),
      new RegExp(`--overwrite '?${DRIVER_LABEL}=ready`),
    );
  });

  it("takes the label off a node whose driver stopped answering", () => {
    const command = text("label-amd-driver", { ...AMD, ...node, amdDriverWorking: false });
    assert.match(command, new RegExp(`${DRIVER_LABEL}-`));
    assert.doesNotMatch(command, /=ready/);
  });

  it("is one command per node, run where kubectl is", () => {
    assert.equal(named("label-amd-driver").runOn, CommandTarget.ControlPlane);
    assert.equal(named("label-amd-driver").scope, CommandScope.EachNode);
  });
});

describe("the device plugin", async () => {
  const config = await loadFixtureConfig();
  const values = parse(
    renderInstallerFile(config, DEVICE_PLUGIN.valuesFile!, { templateNamespace: DEVICE_PLUGIN.namespace }),
  );
  const install = named("helm-install-amd-gpu-device-plugin") as any;

  it("is pinned", () => {
    assert.match(DEVICE_PLUGIN.version!, /^\d+\.\d+\.\d+$/);
  });

  it("comes with the bundle rather than being chosen", () => {
    assert.equal(getPackage("amd-gpu-device-plugin"), undefined);
  });

  it("goes with what runs the cluster", () => {
    assert.equal(DEVICE_PLUGIN.namespace, CLUSTER_NAMESPACE);
  });

  it("only goes where a driver answered", () => {
    assert.equal(values.node_selector_enabled, true);
    assert.equal(values.node_selector[DRIVER_LABEL], "ready");
  });

  it("takes out the chart's own label, which asks for Node Feature Discovery", () => {
    const key = "feature.node.kubernetes.io/pci-0300_1002.present";
    assert.ok(key in values.node_selector);
    assert.equal(values.node_selector[key], null);
  });

  it("brings neither Node Feature Discovery nor the labeller", () => {
    assert.equal(values.nfd.enabled, false);
    assert.equal(values.labeller.enabled, false);
  });

  it("isn't made privileged", () => {
    assert.equal(values.securityContext?.privileged, undefined);
    assert.equal(values.dp?.securityContext, undefined);
  });

  it("isn't installed on a cluster with no working card", () => {
    assert.equal(install.skipWhen({}, { amdDriverNodes: [] }, {}), true);
    assert.equal(install.skipWhen({}, {}, {}), true);
  });

  it("is installed once any node has one", () => {
    assert.equal(install.skipWhen({}, { amdDriverNodes: ["node/gpu-1"] }, {}), false);
  });

  it("looks for those nodes after labelling them, and checks them after installing", () => {
    const names = getBundleCommands(getBundle("amd")!, config).map((command) => command.name);
    assert.ok(names.indexOf("label-amd-driver") < names.indexOf("find-amd-driver-nodes"));
    assert.ok(names.indexOf("find-amd-driver-nodes") < names.indexOf("helm-install-amd-gpu-device-plugin"));
    assert.ok(names.indexOf("helm-install-amd-gpu-device-plugin") < names.indexOf("verify-amd-gpus-allocatable"));
  });
});

describe("checking a node offers its cards", () => {
  const verify = named("verify-amd-gpus-allocatable");
  const node = { ...AMD, node: { nodeName: "gpu-1" }, amdDriverWorking: true };

  it("changes nothing", () => {
    assert.equal(verify.purpose, CommandPurpose.Verify);
  });

  it("is asked of nodes whose driver works, and no others", () => {
    assert.equal(verify.skipWhen!({}, node), false);
    assert.equal(verify.skipWhen!({}, { ...node, amdDriverWorking: false }), true);
  });

  it("reads amd.com/gpu from the node, and fails without it", () => {
    const shell = text("verify-amd-gpus-allocatable", node);
    assert.match(shell, /jsonpath='\{\.status\.allocatable\.amd\\\.com\/gpu\}'/);
    assert.match(shell, /-gt 0 \] 2>\/dev\/null \|\| \{ echo .*exit 1; \}/);
  });

  it("waits during an install, and not during a check-up", () => {
    assert.match(text("verify-amd-gpus-allocatable", node), /for attempt in \$\(seq 60\)/);
    assert.doesNotMatch(text("verify-amd-gpus-allocatable", { ...node, noWaiting: true }), /for attempt in/);
  });
});

describe("what the gpu bundle says about an AMD node", () => {
  const details = GpuInfoCommands.find((command) => command.name === "amd-gpu-details") as any;
  const [hook] = details.postProcessHooks;

  it("asks for /dev/kfd, which is what a workload needs", () => {
    assert.match((details.command as string[]).join("\n"), /\[ -c \/dev\/kfd \]/);
  });

  it("doesn't count missing ROCm tools against a node that has /dev/kfd", async () => {
    await withoutConsole(async () => {
      const found = hook({ stdout: "tooling|rocm-smi|missing\ntooling|amd-smi|missing\nkfd|present\n" });
      assert.equal(found.computeReady, true);
      assert.equal(found.toolingInstalled, false);
    });
  });

  it("points at the amd bundle when there's no /dev/kfd", async () => {
    const said: string[] = [];
    const log = console.log;
    console.log = (...parts: any[]) => said.push(parts.join(" "));

    try {
      assert.equal(hook({ stdout: "kfd|missing\n" }).computeReady, false);
    } finally {
      console.log = log;
    }

    assert.ok(said.some((line) => line.includes("amd bundle")), said.join("\n"));
  });
});

describe("the vLLM manifest", async () => {
  const config = await loadFixtureConfig();
  const documents = [
    ...parseAllDocuments(renderInstallerFile(config, "embed://ai/vLLM/vllm-amd.yaml")),
    ...parseAllDocuments(renderInstallerFile(config, "embed://ai/vLLM/vllm-amd-pvc.yaml")),
  ].map((document) => document.toJS());
  const deployment = documents.find((document) => document.kind === "Deployment");
  const pod = deployment.spec.template.spec;

  it("goes in cc-office with the other applications", () => {
    for (const document of documents) {
      assert.equal(document.metadata.namespace, "cc-office", document.kind);
    }
  });

  it("gets its card from the device plugin", () => {
    assert.equal(pod.containers[0].resources.limits["amd.com/gpu"], "1");
  });

  it("uses neither the host's network nor its IPC, and isn't privileged", () => {
    assert.equal(pod.hostNetwork, undefined);
    assert.equal(pod.hostIPC, undefined);
    assert.equal(pod.containers[0].securityContext.privileged, undefined);
    assert.ok(!(pod.volumes ?? []).some((volume: any) => volume.hostPath !== undefined));
  });

  it("runs an image pinned exactly, and not the MI300 one", () => {
    const image: string = pod.containers[0].image;
    assert.match(image, /^rocm\/vllm:rocm[\d.]+_[^@]+@sha256:[0-9a-f]{64}$/);
    assert.doesNotMatch(image, /mi300/i);
  });

  it("asks for nothing gfx1151 can't do", () => {
    const serve = pod.containers[0].args.join(" ");
    assert.doesNotMatch(serve, /fp8/i);
    assert.match(serve, /--dtype bfloat16/);
    assert.match(serve, /--gpu-memory-utilization 0\.\d+/);
  });

  it("keeps its models on the volume made for them", () => {
    const claim = pod.volumes.find((volume: any) => volume.persistentVolumeClaim !== undefined);
    const pvc = documents.find((document) => document.kind === "PersistentVolumeClaim");
    assert.equal(claim.persistentVolumeClaim.claimName, pvc.metadata.name);
  });
});
