/**
 * @file
 * Planning and running work across a cluster.
 *
 * The properties worth holding onto are the ones a single node can't
 * show you: that a step runs on the right nodes and no others, that
 * nobody gets ahead of anybody else, that what one node learns stays
 * that node's, and that a failure stops the whole run at a place
 * somebody can describe.
 *
 * Nothing here connects to anything. The fleet is built on paper and
 * the exec function is a stand-in that records what it was asked to
 * do, so the assertions are about the orchestration rather than about
 * any particular command.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import CloudConfig from "../util/CloudConfig.ts";
import {
  CommandScope,
  CommandSpec,
  CommandTarget,
  getCommandScope,
} from "../cli/commands/Command.ts";
import { CommandPurpose, PROMPT_PURPOSES, READ_ONLY_PURPOSES } from "../cli/commands/Command.ts";
import { buildPackageCommands } from "../cli/commands/Helm.ts";
import { resolvePackage } from "../cli/commands/packages.ts";
import {
  Fleet,
  FleetMember,
  isServerNode,
  paperFleet,
  resolveTarget,
} from "../pipeline/fleet.ts";
import { Plan, Step, buildPlan, nodesForScope } from "../pipeline/plan.ts";
import { ConsoleReporter, SilentReporter } from "../pipeline/reporter.ts";
import { displayNode, getDisplayNames } from "../pipeline/fleet.ts";
import { runPlan } from "../pipeline/run.ts";
import { configFrom } from "./helpers.ts";

/**
 * What ran, in the order it was asked for.
 */
interface Trace {
  calls: { node: string; command: string }[];
}

/**
 * A fleet of make-believe nodes whose exec function records rather
 * than runs.
 *
 * @param shape node name to whether it is a server
 * @param trace where to record
 * @param failOn a command that should fail, and on which node
 */
function makeFleet(
  shape: Record<string, "server" | "agent">,
  trace: Trace,
  failOn?: { command: string; node: string },
): Fleet {
  const members: FleetMember[] = Object.entries(shape).map(([name, type]) => {
    const node = { name, address: name, type, roles: ["worker"] };

    return {
      name,
      node,
      isServer: isServerNode(node),
      connection: {
        node,
        local: false,
        disconnect: async () => {},
        exec: async (command: string) => {
          // The command text carries its own name, because that is
          // what the stand-in has to go on
          const label = command.trim();
          trace.calls.push({ node: name, command: label });

          if (failOn !== undefined && label.includes(failOn.command) && name === failOn.node) {
            const error: any = new Error(`${failOn.command} failed on ${name}`);
            error.stderr = `${failOn.command} failed on ${name}`;
            throw error;
          }

          return { stdout: label, stderr: "" };
        },
      },
    };
  });

  return new Fleet(members);
}

/**
 * A command that echoes its own name, so a trace can be read.
 */
function echoCommand(name: string, extra: Partial<CommandSpec> = {}): CommandSpec {
  return {
    name,
    description: name,
    command: `echo ${name}`,
    ...extra,
  } as CommandSpec;
}

/**
 * A plan of the given steps.
 */
function makePlan(commands: CommandSpec[], fleet: Fleet): Plan {
  const steps: Step[] = commands.map((command) => {
    const scope = getCommandScope(command);

    return {
      bundle: "test",
      bundleDescription: "a test bundle",
      command,
      scope,
      nodes: nodesForScope(scope, fleet),
      runOn: command.runOn ?? CommandTarget.Node,
    };
  });

  return { steps, bundles: ["test"], nodes: fleet.names(), problems: [] };
}

const CONFIG: CloudConfig = configFrom({
  k3s: { token: "t" },
  nodes: [
    { name: "one", address: "one", type: "server" },
    { name: "two", address: "two", type: "agent" },
    { name: "three", address: "three", type: "agent" },
  ],
});

