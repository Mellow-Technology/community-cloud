# Plugins

**Status: draft for discussion.** Nothing here is built. This describes how
commands, manifests and charts could be packaged and loaded by the installer,
and records what was measured rather than assumed.

---

## What this is solving

Adding anything to Community Cloud currently means editing the installer. A new
application is a row in `packageCatalogue`, its manifests are files under `k8s/`
that have to be re-embedded into the binary, and anything needing real logic is
a new `CommandSpec` compiled into `bundles.ts`. That is right for the components
the platform defines and wrong for everything else: someone running a community
cloud should be able to add their own application, storage backend or
site-specific checks without forking.

The requirement, plainly: **a plugin is a set of commands that can be run on
their own or composed into existing bundles, and it can carry its own manifest
templates.** The templates matter as much as the commands — a plugin that can
only run shell is a script, not an extension of a Kubernetes installer.

Distribution should be one file: something you can attach to a release, check a
hash against, and hand to someone.

---

## What is already plugin-shaped

Most of this exists. The work is opening seams rather than building a plugin
system.

**Commands are data, not classes.** `createCommand()` dispatches on the shape of
a plain object — `"url" in spec` — with no inheritance anywhere. There is no
base class to extend and therefore no class hierarchy to design an API around.

**A large subset of a command is expressible in YAML.** `command` accepts
`string[]`; `env`, `stdin` and `secretEnv` accept plain objects; and
`saveToContext` accepts `Record<string, string>` mapping a context key to a path
into the command's output. So this is a complete, working command containing no
code:

```yaml
- name: install-thing
  description: Install the thing
  purpose: apply
  runOn: control-plane
  command: ["curl -fsSL https://example.invalid/i.sh | sh"]
  saveToContext: { thingVersion: "parsed.version" }
```

**`packages.ts` is already a plugin registry**, scoped to Helm charts. Name,
chart, version, namespace, values file, `manifests.before` / `manifests.after`,
`secrets`, and `requires` resolved by a topological sort in
`resolveInstallOrder`. Generalising that structure is most of a plugin format,
and plugin packages inherit dependency ordering for free.

**File reading is already a two-source virtual filesystem.**
`readInstallerFile()` switches on `embed://` versus a path on disk. A third
source is a small change in one function with a very large reach.

**Purpose makes plugin commands first-class.** Because `doctor` and `preflight`
filter on `CommandPurpose`, a plugin that writes a single `Verify` command gets
cluster health checking without either runner knowing plugins exist.

---

## The four seams

In dependency order.

### 1. The file resolver

Add a `plugin://<name>/<path>` scheme to `readInstallerFile()`, backed by a
registry of plugin sources. Because every template path funnels through that one
function, plugin templates immediately work in `valuesFile`, in
`manifests.before` and `after`, in `run-template`, and in any command's `stdin`.

Roughly fifteen lines. This is the whole "load manifest templates" requirement.

### 2. The two registries

`bundles.ts` and `packages.ts` each export a static array plus lookup helpers.
Convert both to registries seeded with the built-ins, exposing
`registerBundle()` and `registerPackage()`. Every existing caller keeps working
unchanged. The test of whether the API is real: built-ins should register
through it too, not bypass it.

### 3. Derived template values

`buildTemplateValues()` hardcodes its derivations — `l2Announcements`,
`networkDevices`, `storageControllerReplicas`, and the two lvmd values. Turn the
body into a list of contributor functions with the built-ins registered first,
so a plugin can derive its own values from the configuration and use them in its
own templates. Without this, plugin templates are static YAML and most of the
point is lost.

### 4. Namespacing

Command names are result keys and context keys. Two plugins each defining
`install` collide silently and the second wins. Force plugin commands to
`<plugin>:<name>` at registration, and put plugin context under
`context.plugins[name]`. Cheap now, painful to retrofit.

---

## What a plugin is

```
mastodon/
  plugin.yaml      # metadata, packages, bundles, declarative commands
  templates/       # rendered exactly like k8s/
    Mastodon.values.yaml
    Mastodon.database.yaml
  commands.ts      # optional: functions YAML can't express
```

```yaml
apiVersion: community-cloud/v1
name: mastodon
description: Federated social, backed by the cluster's Postgres
type: package                 # refused at load if it ships commands

packages:
  - name: mastodon
    chart: { repo: https://charts.example.invalid, name: mastodon }
    version: 6.1.0
    namespace: cc-social
    requires: [cloudnative-pg]
    valuesFile: plugin://mastodon/templates/Mastodon.values.yaml
    manifests:
      before: [plugin://mastodon/templates/Mastodon.database.yaml]
    secrets:
      - name: mastodon-db
        description: the Mastodon database role
        username: mastodon
        labels: { cnpg.io/reload: "true" }

bundles:
  - name: mastodon
    description: Prepare a node for Mastodon's media store
    commands: [ ... ]

values:
  mastodonDomain: "{{ .Values.domain.main }}"
```

