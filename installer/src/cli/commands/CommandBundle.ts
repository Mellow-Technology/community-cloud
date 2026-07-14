import {
  createMachine,
  assign,
  createActor,
  fromPromise,
  Observer,
} from "xstate";

import consumers from "stream/consumers";
import Command from "./Command.ts";

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
  // User-defined context for passing state between commands
  [key: string]: unknown;
}

enum CommandEvents {
  Start = "START",
  CommandUpdate = "COMMAND_UPDATE",
  SetExec = "SET_EXEC"
}

export const CommandBundleMachine = createMachine({
  id: "commandBundle",
  initial: "idle",
  context: {
    commands: [],
    currentIndex: 0,
    results: [],
    error: null,
    status: "idle" as const,
    exec: null,
  },
  states: {
    idle: {
      on: {
        START: { target: "running" },
        // Before the bundle begins running
        // commands can be added to the bundle
        COMMAND_UPDATE: {
          actions: assign({
            commands: ({ context, event }) => {
              const cmdArr = [...context.commands, event.command];
              return cmdArr;
            },
          }),
        },
        SET_EXEC: {
          actions: assign({
            exec: ({ event }) => event.execFunction,
          })
        }
      },
    },
    running: {
      invoke: {
        // Async service that executes the current command
        src: fromPromise(async ({ input }) => {
          const { command, exec } = input;

          // Execute the current command
          const rawResults = await exec(command.command);
          const results = await consumers.text(rawResults.stdout);

          return results;
        }),
        input: ({ context }) => {
          return {
            exec: context.exec,
            command: context.commands[context.currentIndex],
          };
        },
        onDone: [
          // In the basic case we continue to run commands
          // as nothing else needs to be done
          {
            target: "next",
            actions: assign(({ context, event }) => {
              console.debug({ context, event });
              return {
                results: [...context.results, event.output],
                // Apply context updates returned by the command
                // ...(event.data.contextUpdates || {}),
                status: "running" as const,
              };
            }),
          },
          // In the case that there needs to be
          // some kind of optional input
          // we retrieve options either from
          // the user or some other source
          {
            target: "retrieveOptions",
          },
        ],
        onError: {
          target: "error",
          actions: assign((err, event) => {
            console.log(err);
          }),
        },
      },
    },
    retrieveOptions: {},
    next: {
      always: [
        {
          target: "running",
          guard: ({ context }) => {
            return context.currentIndex < context.commands.length - 1;
          },
          actions: assign({
            currentIndex: ({ context }) => context.currentIndex + 1,
          }),
        },
        { target: "completed" },
      ],
    },
    completed: { type: "final" },
    error: { type: "final" },
  },
});

export class CommandBundle {
  private actor: ReturnType<typeof createActor<typeof CommandBundleMachine>>;
  private userContext: Record<string, unknown> = {};

  constructor(subscribeHooks?: Observer<any>[]) {
    this.actor = createActor(CommandBundleMachine, {
      context: {
        ...CommandBundleMachine.context,
        ...this.userContext,
      },
    });

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
    this.actor.send({ type: CommandEvents.CommandUpdate, command });
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

  async start(): Promise<void> {
    this.actor.start();
    this.actor.send({ type: "START" });

    //return new Promise((resolve, reject) => {});
    return new Promise((resolve, reject) => {
      const subscription = this.actor.subscribe({
        complete: () => {
          subscription.unsubscribe();
          const snapshot = this.actor.getSnapshot();
          if (snapshot.value === "completed") {
            resolve();
          } else if (snapshot.value === "error") {
            reject(new Error(snapshot.context.error));
          }
        },
      });
    });
  }

  getContext(): BundleContext {
    return this.actor.getSnapshot().context;
  }

  stop(): void {
    this.actor.stop();
  }
}