describe("what a scope means", () => {
  const trace: Trace = { calls: [] };
  const fleet = makeFleet({ one: "server", two: "agent", three: "agent" }, trace);

  it("runs cluster work once, on a server", () => {
    assert.deepEqual(nodesForScope(CommandScope.Cluster, fleet), ["one"]);
  });

  it("runs node work on every node", () => {
    assert.deepEqual(nodesForScope(CommandScope.EachNode, fleet), ["one", "two", "three"]);
  });

  it("runs server work on the servers", () => {
    assert.deepEqual(nodesForScope(CommandScope.EachServer, fleet), ["one"]);
  });

  it("runs agent work on the agents", () => {
    assert.deepEqual(nodesForScope(CommandScope.EachAgent, fleet), ["two", "three"]);
  });
});

describe("the scope a command gets when it doesn't say", () => {
  it("is once for the cluster, when it runs on the control plane", () => {
    assert.equal(
      getCommandScope({ name: "x", description: "", runOn: CommandTarget.ControlPlane }),
      CommandScope.Cluster,
    );
  });

  it("is once per node, when it runs on the node", () => {
    assert.equal(getCommandScope({ name: "x", description: "" }), CommandScope.EachNode);
  });

  it("is whatever it said, when it said", () => {
    // Labelling a node is the case the default gets wrong: kubectl on
    // a server, once for every node in the cluster
    assert.equal(
      getCommandScope({
        name: "x",
        description: "",
        runOn: CommandTarget.ControlPlane,
        scope: CommandScope.EachNode,
      }),
      CommandScope.EachNode,
    );
  });
});

describe("running a plan", () => {
  it("runs a step on every node it applies to", async () => {
    const trace: Trace = { calls: [] };
    const fleet = makeFleet({ one: "server", two: "agent", three: "agent" }, trace);

    await runPlan(CONFIG, makePlan([echoCommand("everywhere")], fleet), fleet, {
      reporter: new SilentReporter(),
    });

    assert.deepEqual(
      trace.calls.map((call) => call.node).sort(),
      ["one", "three", "two"],
    );
  });

  it("runs an agent step on the agents only", async () => {
    const trace: Trace = { calls: [] };
    const fleet = makeFleet({ one: "server", two: "agent", three: "agent" }, trace);

    await runPlan(
      CONFIG,
      makePlan([echoCommand("join", { scope: CommandScope.EachAgent })], fleet),
      fleet,
      { reporter: new SilentReporter() },
    );

    assert.deepEqual(trace.calls.map((call) => call.node).sort(), ["three", "two"]);
  });

  it("runs cluster work once even with three nodes", async () => {
    const trace: Trace = { calls: [] };
    const fleet = makeFleet({ one: "server", two: "agent", three: "agent" }, trace);

    await runPlan(
      CONFIG,
      makePlan([echoCommand("apply", { runOn: CommandTarget.ControlPlane })], fleet),
      fleet,
      { reporter: new SilentReporter() },
    );

    assert.equal(trace.calls.length, 1, "a manifest applied three times is applied twice too often");
  });

  it("reports a step for every node it ran on", async () => {
    const trace: Trace = { calls: [] };
    const fleet = makeFleet({ one: "server", two: "agent" }, trace);

    const summary = await runPlan(
      CONFIG,
      makePlan([echoCommand("a"), echoCommand("b")], fleet),
      fleet,
      { reporter: new SilentReporter() },
    );

    assert.equal(summary.completed, 2);
    assert.deepEqual(summary.failures, []);
  });
});