The `secrets` block is the structure that already exists on `cloudnative-pg`,
and `requires` is the field the existing topological sort already reads. A
plugin is not a new concept so much as the existing catalogue entry, moved
outside the binary.

---

## Distribution

The installer ships as a `bun build --compile` executable with no `node_modules`
beside it, so "just add a library" is a real cost and "shell out to `unzip`"
imposes a dependency on every node.

| Format | How it is read | New deps | One file without unpacking all | Openable by hand | Authoring |
|---|---|---|---|---|---|
| Directory | Existing filesystem handling | none | yes | it is files | trivial |
| **Zip** (`.ccp`) | **46 lines over `node:zlib` `inflateRawSync`** | **none** | **yes — central directory** | **`unzip -l`** | **`zip -r`** |
| Gzipped tar | `Bun.Archive`, native | none | no — whole stream | tar, on Unix | `tar czf` |
| SQLite | `bun:sqlite`, same code as `embedded.sqlite` | none | yes — it is a query | needs sqlite3 | needs a build script |
| One `.ts` file | Dynamic `import()` | none | n/a | it is source | templates become string literals |

**Gzipped tar is the zero-code option** — `Bun.Archive` reads it natively. But it
has no index: finding `plugin.yaml` means decompressing the whole stream, which
matters when listing twenty installed plugins. It is also less friendly on
Windows.

**Zip costs 46 lines and buys an index.** Only the central directory need be
parsed to list contents or pull a single file, and deflate is already in
`node:zlib`. The extension trick means `unzip -l mastodon.ccp` works unchanged,
which is worth a lot when debugging someone else's plugin.

**SQLite deserves more consideration than it will get.** The installer already
carries its manifests as a SQLite file read with `Database.deserialize()`; a
plugin using the same schema would need almost no new code. It loses on
authoring and inspection, which for a format people are meant to trust and share
is the deciding objection.

### Recommendation: define the seam, choose later

Every option reduces to the same interface, so the format is a swappable
implementation rather than an architectural commitment:

```ts
interface PluginSource {
  name: string;
  list(): string[];
  read(path: string): Uint8Array;
}
```

Implement `DirectorySource` first — a dozen lines, and it makes the whole system
testable without any packaging. Then `ZipSource` as the wire format on `.ccp`.
Keeping `Bun.Archive` behind the same interface for `.tgz` is then nearly free.

### The load path

```
plugin://mastodon/templates/x.yaml
  → readInstallerFile()      third scheme alongside embed:// and disk paths
  → PluginSource.read()      directory, zip or tar.gz — the caller never knows
  → renderTemplate()         unchanged
```

### A packaging papercut worth fixing in the spec

`zip -r mastodon.ccp mastodon/` puts everything under a `mastodon/` prefix, so
the manifest lands at `mastodon/plugin.yaml` rather than the root. Require
`plugin.yaml` at the archive root, zip the *contents* rather than the directory,
and have the loader say so explicitly when it finds a single top-level directory
instead.

---

## Where plugins are found

One directory, for now: `~/.community-cloud/plugins/`.

```
~/.community-cloud/
└── plugins/                    # mode 0700
    ├── mastodon.ccp            # a packaged plugin
    ├── forgejo.ccp
    └── site-checks/            # or an unpacked one, while developing
        ├── plugin.yaml
        └── templates/
```

Both forms sit side by side, which matters more than it sounds: developing a
plugin means editing files, and having to repackage after every change would
make the archive a tax on authorship rather than a convenience for distribution.
A directory is the development form, an archive the shipping form, and
`PluginSource` makes them indistinguishable to everything upstream.

### Being in the directory is not consent

The directory says what is *available*. The configuration says what is
*enabled*. Nothing loads because it was dropped in a folder.

```yaml
plugins:
  mastodon:
    enabled: true
    sha256: 3f1c…          # pinned at first use
```

This is the same split `packages` already uses — a catalogue of what exists, and
a configuration saying which of it this cluster wants. It also means a file
appearing in that directory, by whatever means, does not silently acquire root
on every node at the next run.

### Rules worth settling now

