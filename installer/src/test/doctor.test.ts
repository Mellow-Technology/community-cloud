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
import {
  bundles,
  getBundle,
  getBundleCommands,
  getCheckableBundleNames,
} from "../cli/commands/bundles.ts";
import {
  Finding,
  findSharedCauses,
  formatRemedy,
  getRemedy,
  headline,
  orderForCheckup,
} from "../runners/doctor.ts";
import { DEFINED_API_ERRORS } from "../cli/commands/NebulaNetwork.ts";
import { CommandSpec } from "../cli/commands/Command.ts";
import { INSTALL_PIPELINE } from "../runners/install.ts";
import { Plan, Step, getRunningBundles } from "../pipeline/plan.ts";
import { numberBundle } from "../pipeline/reporter.ts";
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

describe("what a check-up of everything asks about", () => {
  it("leaves out the bundles another bundle's checks already cover", () => {
    // Their checks are the package's own, which helm-charts asks for
    // every package enabled — and for one that isn't, they'd report a
    // cluster without Lago as a broken Lago
    const checkable = getCheckableBundleNames();

    for (const name of ["lago", "documenso"]) {
      assert.ok(!checkable.includes(name), name);
      assert.ok(getBundle(name) !== undefined, `${name} can still be asked about by name`);
    }
  });

  it("asks about the applications through helm-charts, and about DNS", () => {
    const checkable = getCheckableBundleNames();
    assert.ok(checkable.includes("helm-charts"));
    assert.ok(checkable.includes("dns"));
  });
});

describe("the order a check-up asks in", () => {
  it("is the order an install runs in, then whatever an install doesn't run", () => {
    const order = orderForCheckup(getCheckableBundleNames());
    const staged = order.slice(0, INSTALL_PIPELINE.length);

    assert.deepEqual(staged, INSTALL_PIPELINE);
    assert.ok(order.indexOf("k3s") < order.indexOf("cilium"), "K3s should be asked about before Cilium");
    assert.ok(order.indexOf("helm") < order.indexOf("helm-charts"));
  });

  it("leaves out nothing it was given", () => {
    const names = getCheckableBundleNames();
    assert.deepEqual([...orderForCheckup(names)].sort(), [...names].sort());
  });
});

describe("how a run's bundles are numbered", () => {
  it("counts only the bundles with something to run, in the order they run", () => {
    const step = (bundle: string) => ({ bundle }) as Step;
    const plan = {
      steps: [step("preflight"), step("k3s"), step("cilium")],
      bundles: ["preflight", "base", "k3s", "cilium"],
      nodes: [],
      problems: [],
    } as Plan;

    const numbered = getRunningBundles(plan).map((bundle, index) => numberBundle(index, bundle));
    assert.deepEqual(numbered, ["1. preflight", "2. k3s", "3. cilium"]);
  });
});

describe("failures with one cause", () => {
  const REFUSED = "Defined Networking refused the API key: it's been revoked. Create a new one.";

  /**
   * One node's failures in one bundle.
   *
   * @param bundle
   * @param failures step and why, in pairs
   * @returns
   */
  function finding(node: string, bundle: string, failures: [string, string | undefined][]): Finding {
    return {
      node,
      bundle,
      ran: failures.length,
      skipped: 0,
      blocked: 0,
      failures: failures.map(([step, why]) => ({ node, bundle, step, outcome: "failed", why })),
    };
  }

  it("says a reason once, with every step and bundle it took down", () => {
    const shared = findSharedCauses([
      finding("cleverswing", "nebula", [["find-nebula-network", REFUSED], ["list-nebula-roles", REFUSED]]),
      finding("cleverswing", "nebula-network", [["verify-nebula-roles", REFUSED]]),
      finding("cleverswing", "network", [["verify-network-settings", "Expected bbr, got cubic"]]),
    ]);

    assert.deepEqual([...shared.keys()], [REFUSED]);
    assert.deepEqual(
      shared.get(REFUSED)?.map(({ finding, steps }) => [finding.bundle, steps]),
      [["nebula", ["find-nebula-network", "list-nebula-roles"]], ["nebula-network", ["verify-nebula-roles"]]],
    );
  });

  it("matches across nodes, on the first line only", () => {
    const shared = findSharedCauses([
      finding("one", "network", [["verify-network-settings", "No bbr\nreno cubic"]]),
      finding("two", "network", [["verify-network-settings", "No bbr\nreno"]]),
    ]);

    assert.deepEqual([...shared.keys()], ["No bbr"]);
  });

  it("leaves a reason given once, and failures that gave none, where they are", () => {
    const shared = findSharedCauses([
      finding("one", "k3s", [["verify-k3s", undefined], ["verify-agent", ""]]),
      finding("one", "network", [["verify-network-settings", "Expected bbr, got cubic"]]),
    ]);

    assert.equal(shared.size, 0);
  });

  it("recognises a reason by the part before it explains itself", () => {
    assert.equal(headline(REFUSED), "Defined Networking refused the API key");
    assert.equal(headline("Expected bbr, got cubic"), "Expected bbr, got cubic");
    assert.equal(headline("Version 1.2.3 isn't 1.3"), "Version 1.2.3 isn't 1.3");
  });
});