describe("the barrier", () => {
  it("finishes a step on every node before starting the next", async () => {
    const trace: Trace = { calls: [] };
    const fleet = makeFleet({ one: "server", two: "agent", three: "agent" }, trace);

    await runPlan(
      CONFIG,
      makePlan([echoCommand("first"), echoCommand("second"), echoCommand("third")], fleet),
      fleet,
      { reporter: new SilentReporter() },
    );

    // Every "first" comes before every "second", and so on. This is
    // the whole design in one assertion: no node gets ahead.
    const order = trace.calls.map((call) => call.command.replace("echo ", ""));
    const lastFirst = order.lastIndexOf("first");
    const firstSecond = order.indexOf("second");
    const lastSecond = order.lastIndexOf("second");
    const firstThird = order.indexOf("third");

    assert.ok(lastFirst < firstSecond, "a node started the second step before another finished the first");
    assert.ok(lastSecond < firstThird, "a node started the third step before another finished the second");
  });

  it("stops the whole run when one node fails", async () => {
    const trace: Trace = { calls: [] };
    const fleet = makeFleet({ one: "server", two: "agent", three: "agent" }, trace, {
      command: "echo second",
      node: "three",
    });

    const summary = await runPlan(
      CONFIG,
      makePlan([echoCommand("first"), echoCommand("second"), echoCommand("third")], fleet),
      fleet,
      { reporter: new SilentReporter() },
    );

    assert.equal(summary.completed, 2, "it should stop after the step that failed");
    assert.equal(summary.failures.length, 1);
    assert.equal(summary.failures[0]!.node, "three");

    const reached = trace.calls.map((call) => call.command.replace("echo ", ""));
    assert.ok(!reached.includes("third"), "no node should have reached the step after the failure");
  });

  it("lets the other nodes finish the failing step", async () => {
    // They are running in parallel and a remote command can't be
    // safely taken back, so the honest thing is to let them land and
    // stop at the barrier
    const trace: Trace = { calls: [] };
    const fleet = makeFleet({ one: "server", two: "agent", three: "agent" }, trace, {
      command: "echo only",
      node: "three",
    });

    await runPlan(CONFIG, makePlan([echoCommand("only")], fleet), fleet, {
      reporter: new SilentReporter(),
    });

    assert.equal(trace.calls.length, 3, "every node should have been asked");
  });

  it("carries on past a failure when told to", async () => {
    const trace: Trace = { calls: [] };
    const fleet = makeFleet({ one: "server", two: "agent" }, trace, {
      command: "echo first",
      node: "two",
    });

    const summary = await runPlan(
      CONFIG,
      makePlan([echoCommand("first"), echoCommand("second")], fleet),
      fleet,
      { reporter: new SilentReporter(), keepGoing: true },
    );

    assert.equal(summary.completed, 2);
    assert.equal(summary.failures.length, 1);
    assert.ok(trace.calls.some((call) => call.command.includes("second")));
  });
});

describe("what a node knows", () => {
  it("keeps one node's findings to itself", async () => {
    const trace: Trace = { calls: [] };
    const fleet = makeFleet({ one: "server", two: "agent" }, trace);

    const learn: CommandSpec = {
      name: "learn",
      description: "",
      command: "echo learn",
      saveToContext: (_output: any, _context: any) => ({ secretOfThisNode: "found" }),
    } as CommandSpec;

    const seen: Record<string, unknown> = {};
    const report: CommandSpec = {
      name: "report",
      description: "",
      command: (_config: CloudConfig, context: any) => {
        seen[context.nodeName] = context.secretOfThisNode;
        return "echo report";
      },
    } as CommandSpec;

    // Only "one" learns anything, by skipping the command on "two"
    const onlyOne: CommandSpec = {
      ...learn,
      skipWhen: (_config: CloudConfig, context: any) => context.nodeName !== "one",
    } as CommandSpec;

    await runPlan(CONFIG, makePlan([onlyOne, report], fleet), fleet, {
      reporter: new SilentReporter(),
    });

    assert.equal(seen["one"], "found");
    assert.equal(seen["two"], undefined, "one node's findings leaked into another's context");
  });

  it("carries what an earlier command returned, not just what it stored", async () => {
    // The Cilium CLI install reads the version the step before it
    // printed, out of the results rather than the context. A runner
    // that builds a fresh bundle per step loses that unless it carries
    // the results forward, and the command simply breaks.
    const trace: Trace = { calls: [] };
    const fleet = makeFleet({ one: "server", two: "agent" }, trace);

    const produce = echoCommand("produce");

    let sawVersion: string | undefined;
    const consume: CommandSpec = {
      name: "consume",
      description: "",
      command: (_config: CloudConfig, _context: any, results: any) => {
        sawVersion = results["produce"]?.parsed;
        return "echo consume";
      },
    } as CommandSpec;

    await runPlan(CONFIG, makePlan([produce, consume], fleet), fleet, {
      reporter: new SilentReporter(),
    });

    assert.equal(sawVersion, "echo produce", "the earlier command's result was lost");
  });

  it("shares what a cluster-wide step learned with everybody", async () => {
    const trace: Trace = { calls: [] };
    const fleet = makeFleet({ one: "server", two: "agent" }, trace);

    const learn: CommandSpec = {
      name: "learn",
      description: "",
      runOn: CommandTarget.ControlPlane,
      command: "echo learn",
      saveToContext: () => ({ clusterFact: "shared" }),
    } as CommandSpec;

    const seen: Record<string, unknown> = {};
    const report: CommandSpec = {
      name: "report",
      description: "",
      command: (_config: CloudConfig, context: any) => {
        seen[context.nodeName] = context.clusterFact;
        return "echo report";
      },
    } as CommandSpec;

    await runPlan(CONFIG, makePlan([learn, report], fleet), fleet, {
      reporter: new SilentReporter(),
    });

    assert.equal(seen["one"], "shared");
    assert.equal(seen["two"], "shared", "a cluster-wide finding should reach every node");
  });
});

