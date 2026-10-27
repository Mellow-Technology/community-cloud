/**
 * @file
 * The WebApplication form's model, and the conversions between it and
 * the resource.
 *
 * The form and the resource disagree about shape in small ways that
 * add up. The resource says "I want a database" by having a postgres
 * block at all; the form says it with a switch. The resource keeps a
 * command as a list; the form has a text box. The resource leaves out
 * whatever it doesn't need; the form always has every field, if only
 * as an empty string. Doing the translation in one pure module, rather
 * than in the component, is what lets it be tested both ways.
 *
 * Editing never loses what the form doesn't show. An existing resource
 * is the starting point for the one written back, and only the fields
 * the form owns are replaced: an environment variable read from a
 * Secret, a resource limit on something other than CPU and memory, or
 * a field Cirrus adds after this was written all come through as they
 * were.
 */
import type { EnvVar, ResourceRequirements } from "../kube/types";
import {
  API_VERSION,
  DEFAULT_GITLAB_REF,
  DEFAULT_GITLAB_URL,
  DEFAULT_IMAGE_TAG,
  DEFAULT_PORT,
  DEFAULT_REPLICAS,
  DEFAULT_TAG,
  DEFAULT_TOKEN_KEY,
  KIND,
  type WebApplication,
  type WebApplicationSpec,
} from "./types";

/**
 * A plain environment variable, as a row in the form.
 */
export interface EnvRow {
  name: string;
  value: string;
}

/**
 * Everything the form edits. Numbers are kept as the text that was
 * typed, so a half-typed or empty field can be told apart from zero
 * and reported, rather than silently becoming NaN.
 *
 * Lists that are one item per line in the form (the migration command
 * and its arguments) are kept as that text; lists edited row by row
 * (hostnames, environment) are kept as arrays.
 */
export interface WebApplicationForm {
  namespace: string;
  name: string;

  repository: string;
  tag: string;
  imagePullSecrets: string;

  replicas: string;
  port: string;
  healthCheckPath: string;
  cpuRequest: string;
  memoryRequest: string;
  cpuLimit: string;
  memoryLimit: string;

  hostnames: string[];

  postgres: boolean;
  bucket: boolean;
  bucketQuota: string;
  rabbitmq: boolean;

  migrations: boolean;
  migrationCommand: string;
  migrationArgs: string;
  migrationTimeoutSeconds: string;

  gitlab: boolean;
  gitlabUrl: string;
  gitlabProject: string;
  gitlabRef: string;
  gitlabTokenSecretName: string;
  gitlabTokenSecretKey: string;
  gitlabImageTag: string;

  env: EnvRow[];
  // Variables the form can't edit — those read from a Secret or a
  // ConfigMap — shown, and written back as they were
  preservedEnv: EnvVar[];
}

/**
 * The form for an application that doesn't exist yet.
 *
 * @param namespace the namespace to start in, if one was chosen
 * @returns
 */
export function emptyForm(namespace = ""): WebApplicationForm {
  return {
    namespace,
    name: "",
    repository: "",
    tag: DEFAULT_TAG,
    imagePullSecrets: "",
    replicas: String(DEFAULT_REPLICAS),
    port: String(DEFAULT_PORT),
    healthCheckPath: "",
    cpuRequest: "",
    memoryRequest: "",
    cpuLimit: "",
    memoryLimit: "",
    hostnames: [],
    postgres: false,
    bucket: false,
    bucketQuota: "",
    rabbitmq: false,
    migrations: false,
    migrationCommand: "",
    migrationArgs: "",
    migrationTimeoutSeconds: "",
    gitlab: false,
    gitlabUrl: DEFAULT_GITLAB_URL,
    gitlabProject: "",
    gitlabRef: DEFAULT_GITLAB_REF,
    gitlabTokenSecretName: "",
    gitlabTokenSecretKey: DEFAULT_TOKEN_KEY,
    gitlabImageTag: DEFAULT_IMAGE_TAG,
    env: [],
    preservedEnv: [],
  };
}

/**
 * Lines of text, without the blank ones.
 *
 * @param text
 * @returns
 */
export function splitLines(text: string): string[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
}

/**
 * A comma- or whitespace-separated list, without the empty items.
 *
 * @param text
 * @returns
 */
export function splitList(text: string): string[] {
  return text
    .split(/[\s,]+/)
    .map((item) => item.trim())
    .filter((item) => item !== "");
}

/**
 * The form for an existing application.
 *
 * Defaults are filled in where the resource leaves a field out, so
 * the form shows what Cirrus will actually do.
 *
 * @param app
 * @returns
 */
