import Command, {
  CommandPurpose,
  CommandSpec,
  CommandTarget,
  ContextUpdates,
} from "./Command.ts";
import TerminalCommand from "./TerminalCommand.ts";
import WebCommand from "./WebCommand.ts";
import { createCommand } from "./createCommand.ts";
import CloudConfig from "../../util/CloudConfig.ts";

export interface CommandResult {
  stdout: string;
  stderr: string;
  parsed: any;
  processed?: any;

  // Set by web commands
  status?: number;
  headers?: Record<string, string>;

  // What the command added to the bundle's context
  contextUpdates?: ContextUpdates;

  // Set when the command failed
  error?: boolean;

  // Set when the command had nothing to do
  skipped?: boolean;
}

export interface CommandConfig {
  command: Command;
  local?: boolean;
  remote?: boolean;
  // Optional: custom executor to override default shell logic
  execute?: (ctx: any) => Promise<CommandResult>;
}

export interface BundleContext {
  commands: Command[];
  currentIndex: number;
  results: CommandResult[];
  error: string | null;
  status: "idle" | "running" | "completed" | "error";
  config: object;
  // User-defined context for passing state between commands
  [key: string]: unknown;
}



export class CommandBundle {

  protected config: CloudConfig;
  protected commands: CommandSpec[];
  protected commandResults: Record<string, CommandResult>;
  protected execFunction: Function | undefined;
  protected controlPlaneExecFunction: Function | undefined;
  protected fetchFunction: Function | undefined;
  protected context: Record<string, unknown>;
  protected failed: boolean;
  protected purposes: CommandPurpose[] | undefined;
  protected continueOnFailure: boolean;
  protected quiet: boolean;

  constructor(config: CloudConfig, commands?: CommandSpec[], context?: object, execFunction?: Function,subscribeHooks?: Observer<any>[]) {
    this.config = config;
    this.commands = commands !== undefined ? commands : [];
    this.context = context !== undefined ? context : {};
    this.execFunction = execFunction;
    this.controlPlaneExecFunction = undefined;
    this.fetchFunction = undefined;
    this.commandResults = {};
    this.failed = false;
    this.purposes = undefined;
    this.continueOnFailure = false;
    this.quiet = false;


    // Have any subscribe hooks. Can be used for
    // to generate various output types
    // if (subscribeHooks !== undefined) {
    //   for (let i = 0; i < subscribeHooks.length; i++) {
    //     const hook = subscribeHooks[i];
    //     this.actor.subscribe(hook);
    //   }
    // }
  }

  /**
   * Add a command to the command bundle.
   *
   * @param command
   * @returns
   */
  add(command: CommandSpec): this {
    this.commands.push(command);
    return this;
  }

  /**
   * Add commands in bulk.
   *
   * @param commands
   * @returns
   */
  addBulk(commands: CommandSpec[]): this {
    for (let i = 0; i < commands.length; i++) {
      // @ts-expect-error This will always work (please let this not bite me lol)
      this.add(commands[i]);
    }

    return this;
  }


  /**
   * Set the execution function that we'll use to execute commands.
   *
   * @param execFunction
   * @returns
   */
  setExec(execFunction: Function): this {
    this.execFunction = execFunction;
    return this;
  }

  /**
   * Run only the commands that are for one of these purposes.
   *
   * This is how something can ask a bundle a question without letting
   * it change anything: hand it the purposes that change nothing and
   * the rest are never built, let alone run. The commands that do run
   * still pass their findings along, so a check that depends on what
   * an earlier one saw still works.
   *
   * @param purposes
   * @returns
   */
  setPurposes(purposes: CommandPurpose[]): this {
    this.purposes = purposes;
    return this;
  }

  /**
   * Keep going after a command fails.
   *
   * A bundle halts by default, because the commands in one build on
   * each other and carrying on after a failed install means doing the
   * next thing to a node that isn't ready for it. Somewhere only
   * asking questions wants the opposite: one thing being wrong is the
   * most likely reason to want to know what else is.
   *
   * @param value
   * @returns
   */
  setContinueOnFailure(value: boolean = true): this {
    this.continueOnFailure = value;
    return this;
  }

  /**
   * Stop the commands printing their output as they go.
   *
   * For a caller rendering its own report: the raw output of fifty
   * commands buried underneath it helps nobody.
   *
   * @param value
   * @returns
   */
  setQuiet(value: boolean = true): this {
    this.quiet = value;
    return this;
  }

  /**
   * Whether a command is one this bundle was asked to run.
   *
   * @param command
   * @returns
   */
  protected wants(command: Command): boolean {
    return this.purposes === undefined || this.purposes.includes(command.purpose);
  }

  /**
   * Set the execution function for commands that asked to run on the
   * control plane rather than on the node this bundle is aimed at.
   *
   * @param execFunction
   * @returns
   */
  setControlPlaneExec(execFunction: Function): this {
    this.controlPlaneExecFunction = execFunction;
    return this;
  }

  /**
   * Whether this bundle holds anything that needs the control plane,
   * so a runner knows whether to go and connect to one.
   */
  needsControlPlane(commands: CommandSpec[]): boolean {
    return commands.some((command) => command.runOn === CommandTarget.ControlPlane);
  }

  /**
   * Set the function that web commands make their requests with.
   * Only useful for pointing them somewhere other than the network.
   *
   * @param fetchFunction
   * @returns
   */
  setFetch(fetchFunction: Function): this {
    this.fetchFunction = fetchFunction;
    return this;
  }

