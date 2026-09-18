/**
 * @file
 * The base of everything a bundle can run.
 *
 * A bundle is a sequence of steps, and not every step is a shell
 * command: some of what has to happen during an install is an API
 * call. Both kinds share the same shape — they produce output, that
 * output gets parsed, post-processed and can be handed to the steps
 * that follow — so the shared half lives here and the subclasses only
 * describe how they actually go and get the output.
 *
 * - TerminalCommand runs something in a shell, locally or over SSH
 * - WebCommand calls an HTTP API
 */
import { loadAll } from "js-yaml";

import CloudConfig from "../../util/CloudConfig.ts";

export enum OutputType {
  // Output is JSON
  Json = "json",

  // Output is CSV
  Csv = "csv",

  // Output is Yaml
  Yaml = "yaml",

  // Output is handled by a custom function
  // in order to parse the output
  Custom = "custom",

  // Raw output will short-circuit any parsing
  Raw = "raw",
}

/**
 * The kinds of command a bundle can hold.
 */
export enum CommandType {
  Terminal = "terminal",
  Web = "web",
}

/**
 * What a command is for.
 *
 * Every command in here does one of four things, and the difference
 * that matters most is whether it changes anything. A cluster people
 * depend on should be safe to ask questions of, and that's only true
 * if something knows which commands are questions.
 *
 * - Inspect: reads the node or the cluster and says what it found.
 *   Every answer is a valid answer — a node with no GPU is a fine
 *   node, K3s not being installed yet is a fine thing to discover —
 *   and what it finds is usually for the commands after it.
 * - Require: reads, and demands a particular answer. This is what has
 *   to be true before the work can start: a kernel offering the
 *   congestion control we're about to set, a cluster with Cilium in
 *   it. A failure here means don't bother trying.
 * - Verify: reads, and demands that a change actually took. Same
 *   mechanics as Require, opposite assumption — Require expects
 *   nothing to be installed, Verify expects everything to be.
 * - Settle: waits for a change to finish taking effect. Changes
 *   nothing itself, but only means anything directly after an Apply,
 *   and it is the one kind that can block for a long time — the point
 *   of it is to wait. On a healthy node it returns at once; on a
 *   broken one it waits out its whole timeout before saying so, which
 *   is right during an install and useless to anything just asking
 *   questions.
 * - Apply: changes something. Installs, writes, labels, restarts.
 *
 * All but the last change nothing, which is what makes them safe to
 * run against a cluster in service. Apply is the default precisely
 * because a command that hasn't said what it is should be treated as
 * though it changes the world.
 */
export enum CommandPurpose {
  Inspect = "inspect",
  Require = "require",
  Verify = "verify",
  Settle = "settle",
  Apply = "apply",
}

/**
 * The purposes that change nothing, and so can be run against a
 * cluster without asking anyone first.
 *
 * Safe is not the same as quick: Settle is in here because it changes
 * nothing, and left out of anything that has to answer promptly.
 */
export const READ_ONLY_PURPOSES: CommandPurpose[] = [
  CommandPurpose.Inspect,
  CommandPurpose.Require,
  CommandPurpose.Verify,
  CommandPurpose.Settle,
];

/**
 * The purposes that change nothing and answer without waiting.
 */
export const PROMPT_PURPOSES: CommandPurpose[] = READ_ONLY_PURPOSES.filter(
  (purpose) => purpose !== CommandPurpose.Settle,
);

/**
 * Whether a command changes anything.
 *
 * @param purpose
 * @returns
 */
export function isReadOnly(purpose: CommandPurpose): boolean {
  return READ_ONLY_PURPOSES.includes(purpose);
}

/**
 * Where a command runs.
 *
 * A bundle is aimed at one node and nearly everything in it belongs
 * there: installing a package, reading the hardware, writing a config
 * file. Anything that talks to the cluster is the exception, because
 * only a server has a kubeconfig. Rather than making every bundle that
 * needs kubectl be run from the control plane, and losing the node it
 * was actually about, a command says where it wants to run and the
 * runner opens the connection it needs.
 *
 * - Node: the node the bundle is aimed at. The default.
 * - ControlPlane: a server, wherever that is. The node the bundle is
 *   about is still in the context, so a command can act on it by name.
 */
