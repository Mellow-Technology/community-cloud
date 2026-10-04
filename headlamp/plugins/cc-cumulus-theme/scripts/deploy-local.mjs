/**
 * Copies the built plugin into Headlamp's plugin directory.
 *
 * `headlamp-plugin start` would normally do this as part of its watch loop,
 * but its CLI does not run on recent Node releases (see README), so there is
 * no watch mode and this is a step of its own. Set HEADLAMP_PLUGIN_DIR to
 * override the destination, e.g. when Headlamp was started with a custom
 * --plugins-dir.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function defaultPluginDir() {
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'Headlamp', 'plugins');
  }
  if (process.platform === 'win32') {
    return path.join(process.env.APPDATA || '', 'Headlamp', 'Config', 'plugins');
  }
  return path.join(os.homedir(), '.config', 'Headlamp', 'plugins');
}

const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
const target = path.join(process.env.HEADLAMP_PLUGIN_DIR || defaultPluginDir(), pkg.name);

if (!fs.existsSync('dist/main.js')) {
  console.error('dist/main.js is missing. Run the build first.');
  process.exit(1);
}

fs.mkdirSync(target, { recursive: true });
// Headlamp needs both files in the folder: main.js to run, package.json for metadata.
fs.copyFileSync('dist/main.js', path.join(target, 'main.js'));
fs.copyFileSync('package.json', path.join(target, 'package.json'));

console.log(`Copied ${pkg.name} to ${target}`);
console.log('Reload Headlamp (Cmd/Ctrl+R) to pick up the change.');