  /**
   * Run all configured commands in the bundle
   */
  async runAllCommands(): Promise<void> {


    for (let i = 0; i < this.commands.length; i++) {
      // Grab the parameters for the current command
      const commandSpec = this.commands[i];

      // Instantiate a command object of whichever kind
      // the specification describes
      const command = createCommand(commandSpec);

      // Not what this run was asked for. Left out entirely rather
      // than skipped, since it was never going to happen and saying
      // so would just be noise.
      if (!this.wants(command)) {
        continue;
      }

      command.setQuiet(this.quiet);

      // Hand over however this bundle runs things. A bundle can be
      // pointed at a remote host or at a stand-in, and only the kind
      // of command it applies to takes it.
      if (command instanceof TerminalCommand) {
        const execFunction = this.getExecFor(command);
        if (execFunction !== undefined) {
          command.setExecFunction(execFunction);
        }
      }

      if (this.fetchFunction !== undefined && command instanceof WebCommand) {
        command.setFetchFunction(this.fetchFunction);
      }

      // A command that has nothing to do is left alone, and says so
      // in the results rather than going missing from them.
      //
      // Working that out reads the configuration, so it can find a
      // mistake in it. That's a failure of this command like any
      // other, rather than something that should escape the runner as
      // a stack trace.
      let skip = false;
      try {
        skip = command.shouldSkip(this.config, this.context, this.commandResults);
      }
      catch (e: any) {
        if (!this.quiet) {
          console.log(`🔴 Error deciding whether to run: "${command.name}"`);
          console.log(`🔴 Error Message: ${e.message}`);
        }

        this.commandResults[command.name] = {
          error: true,
          stdout: "",
          stderr: e.message,
          parsed: "",
        };
        this.failed = true;

        if (!this.continueOnFailure) {
          if (!this.quiet) {
            console.log("== Halted execution ==");
          }
          break;
        }
      }

      if (skip) {
        if (!this.quiet) {
          console.log(`⏭️  Skipped: "${command.name}" has nothing to do`);
        }
        this.commandResults[command.name] = {
          stdout: "",
          stderr: "",
          parsed: null,
          skipped: true,
        };
        continue;
      }

      // Execute the command
      let res = null;
      try {
        res = await command.exec(this.config, this.context, this.commandResults);
      }
      catch (e: any) {
        // A caller rendering its own report has the message in the
        // result and doesn't want the stack and the whole command
        // printed over the top of it
        if (!this.quiet) {
          console.log(e);
          console.log(`🔴 Error running command: "${command.name}"`)
          console.log(`🔴 Generated Command: ${e.cmd}`)
          console.log(`🔴 Error Message: ${e.stderr !== undefined && e.stderr !== "" ? e.stderr : e.message}`);
        }

        res = {
          error: true,
          stdout: e.stdout,
          // A command that failed in the shell reports on stderr, but
          // one that failed before it got there — a configuration a
          // builder wouldn't accept — has only a message. Either way
          // the result should say why, since that's what a caller
          // reads to find out.
          stderr: e.stderr !== undefined && e.stderr !== "" ? e.stderr : e.message,
          parsed: ""
        }
      }

      // Save the results
      this.commandResults[command.name] = res;

      // Fold anything the command wanted to pass on into the shared
      // context, so the commands after it can read it. This is how an
      // API call hands a value to a shell command.
      if (res.contextUpdates !== undefined) {
        Object.assign(this.context, res.contextUpdates);
      }

      // Stop executing the bundle
      if (res.error) {
        this.failed = true;

        if (!this.continueOnFailure) {
          if (!this.quiet) {
            console.log("== Halted execution ==");
          }
          break;
        }
      }
    }


  }

  /**
   * Retrieve the results of every command that ran, keyed
   * by command name.
   */
  getResults(): Record<string, CommandResult> {
    return this.commandResults;
  }

  /**
   * The execution function a command should run through.
   *
   * A command asking for the control plane and not being given one is
   * a mistake worth stopping for: running it on the node instead would
   * mean running kubectl where there is no kubeconfig, and reporting
   * that as though it were the command's own failure.
   *
   * @param command
   * @returns
   */
  protected getExecFor(command: Command): Function | undefined {
    if (command.runOn !== CommandTarget.ControlPlane) {
      return this.execFunction;
    }

    if (this.controlPlaneExecFunction === undefined) {
      throw new Error(
        `The command "${command.name}" runs on the control plane, but this bundle wasn't given a connection to one.`,
      );
    }

    return this.controlPlaneExecFunction;
  }

  /**
   * Whether a command in this bundle failed and stopped the rest.
   *
   * A bundle reports a failure rather than throwing, so that the
   * caller decides what a failure means. On its own it means the
   * remaining commands were skipped; in a pipeline it means the
   * bundles after this one shouldn't run either.
   */
  hasFailed(): boolean {
    return this.failed;
  }

  /**
   * The name of the command that failed, when one did.
   */
  getFailedCommand(): string | undefined {
    return this.getFailedCommands()[0];
  }

  /**
   * Every command that failed. More than one only when the bundle was
   * told to keep going.
   */
  getFailedCommands(): string[] {
    return Object.keys(this.commandResults).filter(
      (name) => this.commandResults[name]?.error === true,
    );
  }

  /**
   * The context shared by every command in the bundle, including
   * whatever the commands that have already run added to it.
   */
  getContext(): Record<string, unknown> {
    return this.context;
  }
}
