/**
 * @file
 * The Postgres Cirrus gives each namespace.
 *
 * The first WebApplication in a namespace to ask for a database makes
 * Cirrus start a CloudNativePG Cluster there, which every later one
 * shares. It's made once, from Cirrus's defaults, and then left to the
 * namespace. These are those defaults, so the pages can say what
 * asking for a database will take before it's asked for. They mirror
 * operators/cirrus/src/settings.rs and have to be changed with it.
 */
import { formatBytes, parseQuantity } from "./quantity";

// The Cluster's name in every namespace. It's the server, which
// every application there shares, not any one application's database
export const POSTGRES_CLUSTER = "cirrus-postgres";

// The volume a new one is given
export const POSTGRES_STORAGE = "20Gi";

/**
 * Why a namespace's storage quota can't hold the Postgres a first
 * database would start, or undefined when it can or there's no quota.
 *
 * @param hard the quota's requests.storage
 * @param used what's already claimed against it
 * @returns
 */
export function postgresStorageProblem(hard: string | undefined, used: string | undefined): string | undefined {
  const limit = parseQuantity(hard);
  if (limit === undefined) {
    return undefined;
  }
  const needed = parseQuantity(POSTGRES_STORAGE) ?? 0;
  const left = limit - (parseQuantity(used) ?? 0);
  if (left >= needed) {
    return undefined;
  }
  return (
    `The namespace's Postgres needs a ${POSTGRES_STORAGE} volume, and the storage quota has ` +
    `${formatBytes(Math.max(left, 0))} left, so it won't start until the quota is raised.`
  );
}

/**
 * The database an application is given, and the role it signs in as,
 * which share a name. Hyphens become underscores, as
 * postgres_identifier in operators/cirrus/src/naming.rs makes them.
 * That also shortens a name past 63 characters, which an application's
 * can't be: its Service is named after it.
 *
 * @param application the WebApplication's name
 * @returns
 */
export function postgresDatabase(application: string): string {
  return application.replaceAll("-", "_");
}