- **The name comes from `plugin.yaml`, not the filename.** A filename is a
  property of a copy; the name is a property of the plugin, and it is what the
  configuration and every namespaced command refer to. A mismatch is worth a
  warning; two plugins claiming one name is an error naming both paths.
- **Load in a defined order.** Alphabetical by name, so two machines with the
  same directory contents resolve identically.
- **Resolve the home directory properly.** The installer cross-compiles to
  Windows, so `os.homedir()` rather than a literal `~`, and the directory is
  created on demand rather than being a prerequisite.
- **A missing directory is not an error.** Most clusters will never have one.
- **This directory is on the privileged host.** It sits beside the configuration
  holding the cluster token. Mode `0700`, stated in the documentation rather
  than left to a default umask.

### Deliberately not doing yet

A search path rather than a single directory, a per-project `./plugins/`, a
system-wide `/etc/community-cloud/`, an environment variable override, and
anything resembling a registry or a `plugin install` subcommand that fetches
over the network.

---

## What the spike proved

Four things were uncertain enough to change the design, so they were tested —
compiled for `bun-linux-arm64` and run on an aarch64 node, not in the dev
runtime.

- **A compiled binary can `import()` a `.ts` file from disk** and transpile it at
  runtime. Code plugins are not limited to running from source, which was the
  one finding that could have killed them outright.
- **`Bun.Archive` reads tar and tar.gz natively**, returning
  `Map<string, File>`, with `extract(dir)` to disk. It returns a `Map`, not a
  plain object — `Object.keys()` on it silently reports nothing.
- **`Bun.Archive` does not read zip.** A file beginning `50 4b 03 04` is rejected
  with "Unrecognized archive format", and `Bun.Archive.write` emits tar
  regardless of the extension given. Zip needs our own reader.
- **That reader is 46 lines** — locate the end-of-central-directory record, walk
  the entries, hand stored or deflated bytes to `inflateRawSync`. No dependency,
  and it ran correctly inside the compiled binary.
- **A single-file plugin never has to touch the disk.** Templates read straight
  out of the archive in memory, and plugin TypeScript can be transpiled with
  `Bun.Transpiler` and imported from a `data:` URL — no extraction, no cache
  directory, nothing to invalidate.

```
1. Bun.Archive tar.gz: native, zero dependencies
2. hand-rolled zip:    46 lines, node:zlib only
3. template in memory: apiVersion: v1
4. code imported from memory: [{"name":"demo:hello","command":["echo hello"]}]
```

The fourth line is a command definition that travelled inside a zip, was
transpiled in memory, and arrived as a live object — the complete loading path,
with no filesystem involved after opening the one file.

Measured 16 September 2026 with Bun 1.4.0. Worth re-checking against any Bun
upgrade, since `Bun.Archive` is a young API and zip support arriving upstream
would remove the need for our own reader.

---

## Declarative or code

`plugin.yaml` for everything declarative, `commands.ts` only when a function is
genuinely needed — a dynamic `command` builder, a `skipWhen`, a post-process
hook, a custom parser. Most plugins will never need the second file, because a
large part of `CommandSpec` is already data.

**Declarative is reviewable, not safe.** It is tempting to present YAML plugins
as the safe tier and code plugins as the dangerous one. That is not true and
should not be written into the docs. A declarative plugin still runs arbitrary
shell as root on every node it is pointed at; that is what the installer *is*.
What declarative buys is reviewability — the exact shell can be printed before
anything runs — and the fact that it never executes inside the installer
process, where the credentials live.

---

## Trust and blast radius

Installing a plugin means "run this on every machine I own, as root". The design
should be honest about that rather than implying a sandbox exists, because one
cannot: **you cannot sandbox a tool whose job is running root commands on your
machines.** Anything that looks like a permission system but sits above the
shell is defeated by the first command that runs.

What can be done is to separate the ways a plugin can do harm, refuse
capabilities that are not needed, make what will run visible before it runs, and
put the real controls in the environment rather than the loader.

### Three ways a plugin can do harm

| Path | What it reaches | How visible | What actually limits it |
|---|---|---|---|
| Node — root shell over SSH | Everything on every node the bundle runs against | Loud — a broken node announces itself | The SSH user's real privileges, enforced by the node's OS |
| Installer process — code plugins only | K3s token, registry passwords, Nebula API key, SSH private keys, the network | Silent — no node touched, nothing logged | Not shipping code plugins |
| Cluster — charts and images | Whatever a pod can reach, which without admission policy is a great deal | Quiet — it looks like a normal workload | Cluster hardening: admission policy, registry allowlist, network policy |