export function toForm(app: WebApplication): WebApplicationForm {
  const spec = app.spec;
  const gitlab = spec.source?.gitlab;
  const env = spec.env ?? [];

  return {
    namespace: app.metadata.namespace ?? "",
    name: app.metadata.name,
    repository: spec.image.repository,
    tag: spec.image.tag ?? DEFAULT_TAG,
    imagePullSecrets: (spec.imagePullSecrets ?? []).join(", "),
    replicas: String(spec.replicas ?? DEFAULT_REPLICAS),
    port: String(spec.port ?? DEFAULT_PORT),
    healthCheckPath: spec.healthCheck?.path ?? "",
    cpuRequest: spec.resources?.requests?.cpu ?? "",
    memoryRequest: spec.resources?.requests?.memory ?? "",
    cpuLimit: spec.resources?.limits?.cpu ?? "",
    memoryLimit: spec.resources?.limits?.memory ?? "",
    hostnames: [...(spec.hostnames ?? [])],
    postgres: spec.postgres !== undefined,
    bucket: spec.bucket !== undefined,
    bucketQuota: spec.bucket?.quota ?? "",
    rabbitmq: spec.rabbitmq !== undefined,
    migrations: spec.migrations !== undefined,
    migrationCommand: (spec.migrations?.command ?? []).join("\n"),
    migrationArgs: (spec.migrations?.args ?? []).join("\n"),
    migrationTimeoutSeconds:
      spec.migrations?.timeoutSeconds !== undefined ? String(spec.migrations.timeoutSeconds) : "",
    gitlab: gitlab !== undefined,
    gitlabUrl: gitlab?.url ?? DEFAULT_GITLAB_URL,
    gitlabProject: gitlab?.project ?? "",
    gitlabRef: gitlab?.ref ?? DEFAULT_GITLAB_REF,
    gitlabTokenSecretName: gitlab?.tokenSecret.name ?? "",
    gitlabTokenSecretKey: gitlab?.tokenSecret.key ?? DEFAULT_TOKEN_KEY,
    gitlabImageTag: gitlab?.imageTag ?? DEFAULT_IMAGE_TAG,
    env: env
      .filter((variable) => variable.valueFrom === undefined)
      .map((variable) => ({ name: variable.name, value: variable.value ?? "" })),
    preservedEnv: env.filter((variable) => variable.valueFrom !== undefined),
  };
}

/**
 * A copy of a value that shares nothing with it.
 *
 * @param value
 * @returns
 */
function copy<T>(value: T): T {
  return structuredClone(value);
}

/**
 * Sets a key to a value, or removes it when there's no value, so the
 * resource written back only has what was asked for.
 *
 * @param target
 * @param key
 * @param value
 */
function setOrDelete<T extends object, K extends keyof T>(target: T, key: K, value: T[K] | undefined): void {
  if (value === undefined) {
    delete target[key];
  } else {
    target[key] = value;
  }
}

/**
 * A whole number from the form, or nothing when the field is empty or
 * isn't one. Validation is what reports the second case.
 *
 * @param text
 * @returns
 */
function toInteger(text: string): number | undefined {
  const trimmed = text.trim();
  return /^-?\d+$/.test(trimmed) ? Number(trimmed) : undefined;
}

/**
 * Nothing in place of an empty or blank string.
 *
 * @param text
 * @returns
 */
function nonEmpty(text: string): string | undefined {
  const trimmed = text.trim();
  return trimmed === "" ? undefined : trimmed;
}

/**
 * CPU and memory from the form, over whatever else the resource
 * already asked for.
 *
 * @param form
 * @param base the resource's existing requirements
 * @returns nothing, when nothing at all is asked for
 */
function buildResources(
  form: WebApplicationForm,
  base: ResourceRequirements | undefined,
): ResourceRequirements | undefined {
  const resources: ResourceRequirements = copy(base ?? {});

  for (const [section, cpu, memory] of [
    ["requests", form.cpuRequest, form.memoryRequest],
    ["limits", form.cpuLimit, form.memoryLimit],
  ] as const) {
    const amounts = { ...resources[section] };
    setOrDelete(amounts, "cpu", nonEmpty(cpu));
    setOrDelete(amounts, "memory", nonEmpty(memory));
    setOrDelete(resources, section, Object.keys(amounts).length > 0 ? amounts : undefined);
  }

  return Object.keys(resources).length > 0 ? resources : undefined;
}