export enum CommandTarget {
  Node = "node",
  ControlPlane = "control-plane",
}

/**
 * How many times a command runs, and for which nodes.
 *
 * This is a different question from "runOn", and the two get confused
 * because on a single node they look like the same thing. "runOn" says
 * which machine executes the shell. This says how many times, and on
 * whose behalf.
 *
 * Labelling a node is the case that shows they're separate: the shell
 * is kubectl, so it has to run on a server, and it is nevertheless one
 * command per node in the cluster.
 *
 * - Cluster: once, whatever the cluster's size. Anything addressing
 *   Kubernetes rather than a machine — applying a manifest, installing
 *   a chart. The API is shared, so doing it per node would be doing it
 *   again.
 * - EachNode: once per node. System configuration, hardware, storage,
 *   and anything about a particular machine even when something else
 *   carries it out.
 * - EachServer / EachAgent: once per node of that kind. K3s is the
 *   reason both exist: a server has to be up before an agent can join
 *   it, so those are two steps rather than one.
 */
export enum CommandScope {
  Cluster = "cluster",
  EachNode = "each-node",
  EachServer = "each-server",
  EachAgent = "each-agent",
}

/**
 * What a command's scope is, including the ones that never said.
 *
 * The default is worked out from where it runs, because that is right
 * for almost every command already written: something running on the
 * control plane is talking to the cluster and wants doing once, and
 * something running on a node is about that node. Only the commands
 * where those two come apart have to say so, which today is labelling
 * a node and installing K3s.
 *
 * @param spec
 * @returns
 */
export function getCommandScope(spec: BaseCommandSpec): CommandScope {
  if (spec.scope !== undefined) {
    return spec.scope;
  }

  return spec.runOn === CommandTarget.ControlPlane
    ? CommandScope.Cluster
    : CommandScope.EachNode;
}

/**
 * Whether a scope means one command per node rather than one for the
 * whole cluster.
 *
 * @param scope
 * @returns
 */
export function isPerNode(scope: CommandScope): boolean {
  return scope !== CommandScope.Cluster;
}

/**
 * The output of a command.
 *
 * Both kinds of command report through the same fields so that
 * parsing, post-processing and anything reading a previous result
 * doesn't have to care which one produced it. For a web command
 * "stdout" is the response body, and status and headers carry the
 * rest of the response.
 */
export interface CommandOutput {
  stdout: string | null;
  stderr: string | null;
  parsed?: any;
  processed?: any;

  // Set by web commands
  status?: number;
  headers?: Record<string, string>;

  // What this command added to the bundle's context
  contextUpdates?: ContextUpdates;
}

/**
 * Values a command adds to the context shared by the bundle.
 */
export type ContextUpdates = Record<string, unknown>;

/**
 * What a command is told before it runs: everything the commands
 * before it decided to pass on.
 *
 * Deliberately open, and named rather than written as "any" at each
 * of the several dozen places that take one. The whole point of the
 * context is that a bundle can put a finding in it that nothing else
 * knew about — the disks lvm found, the GPUs gpu found — and having
 * to declare each one in a closed shape here would make adding a
 * finding a change in two places.
 *
 * The cost is that a typo in a context key isn't caught by the
 * compiler, which is the trade this makes knowingly. Being one name
 * is what makes tightening it later a single edit rather than a
 * hundred.
 */
export type CommandContext = any;

/**
 * What the commands before this one returned, by name.
 */
export type CommandResults = Record<string, any>;