The third row is reachable by a plugin containing *no commands at all*. A
declarations-only plugin that installs a Helm chart can pull any image it likes.
Restricting a plugin to manifests moves the attack surface; it does not remove
it.

That hole is also already open. The `packages` section of a configuration
accepts an arbitrary Helm repository and chart today, so "only known commands
run" is not a property the installer currently has.

### Plugin types

Declared in `plugin.yaml` and enforced at registration, not at run. Each type
includes the ones above it.

| Type | May contain | Enforced by | Can still |
|---|---|---|---|
| `package` | Charts, manifests, secrets, values. No commands. | Counting commands. It has none. | *Cluster only* — schedule any container image |
| `inspection` | Facts and probes, with assertions. No shell of its own. | The probe catalogue. There is nowhere to put a shell string. | *Node read* — learn what the probes expose, within the SSH user's reach |
| `node` | Arbitrary shell, `Apply` and `Settle` | Nothing. This is the trust cliff. | *Node root* — change or destroy any node it runs against |
| `code` | Adds `commands.ts`, executed in-process | Nothing. | *Installer* — read every credential the installer holds |

Two of those rows are enforceable, and that is the point of the table. `package`
is enforceable by counting commands. `inspection` is enforceable only because of
the next section — without it, a read-only *label* on an arbitrary shell string
is worth nothing.

### Making inspection enforceable

An `inspection` plugin never supplies shell. That is the whole mechanism, and it
is what turns `purpose` from a claim into a constraint. It supplies:

- **Facts** it wants gathered — values the installer's own `Inspect` commands
  already put in the context, such as `storageDisks`, `videoDevices` or
  `storageShapes`.
- **Probes** from a fixed catalogue with typed parameters: is this program
  installed, is this port free, does this path exist, what does `kubectl get`
  say about this resource.

Then it asserts over the results. The assertion is an expression, not a command:

```yaml
type: inspection

facts: [storageDisks]
probes:
  - id: ffmpeg
    probe: command-present
    program: ffmpeg          # validated: ^[A-Za-z0-9._-]+$

checks:
  - name: media-disk
    purpose: require
    assert: storageDisks | any(class == "ssd" and size >= 100Gi)
    otherwise: The media store needs an SSD of at least 100 GB.
  - name: transcoding
    purpose: require
    assert: probes.ffmpeg.present
    otherwise: Install ffmpeg on this node.
```

This costs less than it looks, because **the probe catalogue mostly exists
already**. `Network.ts` reads interfaces with `ip -j addr show`; `find-disks`
walks lsblk, pvs and vgs; the GPU bundle detects hardware;
`read-storage-shapes` queries node labels. These are exactly probes: fixed shell
written by us, parsed into structures, placed in context. Exposing them to
plugins is mostly naming what is already there.

**The rules that make it hold:**

- **Allowlist probes, never binaries.** A list of permitted programs is defeated
  by the programs themselves — `find -exec`, `awk 'BEGIN{system(...)}'`,
  `tar --to-command`, `less` and `!sh`. GTFOBins is a long catalogue of
  innocuous binaries that hand back a shell. The unit of approval has to be the
  whole invocation, written by us.
- **No shell string is ever assembled from plugin input.** Parameters are typed
  and validated as values; the installer writes the command around them. There
  is no quoting problem to get wrong because there is nothing to quote.
- **Bar `WebCommand` for this type.** This is the leak that would otherwise undo
  the whole thing: a plugin that can read facts and also POST somewhere has
  exfiltration without ever running a shell.
- **Constrain the file probe, and back it with the OS.** A path policy is
  necessary but is the weakest link, since a policy is only as good as its list.
  The real enforcement is the unprivileged SSH user — what an inspection plugin
  can read should be decided by the node, not by us.

This does not make `inspection` harmless. A plugin can still learn things about
your infrastructure, and a probe catalogue grows toward whatever people ask for,
which is the direction of more exposure. But it moves the trust cliff from the
second row to the third, and the two types most plugins actually need are both
enforced rather than merely declared.

### What is not a boundary

- **`purpose` on arbitrary shell is author-declared.** A malicious plugin labels
  `rm -rf /` as `Inspect`. The field is useful against carelessness and worth
  nothing against malice — *unless* the type also removes the ability to write
  shell.
- **The `sudo` flag is not a chokepoint.** The codebase sets `sudo: true` twice
  and writes `sudo` inline fifty-eight times, a consequence of the multi-line
  sudo fix. You cannot inspect a spec and conclude it will not try for root.
- **Declarative is not safer than code** for node damage. The same shell runs
  either way.
