/**
 * @file
 * Turning a pipeline into the steps a cluster will actually take.
 *
 * The whole plan is worked out before any of it runs. That is worth
 * the trouble for two reasons. A misspelled bundle at the end of a
 * pipeline should be found now rather than twenty minutes in, with
 * half a cluster built. And knowing how many steps there are is what
 * lets the run say how far through it is — a progress bar that
 * discovers its own length as it goes is not telling anyone much.
 *
 * A step here is one command, together with the nodes it applies to.
 * Not a bundle: a bundle is a sensible unit for a person to ask for
 * and too coarse to synchronise on, because a bundle that fails
 * halfway leaves its nodes at different points of the same bundle,
 * which is the thing this design exists to avoid.
 */
import CloudConfig from "../util/CloudConfig.ts";
import {
  CommandPurpose,
  CommandScope,
  CommandSpec,
  CommandTarget,
  getCommandScope,
} from "../cli/commands/Command.ts";
import { getCommandType } from "../cli/commands/createCommand.ts";
import {
  BundleDefinition,
  getBundle,
  getBundleCommands,
  getBundleNames,
} from "../cli/commands/bundles.ts";
import { Fleet } from "./fleet.ts";

/**
 * One step: a command, and who it runs for.
 *
 * - nodes: the nodes this runs on behalf of. A cluster-wide step has
 *   exactly one entry, the node it will be run from, because a step
 *   with no nodes is a step that does nothing and a step with several
 *   would be doing the same work twice.
 */
export interface Step {
  bundle: string;
  bundleDescription: string;
  command: CommandSpec;
  scope: CommandScope;
  nodes: string[];

  // Where the shell runs, which is not the same question as which
  // nodes the step is for
  runOn: CommandTarget;
}

/**
 * A whole run, worked out in advance.
 */
export interface Plan {
  steps: Step[];
  bundles: string[];
  nodes: string[];

  // Bundles that couldn't be turned into steps at all. Empty unless
  // the plan was built tolerantly, because otherwise this throws.
  problems: PlanProblem[];
}

/**
 * A bundle that couldn't be planned.
 */
export interface PlanProblem {
  bundle: string;
  why: string;
}

/**
 * How a plan should be built.
 *
 * - purposes: only include commands for these. What makes the same
 *   pipeline serve as a thing that installs a cluster and a thing
 *   that asks the cluster how it is.
 * - tolerant: record a bundle that can't be built and carry on,
 *   rather than refusing to plan. Right for anything only asking
 *   questions — one unanswerable bundle shouldn't cost you the answer
 *   to the other fourteen — and wrong for an install, where a bundle
 *   that won't build is a configuration to fix before starting.
 */
export interface PlanOptions {
  purposes?: CommandPurpose[];
  tolerant?: boolean;
}

/**
 * Which nodes a scope covers.
 *
 * @param scope
 * @param fleet
 * @returns
 */
export function nodesForScope(scope: CommandScope, fleet: Fleet): string[] {
  switch (scope) {
    case CommandScope.Cluster:
      // Once, from a server. Named so the reporting can say where it
      // happened, and so a cluster step is a step like any other.
      return [fleet.controlPlane().name];

    case CommandScope.EachServer:
      return fleet.servers().map((member) => member.name);

    case CommandScope.EachAgent:
      return fleet.agents().map((member) => member.name);

    default:
      return fleet.names();
  }
}

/**
 * Work out every step a pipeline will take.
 *
 * @param config
 * @param pipelineName a comma separated list of bundles, or the name
 *   of one under "pipelines" in the configuration
 * @param fleet
 * @returns
 */
