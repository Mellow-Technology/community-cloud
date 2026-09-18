/**
 * @file
 * What every test needs: where the repository is, a configuration to
 * work against, and somewhere to make a mess.
 *
 * Paths are worked out from this file's own location rather than
 * written down, so the tests run from a checkout anywhere and on
 * anybody's machine. Nothing here reaches outside the repository
 * except into a temporary directory it made itself.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import CloudConfig from "../util/CloudConfig.ts";

// This file is installer/src/test/helpers.ts, so the installer is two
// levels up and the repository three. Worked out from the module's own
// URL rather than import.meta.dirname, which needs a module setting
// this project doesn't use.
export const TEST_DIR = dirname(fileURLToPath(import.meta.url));
export const INSTALLER_ROOT = join(TEST_DIR, "..", "..");
export const REPO_ROOT = join(INSTALLER_ROOT, "..");

// A configuration with every value the manifests reference and no real
// credentials in it. The tests use this rather than whatever
// cc.config.json happens to hold: that file is gitignored, holds live
// secrets, and describes one person's cluster.
//
// Named ".fixture.json" rather than ".config.json" on purpose — the
// repository gitignores "*.config.json" so a real configuration can't
// be committed by accident, and a fixture that matched that pattern
// would never be committed either.
export const FIXTURE_CONFIG = join(TEST_DIR, "fixtures", "cluster.fixture.json");

/**
 * The fixture configuration, loaded.
 *
 * @param overrides merged over the top, for a test that needs the
 *                  fixture to say something different
 * @returns
 */
export async function loadFixtureConfig(overrides: Record<string, unknown> = {}) {
  const config = new CloudConfig();
  await config.loadConfigFromFile(FIXTURE_CONFIG);

  if (Object.keys(overrides).length > 0) {
    Object.assign(config.getConfig(), overrides);
  }

  return config;
}

/**
 * A configuration built from an object, for the tests that are about
 * what a particular shape of configuration does.
 *
 * @param contents
 * @returns
 */
export function configFrom(contents: Record<string, unknown>): CloudConfig {
  return new CloudConfig(contents);
}

/**
 * A directory that cleans itself up.
 *
 * Returned with a "remove" rather than registered against an after
 * hook, so a test that wants to look at what it built when something
 * fails can simply not call it.
 *
 * @param label
 * @returns
 */
export function makeTempDirectory(label: string): { path: string; remove: () => void } {
  const path = mkdtempSync(join(tmpdir(), `cc-${label}-`));

  return {
    path,
    remove: () => rmSync(path, { recursive: true, force: true }),
  };
}

/**
 * Run something with the console turned off.
 *
 * Commands narrate what they found as they go, which is right when a
 * person is watching one run and is noise when a test builds every
 * command in every bundle. The output is restored even if the work
 * throws, so a failure still reports itself.
 *
 * @param work
 * @returns whatever the work returned
 */
export async function withoutConsole<T>(work: () => Promise<T> | T): Promise<T> {
  const { log, warn, error, info } = console;
  const quiet = () => {};

  console.log = quiet;
  console.warn = quiet;
  console.error = quiet;
  console.info = quiet;

  try {
    return await work();
  } finally {
    console.log = log;
    console.warn = warn;
    console.error = error;
    console.info = info;
  }
}

/**
 * The node the fixture describes, for commands that want one in their
 * context.
 *
 * @returns
 */
export function fixtureNode() {
  return {
    name: "server-1",
    address: "server-1.test",
    username: "someone",
    type: "server",
    gateway: true,
    roles: ["worker", "storage-local"],
    region: "mob",
    zone: "mob-mob-0",
  };
}
