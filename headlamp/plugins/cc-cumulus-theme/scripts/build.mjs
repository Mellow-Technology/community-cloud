/**
 * @file
 * Production build without the `headlamp-plugin` CLI wrapper.
 *
 * `headlamp-plugin build` (v0.14) loads yargs in a way that throws
 * "require is not defined in ES module scope" on recent Node releases.
 * This runs the same Vite config the CLI would, with one change.
 *
 * That change is the asset inline limit. A Headlamp plugin is one
 * JavaScript file served from its own folder; there is nothing to
 * serve a second file from, and nothing that would know the folder's
 * name to ask for it. So the bundled fonts have to end up inside the
 * bundle, and Vite only inlines an asset under its limit, which is 4
 * KB by default. Raising it to 512 KB covers the two woff2 files with
 * room to spare and leaves anything genuinely large still emitted,
 * where the failure would at least be visible.
 */
import fs from 'node:fs';

process.env.NODE_ENV = process.env.NODE_ENV || 'production';

const config = (await import('../node_modules/@kinvolk/headlamp-plugin/config/vite.config.mjs'))
  .default;
const vite = await import('../node_modules/vite/dist/node/index.js');
const { pluginNameInjection } = await import(
  '../node_modules/@kinvolk/headlamp-plugin/config/vite-plugin-name-injection.mjs'
);

const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
config.plugins = [...(config.plugins || []), pluginNameInjection({ pluginName: pkg.name })];
config.build = { ...(config.build || {}), assetsInlineLimit: 512 * 1024 };

await vite.build(config);