/**
 * The resource the form describes.
 *
 * With a base, the result is that resource with the form's fields
 * written over it — metadata, resourceVersion and status included, so
 * a replace made with it is refused if someone else changed the
 * resource in the meantime. Without one, it's a new resource.
 *
 * @param form
 * @param base the resource being edited, if any
 * @returns
 */
export function fromForm(form: WebApplicationForm, base?: WebApplication): WebApplication {
  const app: WebApplication = base
    ? copy(base)
    : {
        apiVersion: API_VERSION,
        kind: KIND,
        metadata: { name: form.name.trim(), namespace: form.namespace.trim() },
        spec: { image: { repository: "" } },
      };
  const spec: WebApplicationSpec = app.spec;

  spec.image = { ...spec.image, repository: form.repository.trim(), tag: nonEmpty(form.tag) ?? DEFAULT_TAG };
  spec.replicas = toInteger(form.replicas) ?? DEFAULT_REPLICAS;
  spec.port = toInteger(form.port) ?? DEFAULT_PORT;

  const env: EnvVar[] = [
    ...form.env.filter((row) => row.name.trim() !== "").map((row) => ({ name: row.name.trim(), value: row.value })),
    ...copy(form.preservedEnv),
  ];
  setOrDelete(spec, "env", env.length > 0 ? env : undefined);

  setOrDelete(spec, "resources", buildResources(form, spec.resources));

  const pullSecrets = splitList(form.imagePullSecrets);
  setOrDelete(spec, "imagePullSecrets", pullSecrets.length > 0 ? pullSecrets : undefined);

  const healthPath = nonEmpty(form.healthCheckPath);
  setOrDelete(spec, "healthCheck", healthPath !== undefined ? { ...spec.healthCheck, path: healthPath } : undefined);

  const hostnames = form.hostnames.map((hostname) => hostname.trim().toLowerCase()).filter((name) => name !== "");
  setOrDelete(spec, "hostnames", hostnames.length > 0 ? [...new Set(hostnames)] : undefined);

  setOrDelete(spec, "postgres", form.postgres ? (spec.postgres ?? {}) : undefined);
  setOrDelete(spec, "rabbitmq", form.rabbitmq ? (spec.rabbitmq ?? {}) : undefined);

  if (form.bucket) {
    const bucket = { ...spec.bucket };
    setOrDelete(bucket, "quota", nonEmpty(form.bucketQuota));
    spec.bucket = bucket;
  } else {
    delete spec.bucket;
  }

  if (form.migrations) {
    const args = splitLines(form.migrationArgs);
    const migrations = { ...spec.migrations, command: splitLines(form.migrationCommand) };
    setOrDelete(migrations, "args", args.length > 0 ? args : undefined);
    setOrDelete(migrations, "timeoutSeconds", toInteger(form.migrationTimeoutSeconds));
    spec.migrations = migrations;
  } else {
    delete spec.migrations;
  }

  if (form.gitlab) {
    spec.source = {
      ...spec.source,
      gitlab: {
        ...spec.source?.gitlab,
        url: nonEmpty(form.gitlabUrl) ?? DEFAULT_GITLAB_URL,
        project: form.gitlabProject.trim(),
        ref: nonEmpty(form.gitlabRef) ?? DEFAULT_GITLAB_REF,
        tokenSecret: {
          name: form.gitlabTokenSecretName.trim(),
          key: nonEmpty(form.gitlabTokenSecretKey) ?? DEFAULT_TOKEN_KEY,
        },
        imageTag: nonEmpty(form.gitlabImageTag) ?? DEFAULT_IMAGE_TAG,
      },
    };
  } else if (spec.source !== undefined) {
    delete spec.source.gitlab;
    if (Object.keys(spec.source).length === 0) {
      delete spec.source;
    }
  }

  return app;
}

// A Service is made with the application's name, and Service names
// are RFC 1035 labels: they have to start with a letter
const APP_NAME = /^[a-z]([-a-z0-9]*[a-z0-9])?$/;

// Secret names are DNS subdomains
const SECRET_NAME = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?(\.[a-z0-9]([-a-z0-9]*[a-z0-9])?)*$/;

// What Kubernetes accepts as an environment variable's name
const ENV_NAME = /^[-._a-zA-Z][-._a-zA-Z0-9]*$/;

// A hostname a Gateway listener takes: DNS labels, optionally with a
// wildcard first one
const HOSTNAME = /^(\*\.)?[a-z0-9]([-a-z0-9]*[a-z0-9])?(\.[a-z0-9]([-a-z0-9]*[a-z0-9])?)+$/;

