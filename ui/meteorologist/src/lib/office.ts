/**
 * @file
 * The office applications, from the records the installer leaves.
 *
 * Every package the installer installs leaves a ConfigMap in
 * community-cloud saying what it is (installer/src/cli/commands/
 * PackageRecord.ts). The ones with an application in them are what
 * the Office page lists: where each is, how people sign in, and where
 * its administrator's password is kept, by the Secret's name. The
 * password itself is only ever read on request, as whoever's asking.
 *
 * A record is read as untrusted: anyone who can write ConfigMaps in
 * community-cloud can write one. So it's checked field by field, an
 * address has to be http or https before it becomes a link, and one
 * that doesn't hold up is left out rather than breaking the page.
 */
import type { KubeClient } from "./kube/client";
import type { ConfigMap, Workload } from "./kube/types";
import { presentHealth, type Health, type HealthState } from "./webapp/health";

// Where the records are, and how they're found and read. The same as
// the installer's, in PackageRecord.ts.
export const RECORD_NAMESPACE = "community-cloud";
export const RECORD_LABEL = "community-cloud.technology/package";
export const RECORD_KEY = "record.json";

// The record format this reads. A newer one is left out, rather than
// misread.
const RECORD_VERSION = 1;

/**
 * How people sign in: through Authentik, through the gate in front of
 * it, or with an account of the application's own.
 */
export type SignIn = "authentik" | "gate" | "own";

/**
 * The way in for an application's administrator: a credential the
 * install made, in a Secret, or how to become one.
 */
export type AdminAccess =
  { secret: { namespace: string; name: string; key: string }; login?: string } | { how: string };

/**
 * What a record says about an application.
 */
export interface OfficeApp {
  title: string;
  url: string;
  signIn: SignIn;
  admin?: AdminAccess;
  note?: string;
}

/**
 * A package the installer installed.
 */
export interface PackageRecord {
  name: string;
  description: string;
  namespace: string;
  chartVersion?: string;
  rollout: string[];
  updated?: string;
  app?: OfficeApp;
}

/**
 * A record with an application in it.
 */
export type OfficeRecord = PackageRecord & { app: OfficeApp };

// How each way of signing in is described
export const SIGN_IN_LABELS: Record<SignIn, string> = {
  authentik: "Through Authentik",
  gate: "Through Authentik, at a gate in front of it",
  own: "With its own accounts",
};

/**
 * @param value
 * @returns
 */
function isString(value: unknown): value is string {
  return typeof value === "string" && value !== "";
}

/**
 * @param value
 * @returns
 */
function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * An address that's safe to link to, or undefined.
 *
 * @param value
 * @returns
 */
function readUrl(value: unknown): string | undefined {
  if (!isString(value)) {
    return undefined;
  }
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The administrator's way in, as the record has it, or undefined when
 * it doesn't hold up.
 *
 * @param value
 * @returns
 */
function readAdmin(value: unknown): AdminAccess | undefined {
  if (!isObject(value)) {
    return undefined;
  }
  if (isString(value.how)) {
    return { how: value.how };
  }

  const secret = value.secret;
  if (!isObject(secret) || !isString(secret.namespace) || !isString(secret.name) || !isString(secret.key)) {
    return undefined;
  }
  return {
    secret: { namespace: secret.namespace, name: secret.name, key: secret.key },
    ...(isString(value.login) ? { login: value.login } : {}),
  };
}

/**
 * The application in a record, or undefined when it has none or it
 * doesn't hold up.
 *
 * @param value
 * @returns
 */
function readApp(value: unknown): OfficeApp | undefined {
  if (!isObject(value) || !isString(value.title)) {
    return undefined;
  }
  const url = readUrl(value.url);
  const signIn = value.signIn;
  if (url === undefined || (signIn !== "authentik" && signIn !== "gate" && signIn !== "own")) {
    return undefined;
  }

  const admin = readAdmin(value.admin);
  return {
    title: value.title,
    url,
    signIn,
    ...(admin !== undefined ? { admin } : {}),
    ...(isString(value.note) ? { note: value.note } : {}),
  };
}

/**
 * A package's record, from the ConfigMap it's kept in, or undefined
 * when it isn't one this can read.
 *
 * @param configMap
 * @returns
 */
export function parseRecord(configMap: ConfigMap): PackageRecord | undefined {
  const text = configMap.data?.[RECORD_KEY];
  if (text === undefined) {
    return undefined;
  }

  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return undefined;
  }

  if (
    !isObject(raw) ||
    raw.version !== RECORD_VERSION ||
    !isString(raw.name) ||
    !isString(raw.namespace) ||
    // The record's own name is what the label says it is
    configMap.metadata.labels?.[RECORD_LABEL] !== raw.name
  ) {
    return undefined;
  }

  const chart = isObject(raw.chart) && isString(raw.chart.version) ? raw.chart.version : undefined;
  let app = readApp(raw.app);
  // A credential is the package's own, in its own namespace. One
  // pointed anywhere else is dropped, so a record can't turn the page
  // into a way of showing some other Secret.
  if (app?.admin !== undefined && "secret" in app.admin && app.admin.secret.namespace !== raw.namespace) {
    const { admin: _dropped, ...rest } = app;
    app = rest;
  }

  return {
    name: raw.name,
    description: isString(raw.description) ? raw.description : "",
    namespace: raw.namespace,
    rollout: Array.isArray(raw.rollout) ? raw.rollout.filter(isString) : [],
    ...(chart !== undefined ? { chartVersion: chart } : {}),
    ...(isString(raw.updated) ? { updated: raw.updated } : {}),
    ...(app !== undefined ? { app } : {}),
  };
}

