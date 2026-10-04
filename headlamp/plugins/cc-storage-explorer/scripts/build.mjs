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

// Kept in the output rather than only in the source tree: the built file is
// how this is actually distributed, so it is where someone who has only the
// built file will look. Rollup leaves a `/*!` comment alone.
const BANNER = `/*!
 * cc-storage-explorer — node storage and TopoLVM logical volumes for Headlamp
 * Copyright (C) 2026 Code Incarnate Technologies, LLC.
 * SPDX-License-Identifier: LGPL-3.0-or-later
 */`;

config.build = {
  ...(config.build || {}),
  rollupOptions: {
    ...(config.build?.rollupOptions || {}),
    output: { ...(config.build?.rollupOptions?.output || {}), banner: BANNER },
  },
};

await vite.build(config);
