/**
 * @file
 * Congestion control on a kernel that has it in a module not yet
 * loaded.
 *
 * That's how most distributions ship BBR, and it used to read as "this
 * kernel doesn't offer bbr" to anything that checked without loading
 * the module first — preflight and the doctor, which change nothing.
 * These run the commands themselves, against a stand-in sysctl,
 * modprobe and sudo, so what's tested is what a node would do.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { NetworkingCommands, checkNetworkSupportCommand, getTcpBufferBytes } from "../cli/commands/Networking.ts";
import type { TerminalCommandSpec } from "../cli/commands/Command.ts";
import YAML from "yaml";
import { buildTemplateValues, renderInstallerFile } from "../util/template.ts";
import { configFrom, loadFixtureConfig, makeTempDirectory } from "./helpers.ts";

const CONFIG = configFrom({ network: { congestionControl: "bbr", qdisc: "fq" } });

// Where the check looks for the qdisc setting, which a machine running
// the tests may not have
const QDISC_PATH = "/proc/sys/net/core/default_qdisc";

/**
 * The state of a pretend kernel.
 *
 * - available: what it offers now
 * - hasModule: whether tcp_bbr is there to load
 * - loadAdds: whether loading it puts bbr on offer
 */
interface Kernel {
  available: string;
  hasModule: boolean;
  loadAdds?: boolean;
}

let directory: { path: string; remove: () => void };

before(() => {
  directory = makeTempDirectory("networking");

  const tools: Record<string, string> = {
    // Only what the commands ask of it: the list, read from a file
    sysctl: `#!/bin/sh\ncat "$KERNEL/available"\n`,
    // Finding the module, which fails without one
    modinfo: `#!/bin/sh\n[ -e "$KERNEL/has-module" ] && echo "/lib/modules/tcp_bbr.ko"\n`,
    // Loading it, which fails without one
    modprobe: [
      "#!/bin/sh",
      '[ -e "$KERNEL/has-module" ] || exit 1',
      'echo loaded >> "$KERNEL/loads"',
      '[ -e "$KERNEL/load-adds" ] && printf " bbr" >> "$KERNEL/available"',
      "exit 0",
      "",
    ].join("\n"),
    sudo: `#!/bin/sh\nexec "$@"\n`,
  };

  for (const [name, script] of Object.entries(tools)) {
    const path = join(directory.path, name);
    writeFileSync(path, script);
    chmodSync(path, 0o755);
  }
});

after(() => directory.remove());

/**
 * Run a command's shell against a pretend kernel.
 *
 * @param lines
 * @param kernel
 * @returns
 */
function run(lines: string[], kernel: Kernel) {
  const state = makeTempDirectory("kernel");
  writeFileSync(join(state.path, "available"), kernel.available);
  if (kernel.hasModule) {
    writeFileSync(join(state.path, "has-module"), "");
  }
  if (kernel.loadAdds === true) {
    writeFileSync(join(state.path, "load-adds"), "");
  }

  // The qdisc file stands in for the kernel's, which is the next
  // check's business rather than this one's
  const qdisc = join(state.path, "default_qdisc");
  writeFileSync(qdisc, "fq");
  const script = lines.join("\n").replaceAll(QDISC_PATH, qdisc);

  const result = spawnSync("sh", ["-c", script], {
    encoding: "utf8",
    env: { ...process.env, KERNEL: state.path, PATH: `${directory.path}:${process.env["PATH"]}` },
  });

  const loaded = existsSync(join(state.path, "loads"));
  state.remove();

  return { code: result.status, out: result.stdout + result.stderr, loaded };
}

const check = (kernel: Kernel) =>
  run((checkNetworkSupportCommand as any).command(CONFIG), kernel);

const load = (kernel: Kernel) =>
  run((NetworkingCommands.find((spec: any) => spec.name === "load-congestion-module") as any).command(CONFIG), kernel);

