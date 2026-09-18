# Scratch

Test code, and things that are cooking or may be used at some point.
None of it is imported by the installer, none of it is compiled into
the binary, and it is excluded from the typecheck — so it is allowed
to be broken while an idea is being worked out.

What's in here and why:

| | |
|---|---|
| `installer/` | Sketches of other ways to drive an install: a state machine, a runner, prompt experiments. |
| `ui/` | An Ink terminal UI for picking hosts. The CLI went with commander and @inquirer/prompts instead. |
| `controller/` | A Kubernetes controller for a Webapp CRD. A different product to the installer. |
| `RemoteAgent.ts` | An agent-shaped subclass of RemoteHost, from before commands carried their own target. |
| `K3sInstallation.ts` | The K3s install as a class, from before it was a bundle of commands. |

Anything here that comes back to life should move out of this
directory and into the typecheck with it.
