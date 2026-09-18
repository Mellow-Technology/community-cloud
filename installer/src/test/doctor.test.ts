/**
 * @file
 * The doctor changes nothing.
 *
 * That claim is the whole reason the command exists — it is meant to
 * be safe to point at a cluster people depend on — and it rests on
 * every command being honestly labelled with a purpose. This runs every
 * bundle the way the doctor would, records the shell each command
 * would have run, and checks that none of it writes, installs,
 * restarts or applies.
 *
 * Nothing reaches a node: the exec function is replaced with one that
 * records and returns plausible output, so the commands after it still
 * build.
 */
import { describe, it, before } from "node:test";
import assert from "node:assert/strict";

import { CommandBundle } from "../cli/commands/CommandBundle.ts";
import { CommandPurpose, PROMPT_PURPOSES, isReadOnly } from "../cli/commands/Command.ts";
import { bundles, getBundleCommands } from "../cli/commands/bundles.ts";
import { fixtureNode, loadFixtureConfig, withoutConsole } from "./helpers.ts";

// Anything that would change a node or a cluster
const MUTATES: [string, RegExp][] = [
  ["installs packages", /\bapt(-get)?\s+(install|upgrade|update)/],
  ["installs a file", /\binstall\b\s+-[a-zA-Z]/],
  ["loads a kernel module", /\bmodprobe\b/],
  ["changes a service", /\bsystemctl\s+(start|stop|restart|enable|disable)/],
  ["changes the cluster", /\bkubectl\s+(apply|create|delete|label|patch|annotate)/],
  ["changes a release", /\bhelm\s+(install|upgrade|repo add|delete|uninstall)/],
  ["installs Cilium", /\bcilium\s+install/],
  ["writes a file", /\btee\b/],
  ["reloads sysctl", /\bsysctl\s+--system/],
  ["creates a physical volume", /\bpvcreate\b/],
  ["creates a volume group", /\bvgcreate\b/],
  ["enrols in a mesh", /\benroll\b/],
  ["makes a filesystem", /\bmkfs/],
  ["deletes everything", /\brm\s+-rf\s+\//],
];

// A wait loop, which the doctor is meant never to sit through
const WAITS = /for attempt in \$\(seq/;

describe("what the doctor would run", () => {
  const ran: { bundle: string; command: string }[] = [];
  let mutatingAvailable = 0;

  before(async () => {
    // Commands narrate what they find, and this builds every one in
    // every bundle
    await withoutConsole(async () => {
      const config = await loadFixtureConfig();
      const node = fixtureNode();
      const context = { nodeName: node.name, node, noWaiting: true };

      for (const bundle of bundles) {
        let specs: any[];

        try {
          specs = getBundleCommands(bundle, config, context);
        } catch {
          continue;
        }

        // How many of this bundle's commands the doctor is declining
        // to run, so the test can tell "nothing mutating ran" from
        // "nothing mutating exists"
        for (const spec of specs) {
          if (!isReadOnly(spec.purpose ?? CommandPurpose.Apply)) {
            mutatingAvailable += 1;
          }
        }

        const record = async (command: string) => {
          ran.push({ bundle: bundle.name, command });

          // Plausible enough that the next command still builds
          return { stdout: "{}", stderr: "" };
        };

        const runner = new CommandBundle(config, specs, { ...context })
          .setPurposes(PROMPT_PURPOSES)
          .setContinueOnFailure()
          .setQuiet();

        runner.setExec(record);
        runner.setControlPlaneExec(record);
        runner.setFetch(async () => ({
          status: 200,
          headers: {},
          stdout: JSON.stringify({ data: [] }),
          stderr: "",
        }));

        try {
          await runner.runAllCommands();
        } catch {
          // A check that can't build without a live node is fine here
        }
      }
    });
  });

  it("runs something, so the rest of this means anything", () => {
    assert.ok(ran.length > 0, "no commands ran at all");
  });

  it("had mutating commands available to run", () => {
    assert.ok(
      mutatingAvailable > 0,
      "nothing mutating exists, so declining to run it proves nothing",
    );
  });

  for (const [what, pattern] of MUTATES) {
    it(`never ${what}`, () => {
      const offenders = ran
        .filter(({ command }) => pattern.test(command))
        .map(({ bundle, command }) => `${bundle}: ${command.split("\n")[0]}`);

      assert.deepEqual(offenders, []);
    });
  }

  it("never waits for anything to settle", () => {
    // Waiting is right during an install and useless to something only
    // asking questions — a broken node would otherwise sit through
    // every timeout in turn before saying so
    const waiting = ran
      .filter(({ command }) => WAITS.test(command))
      .map(({ bundle }) => bundle);

    assert.deepEqual([...new Set(waiting)], []);
  });
});
