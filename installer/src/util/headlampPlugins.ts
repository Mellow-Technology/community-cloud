/**
 * @file
 * The Headlamp plugins the installer carries, as template values.
 *
 * The plugins in headlamp/plugins/ are built and embedded alongside
 * the manifests (see scripts/generateEmbedded.ts), each as its
 * main.js and package.json. Headlamp loads a plugin from a folder of
 * its own holding both, so the headlamp package puts each plugin in a
 * ConfigMap and mounts them all into Headlamp's plugins directory.
 *
 * The files go into the ConfigMaps base64 encoded, as binaryData.
 * That's what keeps them intact: the manifests are templates, and a
 * plugin's JavaScript is free to contain anything a template would
 * try to read as its own.
 */
import { createHash } from "node:crypto";

import { listEmbeddedFiles, readEmbeddedFile } from "./embedded.ts";

// Where generateEmbedded.ts stores them
const PLUGIN_PREFIX = "headlamp-plugins/";

/**
 * A plugin, ready to go into a ConfigMap.
 *
 * - name: the plugin's folder, and so the name Headlamp knows it by
 * - main / packageJson: its two files, base64 encoded
 */
export interface HeadlampPlugin {
  name: string;
  main: string;
  packageJson: string;
}

/**
 * Every plugin the installer carries.
 *
 * @returns
 */
export function getHeadlampPlugins(): HeadlampPlugin[] {
  const names = [
    ...new Set(
      listEmbeddedFiles()
        .filter((path) => path.startsWith(PLUGIN_PREFIX))
        .map((path) => path.slice(PLUGIN_PREFIX.length).split("/")[0]!),
    ),
  ];

  const encode = (name: string, file: string) =>
    Buffer.from(readEmbeddedFile(`${PLUGIN_PREFIX}${name}/${file}`), "utf8").toString("base64");

  return names.map((name) => ({
    name,
    main: encode(name, "main.js"),
    packageJson: encode(name, "package.json"),
  }));
}

/**
 * Something that changes whenever any plugin does.
 *
 * For a pod annotation: Headlamp is restarted when its plugins
 * change, rather than relying on it to notice files swapped under it.
 *
 * @param plugins
 * @returns
 */
export function getHeadlampPluginsRevision(plugins: HeadlampPlugin[]): string {
  const hash = createHash("sha256");

  for (const plugin of plugins) {
    hash.update(plugin.name).update(plugin.main).update(plugin.packageJson);
  }

  return hash.digest("hex").slice(0, 16);
}