/**
 * Every package record this can read. One that can't be is said so in
 * the server's log, and left out.
 *
 * @param kube
 * @returns
 */
export async function readPackageRecords(kube: Pick<KubeClient, "listConfigMaps">): Promise<PackageRecord[]> {
  const configMaps = await kube.listConfigMaps(RECORD_NAMESPACE, RECORD_LABEL);
  return configMaps.flatMap((configMap) => {
    const record = parseRecord(configMap);
    if (record === undefined) {
      console.warn(`Skipping ${RECORD_NAMESPACE}/${configMap.metadata.name}: not a package record this can read`);
      return [];
    }
    return [record];
  });
}

/**
 * The records with an application in them, by title.
 *
 * @param records
 * @returns
 */
export function officeApps(records: PackageRecord[]): OfficeRecord[] {
  return records
    .filter((record): record is OfficeRecord => record.app !== undefined)
    .sort((a, b) => a.app.title.localeCompare(b.app.title));
}

/**
 * A health, from a state and why.
 *
 * @param state
 * @param message
 * @returns
 */
function health(state: HealthState, message?: string): Health {
  return { state, ...presentHealth(state), ...(message ? { message } : {}) };
}

/**
 * How an application is doing, from the workloads its install waited
 * for, as they are now.
 *
 * Missing, or with nothing ready, it's failing: nobody can use it.
 * Short of what was asked for, it's degraded, which is also what a
 * rollout looks like part way.
 *
 * @param record
 * @param workloads the workloads in the record's namespace
 * @returns undefined when its install names nothing to look at, as for
 *   a chart, which Helm waits for instead
 */
export function officeHealth(record: PackageRecord, workloads: Workload[]): Health | undefined {
  if (record.rollout.length === 0) {
    return undefined;
  }

  const problems: string[] = [];
  let failing = false;

  for (const entry of record.rollout) {
    const [kind, name] = entry.split("/");
    const workload = workloads.find((each) => each.kind === kind && each.name === name);

    if (workload === undefined) {
      failing = true;
      problems.push(`${entry} isn't there.`);
    } else if (workload.desired === 0) {
      problems.push(`${entry} is scaled down to nothing.`);
    } else if (workload.ready === 0) {
      failing = true;
      problems.push(`${entry} has nothing ready.`);
    } else if (workload.ready < workload.desired) {
      problems.push(`${entry} has ${workload.ready} of ${workload.desired} ready.`);
    }
  }

  if (problems.length === 0) {
    return health("healthy");
  }
  return health(failing ? "failing" : "degraded", problems.join(" "));
}

/**
 * Whether a package is the one a record names, for an action asked to
 * read that package's credential.
 *
 * @param records
 * @param name
 * @returns the credential, when the package has one
 */
export function findAdminSecret(
  records: PackageRecord[],
  name: string,
): { namespace: string; name: string; key: string } | undefined {
  const admin = records.find((record) => record.name === name)?.app?.admin;
  return admin !== undefined && "secret" in admin ? admin.secret : undefined;
}
