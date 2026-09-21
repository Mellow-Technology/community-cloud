/**
 * @file
 * Taking a node back out of a cluster, and removing what that kept.
 *
 * Three things are worth holding onto here, and all three are about
 * refusing rather than doing.
 *
 * The order: drain has to come before K3s is stopped, or the workloads
 * are killed rather than moved, and the node can only be removed from
 * the cluster after its kubelet has stopped, or it registers itself
 * again. Both are orderings that would still "work" if reversed, in
 * the sense of running to the end and reporting success, which is
 * exactly why they want a test rather than a comment.
 *
 * The blast radius: an uninstall is about one machine. Nothing in it
 * may touch the bundles that build the cluster, because taking one
 * agent away should not reinstall a CNI.
 *
 * The gate on the disks: the volume groups hold what the applications
 * stored, and nothing in this repository can put that back. The check
 * lives in the bundle rather than the runner so that no route to it is
 * shorter than any other, and a run told to keep going past failures
 * must not carry on past that particular one.
 *
 * Nothing here connects to anything — every plan is built on paper,
 * which is what --dry-run does.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { CommandTarget } from "../cli/commands/Command.ts";
import { INSTALL_PIPELINE } from "../runners/install.ts";
import {
  UNINSTALL_PIPELINE,
  UNINSTALL_SERVER_PIPELINE,
  uninstall,
} from "../runners/uninstall.ts";
import { CLEAN_FULL_PIPELINE, CLEAN_PIPELINE } from "../runners/clean.ts";
import { buildPlan } from "../pipeline/plan.ts";
import {
  getBundle,
  getBundleCommands,
  getBundleNames,
  getCheckableBundleNames,
} from "../cli/commands/bundles.ts";
import { paperFleet } from "../pipeline/fleet.ts";
import { FIXTURE_CONFIG, configFrom, withoutConsole } from "./helpers.ts";

// A server with one agent joined to it
const CONFIG = configFrom({
  k3s: { token: "t" },
  nodes: [
    { name: "one", address: "one", type: "server" },
    { name: "two", address: "two", type: "agent", roles: ["worker"] },
  ],
});

// What an install does to build the cluster rather than a machine.
// None of it has any business running while a node is leaving.
const CLUSTER_WIDE = ["cilium", "gateway", "helm", "helm-charts", "cluster"];

/**
 * The commands in a bundle, by name.
 *
 * @param name
 * @returns
 */
function commandsIn(name: string) {
  const bundle = getBundle(name);
  assert.ok(bundle !== undefined, `there is no bundle called "${name}"`);

  return getBundleCommands(bundle, CONFIG);
}

/**
 * One command out of a bundle.
 *
 * @param bundle
 * @param command
 * @returns
 */
function commandIn(bundle: string, command: string): any {
  const found = commandsIn(bundle).find((spec) => spec.name === command);
  assert.ok(found !== undefined, `${bundle} has no command called "${command}"`);

  return found;
}

describe("the bundles an uninstall runs", () => {
  it("names only bundles that exist", () => {
    const missing = [...UNINSTALL_PIPELINE, ...UNINSTALL_SERVER_PIPELINE].filter(
      (name) => !getBundleNames().includes(name),
    );

    assert.deepEqual(missing, []);
  });

  it("rebuilds nothing about the cluster", () => {
    const rebuilding = UNINSTALL_PIPELINE.filter((name) => CLUSTER_WIDE.includes(name));

    assert.deepEqual(rebuilding, [], "one node leaving is not a reason to reinstall a CNI");
  });

  it("moves the work off before it stops anything", () => {
    assert.ok(
      UNINSTALL_PIPELINE.indexOf("drain") < UNINSTALL_PIPELINE.indexOf("k3s-uninstall"),
      "stopping K3s first would kill the workloads rather than move them",
    );
  });

  it("tells the cluster last, once the kubelet has stopped", () => {
    assert.ok(
      UNINSTALL_PIPELINE.indexOf("node-removed") >
        UNINSTALL_PIPELINE.indexOf("k3s-uninstall"),
      "a node deleted while its kubelet runs simply registers itself again",
    );
  });

  it("asks whether there is a cluster before touching anything", () => {
    assert.equal(UNINSTALL_PIPELINE[0], "cluster-online");
  });

  it("asks a server nothing, because it is the thing going away", () => {
    const clusterFacing = UNINSTALL_SERVER_PIPELINE.filter((name) =>
      ["cluster-online", "drain", "node-removed"].includes(name),
    );

    assert.deepEqual(
      clusterFacing,
      [],
      "there is no cluster left to drain to or be removed from",
    );
  });
});

describe("the plan for uninstalling one agent", () => {
  const plan = buildPlan(
    CONFIG,
    UNINSTALL_PIPELINE.join(","),
    paperFleet(CONFIG, ["two"]),
  );

  it("drains from the server, about the agent", () => {
    const drain = plan.steps.find((step) => step.command.name === "drain-node");

    assert.deepEqual(drain?.nodes, ["two"], "the agent is what is being emptied");
    assert.equal(drain?.runOn, CommandTarget.ControlPlane, "kubectl lives on a server");
  });

  it("takes K3s off the agent itself", () => {
    const removal = plan.steps.find((step) => step.command.name === "remove-k3s");

    assert.deepEqual(removal?.nodes, ["two"]);
    assert.equal(removal?.runOn, CommandTarget.Node);
  });

  it("changes nothing on the server", () => {
    const elsewhere = plan.steps.filter(
      (step) => step.nodes.includes("one") && step.runOn !== CommandTarget.ControlPlane,
    );

    assert.deepEqual(elsewhere, [], "the node that stays should be left alone");
  });
});

