/**
 * @file
 * Finding plugins, deciding which to load, and loading them.
 *
 * Plugins live in one directory: ~/.community-cloud/plugins/. Being
 * in it is not the same as being loaded. The directory says what is
 * available and the configuration says what is enabled, which is the
 * same split "packages" already uses — and it means a file arriving
 * in that directory, by whatever means, doesn't silently acquire root
 * on every node at the next run.
 *
 * Everything a plugin registers is namespaced with its own name.
 * Command names are result keys and context keys, so two plugins each
 * shipping an "install" command would otherwise collide silently and
 * the second would win.
 */
import { homedir } from "node:os";
import { existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import CloudConfig from "../util/CloudConfig.ts";
import {
  addFileResolver,
  addValueContributor,
  resetFileResolvers,
} from "../util/fileResolvers.ts";
import { registerBundle } from "../cli/commands/bundles.ts";
import { registerPackage } from "../cli/commands/packages.ts";
import ArchiveSource, { looksLikeArchive } from "./ArchiveSource.ts";
import DirectorySource, { looksLikePlugin } from "./DirectorySource.ts";
import { PluginSource } from "./PluginSource.ts";
import { PluginManifest, PluginType, readManifest } from "./manifest.ts";
import { changedError, describePlugin, fingerprint, isApproved } from "./approval.ts";

// The scheme a plugin's own files are referred to by, anywhere a
// manifest path can appear
export const PLUGIN_SCHEME = "plugin://";

// One directory, for now. A search path, a per-project directory and
// an environment override are all defensible and none of them is
// needed to find out whether any of this works.
export const PLUGIN_DIRECTORY = join(homedir(), ".community-cloud", "plugins");

/**
 * What a configuration says about a plugin.
 */
export interface PluginSelection {
  enabled?: boolean;
  sha256?: string;
}

/**
 * A plugin that has been read and accepted.
 */
export interface LoadedPlugin {
  manifest: PluginManifest;
  source: PluginSource;
}

// What's loaded, by name. Module level because the resolver in
// template.ts has to reach it from deep inside a render, and threading
// a registry through every template call would mean changing every
// caller of renderInstallerFile to carry something it doesn't use.
const loaded = new Map<string, LoadedPlugin>();

/**
 * Forget every loaded plugin. For tests, and for a process that loads
 * more than one configuration.
 */
export function resetPlugins() {
  loaded.clear();
  resetFileResolvers();
  registerResolver();
}

/**
 * Teach the renderer to read plugin:// paths.
 *
 * Registered rather than imported, so that the renderer doesn't have
 * to know plugins exist — which would close an import loop through the
 * bundle list and leave whichever module loaded first holding
 * half-built references to the others.
 */
function registerResolver() {
  addFileResolver({
    scheme: PLUGIN_SCHEME,
    matches: isPluginPath,
    read: readPluginFile,
  });
}

registerResolver();

/**
 * The plugins currently loaded.
 *
 * @returns
 */
export function getLoadedPlugins(): LoadedPlugin[] {
  return [...loaded.values()];
}

/**
 * One loaded plugin, by name.
 *
 * @param name
 * @returns
 */
export function getPlugin(name: string): LoadedPlugin | undefined {
  return loaded.get(name);
}

/**
 * Read the plugins section of a configuration.
 *
 * "true" is shorthand for enabling one with nothing else said about
 * it, which matches how packages are written.
 *
 * @param config
 * @returns
 */
export function getPluginSelections(config: CloudConfig): Record<string, PluginSelection> {
  const { plugins } = config.getConfig();

  if (plugins === undefined || plugins === null || typeof plugins !== "object") {
    return {};
  }

  const selections: Record<string, PluginSelection> = {};

  for (const [name, selection] of Object.entries(plugins)) {
    if (typeof selection === "string") {
      continue;
    }

    selections[name] = selection === true ? { enabled: true } : (selection as PluginSelection);
  }

  return selections;
}

/**
 * What's sitting in the plugin directory, whether or not it's enabled.
 *
 * A missing directory is the ordinary case rather than a problem —
 * most clusters will never have one — so it reads as empty.
 *
 * @param directory
 * @returns
 */
export function discoverPlugins(directory: string = PLUGIN_DIRECTORY): PluginSource[] {
  if (!existsSync(directory)) {
    return [];
  }

  const sources: PluginSource[] = [];

  for (const entry of readdirSync(directory).sort()) {
    // Anything hidden is left alone. A .DS_Store or a .git isn't a
    // plugin, and a directory somebody renamed out of the way with a
    // dot meant to take it out of the way.
    if (entry.startsWith(".")) {
      continue;
    }

    const path = join(directory, entry);
    const stats = statSync(path);

    // Unpacked, which is the form a plugin has while it is being
    // written, and packaged, which is the form it has while it is
    // being sent. Both sit in the same directory on purpose: having
    // to repackage after every edit would make the archive a tax on
    // writing a plugin rather than a convenience for sending one.
    if (stats.isDirectory() && looksLikePlugin(path)) {
      sources.push(new DirectorySource(path));
      continue;
    }

    if (stats.isFile() && looksLikeArchive(path)) {
      try {
        sources.push(new ArchiveSource(path));
      } catch (error: any) {
        console.warn(`⚠️  Ignoring ${path}: ${error.message}`);
      }
    }
  }

  return sources;
}

/**
 * Load the plugins a configuration asks for.
 *
 * Called by each runner after it reads its configuration, rather than
 * from inside CloudConfig, so that loading a configuration stays a
 * thing that only reads a file.
 *
 * @param config
 * @param directory
 * @returns the plugins loaded
 */
export function loadPlugins(
  config: CloudConfig,
  directory: string = PLUGIN_DIRECTORY,
): LoadedPlugin[] {
  const selections = getPluginSelections(config);
  const wanted = Object.entries(selections)
    .filter(([, selection]) => selection.enabled !== false)
    .map(([name]) => name);

  if (wanted.length === 0) {
    return [];
  }

  const available = new Map<string, { source: PluginSource; manifest: PluginManifest }>();

  for (const source of discoverPlugins(directory)) {
    // A plugin that can't be read is worth saying so about, but it
    // shouldn't stop a run that never asked for it
    let manifest: PluginManifest;

    try {
      manifest = readManifest(source);
    } catch (error: any) {
      console.warn(`⚠️  Ignoring ${source.origin}: ${error.message}`);
      continue;
    }

    const already = available.get(manifest.name);
    if (already !== undefined) {
      throw new Error(
        `Two plugins both call themselves "${manifest.name}": ${already.source.origin} and ${source.origin}. A plugin's name comes from its manifest rather than its filename, so renaming the file won't settle it — one of them has to change its name.`,
      );
    }

    available.set(manifest.name, { source, manifest });
  }

  const plugins: LoadedPlugin[] = [];

  for (const name of wanted) {
    const found = available.get(name);

    if (found === undefined) {
      throw new Error(
        `The configuration enables the plugin "${name}", and there isn't one in ${directory}.${describeAvailable(available)}`,
      );
    }

    approve(name, found.manifest, found.source, selections[name]);
    register(found.manifest);

    if (Object.keys(found.manifest.values).length > 0) {
      addValueContributor({
        name: `The plugin "${found.manifest.name}"`,
        values: found.manifest.values,
      });
    }
    loaded.set(name, { manifest: found.manifest, source: found.source });
    plugins.push({ manifest: found.manifest, source: found.source });
  }

  return plugins;
}

/**
 * Check a plugin is the one that was approved, or show what it would
 * add so that somebody can decide.
 *
 * The fingerprint goes in the configuration rather than in a file of
 * this installer's own, because the configuration is already the
 * thing that says what this cluster is and is already the thing kept
 * somewhere safe. A plugin nobody has approved is refused rather than
 * prompted for: a prompt is a thing people press through, and the
 * decision belongs in the file that records every other decision
 * about the cluster.
 *
 * @param name
 * @param manifest
 * @param source
 * @param selection
 */
function approve(
  name: string,
  manifest: PluginManifest,
  source: PluginSource,
  selection: PluginSelection | undefined,
) {
  const actual = fingerprint(source);

  if (isApproved(selection, actual)) {
    return;
  }

  if (selection?.sha256 !== undefined) {
    throw changedError(name, selection.sha256, actual);
  }

  const lines = describePlugin(manifest, source);

  throw new Error(
    `The plugin "${name}" hasn't been approved, so it wasn't loaded. This is everything it would add:\n\n` +
      `${lines.join("\n")}\n\n` +
      `A plugin runs against every machine this configuration describes. Read the above, and if it's what you meant, record it in the configuration:\n\n` +
      `  "plugins": {\n    "${name}": { "enabled": true, "sha256": "${actual}" }\n  }\n\n` +
      `It will not be asked again unless the plugin changes.`,
  );
}

/**
 * Put a plugin's contributions into the registries everything else
 * reads.
 *
 * @param manifest
 * @param source
 */
function register(manifest: PluginManifest) {
  for (const definition of manifest.packages) {
    registerPackage({ ...definition, name: namespaced(manifest.name, definition.name) }, manifest.name);
  }

  for (const bundle of manifest.bundles) {
    registerBundle(
      {
        name: namespaced(manifest.name, bundle.name),
        description: bundle.description,
        commands: bundle.commands.map((command) => ({
          ...command,
          name: namespaced(manifest.name, command.name),
        })),
      },
      manifest.name,
    );
  }
}

/**
 * A plugin's name for one of its own things.
 *
 * Two names are left alone. One already carrying the prefix, so an
 * author who writes it out doesn't get it twice; and one that is the
 * plugin's own name, because a plugin whose whole purpose is a single
 * package named after itself should not have to be called
 * "authentik:authentik" in every configuration that wants it.
 *
 * @param plugin
 * @param name
 * @returns
 */
export function namespaced(plugin: string, name: string): string {
  if (name === plugin || name.startsWith(`${plugin}:`)) {
    return name;
  }

  return `${plugin}:${name}`;
}

/**
 * Read a file out of a loaded plugin, given a plugin:// path.
 *
 * @param path
 * @returns
 */
export function readPluginFile(path: string): string {
  const { plugin, file } = parsePluginPath(path);
  const found = loaded.get(plugin);

  if (found === undefined) {
    throw new Error(
      `"${path}" refers to the plugin "${plugin}", which isn't loaded.${
        loaded.size > 0
          ? ` Loaded: ${[...loaded.keys()].join(", ")}.`
          : " No plugins are loaded — a plugin has to be enabled in the configuration as well as present in the plugin directory."
      }`,
    );
  }

  return found.source.readText(file);
}

/**
 * Whether a path refers to a file inside a plugin.
 *
 * @param path
 * @returns
 */
export function isPluginPath(path: string): boolean {
  return path.startsWith(PLUGIN_SCHEME);
}

/**
 * Split a plugin:// path into the plugin and the file.
 *
 * @param path
 * @returns
 */
export function parsePluginPath(path: string): { plugin: string; file: string } {
  const rest = path.slice(PLUGIN_SCHEME.length);
  const slash = rest.indexOf("/");

  if (slash <= 0 || slash === rest.length - 1) {
    throw new Error(
      `"${path}" isn't a complete plugin path. It should be ${PLUGIN_SCHEME}<plugin>/<file>, for example ${PLUGIN_SCHEME}authentik/templates/Authentik.values.yaml.`,
    );
  }

  return { plugin: rest.slice(0, slash), file: rest.slice(slash + 1) };
}

/**
 * Make the plugin directory, so there's somewhere obvious to put one.
 *
 * @param directory
 * @returns
 */
export function ensurePluginDirectory(directory: string = PLUGIN_DIRECTORY): string {
  // 0700 because this sits beside the configuration holding the
  // cluster token, on the one machine with root on every node
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  return directory;
}

/**
 * Name what is in the directory, when what was asked for isn't.
 *
 * @param available
 * @returns
 */
function describeAvailable(available: Map<string, unknown>): string {
  if (available.size === 0) {
    return " That directory holds no plugins at all.";
  }

  return ` It holds: ${[...available.keys()].join(", ")}.`;
}

/**
 * Only used to keep the type import honest for callers that switch on
 * what a plugin is.
 */
export { PluginType };
