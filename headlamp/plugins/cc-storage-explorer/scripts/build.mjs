/**
 * Production build without the `headlamp-plugin` CLI wrapper.
 *
 * `headlamp-plugin build` (v0.14) loads yargs in a way that throws
 * "require is not defined in ES module scope" on recent Node releases. This
 * runs the exact Vite config that the CLI would run, so the output in `dist/`
 * is the same.
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

await vite.build(config);
