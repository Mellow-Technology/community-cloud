/**
 * @file
 * Every command string every bundle can build, checked as shell.
 *
 * The commands here are assembled from arrays, template literals and
 * functions of the configuration, and none of that is syntax-checked
 * by anything on the way to a node. A missing "fi" or a stray
 * separator after "do" is a thing you find out about by breaking a
 * machine, so the strings get run past sh and bash first.
 *
 * Nothing is executed. The exec function is replaced with one that
 * records what it was handed, and the recorded string is what gets
 * checked.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { CommandType } from "../cli/commands/Command.ts";
import CloudConfig from "../util/CloudConfig.ts";
import TerminalCommand from "../cli/commands/TerminalCommand.ts";
import { bundles, getBundleCommands } from "../cli/commands/bundles.ts";
import { getCommandType } from "../cli/commands/createCommand.ts";
import {
  fixtureNode,
  loadFixtureConfig,
  makeTempDirectory,
  withoutConsole,
} from "./helpers.ts";

// The shells a node might actually run these under. Ubuntu's /bin/sh
// is dash, which is stricter than bash about several things we have
// got wrong before.
const SHELLS = ["/bin/sh", "/bin/bash"];

// A separator directly after one of the words that takes its body
// next. "for x in y; do; echo" is a syntax error and an easy one to
// write by accident when something else is doing the joining.
const SEPARATOR_AFTER_KEYWORD = /;\s*(do|then|else)\s*;/;

/**
 * Enough context that commands which read what an earlier command
 * found will build rather than give up.
 */
function buildContext(): Record<string, any> {
  return {
    nodeName: "server-1",
    node: fixtureNode(),
    params: [],
    operation: "apply",
    namespace: null,
    manifest: "kind: ConfigMap\n",
    k3sService: "k3s",
    k3sServiceActive: true,
    dnclientEnrolled: false,
    nebulaNetworkID: "n1",
    nebulaHostID: "h1",
    nebulaEnrollmentCode: "code",
    nebulaIPAddresses: ["10.10.0.2"],
    videoDevices: [{ vendor: "nvidia", compute: true }],
    gpuVendors: ["nvidia", "amd", "intel"],
    disks: [{ name: "sdb", path: "/dev/sdb", rotational: false }],
  };
}

/**
 * What the commands before this one would have found.
 */
function priorResults(): Record<string, any> {
  const disks = [
    { name: "sdb", path: "/dev/sdb", rotational: false, size: 512_000_000_000 },
  ];

  return {
    "find-disks": { stdout: "", stderr: "", parsed: disks, processed: disks },
    "check-k3s-service": {
      stdout: "",
      stderr: "",
      parsed: null,
      processed: { service: "k3s", active: true },
    },
    "get-cilium-cli-version": { stdout: "v0.20.0", stderr: "", parsed: "v0.20.0" },
    "detect-video-hardware": {
      stdout: "",
      stderr: "",
      parsed: null,
      processed: { devices: [{ vendor: "nvidia" }] },
    },
  };
}

/**
 * Build every terminal command in a bundle, without running any.
 *
 * @param bundle
 * @param config
 * @returns the command strings, and why any were skipped
 */
async function buildCommands(bundle: any, config: CloudConfig) {
  const built: { name: string; text: string }[] = [];
  const skipped: string[] = [];

  let specs: any[];

  try {
    specs = getBundleCommands(bundle, config, buildContext());
  } catch (error: any) {
    return { built, skipped: [`${bundle.name} (${error.message})`] };
  }

  for (const spec of specs) {
    if (getCommandType(spec) !== CommandType.Terminal) {
      continue;
    }

    const seen: string[] = [];
    const command = new TerminalCommand(spec);

    // Several of these parse their output, and the stub hands them
    // nothing to parse. That is fine and it is not this test's
    // subject, so it doesn't need narrating.
    command.setQuiet(true);
    command.setExecFunction(async (text: string) => {
      seen.push(text);
      return { stdout: "", stderr: "" };
    });

    try {
      await command.exec(config, buildContext(), priorResults());
    } catch (error: any) {
      // A command that couldn't build is reported rather than failed:
      // several of them need a live node to say anything at all
      if (seen.length === 0) {
        skipped.push(`${bundle.name}/${spec.name} (${error.message.split("\n")[0]})`);
        continue;
      }
    }

    if (seen.length === 0) {
      skipped.push(`${bundle.name}/${spec.name} (nothing built)`);
      continue;
    }

    for (const text of seen) {
      built.push({ name: `${bundle.name}/${spec.name}`, text });
    }
  }

  return { built, skipped };
}

describe("the shell every bundle builds", async () => {
  const temporary = makeTempDirectory("shell");
  const scriptPath = join(temporary.path, "command.sh");

  let config: CloudConfig;
  let built: { name: string; text: string }[] = [];
  let skipped: string[] = [];

  before(async () => {
    await withoutConsole(async () => {
      config = await loadFixtureConfig();

      for (const bundle of bundles) {
        const result = await buildCommands(bundle, config);
        built = [...built, ...result.built];
        skipped = [...skipped, ...result.skipped];
      }
    });
  });

  after(() => temporary.remove());

  it("builds something to check", () => {
    assert.ok(
      built.length > 50,
      `only ${built.length} command strings were built, which means most bundles stopped early rather than that there are no commands`,
    );
  });

  for (const shell of SHELLS) {
    it(`is valid ${shell}`, () => {
      const broken: string[] = [];

      for (const { name, text } of built) {
        writeFileSync(scriptPath, text);

        try {
          execFileSync(shell, ["-n", scriptPath], { stdio: "pipe" });
        } catch (error: any) {
          broken.push(`${name}: ${String(error.stderr).trim()}`);
        }
      }

      assert.deepEqual(broken, [], `\n  ${broken.join("\n  ")}`);
    });
  }

  it("never puts a separator after do, then or else", () => {
    const broken = built
      .filter(({ text }) => SEPARATOR_AFTER_KEYWORD.test(text))
      .map(({ name }) => name);

    assert.deepEqual(
      broken,
      [],
      "a joiner has put a separator where the next word is the body",
    );
  });
});
