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
  protected commands: object[];
  protected commandResults: CommandResult[];
  protected execFunction: Function | undefined;

  constructor(config: CloudConfig, commands?: object[], execFunction?: Function, subscribeHooks?: Observer<any>[]) {
    this.config = config;
    this.commands = commands !== undefined ? commands: [];
    this.commandResults = [];
    this.execFunction = execFunction;


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
   * Run all configured commands in the bundle
   */
  async runAllCommands(): Promise<void> {


    for (let i = 0; i < this.commands.length; i++) {
      // Grab the parameters for the current command
      const commandSpec = this.commands[i];

      // Instantiate a command object
      const command = new Command(commandSpec);

      // Set the exec function for the command using
      // the one that's configured for the command bundle
      if (this.execFunction !== undefined) {
        command.setExecFunction(this.execFunction);
      }

      // Execute the command
      const res = await command.exec(this.config);

      // Save the results
      this.commandResults[i] = res;
      console.log(res);
    }


  }

  getContext(): BundleContext {
    return this.actor.getSnapshot().context;
  }

  stop(): void {
    this.actor.stop();
  }
}