/**
 * What every command has, whichever kind it is.
 *
 * - name: a label for the command, and the key its result is kept under
 * - description: a description to show the user what the command does
 * - type: which kind of command this is. Worked out from the spec when
 *   it isn't given, so it's only needed to settle an ambiguous case
 * - output: an output type that will be automatically parsed
 * - postProcessHooks: functions run over the parsed output, whose
 *   result lands in "processed"
 * - saveToContext: what to put into the bundle's context for later
 *   commands to use. Either a map of context key to a path into this
 *   command's output ("parsed.token", "status"), or a function handed
 *   the output which returns the values to add.
 * - purpose: what the command is for, and in particular whether it
 *   changes anything. Defaults to Apply, so a command that doesn't say
 *   is never run by anything that promised to only look.
 * - runOn: where the command runs. Defaults to the node the bundle is
 *   aimed at; set to the control plane for anything needing kubectl.
 * - scope: how many times it runs and for which nodes. Worked out from
 *   "runOn" when it isn't given, which is right for everything except
 *   the commands where the two come apart.
 * - skipWhen: a function saying this command has nothing to do, given
 *   what the commands before it found. A bundle that can be run twice
 *   needs this: a shell command can check the state it's about to
 *   change, but an API call that creates something can't take itself
 *   back once it has been sent.
 */
export interface BaseCommandSpec {
  name: string;
  description: string;
  type?: CommandType;
  output?: OutputType;
  commandParser?: string;
  postProcessHooks?: Function[];
  parseFunction?: Function;
  saveToContext?: Record<string, string> | Function;
  skipWhen?: Function;
  purpose?: CommandPurpose;
  runOn?: CommandTarget;
  scope?: CommandScope;
}

/**
 * A command that runs in a shell.
 *
 * - command: the command itself, or a function that builds it. Most
 *   commands here are several lines of shell, so an array is taken as
 *   those lines and joined, and a function may return either form.
 * - sudo: whether the command should be run using sudo
 * - env: environment variables for the command, either as an object or
 *   as a function worked out from the configuration
 * - stdin: what to write to the command's standard input, as a string
 *   or a function returning one. This is where anything secret or
 *   large belongs: a command line is world-readable in a process
 *   listing and gets repeated back in error messages, while standard
 *   input is seen only by the process reading it.
 * - secretEnv: environment variables that mustn't appear on the
 *   command line. They travel over standard input and are exported by
 *   a preamble on the far side, so "env" stays the place for ordinary
 *   settings and this is the place for credentials.
 * - commandParser: a program to pipe the output through before parsing
 *   e.g. for using JC (https://github.com/kellyjonbrazil/jc)
 */
export interface TerminalCommandSpec extends BaseCommandSpec {
  command: string | string[] | Function;
  sudo?: boolean;
  env?: Record<string, string> | Function;
  stdin?: string | Function;
  secretEnv?: Record<string, unknown> | Function;
  remoteHost?: unknown;
}

/**
 * A command that calls an HTTP API.
 *
 * Every part of the request can be a function taking the same
 * arguments a command builder does, so a request can be put together
 * from the configuration and from what earlier commands found.
 *
 * - url: where to send the request
 * - method: defaults to GET
 * - query: query string parameters
 * - headers: request headers
 * - body: a string is sent as-is, anything else is sent as JSON
 * - expectStatus: response codes to accept. Any 2xx by default.
 * - timeout: how long to wait, in milliseconds
 */
export interface WebCommandSpec extends BaseCommandSpec {
  url: string | Function;
  method?: string;
  query?: Record<string, string | number | boolean> | Function;
  headers?: Record<string, string> | Function;
  body?: unknown;
  expectStatus?: number[];
  timeout?: number;
}

/**
 * The specification for a command of any kind.
 */
export type CommandSpec = TerminalCommandSpec | WebCommandSpec;

/**
 * Turn what a spec gave as a command into the one string a shell runs.
 *
 * Nearly every command in here is a sequence of steps, and writing
 * that as an array reads better than one long string. Joining is done
 * here rather than at each spec so that they all agree on the
 * separator, which had been half "; " and half "\n".
 *
 * The separator is a newline, because "; " is wrong after the words
 * that take their body straight after them. "for x in y; do; echo $x;
 * done" is a syntax error, and it's an easy one to write by accident
 * when the join is putting the separators in.
 *
 * @param command
 * @returns
 */