describe("choosing what to run against", () => {
  it("takes every node for 'all'", () => {
    assert.deepEqual(resolveTarget(CONFIG, "all"), ["one", "two", "three"]);
  });

  it("takes one node by name", () => {
    assert.deepEqual(resolveTarget(CONFIG, "two"), ["two"]);
  });

  it("says what there is when the name isn't one", () => {
    assert.throws(() => resolveTarget(CONFIG, "nope"), /one, two, three/);
  });
});

describe("a cluster with no server in it", () => {
  it("says so rather than guessing", () => {
    const trace: Trace = { calls: [] };
    const fleet = makeFleet({ two: "agent", three: "agent" }, trace);

    assert.throws(() => fleet.controlPlane(), /needs "type": "server"/);
  });

  it("runs what only needs the nodes anyway", async () => {
    // One agent asked about something on the machine itself, like its
    // disks, isn't given a server, and shouldn't need one
    const trace: Trace = { calls: [] };
    const fleet = makeFleet({ two: "agent" }, trace);

    await runPlan(CONFIG, makePlan([echoCommand("find-disks")], fleet), fleet, {
      reporter: new SilentReporter(),
    });

    assert.deepEqual(trace.calls.map((call) => call.node), ["two"]);
  });
});

describe("borrowing a control plane", () => {
  // Running one bundle against one agent is the case this exists for.
  // The agent has no kubeconfig, so anything cluster-facing in that
  // bundle has to run on a server that was never asked for.
  const trace: Trace = { calls: [] };
  const borrowed = makeFleet({ one: "server" }, trace).members[0]!;
  const fleet = new Fleet(makeFleet({ two: "agent" }, trace).members, borrowed);

  it("runs cluster work on the server nobody asked for", () => {
    assert.deepEqual(nodesForScope(CommandScope.Cluster, fleet), ["one"]);
  });

  it("keeps it out of the nodes being worked on", () => {
    assert.deepEqual(fleet.names(), ["two"]);
    assert.deepEqual(fleet.agents().map((member) => member.name), ["two"]);
    assert.deepEqual(fleet.servers(), [], "a borrowed server isn't a node this run is for");
  });

  it("still finds it by name, so a step can be run on it", () => {
    assert.equal(fleet.get("one")?.name, "one");
  });

  it("prefers a server that was asked for", () => {
    const asked = new Fleet(makeFleet({ three: "server" }, trace).members, borrowed);

    assert.equal(asked.controlPlane().name, "three");
  });

  it("is what a paper fleet does too, so a dry run plans the same", () => {
    const paper = paperFleet(CONFIG, ["two"]);

    assert.deepEqual(paper.names(), ["two"]);
    assert.equal(paper.controlPlane().name, "one");
  });
});

