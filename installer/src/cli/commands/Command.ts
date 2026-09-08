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
}

/**
 * A command that runs in a shell.
 *
 * - command: the command itself, or a function that builds it
 * - sudo: whether the command should be run using sudo
 * - env: environment variables for the command, either as an object or
 *   as a function worked out from the configuration
 * - commandParser: a program to pipe the output through before parsing
 *   e.g. for using JC (https://github.com/kellyjonbrazil/jc)
 */
export interface TerminalCommandSpec extends BaseCommandSpec {
  command: string | Function;
  sudo?: boolean;
  env?: Record<string, string> | Function;
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
  shouldSkip(config, context, commandResults): boolean {
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
  async exec(config, context, commandResults) {
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

    console.log(this.parsedOutput);

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
  resolveContextUpdates(config, context, commandResults): ContextUpdates {
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
  async parseOutput(): boolean {
    if (this.rawOutput === null || this.rawOutput === undefined) {
      return false;
    }

    // Copy over the initial raw output
    this.parsedOutput = this.rawOutput;

    // Parse output
    try {
      switch (this.outputType) {
        case OutputType.Json:
          this.parsedOutput.parsed = JSON.parse(this.rawOutput.stdout);
          break;

        case OutputType.Csv:
          console.warn(
            "CSV parsing requires an external library. Returning raw output.",
          );
          this.parsedOutput.parsed = this.rawOutput;
          break;

        case OutputType.Yaml:
          this.parsedOutput.parsed = loadAll(this.rawOutput.stdout);
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
      console.error(`Failed to parse ${this.outputType} output:`, error);
      this.parsedOutput = null;
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