- **A redacted configuration does not stop a file read.** Handing a code plugin
  a stripped `CloudConfig` is worth doing and does nothing about `readFileSync`
  on an SSH private key.

### Where the real controls are

**Harden the cluster first, and treat that as a prerequisite for plugins rather
than a follow-up.** If a plugin's worst case is "schedules a malicious
container", then admission policy is the control, not the plugin format. Cilium
is already there for default-deny network policy; Pod Security Admission at the
`restricted` profile stops privileged pods and host mounts; an allowlist of
registries with digest pinning closes the image question — and the `registries`
section already knows which registries this cluster expects. None of this is
plugin-specific work, which is the point.

**Treat the installer host as the crown jewel.** `cc.config.json` is not a
configuration file that happens to contain secrets — it is the cluster token,
the registry credentials and the Nebula API key in one place, next to an SSH key
with root on every node. Whatever machine holds it is more privileged than any
node. A dedicated administrative host beats a laptop.

### What the loader should still do

In descending order of value for effort:

1. **Do not ship the `code` type.** The largest risk reduction available, and
   today it costs nothing. The bar for adding it later should be concrete cases
   that declarations genuinely cannot express.
2. **Enforce the declared type at registration.** Cheap, because `purpose` is
   already a field on every command.
3. **Give `inspection` plugins no shell at all.** Facts, a probe catalogue and
   assertions. This is what makes the second type an enforced boundary.
4. **Show the shell before running it.** Because commands are data rather than
   functions, a `--dry-run` can render every command string and every manifest a
   plugin will produce without executing any of it. No imperative plugin API can
   offer this. It turns "trust this stranger" into "read these forty lines".
5. **Trust on first use.** Print everything a plugin registers, take one
   confirmation, pin the `sha256`. The SSH host key model.
6. **Separate privilege on the node.** The only OS-enforced boundary available.
   `connectToNode` already takes a `username` per node, so connecting as a
   second user without sudo for plugin commands is architecturally close.
7. **Restrict which nodes a plugin may touch.** Real, because the runner opens
   the connection and the plugin does not.

---

## Sequencing

The risk is designing a format against imagined plugins. There is a better test
available: **Authentik is already the shape of a plugin** — a chart, a values
template, a before-manifest, a CloudNativePG database, a generated secret, and a
`requires` on another package. If it round-trips through the format with nothing
left over, the format is adequate.

1. **Resolver and `DirectorySource`.** `plugin://` in `readInstallerFile`,
   plugins discovered under `~/.community-cloud/plugins/` and enabled from the
   configuration. No packaging yet.
2. **Extract Authentik** using `plugin.yaml` alone. Whatever cannot be expressed
   is the real requirements list.
3. **Registries.** `registerBundle` and `registerPackage`, with the built-ins
   moved onto the same path.
4. **Value contributors**, so plugin templates can derive values rather than only
   substitute them.
5. **`ZipSource` and the `.ccp` extension.** Packaging last, once there is
   something proven to package.
6. **Dry-run and trust-on-first-use**, before any plugin is loaded from outside
   your own machine.
7. **Leave `commands.ts` unshipped** until there is a concrete case declarations
   cannot express. The default answer is no.

---

## Open questions

**How do plugin bundles order against each other?** Packages have `requires` and
a topological sort. Bundles have nothing equivalent. If a plugin needs to insert
commands into an existing bundle rather than add its own, that needs a
positioning concept that does not exist today.

**Should a plugin's Verify commands turn doctor red?** They will, automatically,
because `doctor` filters on purpose. Probably correct, but a badly written
plugin then degrades the health of the whole cluster report.

**What owns the label and tag namespace?** `gpu.community-cloud.technology` and
`storage.community-cloud.technology` set the convention;
`<plugin>.plugins.community-cloud.technology` would keep ownership legible. LVM
object tags need the same treatment.

**Is cluster hardening a prerequisite or a parallel track?** A `package`
plugin's worst case is a malicious image, which admission policy answers and the
plugin format cannot. If hardening is a prerequisite, plugins wait on Pod
Security Admission, a registry allowlist and default-deny network policy landing
first.

**How is compatibility expressed?** `apiVersion: community-cloud/v1` is the
cheap answer, but it needs a policy: what happens when a plugin declares a
version the installer does not know, and is the answer refuse or warn?

**Does a plugin get to contribute to the configurator?** The interactive
`configure` flow is a fixed set of sections. A plugin needing settings has
nowhere to ask for them, so its configuration has to be hand-written into
`cc.config.json` — an acceptable first answer, but a deliberate one.