// A Kubernetes quantity, near enough: a number and an optional suffix
const QUANTITY = /^\d+(\.\d+)?(m|k|M|G|T|P|E|Ki|Mi|Gi|Ti|Pi|Ei)?$/;

/**
 * What's wrong with the form, by field. Empty when nothing is.
 *
 * Only what can be known without asking the cluster. Whether the
 * namespace allows what's asked for is a warning rather than an error,
 * in warnings.ts, since it can be fixed after the fact.
 *
 * @param form
 * @returns
 */
export function validateForm(form: WebApplicationForm): Partial<Record<keyof WebApplicationForm, string>> {
  const errors: Partial<Record<keyof WebApplicationForm, string>> = {};
  const name = form.name.trim();

  if (form.namespace.trim() === "") {
    errors.namespace = "Choose a namespace.";
  }

  if (name === "") {
    errors.name = "Give the application a name.";
  } else if (name.length > 63 || !APP_NAME.test(name)) {
    errors.name = "Lower-case letters, digits and hyphens, starting with a letter and no longer than 63 characters.";
  }

  const repository = form.repository.trim();
  if (repository === "") {
    errors.repository = "Say which image to run.";
  } else if (/\s/.test(repository)) {
    errors.repository = "An image reference has no spaces in it.";
  } else if (repository.includes("@")) {
    errors.repository = "Leave the digest off; Cirrus pins releases by digest itself.";
  } else if ((repository.split("/").pop() ?? "").includes(":")) {
    errors.repository = "Leave the tag off here and put it in the tag field.";
  }

  const replicas = toInteger(form.replicas);
  if (replicas === undefined || replicas < 0) {
    errors.replicas = "A whole number, zero or more.";
  }

  const port = toInteger(form.port);
  if (port === undefined || port < 1 || port > 65535) {
    errors.port = "A port number, from 1 to 65535.";
  }

  if (form.healthCheckPath.trim() !== "" && !form.healthCheckPath.trim().startsWith("/")) {
    errors.healthCheckPath = "A path, starting with /.";
  }

  for (const field of ["cpuRequest", "memoryRequest", "cpuLimit", "memoryLimit", "bucketQuota"] as const) {
    const value = form[field].trim();
    if (value !== "" && !QUANTITY.test(value)) {
      errors[field] = "A Kubernetes quantity, such as 250m, 512Mi or 10Gi.";
    }
  }

  const badHost = form.hostnames
    .map((hostname) => hostname.trim().toLowerCase())
    .find((hostname) => hostname !== "" && (hostname.length > 253 || !HOSTNAME.test(hostname)));
  if (badHost !== undefined) {
    errors.hostnames = `${badHost} isn't a hostname. Use the full name, such as app.example.org.`;
  }

  const envNames = form.env.map((row) => row.name.trim()).filter((envName) => envName !== "");
  const badEnv = envNames.find((envName) => !ENV_NAME.test(envName));
  const repeated = envNames.find((envName, index) => envNames.indexOf(envName) !== index);
  if (badEnv !== undefined) {
    errors.env = `${badEnv} can't be an environment variable's name.`;
  } else if (repeated !== undefined) {
    errors.env = `${repeated} is set twice.`;
  } else if (form.env.some((row) => row.name.trim() === "" && row.value !== "")) {
    errors.env = "Every variable with a value needs a name.";
  }

  if (form.migrations) {
    if (splitLines(form.migrationCommand).length === 0) {
      errors.migrationCommand = "Give the command to run, one part per line.";
    }
    const timeout = form.migrationTimeoutSeconds.trim();
    if (timeout !== "" && (toInteger(timeout) ?? 0) < 1) {
      errors.migrationTimeoutSeconds = "A number of seconds, one or more.";
    }
  }

  if (form.gitlab) {
    const url = form.gitlabUrl.trim();
    if (url !== "" && !/^https?:\/\/[^\s/]+/.test(url)) {
      errors.gitlabUrl = "The GitLab instance's address, such as https://gitlab.com.";
    }
    if (form.gitlabProject.trim() === "") {
      errors.gitlabProject = "The project's path, such as group/app, or its numeric id.";
    }
    const secret = form.gitlabTokenSecretName.trim();
    if (secret === "") {
      errors.gitlabTokenSecretName = "Name the Secret holding the access token, or create one below.";
    } else if (secret.length > 253 || !SECRET_NAME.test(secret)) {
      errors.gitlabTokenSecretName = "Not a valid Secret name.";
    }
  }

  return errors;
}