export function joinCommand(command: string | string[]): string {
  return Array.isArray(command) ? command.join("\n") : command;
}

/**
 * A single step in a bundle.
 *
 * Subclasses only have to say how they get their output. Everything
 * after that — parsing it, running the post-process hooks, working out
 * what to hand to the commands that follow — happens here.
 */
export default abstract class Command {
  // A human readable name
  name: string;

  // A description of what the command does
  description: string;

  // The raw output of the command
  rawOutput: CommandOutput | null;

  // The type of output the command has
  outputType: OutputType;

  // The parsed output of the command
  // TODO: Make this a generic so that
  // each command has a verifiable output
  parsedOutput: CommandOutput;

  // An optional program used to process the
  // output of a command before parsing
  commandParser?: string;

  // An array of functions that can be used to post-process
  // data from a command after parsing. Processed data is
  // placed in the "processed" key of the CommandOutput
  postProcessHooks?: Function[];

  // An optional function to parse the output
  parseFunction?: Function;

  // What this command contributes to the bundle's context
  saveToContext?: Record<string, string> | Function;

  // Whether this command has anything to do
  skipWhen?: Function;

  // Where the command runs
  runOn: CommandTarget;

  // What the command is for, and so whether it changes anything
  purpose: CommandPurpose;

  // Whether to print the output as it goes. On by default, because a
  // bundle being run by hand is something a person is watching.
  quiet: boolean;

  constructor(
    {
      name,
      description,
      output = undefined,
      commandParser = undefined,
      postProcessHooks = undefined,
      parseFunction = undefined,
      saveToContext = undefined,
      skipWhen = undefined,
      purpose = CommandPurpose.Apply,
      runOn = CommandTarget.Node,
    }: BaseCommandSpec,
    defaultOutput: OutputType = OutputType.Raw,
  ) {
    this.name = name;
    this.description = description;
    this.outputType = output !== undefined ? output : defaultOutput;
    this.commandParser = commandParser;
    this.postProcessHooks = postProcessHooks;
    this.parseFunction = parseFunction;
    this.saveToContext = saveToContext;
    this.skipWhen = skipWhen;
    this.purpose = purpose;
    this.quiet = false;
    this.runOn = runOn;
    this.rawOutput = null;
    this.parsedOutput = {
      stdout: null,
      stderr: null,
      parsed: null,
    };
  }

  /**
   * Go and get the output. This is the part that differs between a
   * shell command and an API call, and the only thing a subclass has
   * to provide.
   *
   * @param config
   * @param context
   * @param commandResults
   */
  /**
   * Whether this command has anything left to do.
   *
   * @param config
   * @param context
   * @param commandResults
   * @returns
   */
  /**
   * Stop printing the output as it goes.
   *
   * @param quiet
   */
  setQuiet(quiet: boolean = true) {
    this.quiet = quiet;
  }

  shouldSkip(
    config: CloudConfig,
    context: CommandContext,
    commandResults: CommandResults,
  ): boolean {
    if (typeof this.skipWhen !== "function") {
      return false;
    }

    return this.skipWhen(config, context, commandResults) === true;
  }

  protected abstract run(
    config: any,
    context: any,
    commandResults: any,
  ): Promise<CommandOutput>;

