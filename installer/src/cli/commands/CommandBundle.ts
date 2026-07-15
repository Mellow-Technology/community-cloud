import Command from "./Command.ts";
import CloudConfig from "../../util/CloudConfig.ts";


export interface CommandResult {
  stdout: string;
  stderr: string;
  parsed: any;
  // contextUpdates?: Record<string, unknown>; // Allow commands to update context
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
  protected commands: Command[];
  protected commandResults: CommandResult[];
  protected execFunction: Function | undefined;

  constructor(config: CloudConfig, commands?: Command[], execFunction?: Function, subscribeHooks?: Observer<any>[]) {

    this.config = config;
    this.commands = commands !== undefined ? commands: [];
    this.commandResults = [];
    this.execFunction = execFunction;


    // Have any subscribe hooks. Can be used for
    // to generate various output types
    if (subscribeHooks !== undefined) {
      for (let i = 0; i < subscribeHooks.length; i++) {
        const hook = subscribeHooks[i];
        this.actor.subscribe(hook);
      }
    }
  }

  setContext(key: string, value: unknown): this {
    this.userContext[key] = value;
    // Update actor context if machine hasn't started
    if (this.actor.getSnapshot().value === "idle") {
      this.actor.assign({ [key]: value });
    }
    return this;
  }

  /**
   * Add a command to the command bundle.
   *
   * @param command
   * @returns
   */
  add(command: Command): this {
    this.commands.push(command);
    return this;
  }

  /**
   * Add commands in bulk.
   *
   * @param commands
   * @returns
   */
  addBulk(commands: Command[]): this {
    for (let i = 0; i < commands.length; i++) {
      // @ts-expect-error This will always work (please let this not bite me lol)
      this.add(commands[i]);
    }

    return this;
  }


  setExec(execFunction: Function): this {
    this.actor.send({ type: CommandEvents.SetExec, execFunction });

    return this;
  }

  async runCommands(): Promise<void> {


    for (let i = 0; i < this.commands.length; i++) {
      const { command } = this.commands[i];

      await this.execFunction()


    }


  }

  getContext(): BundleContext {
    return this.actor.getSnapshot().context;
  }

  stop(): void {
    this.actor.stop();
  }
}