describe("what a plan leaves out", () => {
  const fleet = makeFleet({ one: "server" }, { calls: [] });

  it("keeps only the purposes it was asked for", () => {
    const plan = buildPlan(CONFIG, "base", fleet, { purposes: PROMPT_PURPOSES });

    // "base" is all apt, and none of it is a question
    assert.deepEqual(plan.steps, []);
  });

  it("keeps everything when no purposes are named", () => {
    assert.ok(buildPlan(CONFIG, "base", fleet).steps.length > 0);
  });

  it("refuses to plan cluster work with no server to run it on", () => {
    // What the doctor meets when the control plane is the node that's
    // down: the questions can still be asked of everything else
    const agentsOnly = makeFleet({ two: "agent" }, { calls: [] });

    assert.throws(() => buildPlan(CONFIG, "cluster-online", agentsOnly), /"type": "server"/);
  });

  it("records it instead, when told to be tolerant", () => {
    const agentsOnly = makeFleet({ two: "agent" }, { calls: [] });
    const plan = buildPlan(CONFIG, "cluster-online", agentsOnly, { tolerant: true });

    assert.equal(plan.steps.length, 0, "nothing can be asked of a cluster with no server up");
    assert.equal(plan.problems.length, 1);
    assert.equal(plan.problems[0]!.bundle, "cluster-online");
  });
});

describe("what a run remembers about itself", () => {
  it("records every step on every node, including the skipped ones", async () => {
    const trace: Trace = { calls: [] };
    const fleet = makeFleet({ one: "server", two: "agent" }, trace);

    const skipped: CommandSpec = {
      ...echoCommand("nothing-to-do"),
      skipWhen: () => true,
    } as CommandSpec;

    const summary = await runPlan(
      CONFIG,
      makePlan([echoCommand("did-something"), skipped], fleet),
      fleet,
      { reporter: new SilentReporter() },
    );

    // Two steps, two nodes. The doctor's whole report is built by
    // grouping these, so a step that was skipped has to say so rather
    // than be missing.
    assert.equal(summary.outcomes.length, 4);
    assert.deepEqual(
      summary.outcomes.filter((outcome) => outcome.outcome === "skipped").map((o) => o.node).sort(),
      ["one", "two"],
    );
    assert.ok(summary.outcomes.every((outcome) => outcome.bundle === "test"));
  });

  it("tells every node what the run already knew", async () => {
    const trace: Trace = { calls: [] };
    const fleet = makeFleet({ one: "server", two: "agent" }, trace);

    const seen: Record<string, unknown> = {};
    const report: CommandSpec = {
      name: "report",
      description: "",
      command: (_config: CloudConfig, context: any) => {
        seen[context.nodeName] = context.noWaiting;
        return "echo report";
      },
    } as CommandSpec;

    await runPlan(CONFIG, makePlan([report], fleet), fleet, {
      reporter: new SilentReporter(),
      context: { noWaiting: true },
    });

    assert.equal(seen["one"], true);
    assert.equal(seen["two"], true, "the doctor tells every node not to wait");
  });
});

/**
 * A plan whose first commands are the gate bundle's and the rest
 * another's.
 */
function makeGatedPlan(gate: CommandSpec[], rest: CommandSpec[], fleet: Fleet): Plan {
  const plan = makePlan([...gate, ...rest], fleet);

  plan.steps.forEach((step, index) => {
    step.bundle = index < gate.length ? "gate" : "rest";
  });

  return { ...plan, bundles: ["gate", "rest"] };
}

/**
 * A reporter that keeps what nodes said.
 */
class ListeningReporter extends SilentReporter {
  said: { node: string; message: string }[] = [];

  override nodeSaid(node: string, message: string) {
    this.said.push({ node, message });
  }
}

