/**
 * @file
 * What a plugin says it is, and whether it's allowed to say it.
 *
 * Every plugin declares a type, and the type is a ceiling on what it
 * may contain rather than a description of what it happens to hold.
 * A plugin declaring "package" that ships a command is refused when
 * it's read, not when the command runs — the point of declaring is
 * that the declaration can be checked before anything happens.
 *
 * Two of the four types are enforceable and two are not, and it's
 * worth being clear about which is which:
 *
 * - package: enforced by counting commands. It has none.
 * - inspection: would be enforced by having nowhere to put a shell
 *   string, because an inspection plugin names facts and probes
 *   rather than commands. That catalogue doesn't exist yet, so this
 *   type is refused rather than pretended at — see below.
 * - node: not enforced by anything. Arbitrary shell as root. This is
 *   the trust cliff, and calling it that in the error messages is
 *   more honest than a permission that isn't one.
 * - code: not shipped. A plugin running inside this process can read
 *   the cluster token, the registry passwords and any SSH key the
 *   user can, and none of that leaves a trace on any node.
 */
import { parse } from "yaml";

import { CommandPurpose, CommandSpec, isReadOnly } from "../cli/commands/Command.ts";
import { PackageDefinition } from "../cli/commands/packages.ts";
import { PluginSource } from "./PluginSource.ts";

// Where the manifest lives inside a plugin. At the root, deliberately:
// an archive made with "zip -r thing.ccp thing/" puts everything under
// a directory and is the first mistake every plugin author makes, so
// it's worth being able to say so precisely.
export const MANIFEST_PATH = "plugin.yaml";

// The manifest formats this installer understands
const KNOWN_API_VERSIONS = ["community-cloud/v1"];

// What a plugin may be called. It namespaces every command it
// registers and appears in node labels and paths, so it's held to the
// same shape as a Kubernetes name rather than anything looser.
const PLUGIN_NAME = /^[a-z0-9]([-a-z0-9]{0,38}[a-z0-9])?$/;

/**
 * What a plugin is allowed to contain.
 */
export enum PluginType {
  Package = "package",
  Inspection = "inspection",
  Node = "node",
  Code = "code",
}

/**
 * A bundle contributed by a plugin.
 */
export interface PluginBundle {
  name: string;
  description: string;
  commands: CommandSpec[];
}

/**
 * A plugin, as read from its manifest.
 */
export interface PluginManifest {
  apiVersion: string;
  name: string;
  description: string;
  type: PluginType;
  packages: PackageDefinition[];
  bundles: PluginBundle[];
  values: Record<string, unknown>;
}

/**
 * Read and check a plugin's manifest.
 *
 * Everything that can be wrong with a plugin should be wrong here,
 * where the message can name the file and say what was expected,
 * rather than somewhere downstream where it turns into a missing key
 * on an object nobody can trace back.
 *
 * @param source
 * @returns
 */
export function readManifest(source: PluginSource): PluginManifest {
  if (!source.has(MANIFEST_PATH)) {
    throw new Error(describeMissingManifest(source));
  }

  let document: any;

  try {
    document = parse(source.readText(MANIFEST_PATH));
  } catch (error: any) {
    throw new Error(`The plugin at ${source.origin} has a ${MANIFEST_PATH} that isn't valid YAML: ${error.message}`);
  }

  if (document === null || typeof document !== "object") {
    throw new Error(`The ${MANIFEST_PATH} in ${source.origin} is empty.`);
  }

  const where = `${source.origin}/${MANIFEST_PATH}`;

  if (!KNOWN_API_VERSIONS.includes(document.apiVersion)) {
    throw new Error(
      `${where} declares apiVersion ${JSON.stringify(document.apiVersion ?? null)}, which this installer doesn't know. It understands: ${KNOWN_API_VERSIONS.join(", ")}.`,
    );
  }

  if (typeof document.name !== "string" || !PLUGIN_NAME.test(document.name)) {
    throw new Error(
      `${where} has the name ${JSON.stringify(document.name ?? null)}. A plugin name is lower case letters, digits and hyphens, starting and ending with a letter or digit, because it prefixes every command the plugin registers.`,
    );
  }

  const type = readType(document.type, where);

  const manifest: PluginManifest = {
    apiVersion: document.apiVersion,
    name: document.name,
    description:
      typeof document.description === "string" ? document.description : document.name,
    type,
    packages: readList(document.packages, "packages", where),
    bundles: readBundles(document.bundles, where),
    values:
      document.values !== undefined && document.values !== null ? document.values : {},
  };

  enforceType(manifest, where);

  return manifest;
}

/**
 * Work out which type a manifest declared.
 *
 * @param value
 * @param where
 * @returns
 */
function readType(value: unknown, where: string): PluginType {
  const types = Object.values(PluginType);

  if (typeof value !== "string" || !types.includes(value as PluginType)) {
    throw new Error(
      `${where} declares the type ${JSON.stringify(value ?? null)}. A plugin has to say what it is: ${types.join(", ")}.`,
    );
  }

  return value as PluginType;
}