export function buildPlan(
  config: CloudConfig,
  pipelineName: string,
  fleet: Fleet,
  options: PlanOptions = {},
): Plan {
  const definitions = resolvePipeline(config, pipelineName);
  const steps: Step[] = [];
  const problems: PlanProblem[] = [];

  for (const definition of definitions) {
    // Every bundle's command list is a function of the configuration
    // alone, so it is the same for every node and can be worked out
    // once. A bundle whose commands started varying per node would
    // break the lock-step this relies on — every node has to be able
    // to reach the same step — so that is a thing to be careful about
    // rather than a thing to build on.
    let commands: CommandSpec[];

    try {
      commands = getBundleCommands(definition, config, buildPlanningContext(fleet));
    } catch (error: any) {
      if (options.tolerant !== true) {
        throw error;
      }

      problems.push({ bundle: definition.name, why: error.message });
      continue;
    }

    for (const command of commands) {
      if (!isWanted(command, options)) {
        continue;
      }

      const scope = getCommandScope(command);
      let nodes: string[];

      try {
        nodes = nodesForScope(scope, fleet);
      } catch (error: any) {
        // Cluster work with no reachable server. Worth recording
        // rather than dropping: "the control plane is down" is the
        // answer somebody is looking for.
        if (options.tolerant !== true) {
          throw error;
        }

        problems.push({ bundle: definition.name, why: error.message });
        break;
      }

      // A step with nobody to run it isn't an error: a cluster with no
      // agents simply has nothing to do at the agent steps.
      if (nodes.length === 0) {
        continue;
      }

      steps.push({
        bundle: definition.name,
        bundleDescription: definition.description,
        command,
        scope,
        nodes,
        runOn: command.runOn ?? CommandTarget.Node,
      });
    }
  }

  return {
    steps,
    bundles: definitions.map((definition) => definition.name),

    // The nodes asked for, plus anywhere a step actually lands. A
    // cluster step runs on a server, and that server is sometimes one
    // this run borrowed rather than one it was pointed at.
    nodes: [...new Set([...fleet.names(), ...steps.flatMap((step) => step.nodes)])],
    problems,
  };
}

/**
 * Whether a plan wants this command in it.
 *
 * A command with no recognisable type can't be run by anything, which
 * matters here because a plan filtered by purpose is counted — a
 * bundle reporting "12 checks, all happy" shouldn't be counting things
 * that never ran.
 *
 * @param command
 * @param options
 * @returns
 */
function isWanted(command: CommandSpec, options: PlanOptions): boolean {
  if (options.purposes === undefined) {
    return true;
  }

  return (
    options.purposes.includes((command.purpose ?? CommandPurpose.Apply) as CommandPurpose) &&
    getCommandType(command) !== undefined
  );
}

/**
 * A context good enough to build a command list from.
 *
 * Only the bundles whose commands come from the configuration use it,
 * and none of them reads anything node-specific — but they are handed
 * the control plane's identity rather than nothing, so that a bundle
 * which starts doing so fails visibly here rather than producing a
 * command list for a node called undefined.
 *
 * @param fleet
 * @returns
 */
function buildPlanningContext(fleet: Fleet): Record<string, unknown> {
  const controlPlane = fleet.members.length > 0 ? fleet.controlPlane() : undefined;

  return {
    nodeName: controlPlane?.name,
    node: controlPlane?.node,
    params: [],
    planning: true,
  };
}

/**
 * The bundles a pipeline names.
 *
 * @param config
 * @param pipelineName
 * @returns
 */
export function resolvePipeline(
  config: CloudConfig,
  pipelineName: string,
): BundleDefinition[] {
  const named = getConfiguredPipelines(config)[pipelineName];
  const wanted = named !== undefined ? named : pipelineName.split(",");

  const definitions: BundleDefinition[] = [];

  for (const name of wanted.map((entry) => entry.trim()).filter((entry) => entry !== "")) {
    const definition = getBundle(name);

    if (definition === undefined) {
      // Asking for one bundle by name is the common case, and being
      // told that "the pipeline base names it" reads like a riddle
      throw new Error(
        name === pipelineName
          ? `Couldn't find a command bundle named "${name}". Was it spelled correctly? The bundles that can be run are: ${getBundleNames().join(", ")}.`
          : `"${name}" isn't a bundle. The pipeline "${pipelineName}" names it, and the bundles that exist are: ${getBundleNames().join(", ")}.`,
      );
    }

    definitions.push(definition);
  }

  if (definitions.length === 0) {
    throw new Error(
      `The pipeline "${pipelineName}" doesn't name any bundles to run.`,
    );
  }

  return definitions;
}

/**
 * The pipelines a configuration defines.
 *
 * @param config
 * @returns
 */
export function getConfiguredPipelines(config: CloudConfig): Record<string, string[]> {
  const { pipelines } = config.getConfig();

  return pipelines !== undefined && pipelines !== null ? pipelines : {};
}

/**
 * Describe a plan in the shape a person wants to read before agreeing
 * to it: what will happen, in order, to whom.
 *
 * @param plan
 * @returns the lines to show
 */
export function describePlan(plan: Plan): string[] {
  const lines: string[] = [];
  let bundle: string | undefined;

  for (const [index, step] of plan.steps.entries()) {
    if (step.bundle !== bundle) {
      bundle = step.bundle;
      lines.push(`  ${bundle}`);
    }

    const who =
      step.scope === CommandScope.Cluster
        ? "the cluster"
        : `${step.nodes.length} node${step.nodes.length === 1 ? "" : "s"}`;

    lines.push(`    ${String(index + 1).padStart(3)}. ${step.command.name}  (${who})`);
  }

  return lines;
}