describe("checking for congestion control", () => {
  it("passes when the kernel already offers it", () => {
    const result = check({ available: "reno cubic bbr", hasModule: false });
    assert.equal(result.code, 0, result.out);
    assert.match(result.out, /bbr is available/);
  });

  it("passes for a module that's there and not loaded, and loads nothing", () => {
    const result = check({ available: "reno cubic", hasModule: true });
    assert.equal(result.code, 0, result.out);
    assert.match(result.out, /tcp_bbr module, which isn't loaded yet/);
    assert.equal(result.loaded, false);
  });

  it("fails with neither", () => {
    const result = check({ available: "reno cubic", hasModule: false });
    assert.notEqual(result.code, 0);
    assert.match(result.out, /isn't built in, and there's no tcp_bbr module/);
  });

  it("doesn't take a longer name for the one asked for", () => {
    const result = check({ available: "reno cubic bbr2", hasModule: false });
    assert.notEqual(result.code, 0);
  });
});

describe("loading the module", () => {
  it("leaves a kernel that already offers it alone", () => {
    const result = load({ available: "reno cubic bbr", hasModule: true, loadAdds: true });
    assert.equal(result.code, 0, result.out);
    assert.match(result.out, /already available/);
    assert.equal(result.loaded, false);
  });

  it("loads one that's there", () => {
    const result = load({ available: "reno cubic", hasModule: true, loadAdds: true });
    assert.equal(result.code, 0, result.out);
    assert.match(result.out, /loaded tcp_bbr/);
    assert.equal(result.loaded, true);
  });

  it("fails when there's nothing to load", () => {
    const result = load({ available: "reno cubic", hasModule: false });
    assert.notEqual(result.code, 0);
    assert.match(result.out, /Couldn't load tcp_bbr/);
  });

  it("fails when loading it doesn't put it on offer", () => {
    const result = load({ available: "reno cubic", hasModule: true, loadAdds: false });
    assert.notEqual(result.code, 0);
    assert.match(result.out, /still doesn't offer bbr/);
  });

  it("is still the bundle's first step after reading the interfaces", () => {
    const names = NetworkingCommands.map((spec: any) => spec.name);
    assert.ok(names.indexOf("load-congestion-module") < names.indexOf("check-network-support"));
    assert.ok(names.indexOf("check-network-support") < names.indexOf("write-sysctl-config"));
  });
});

describe("TCP buffers", () => {
  const written = (network: Record<string, unknown>) => {
    const step = NetworkingCommands.find((command) => command.name === "write-sysctl-config") as TerminalCommandSpec;
    const stdin = step.stdin;
    return typeof stdin === "function" ? stdin(configFrom({ network })) : String(stdin);
  };

  it("lets a connection buffer up to 32 MiB each way by default", () => {
    const file = written({ congestionControl: "bbr", qdisc: "fq" });
    for (const line of [
      "net.core.rmem_max = 33554432",
      "net.core.wmem_max = 33554432",
      "net.ipv4.tcp_rmem = 4096 131072 33554432",
      "net.ipv4.tcp_wmem = 4096 16384 33554432",
    ]) {
      assert.ok(file.includes(line), `${line} in:\n${file}`);
    }
  });

  it("takes another size from the configuration", () => {
    assert.ok(written({ tcpBufferBytes: 67108864 }).includes("net.ipv4.tcp_wmem = 4096 16384 67108864"));
  });

  it("refuses a size that isn't a sensible whole number of bytes", () => {
    for (const tcpBufferBytes of [1000, 2 ** 31, 1048576.5, "32M"]) {
      assert.throws(() => getTcpBufferBytes(configFrom({ network: { tcpBufferBytes } })), /tcpBufferBytes/);
    }
  });

  it("is checked after it's applied, ceilings and caps both", () => {
    const step = NetworkingCommands.find((command) => command.name === "verify-network-settings") as TerminalCommandSpec;
    const command = step.command;
    const lines = (typeof command === "function" ? command(CONFIG) : command) as string[];
    const script = lines.join("\n");
    assert.match(script, /tcp_wmem/);
    assert.match(script, /net\.core\.wmem_max/);
    assert.match(script, /33554432/);
  });
});

describe("the mesh's MTU", () => {
  const meshMtu = (network: Record<string, unknown>) =>
    (buildTemplateValues(configFrom({ network }), {}) as any).Values.meshMtu;

  it("is Defined Networking's 1300, unless set", () => {
    assert.equal(meshMtu({}), 1300);
  });

  it("takes another from network.meshMtu", () => {
    assert.equal(meshMtu({ meshMtu: 1420 }), 1420);
  });

  it("refuses one that isn't a sensible MTU", () => {
    for (const value of [576, 1300.5, "1300", 65536]) {
      assert.throws(() => meshMtu({ meshMtu: value }), /network\.meshMtu/);
    }
  });

  it("refuses podMtu, which meant the pods' and not the mesh's", () => {
    assert.throws(() => meshMtu({ podMtu: 1250 }), /network\.meshMtu/);
  });

  it("reaches Cilium under the chart's own key, MTU", async () => {
    const config = await loadFixtureConfig();
    const values = YAML.parse(await renderInstallerFile(config, "embed://networking/cilium/Cilium.values.yaml"));
    assert.equal(values.MTU, 1300);
    assert.equal(values.mtu, undefined);
  });
});
