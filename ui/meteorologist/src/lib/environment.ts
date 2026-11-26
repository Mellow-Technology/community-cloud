/**
 * @file
 * Where an application's environment values are kept, beyond the plain
 * ones written into its spec.env.
 *
 * - Its own secrets (spec.secrets): names in the spec, values in a
 *   Secret named for the application, `<application>-secrets`, under
 *   the same names. Meteorologist writes it, and the WebApplication
 *   owns it, so it goes when the application does. Whoever can read the
 *   application sees which secrets it has, never their values.
 * - The namespace's shared values (spec.shared): what several
 *   workloads use, kept once on the namespace's Environment tab, plain
 *   ones in the ConfigMap and secret ones in the Secret, both called
 *   `community-cloud-env`. An application names the ones it reads.
 *
 * Cirrus turns both into variables that refer to the values, holds the
 * rollout until each has one, says in status.environment which do, and
 * restarts the application when one changes
 * (operators/cirrus/src/reconcile/environment.rs and config_hash.rs).
 */
import type { WebApplication } from "./webapp/types";

// The namespace's shared values, a ConfigMap and a Secret of this name
export const SHARED_ENV = "community-cloud-env";
// On everything here, so a Secret or ConfigMap Meteorologist didn't
// make for this is never written over
export const ENV_LABEL = "community-cloud.technology/environment";

export type SharedKind = "config" | "secret";

/**
 * The Secret an application's own secret values are kept in.
 *
 * @param app the application's name
 * @returns
 */
export function appSecretName(app: string): string {
  return `${app}-secrets`;
}

/**
 * What to write into the application's Secret: the values typed, and
 * null for each one it no longer has. A secret left blank keeps the
 * value it has.
 *
 * @param rows the form's variables
 * @param before the names of the secrets it had before
 * @returns by name; empty when there's nothing to write
 */
export function secretChanges(
  rows: Array<{ name: string; value: string; secret?: boolean }>,
  before: string[],
): Record<string, string | null> {
  const changes: Record<string, string | null> = {};
  const kept = new Set<string>();
  for (const row of rows) {
    const name = row.name.trim();
    if (!row.secret || name === "") continue;
    kept.add(name);
    if (row.value !== "") changes[name] = row.value;
  }
  for (const name of before) {
    if (!kept.has(name)) changes[name] = null;
  }
  return changes;
}

/**
 * The applications that read a shared value, by name.
 *
 * @param apps
 * @param key the shared value's name
 * @returns
 */
export function sharedValueUsers(apps: Array<Pick<WebApplication, "metadata" | "spec">>, key: string): string[] {
  return apps
    .filter((app) => (app.spec.shared ?? []).some((shared) => shared.name === key))
    .map((app) => app.metadata.name);
}

/**
 * Which of an application's secrets have a value, as Cirrus last saw.
 *
 * @param app
 * @returns
 */
export function secretsSet(app: Pick<WebApplication, "status">): Set<string> {
  return new Set((app.status?.environment?.secrets ?? []).filter((each) => each.set).map((each) => each.name));
}
