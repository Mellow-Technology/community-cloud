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
import { PROMPT_PURPOSES } from "../cli/commands/Command.ts";
import {
  Fleet,
  FleetMember,
  isServerNode,
  paperFleet,
  resolveTarget,
} from "../pipeline/fleet.ts";
import { Plan, Step, buildPlan, nodesForScope } from "../pipeline/plan.ts";
import { SilentReporter } from "../pipeline/reporter.ts";
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