/**
 * Hold a plugin to what its type allows.
 *
 * @param manifest
 * @param where
 */
function enforceType(manifest: PluginManifest, where: string) {
  const commands = manifest.bundles.flatMap((bundle) => bundle.commands);

  if (manifest.type === PluginType.Code) {
    throw new Error(
      `${where} declares the type "code", which this installer doesn't load. A code plugin runs inside the installer, where the cluster token, the registry passwords and your SSH keys are, and nothing it does there touches a node or appears in any log. If the plugin genuinely needs to build a command rather than declare one, that's worth raising rather than working around.`,
    );
  }

  if (manifest.type === PluginType.Inspection) {
    throw new Error(
      `${where} declares the type "inspection", which isn't implemented yet. It's meant to name facts and probes rather than commands, so that "read only" is something the installer enforces instead of something the plugin claims — and that probe catalogue doesn't exist. Until it does, a plugin that needs to look at a node has to declare the type "node" and be trusted accordingly.`,
    );
  }

  if (manifest.type === PluginType.Package && commands.length > 0) {
    const names = commands.map((command) => command.name).join(", ");
    throw new Error(
      `${where} declares the type "package" but contains ${commands.length} command${commands.length === 1 ? "" : "s"} (${names}). A package plugin is charts, manifests, secrets and values — nothing that runs on a node. Either take the commands out or declare the type "node", which means arbitrary shell as root and is trusted rather than checked.`,
    );
  }

  // Not a boundary, and worth saying plainly in the one place that
  // could be mistaken for one: a "node" plugin's purposes are the
  // author's own account of what their shell does. They matter for
  // doctor and preflight, which honour them, and they stop nothing.
  for (const command of commands) {
    if (command.purpose !== undefined && !Object.values(CommandPurpose).includes(command.purpose)) {
      throw new Error(
        `${where} gives the command "${command.name}" the purpose ${JSON.stringify(command.purpose)}, which isn't one of: ${Object.values(CommandPurpose).join(", ")}.`,
      );
    }
  }
}

/**
 * The bundles in a manifest, checked into shape.
 *
 * @param value
 * @param where
 * @returns
 */
function readBundles(value: unknown, where: string): PluginBundle[] {
  const entries = readList(value, "bundles", where);

  return entries.map((entry: any, index: number) => {
    if (typeof entry?.name !== "string" || entry.name === "") {
      throw new Error(`${where} has a bundle at position ${index + 1} with no name.`);
    }

    const commands = readList(entry.commands, `bundles.${entry.name}.commands`, where);

    for (const [position, command] of commands.entries()) {
      if (typeof command?.name !== "string" || command.name === "") {
        throw new Error(
          `${where} has a command at position ${position + 1} of the "${entry.name}" bundle with no name.`,
        );
      }

      if (typeof (command as any).url !== "string" && (command as any).command === undefined) {
        throw new Error(
          `${where} has a command "${command.name}" with nothing to run. A command needs either "command" for a shell command or "url" for a request.`,
        );
      }
    }

    return {
      name: entry.name,
      description: typeof entry.description === "string" ? entry.description : entry.name,
      commands: commands as CommandSpec[],
    };
  });
}

/**
 * A list from the manifest, or an empty one, with anything that isn't
 * a list refused rather than quietly ignored.
 *
 * @param value
 * @param field
 * @param where
 * @returns
 */
function readList(value: unknown, field: string, where: string): any[] {
  if (value === undefined || value === null) {
    return [];
  }

  if (!Array.isArray(value)) {
    throw new Error(`${where} has "${field}" as ${typeof value}, and it has to be a list.`);
  }

  return value;
}

/**
 * Explain a missing manifest, including the mistake nearly everyone
 * makes the first time.
 *
 * @param source
 * @returns
 */
function describeMissingManifest(source: PluginSource): string {
  const files = source.list();
  const nested = files.filter((path) => path.endsWith(`/${MANIFEST_PATH}`));

  if (nested.length > 0) {
    return `The plugin at ${source.origin} has no ${MANIFEST_PATH} at its root, but it does have ${nested[0]}. The manifest has to be at the top level: package the contents of the plugin directory rather than the directory itself.`;
  }

  return `There's no ${MANIFEST_PATH} in ${source.origin}, so there's no way to tell what it is.${files.length > 0 ? ` It holds: ${files.slice(0, 6).join(", ")}${files.length > 6 ? ", …" : ""}` : ""}`;
}

/**
 * Whether every command in a plugin only reads.
 *
 * Reported rather than relied on: it's the author's own account. It's
 * worth showing when a plugin is approved, since a plugin claiming to
 * only look is making a claim somebody can check against its shell.
 *
 * @param manifest
 * @returns
 */
export function claimsReadOnly(manifest: PluginManifest): boolean {
  return manifest.bundles
    .flatMap((bundle) => bundle.commands)
    .every((command) => command.purpose !== undefined && isReadOnly(command.purpose));
}