describe("a gate", () => {
  it("asks nothing more of a node that didn't get through it", async () => {
    const trace: Trace = { calls: [] };
    const fleet = makeFleet({ one: "server", two: "agent" }, trace, {
      command: "echo access",
      node: "two",
    });

    const summary = await runPlan(
      CONFIG,
      makeGatedPlan([echoCommand("access")], [echoCommand("check")], fleet),
      fleet,
      { reporter: new SilentReporter(), keepGoing: true, gate: "gate" },
    );

    const checked = trace.calls.filter((call) => call.command.includes("check")).map((call) => call.node);
    assert.deepEqual(checked, ["one"], "only the node that passed should have been checked");

    const blocked = summary.outcomes.filter((outcome) => outcome.outcome === "blocked");
    assert.deepEqual(blocked.map((outcome) => outcome.node), ["two"]);

    // The gate's failure is the one failure; what wasn't asked isn't
    // counted again
    assert.equal(summary.failures.length, 1);
  });

  it("asks nothing from the control plane when the control plane didn't get through", async () => {
    const trace: Trace = { calls: [] };
    const fleet = makeFleet({ one: "server", two: "agent" }, trace, {
      command: "echo access",
      node: "one",
    });

    // On behalf of every node, run from the control plane, the way a
    // node label is
    const label = echoCommand("label", {
      runOn: CommandTarget.ControlPlane,
      scope: CommandScope.EachNode,
    });

    const summary = await runPlan(
      CONFIG,
      makeGatedPlan([echoCommand("access")], [label], fleet),
      fleet,
      { reporter: new SilentReporter(), keepGoing: true, gate: "gate" },
    );

    assert.ok(!trace.calls.some((call) => call.command.includes("label")));
    assert.equal(summary.outcomes.filter((outcome) => outcome.outcome === "blocked").length, 2);
  });

  it("changes nothing when every node gets through", async () => {
    const trace: Trace = { calls: [] };
    const fleet = makeFleet({ one: "server", two: "agent" }, trace);

    await runPlan(
      CONFIG,
      makeGatedPlan([echoCommand("access")], [echoCommand("check")], fleet),
      fleet,
      { reporter: new SilentReporter(), gate: "gate" },
    );

    assert.equal(trace.calls.filter((call) => call.command.includes("check")).length, 2);
  });
});