describe("what uninstall refuses", () => {
  /**
   * What uninstalling this says, when it says no.
   */
  async function refusal(nodeName: string, options: object = {}): Promise<string> {
    try {
      await withoutConsole(() =>
        uninstall(nodeName, FIXTURE_CONFIG, { dryRun: true, ...options }),
      );
    } catch (error: any) {
      return error.message;
    }

    return "";
  }

  it("won't take down a control plane without being told to", async () => {
    const message = await refusal("server-1");

    assert.match(message, /is a server/);
    assert.match(message, /--server/, "it should say what to do about it");
  });

  it("does take one down when it is told to", async () => {
    assert.equal(await refusal("server-1", { server: true }), "");
  });

  it("won't agree to destroy a cluster that isn't going to be destroyed", async () => {
    // --server on an agent is somebody expecting the drastic thing to
    // happen, and it isn't going to, so saying nothing would be worse
    assert.match(await refusal("agent-1", { server: true }), /is an agent/);
  });

  it("won't do every node at once", async () => {
    assert.match(await refusal("all"), /one node at a time/);
  });

  it("won't uninstall a node the configuration has never heard of", async () => {
    const message = await refusal("nowhere");

    assert.match(message, /no node called "nowhere"/);
    assert.match(message, /server-1/, "it should say what there is");
  });
});

describe("what a check-up leaves alone", () => {
  it("skips the bundles that take a cluster apart", () => {
    const checkable = getCheckableBundleNames();

    for (const name of ["drain", "k3s-uninstall", "node-removed", "clean", "storage-remove"]) {
      assert.ok(
        !checkable.includes(name),
        `${name} asserts the opposite of a working cluster, so a check-up would call a healthy node broken`,
      );
    }
  });

  it("still asks about everything that builds one", () => {
    const missing = INSTALL_PIPELINE.filter(
      (name) => !getCheckableBundleNames().includes(name),
    );

    assert.deepEqual(missing, []);
  });
});

describe("cleaning", () => {
  it("names only bundles that exist", () => {
    const missing = [...CLEAN_PIPELINE, ...CLEAN_FULL_PIPELINE].filter(
      (name) => !getBundleNames().includes(name),
    );

    assert.deepEqual(missing, []);
  });

  it("only touches the disks when asked for the full thing", () => {
    assert.ok(!CLEAN_PIPELINE.includes("storage-remove"));
    assert.ok(CLEAN_FULL_PIPELINE.includes("storage-remove"));
  });

  it("removes the filesystem before the disks", () => {
    assert.ok(
      CLEAN_FULL_PIPELINE.indexOf("clean") <
        CLEAN_FULL_PIPELINE.indexOf("storage-remove"),
      "a run that stops halfway should have removed the recoverable half",
    );
  });

  it("refuses to clean a node that is still using what it would remove", () => {
    const check = commandIn("clean", "check-ready-to-clean");
    const text = (check.command as string[]).join("\n");

    assert.match(text, /is-active/, "a running K3s means the directories are in use");
    assert.match(
      text,
      /var\/lib\/kubelet/,
      "removing a directory a volume is mounted on deletes what is in the volume",
    );
  });
});

describe("the gate on destroying a node's disks", () => {
  const groups = [{ name: "cc-ssd-vg", size: 1_000_000_000, volumes: [{ name: "v", size: 1 }] }];
  const approval = commandIn("storage-remove", "check-storage-approved");
  const removal = commandIn("storage-remove", "remove-volume-groups");

  /**
   * What the approval check builds, as one string.
   */
  function approvalFor(context: object): string {
    const built = approval.command(CONFIG, context);

    return Array.isArray(built) ? built.join("\n") : built;
  }

  it("refuses when nobody has said yes, and names what it would destroy", () => {
    const text = approvalFor({ ownedVolumeGroups: groups });

    assert.match(text, /exit 1/, "it has to actually fail, not just complain");
    assert.match(text, /cc-ssd-vg/, "somebody deciding needs to know what is at stake");
    assert.match(text, /--yes/, "and what to do if they mean it");
  });

  it("goes ahead once somebody has", () => {
    const text = approvalFor({ ownedVolumeGroups: groups, storageApproved: true });

    assert.doesNotMatch(text, /exit 1/);
  });

  it("has nothing to approve when nothing on the node is ours", () => {
    const text = approvalFor({ ownedVolumeGroups: [], storageApproved: false });

    assert.doesNotMatch(text, /exit 1/);
  });

  it("still won't remove anything when the refusal was stepped over", () => {
    // --keep-going carries on past a failed step, so a refusal that
    // only lived in the check before this would be noted and then
    // walked straight past on the way to doing the thing it refused
    assert.equal(
      removal.skipWhen(CONFIG, { ownedVolumeGroups: groups, storageApproved: false }),
      true,
    );

    assert.equal(
      removal.skipWhen(CONFIG, { ownedVolumeGroups: groups, storageApproved: true }),
      false,
    );
  });

  it("only ever removes groups this installer tagged", () => {
    const read = commandIn("storage-remove", "read-volume-groups");
    const text = (read.command as string[]).join("\n");

    // Ownership is a tag we put there, not a name anybody could pick
    assert.match(text, /vg_tags/);
  });
});
