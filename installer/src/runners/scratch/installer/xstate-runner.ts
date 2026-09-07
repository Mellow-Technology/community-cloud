/**
 * Code for using XState for command running.
 *
 * My current feeling regarding this is that XState has become overly
 * complicated. It _should_ be fairly straight-forward, but it seems
 * like there are too many bells and whistles at this point.
 *
 * The idea behind XState is that it would allow for easy customization
 * of the actual execution process. But that's probably overthinking it.
 *
 * Dumping the XState code in here for now in case it's ever needed again.
 * Though, if we get back to this point we may just make our own state chart
 * library in any case.
 */

 enum CommandEvents {
   Start = "START",
   CommandUpdate = "COMMAND_UPDATE",
   SetExec = "SET_EXEC"
 }


export const CommandBundleMachine = createMachine({
  id: "commandBundle",
  initial: "idle",
  context: {
    config: {},
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
        [CommandEvents.SetExec]: {
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
          const results = {
            stdout: await consumers.text(rawResults.stdout),
            stderr: await consumers.text(rawResults.stderr)
          };

          return results;
        }),
        input: ({ context }) => {
          console.log(context);
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
