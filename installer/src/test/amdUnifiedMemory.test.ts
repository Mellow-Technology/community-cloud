/**
 * @file
 * How an AMD APU's memory is split, and what's said about it.
 *
 * The setup this is for is one the cluster has: a Ryzen AI Max with
 * most of its 128 GB set aside for the GPU in the BIOS, GTT left at its
 * default, and Linux, and so Kubernetes, left with 32 GB. That has to
 * be caught, with AMD's fix spelled out, and a node set up the way AMD
 * recommend has to be left in peace.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  UNIFIED_MEMORY_PROBE,
  assessUnifiedMemory,
  hasStrixHaloKernel,
  parseUnifiedMemory,
  toGfxTarget,
  toPagesLimit,
} from "../cli/commands/AmdUnifiedMemory.ts";
import { AmdCommands } from "../cli/commands/Amd.ts";
import { CommandPurpose } from "../cli/commands/Command.ts";
import { withoutConsole } from "./helpers.ts";

const GIB = 1024 ** 3;

// What cleverswing would print: 32484528 kB of RAM, 96 GiB set aside,
// and GTT at half of RAM
const RAM_KIB = 32484528;
const SPLIT = [
  "kernel|7.0.0-43-generic",
  `ram|${RAM_KIB}`,
  `pages|${(RAM_KIB * 1024) / 4096 / 2}`,
  "target|128|110501",
  `memory|128|0000:c5:00.0|${96 * GIB}|${(RAM_KIB * 1024) / 2}`,
].join("\n");

// The same machine as AMD recommend: 0.5 GiB set aside, 96 GiB of GTT
const SHARED = [
  "kernel|7.0.0-43-generic",
  `ram|${127 * 1024 * 1024}`,
  "pages|25165824",
  "target|128|110501",
  `memory|128|0000:c5:00.0|${GIB / 2}|${96 * GIB}`,
].join("\n");

/**
 * The assessment of some probe output.
 */
function assess(stdout: string) {
  return assessUnifiedMemory(parseUnifiedMemory({ stdout } as any));
}

describe("reading the node", () => {
  it("names KFD's targets the way ROCm does", () => {
    assert.equal(toGfxTarget(110501), "gfx1151");
    assert.equal(toGfxTarget(90402), "gfx942");
    assert.equal(toGfxTarget(90010), "gfx90a");
  });

  it("keeps the APUs, matched to their memory by render node", () => {
    const findings = parseUnifiedMemory({ stdout: SPLIT } as any);
    assert.equal(findings.cards.length, 1);
    assert.equal(findings.cards[0]!.target, "gfx1151");
    assert.equal(findings.cards[0]!.vramBytes, 96 * GIB);
    assert.equal(findings.ramBytes, RAM_KIB * 1024);
    assert.equal(findings.kernel, "7.0.0-43-generic");
  });

  it("leaves discrete cards out", () => {
    const findings = parseUnifiedMemory({
      stdout: `target|129|90402\nmemory|129|0000:03:00.0|${192 * GIB}|${64 * GIB}`,
    } as any);
    assert.deepEqual(findings.cards, []);
    assert.deepEqual(assess(`target|129|90402\nmemory|129|0000:03:00.0|${192 * GIB}|${64 * GIB}`), {
      notes: [],
      warnings: [],
    });
  });

  it("counts ttm.pages_limit in 4 KiB pages", () => {
    assert.equal(toPagesLimit(96), 25165824);
    assert.equal(toPagesLimit(108), 28311552);
  });
});

describe("a large BIOS share with GTT at its default", () => {
  const { warnings } = assess(SPLIT);
  const [warning] = warnings;

  it("is caught, once", () => {
    assert.equal(warnings.length, 1);
  });

  it("says both what's wrong", () => {
    assert.match(warning!, /sets aside 96\.0 GiB/);
    assert.match(warning!, /GTT is left at its default/);
  });

  it("gives AMD's fix, keeping the GPU's share as it is", () => {
    assert.match(warning!, /BIOS.*minimum, about 0\.5 GB/);
    assert.match(warning!, /ttm\.pages_limit=25165824/);
    assert.match(warning!, /update-grub/);
  });

  it("says Kubernetes will see the whole machine, and to reserve the GPU's share", () => {
    assert.match(warning!, /about 127\.0 GiB/);
    assert.match(warning!, /reserve it/);
  });
});

describe("a node set up as AMD recommend", () => {
  it("is only described", () => {
    const { notes, warnings } = assess(SHARED);
    assert.deepEqual(warnings, []);
    assert.ok(notes.some((note) => note.includes("96.0 GiB more of RAM through GTT")));
  });

  it("is still told when GTT alone was left at its default", () => {
    const { warnings } = assess(SHARED.replace(`|${96 * GIB}`, `|${(127 * GIB) / 2}`));
    assert.equal(warnings.length, 1);
    assert.match(warnings[0]!, /GTT is left at its default/);
    assert.doesNotMatch(warnings[0]!, /can never use/);
  });
});

describe("the kernel for gfx1151", () => {
  it("wants 6.18.4 or later", () => {
    assert.equal(hasStrixHaloKernel("7.0.0-43-generic"), true);
    assert.equal(hasStrixHaloKernel("6.18.4"), true);
    assert.equal(hasStrixHaloKernel("6.18.3-arch1-1"), false);
    assert.equal(hasStrixHaloKernel("6.8.0-41-generic"), false);
  });

  it("knows Ubuntu 24.04's kernels that have the fixes backported", () => {
    assert.equal(hasStrixHaloKernel("6.17.0-19-generic"), true);
    assert.equal(hasStrixHaloKernel("6.17.0-18-generic"), false);
    assert.equal(hasStrixHaloKernel("6.14.0-1018-oem"), true);
    assert.equal(hasStrixHaloKernel("6.14.0-1017-oem"), false);
    assert.equal(hasStrixHaloKernel("6.14.0-1018-generic"), false);
  });

  it("warns about an older one, and says nothing it can't tell", () => {
    assert.ok(assess(SHARED.replace("7.0.0-43-generic", "6.8.0-41-generic")).warnings.some((line) => line.includes("6.18.4")));
    assert.equal(hasStrixHaloKernel("unknown"), undefined);
  });
});

describe("the check in the amd bundle", () => {
  const check = AmdCommands.find((command) => command.name === "verify-amd-unified-memory")!;

  it("changes nothing, and never fails", () => {
    assert.equal(check.purpose, CommandPurpose.Verify);
    assert.doesNotMatch(UNIFIED_MEMORY_PROBE.join("\n"), /exit 1|tee|grub|modprobe/);
  });

  it("is left out on a node without AMD hardware", () => {
    assert.equal(check.skipWhen!({}, { videoDevices: [{ vendor: "nvidia", compute: true }] }), true);
    assert.equal(check.skipWhen!({}, { videoDevices: [{ vendor: "amd", compute: true }] }), false);
  });

  it("says what it found", async () => {
    const [hook] = (check as any).postProcessHooks;
    const said: string[] = [];
    const log = console.log;
    console.log = (...parts: any[]) => said.push(parts.join(" "));

    try {
      hook({ stdout: SPLIT });
    } finally {
      console.log = log;
    }

    assert.ok(said.some((line) => line.includes("ttm.pages_limit=25165824")), said.join("\n"));
    await withoutConsole(async () => hook({ stdout: "" }));
  });
});
