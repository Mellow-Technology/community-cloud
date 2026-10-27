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

import { NetworkingCommands, checkNetworkSupportCommand } from "../cli/commands/Networking.ts";
import { configFrom, makeTempDirectory } from "./helpers.ts";

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
