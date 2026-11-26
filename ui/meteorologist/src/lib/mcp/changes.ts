/**
 * @file
 * What an agent may change about an application, and applying that to
 * the form model the pages use.
 *
 * An agent never sends a whole spec. It sends the fields it means to
 * change, and they're laid over the form made from the live resource
 * (../webapp/form.ts), which is then written back over that resource.
 * So whatever it doesn't mention stays as it was, including what the
 * form doesn't show, and the same validation applies as when a person
 * saves.
 *
 * Some things are a person's to do, in Meteorologist, and are refused
 * here rather than ignored, so the agent can say so:
 *
 * - Hostnames aren't in the changes at all. They're a claim on a name
 *   others may want (CC-45), and an application made here is only
 *   reachable inside the cluster until a person gives it one.
 * - Services are only ever added. Turning off a database, bucket or
 *   queue is where data gets lost, or a vhost deleted.
 * - Volumes are only added, never changed or taken away, for the same
 *   reason.
 * - A variable read from a Secret can't be set or removed: the agent
 *   never sees what's in it, and replacing it with a plain value would
 *   put a secret in the spec.
 */
import { DEFAULT_GITLAB_REF, DEFAULT_GITLAB_URL, DEFAULT_TOKEN_KEY, type StorageType } from "../webapp/types";
import { validateForm, type WebApplicationForm } from "../webapp/form";

/**
 * The fields an agent may set, all optional. In an update, a field
 * left out is left as it is.
 */
export interface ApplicationChanges {
  image?: { repository: string; tag?: string };
  replicas?: number;
  // Nothing (null) to read it from the image's EXPOSE
  port?: number | null;
  healthCheckPath?: string | null;
  resources?: Partial<Record<"cpuRequest" | "memoryRequest" | "cpuLimit" | "memoryLimit", string | null>>;
  postgres?: boolean;
  rabbitmq?: boolean;
  bucket?: boolean | { quota?: string };
  migrations?: { command: string[]; args?: string[]; timeoutSeconds?: number } | null;
  // A value sets the variable; null removes it
  env?: Record<string, string | null>;
  volumes?: Array<{ name: string; mountPath: string; size: string; type?: StorageType }>;
  connections?: Array<{ offering: string; namespace?: string; name?: string }>;
  gitlab?: { project: string; connection: string; url?: string; ref?: string };
}

// The form's fields, as an agent knows them: its own names for them
const FIELD_NAMES: Partial<Record<keyof WebApplicationForm, string>> = {
  repository: "image.repository",
  tag: "image.tag",
  healthCheckPath: "healthCheckPath",
  cpuRequest: "resources.cpuRequest",
  memoryRequest: "resources.memoryRequest",
  cpuLimit: "resources.cpuLimit",
  memoryLimit: "resources.memoryLimit",
  bucketQuota: "bucket.quota",
  migrationCommand: "migrations.command",
  migrationTimeoutSeconds: "migrations.timeoutSeconds",
  serviceConnections: "connections",
  gitlabTokenSecretName: "gitlab.connection",
  gitlabUrl: "gitlab.url",
  gitlabProject: "gitlab.project",
};

/**
 * The form with the changes laid over it, and what couldn't be done.
 * The form given is left alone.
 *
 * @param base the form for the application as it is, or an empty one
 * @param changes
 * @returns the new form, and a sentence for each change refused or
 *   field that isn't valid; empty when it can be saved
 */
export function applyChanges(
  base: WebApplicationForm,
  changes: ApplicationChanges,
): { form: WebApplicationForm; problems: string[] } {
  const form = structuredClone(base);
  const problems: string[] = [];

  if (changes.image !== undefined) {
    form.repository = changes.image.repository;
    if (changes.image.tag !== undefined) form.tag = changes.image.tag;
  }
  if (changes.replicas !== undefined) form.replicas = String(changes.replicas);
  if (changes.port !== undefined) form.port = changes.port === null ? "" : String(changes.port);
  if (changes.healthCheckPath !== undefined) form.healthCheckPath = changes.healthCheckPath ?? "";
  for (const [field, value] of Object.entries(changes.resources ?? {})) {
    if (field in form && value !== undefined) {
      form[field as "cpuRequest" | "memoryRequest" | "cpuLimit" | "memoryLimit"] = value ?? "";
    }
  }

  for (const service of ["postgres", "rabbitmq"] as const) {
    if (changes[service] === true) form[service] = true;
    if (changes[service] === false && base[service]) {
      problems.push(`${service} can't be turned off from here. A person does that in Meteorologist.`);
    }
  }
  if (changes.bucket === false) {
    if (base.bucket) problems.push("The bucket can't be turned off from here. A person does that in Meteorologist.");
  } else if (changes.bucket !== undefined) {
    form.bucket = true;
    if (typeof changes.bucket === "object" && changes.bucket.quota !== undefined) {
      form.bucketQuota = changes.bucket.quota;
    }
  }

  if (changes.migrations === null) {
    form.migrations = false;
  } else if (changes.migrations !== undefined) {
    form.migrations = true;
    form.migrationCommand = changes.migrations.command.join("\n");
    form.migrationArgs = (changes.migrations.args ?? []).join("\n");
    form.migrationTimeoutSeconds =
      changes.migrations.timeoutSeconds === undefined ? "" : String(changes.migrations.timeoutSeconds);
  }

  for (const [name, value] of Object.entries(changes.env ?? {})) {
    if (form.preservedEnv.some((variable) => variable.name === name)) {
      problems.push(`${name} is read from a Secret or ConfigMap, so it can't be changed from here.`);
      continue;
    }
    const rows = form.env.filter((row) => row.name !== name);
    form.env = value === null ? rows : [...rows, { name, value }];
  }

  for (const volume of changes.volumes ?? []) {
    const existing = form.volumes.find((row) => row.name === volume.name);
    const row = { ...volume, type: volume.type ?? "fast" };
    if (existing === undefined) {
      form.volumes.push(row);
    } else if (JSON.stringify(existing) !== JSON.stringify(row)) {
      problems.push(`The volume ${volume.name} is already there. A person changes it in Meteorologist.`);
    }
  }

  for (const connection of changes.connections ?? []) {
    const row = { offering: connection.offering, namespace: connection.namespace ?? "", name: connection.name ?? "" };
    if (!form.serviceConnections.some((each) => JSON.stringify(each) === JSON.stringify(row))) {
      form.serviceConnections.push(row);
    }
  }

  if (changes.gitlab !== undefined) {
    form.imageSource = "gitlab";
    form.gitlab = true;
    form.gitlabProject = changes.gitlab.project;
    form.gitlabTokenSecretName = changes.gitlab.connection;
    form.gitlabTokenSecretKey = DEFAULT_TOKEN_KEY;
    form.gitlabUrl = changes.gitlab.url ?? (base.gitlab ? base.gitlabUrl : DEFAULT_GITLAB_URL);
    form.gitlabRef = changes.gitlab.ref ?? (base.gitlab ? base.gitlabRef : DEFAULT_GITLAB_REF);
  }

  for (const [field, message] of Object.entries(validateForm(form))) {
    problems.push(`${FIELD_NAMES[field as keyof WebApplicationForm] ?? field}: ${message}`);
  }
  return { form, problems };
}