  /**
   * Execute a command
   * @param config
   * @returns
   */
  async exec(
    config: CloudConfig,
    context: CommandContext,
    commandResults: CommandResults,
  ): Promise<CommandOutput> {
    this.rawOutput = await this.run(config, context, commandResults);

    // Parse the output from the command
    // If it doesn't succeed
    // we simply return the raw output
    const parseSucceeded = await this.parseOutput();
    if (!parseSucceeded) {
      return this.rawOutput;
    }

    // Run post-process hooks
    if (this.postProcessHooks !== undefined) {
      for (let i = 0; i < this.postProcessHooks.length; i++) {
        const hook = this.postProcessHooks[i];
        if (hook !== undefined) {
          this.parsedOutput.processed = hook(this.parsedOutput);
        }
      }
    }

    // Work out what the commands after this one should be able to see.
    // Merging it into the context is the bundle's job, so that the
    // context has one owner.
    const contextUpdates = this.resolveContextUpdates(config, context, commandResults);
    if (Object.keys(contextUpdates).length > 0) {
      this.parsedOutput.contextUpdates = contextUpdates;
    }

    if (!this.quiet) {
      console.log(this.parsedOutput);
    }

    return this.parsedOutput;
  }

  /**
   * Work out what this command adds to the bundle's context.
   *
   * @param config
   * @param context
   * @param commandResults
   * @returns
   */
  resolveContextUpdates(
    config: CloudConfig,
    context: CommandContext,
    commandResults: CommandResults,
  ): ContextUpdates {
    if (this.saveToContext === undefined || this.saveToContext === null) {
      return {};
    }

    if (typeof this.saveToContext === "function") {
      const updates = this.saveToContext(
        this.parsedOutput,
        context,
        config,
        commandResults,
      );

      return updates !== undefined && updates !== null ? updates : {};
    }

    // The map form names a path into this command's output, so that
    // pulling a token out of a JSON response doesn't need a function
    const updates: ContextUpdates = {};
    for (const [key, path] of Object.entries(this.saveToContext)) {
      updates[key] = readPath(this.parsedOutput, path);
    }

    return updates;
  }

  /**
   * Parse the output of the command
   * @returns
   */
  async parseOutput(): Promise<boolean> {
    if (this.rawOutput === null || this.rawOutput === undefined) {
      return false;
    }

    // Copy over the initial raw output
    this.parsedOutput = this.rawOutput;

    // A command that produced nothing has no output rather than null
    // output, as far as anything parsing it is concerned
    const stdout = this.rawOutput.stdout ?? "";

    // Parse output
    try {
      switch (this.outputType) {
        case OutputType.Json:
          this.parsedOutput.parsed = JSON.parse(stdout);
          break;

        case OutputType.Csv:
          console.warn(
            "CSV parsing requires an external library. Returning raw output.",
          );
          this.parsedOutput.parsed = this.rawOutput;
          break;

        case OutputType.Yaml:
          this.parsedOutput.parsed = loadAll(stdout);
          break;

        case OutputType.Custom:
          if (this.parseFunction) {
            this.parsedOutput = this.parseFunction(this.rawOutput);
          } else {
            console.warn("Custom output type requires a parseFunction.");
            this.parsedOutput = this.rawOutput;
          }
          break;

        // In the case of raw we don't do any parsing
        // any simply copy the raw stdout to parsed
        case OutputType.Raw:
          this.parsedOutput.parsed = this.parsedOutput.stdout;
          break;

        default:
          console.warn(`Unknown output type: ${this.outputType}`);
          this.parsedOutput = this.rawOutput;
      }
    } catch (error) {
      // Quiet means quiet. A command whose output didn't parse still
      // reports that through its return value, and a caller that asked
      // not to be narrated at shouldn't get this on the way past.
      if (!this.quiet) {
        console.error(`Failed to parse ${this.outputType} output:`, error);
      }

      // The output is kept even though it didn't parse: it is what
      // the command actually said, and a caller working out what went
      // wrong has nothing else to go on
      this.parsedOutput = { ...this.rawOutput, parsed: null };
      return false;
    }

    return true;
  }
}

/**
 * Follow a dotted path into an object, e.g. "parsed.data.token".
 *
 * @param value
 * @param path
 * @returns
 */
function readPath(value: any, path: string) {
  let current = value;

  for (const segment of path.split(".")) {
    if (current === undefined || current === null) {
      return undefined;
    }

    current = current[segment];
  }

  return current;
}