describe("what commands say on the console", () => {
  it("reaches the reporter, labelled with the node it was said for", async () => {
    const trace: Trace = { calls: [] };
    const fleet = makeFleet({ one: "server", two: "agent" }, trace);
    const reporter = new ListeningReporter();

    const chatty = echoCommand("chatty", {
      saveToContext: (_output: any, context: any) => {
        console.log(`hello from ${context.nodeName}`);
        return {};
      },
    });

    await runPlan(CONFIG, makePlan([chatty], fleet), fleet, { reporter });

    assert.deepEqual(
      reporter.said.map((entry) => `${entry.node}: ${entry.message}`).sort(),
      ["one: hello from one", "two: hello from two"],
    );
  });

  it("is printed under the step it came from, a node at a time", async () => {
    const trace: Trace = { calls: [] };
    const fleet = makeFleet({ one: "server", two: "agent" }, trace);
    const written: string[] = [];
    const stream = { write: (text: string) => written.push(text), columns: 80 } as any;

    const chatty = echoCommand("chatty", {
      saveToContext: (_output: any, context: any) => {
        console.log(`first from ${context.nodeName}`);
        console.log(`second from ${context.nodeName}`);
        return {};
      },
    });

    await runPlan(CONFIG, makePlan([chatty], fleet), fleet, {
      reporter: new ConsoleReporter(stream, false, false),
    });

    // eslint-disable-next-line no-control-regex
    const text = written.join("").replace(/\u001b\[[0-9;]*m/g, "");
    const lines = text.slice(text.indexOf("a test bundle")).split("\n");
    const of = (node: string) =>
      lines.filter((line) => line.startsWith(node)).map((line) => line.slice(node.length).trim());

    for (const node of ["one", "two"]) {
      assert.deepEqual(of(node), ["✅ chatty", `｜ first from ${node}`, `｜ second from ${node}`]);

      const start = lines.findIndex((line) => line.startsWith(`${node} `) && line.includes("✅"));
      assert.deepEqual(
        lines.slice(start, start + 3).map((line) => line.split(" ")[0]),
        [node, node, node],
        "a node's label and what it said should be together",
      );
    }
  });

  it("follows a step that failed by throwing", async () => {
    const trace: Trace = { calls: [] };
    const fleet = makeFleet({ one: "server" }, trace);
    const written: string[] = [];
    const stream = { write: (text: string) => written.push(text), columns: 80 } as any;

    const broken = echoCommand("broken", {
      saveToContext: () => {
        console.log("got this far");
        throw new Error("and no further");
      },
    });

    await runPlan(CONFIG, makePlan([broken], fleet), fleet, {
      reporter: new ConsoleReporter(stream, false, false),
      keepGoing: true,
    });

    // eslint-disable-next-line no-control-regex
    const text = written.join("").replace(/\u001b\[[0-9;]*m/g, "");
    assert.match(text, /one\s+🛑 broken\none\s+｜ got this far\none\s+｜ and no further/);
  });

  it("is put back once the run is over", async () => {
    const before = console.log;
    const trace: Trace = { calls: [] };
    const fleet = makeFleet({ one: "server" }, trace);

    await runPlan(CONFIG, makePlan([echoCommand("x")], fleet), fleet, {
      reporter: new SilentReporter(),
    });

    assert.equal(console.log, before);
  });
});

describe("what a node is printed as", () => {
  const config = configFrom({
    k3s: { token: "t" },
    nodes: [
      { name: "mamoru-bkk", displayName: "Mamoru (Bangkok)", address: "a", type: "server" },
      { name: "plain", address: "b", type: "agent" },
    ],
  });

  it("is its display name when it has one, and its name when it doesn't", () => {
    const names = getDisplayNames(config);

    assert.equal(displayNode(names, "mamoru-bkk"), "Mamoru (Bangkok)");
    assert.equal(displayNode(names, "plain"), "plain");
  });

  it("is what the reporter labels its lines with", () => {
    const written: string[] = [];
    const stream = { write: (text: string) => written.push(text), columns: 80 } as any;
    const reporter = new ConsoleReporter(stream, false, false, getDisplayNames(config));

    reporter.planned(["mamoru-bkk", "plain"], 1, ["test"]);
    reporter.nodeFinished("check", "mamoru-bkk", "ok");

    // eslint-disable-next-line no-control-regex
    const text = written.join("").replace(/\u001b\[[0-9;]*m/g, "");
    assert.match(text, /Mamoru \(Bangkok\) ✅ check/);
    assert.ok(!text.includes("mamoru-bkk"), "the name shouldn't be printed where a display name is set");
  });
});

describe("a package that isn't installed", () => {
  const documensoChecks = () =>
    buildPackageCommands(resolvePackage("documenso", {})).filter((command) =>
      READ_ONLY_PURPOSES.includes(command.purpose ?? CommandPurpose.Apply),
    );

  it("is asked about before anything else about it is", () => {
    const names = documensoChecks().map((command) => command.name);
    const presence = names.indexOf("verify-installed-documenso");

    assert.ok(presence >= 0, "there should be a check that it's installed");
    assert.ok(presence < names.indexOf("verify-secrets-documenso"));
    assert.ok(presence < names.indexOf("verify-rollout-documenso"));
  });

  it("is said once, and its other checks are skipped", async () => {
    const trace: Trace = { calls: [] };
    const fleet = makeFleet({ one: "server" }, trace, {
      command: "get 'deployment/documenso' > /dev/null",
      node: "one",
    });

    const summary = await runPlan(CONFIG, makePlan(documensoChecks(), fleet), fleet, {
      reporter: new SilentReporter(),
      keepGoing: true,
    });

    const outcome = (step: string) => summary.outcomes.find((each) => each.step === step)?.outcome;

    assert.equal(outcome("verify-installed-documenso"), "failed");
    assert.deepEqual(summary.failures.map((failure) => failure.step), ["verify-installed-documenso"]);
    assert.equal(outcome("verify-secrets-documenso"), "skipped");
    assert.equal(outcome("verify-rollout-documenso"), "skipped");
    assert.equal(outcome("verify-authentik-documenso"), "skipped");

    // The namespace's mail is the namespace's, and asked either way
    assert.equal(outcome("verify-smtp-cc-office"), "ok");
  });
});