describe("how a failure is put right", () => {
  /**
   * The step a bundle's command makes, as far as the remedy cares.
   *
   * @param bundle
   * @param command
   * @returns
   */
  function stepOf(bundle: string, command: CommandSpec): Step {
    return { bundle, bundleDescription: "", command, nodes: ["guandi"] } as unknown as Step;
  }

  /**
   * One of a bundle's own commands, by name.
   *
   * @param config
   * @param bundle
   * @param name
   * @returns
   */
  function commandOf(config: any, bundle: string, name: string): CommandSpec {
    const found = getBundleCommands(getBundle(bundle)!, config).find((command) => command.name === name);
    assert.ok(found, `${bundle} has no ${name}`);
    return found;
  }

  /**
   * A failure of a step, for a reason.
   *
   * @param bundle
   * @param step
   * @param why
   * @returns
   */
  function failed(bundle: string, step: string, why = "something's wrong") {
    return { node: "guandi", bundle, step, outcome: "failed" as const, why };
  }

  it("re-runs the check's own bundle when that bundle changes things", async () => {
    const config = await loadFixtureConfig();
    const step = stepOf("nodeLabels", commandOf(config, "nodeLabels", "verify-node-labels"));

    assert.deepEqual(getRemedy(step, failed("nodeLabels", "verify-node-labels"), config), ["nodeLabels"]);
  });

  it("suggests nothing for a bundle that only looks", async () => {
    const config = await loadFixtureConfig();
    const step = stepOf("node-joined", getBundleCommands(getBundle("node-joined")!, config)[0]!);

    assert.equal(getRemedy(step, failed("node-joined", step.command.name), config), undefined);
  });

  it("suggests nothing when the check's explanation is the remedy", async () => {
    const config = await loadFixtureConfig();
    const step = stepOf("nebula", commandOf(config, "nebula", "find-nebula-network"));

    assert.equal(getRemedy(step, failed("nebula", "find-nebula-network", DEFINED_API_ERRORS[401]), config), undefined);
    assert.deepEqual(getRemedy(step, failed("nebula", "find-nebula-network", "No network named prime"), config), ["nebula"]);
  });

  it("takes a check's own remedy over its bundle, including none at all", async () => {
    const config = await loadFixtureConfig();
    const command = commandOf(config, "nodeLabels", "verify-node-labels");

    assert.deepEqual(
      getRemedy(stepOf("nodeLabels", { ...command, remedy: ["gpu", "nodeLabels"] }), failed("nodeLabels", command.name), config),
      ["gpu", "nodeLabels"],
    );
    assert.equal(getRemedy(stepOf("nodeLabels", { ...command, remedy: false }), failed("nodeLabels", command.name), config), undefined);
  });

  it("says it as somebody would type it, looking first when it could destroy something", () => {
    assert.equal(formatRemedy(["cluster"], "cleverswing", "cc.config.json"), "community-cloud run-bundle cluster cleverswing cc.config.json");
    assert.equal(formatRemedy(["lvm"], "guandi", "cc.config.json"), "community-cloud run-bundle lvm guandi cc.config.json --dry-run");
    assert.equal(formatRemedy(["gpu", "nodeLabels"], "all", "../cc.config.json"), "community-cloud run-pipeline gpu,nodeLabels all ../cc.config.json");
    assert.equal(formatRemedy(["cluster"], "all", "My Cluster/cc.json"), "community-cloud run-bundle cluster all 'My Cluster/cc.json'");
  });
});

describe("labelling a node on its own", () => {
  const commands = getBundle("nodeLabels")!.commands as CommandSpec[];
  const named = (name: string) => commands.find((command) => command.name === name)!;

  it("looks for GPUs and disks itself, and only looks", () => {
    assert.ok(named("detect-video-hardware"));
    assert.ok(named("find-disks"));

    // The lvm bundle's other commands make volume groups of free disks
    assert.equal(commands.find((command) => command.name.startsWith("create-")), undefined);
  });

  it("doesn't look again when an earlier bundle in the run already did", () => {
    const earlier = { videoDevices: [], storageClassesPresent: ["ssd"] };

    assert.equal(named("detect-video-hardware").skipWhen!({}, earlier), true);
    assert.equal(named("find-disks").skipWhen!({}, earlier), true);
  });

  it("finishes looking once it has started, rather than taking its own finding as an earlier one", () => {
    const detect = named("detect-video-hardware");
    const found = detect.saveToContext as Function;
    const context = {
      ...found({ processed: { devices: [{ vendor: "nvidia" }], renderNodes: [] } }, {}, {}),
    };

    assert.equal(named("detect-video-hardware").skipWhen!({}, {}), false);
    assert.equal(named("name-video-hardware").skipWhen!({}, context), false);
  });
});
