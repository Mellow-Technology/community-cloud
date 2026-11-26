/**
 * @file
 * The tools an agent is given over MCP, and what each one does.
 *
 * Each runs as the agent's token, in the one namespace that token
 * belongs to, so RBAC decides what it may do; the namespace is never
 * an argument. There are six for now: what the namespace can have
 * (./capabilities.ts), list and get, which an edit needs, create and
 * update, and waiting for a rollout, which create and update can also
 * do before they answer (./rollout.ts). What Cirrus says isn't
 * available is left out of create and update, and refused if asked
 * for anyway. Deleting
 * is a person's to do in Meteorologist, and so are hostnames (see
 * ./changes.ts for what else is held back, and why).
 *
 * Every answer about an application carries the Dockerfile LABEL for
 * what it needs (../webapp/labels.ts), for the agent to write into
 * the project, so what it found by reading the project's files is
 * kept with the image.
 */
import { KubeError, describeError, isNotFound, type KubeClient } from "../kube/client";
import { emptyForm, fromForm, toForm } from "../webapp/form";
import { appHealth } from "../webapp/health";
import { dockerfileLabels, needsOf } from "../webapp/labels";
import { appHref, specImage } from "../webapp/present";
import type { WebApplication } from "../webapp/types";
import { availableProperties, readCapabilities, unavailable, type Capabilities } from "./capabilities";
import { applyChanges, type ApplicationChanges } from "./changes";
import { DEFAULT_WAIT_SECONDS, MAX_WAIT_SECONDS, describeState, waitForRollout, type RolloutOutcome } from "./rollout";

/**
 * What a tool is run with: a client acting as the agent, its
 * namespace, and Meteorologist's address for links. A tool that waits
 * says how it's getting on through progress, when the client asked to
 * hear, and stops when signal says the client has gone.
 */
export interface ToolContext {
  kube: KubeClient;
  namespace: string;
  publicUrl: string;
  progress?: (message: string) => void;
  signal?: AbortSignal;
}

/**
 * A tool's answer: something to show, and the same as data. An error
 * is the tool saying it couldn't, for the agent to read and act on,
 * not a protocol failure.
 */
export interface ToolResult {
  content: Array<{ type: "text"; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

export interface Tool {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations: Record<string, boolean>;
  run(context: ToolContext, args: Record<string, unknown>): Promise<ToolResult>;
}

/**
 * A successful answer.
 *
 * @param data
 * @returns
 */
function answer(data: Record<string, unknown>): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }], structuredContent: data };
}

/**
 * An answer saying it couldn't, and why.
 *
 * @param message
 * @returns
 */
function refusal(message: string): ToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}

/**
 * An application as an agent is shown it: what it runs and asks for,
 * how it's doing, and the labels for its Dockerfile. Variables read
 * from Secrets are named, never read.
 *
 * @param app
 * @param publicUrl
 * @returns
 */
export function describeApplication(app: WebApplication, publicUrl: string): Record<string, unknown> {
  const spec = app.spec;
  const health = appHealth(app);
  return {
    name: app.metadata.name,
    image: specImage(app),
    runningImage: app.status?.deployedImage,
    health: health.label,
    healthMessage: health.message,
    url: app.status?.url,
    hostnames: spec.hostnames ?? [],
    replicas: spec.replicas,
    port: spec.port ?? app.status?.port,
    healthCheckPath: spec.healthCheck?.path,
    resources: spec.resources,
    postgres: spec.postgres !== undefined,
    rabbitmq: spec.rabbitmq !== undefined,
    bucket: spec.bucket,
    volumes: spec.volumes ?? [],
    connections: spec.connections ?? [],
    migrations: spec.migrations,
    // The newest image's migration Job, kept until the next image's
    // starts, so a person can be told where its logs are
    migrationJob: app.status?.migrationJob,
    env: (spec.env ?? []).map((variable) =>
      variable.valueFrom === undefined
        ? { name: variable.name, value: variable.value ?? "" }
        : { name: variable.name, from: variable.valueFrom },
    ),
    // Whether each has a value, as Cirrus last saw; never the value
    secrets: (spec.secrets ?? []).map((secret) => ({
      name: secret.name,
      ...(secret.description ? { description: secret.description } : {}),
      set: app.status?.environment?.secrets?.find((each) => each.name === secret.name)?.set ?? false,
    })),
    shared: (spec.shared ?? []).map((shared) => {
      const found = app.status?.environment?.shared?.find((each) => each.name === shared.name);
      return {
        name: shared.name,
        variable: shared.as ?? shared.name,
        set: found?.set ?? false,
        ...(found?.kind ? { kind: found.kind } : {}),
      };
    }),
    gitlab: spec.source?.gitlab && {
      project: spec.source.gitlab.project,
      connection: spec.source.gitlab.tokenSecret.name,
      url: spec.source.gitlab.url,
      ref: spec.source.gitlab.ref,
    },
    latestRelease: app.status?.release,
    conditions: (app.status?.conditions ?? []).map(({ type, status, reason, message }) => ({
      type,
      status,
      reason,
      message,
    })),
    // What the image's labels filled in that the spec leaves out
    detected: app.status?.detected?.applied ?? [],
    page: new URL(appHref(app), publicUrl).toString(),
    dockerfileLabels: dockerfileLabels(needsOf(spec)),
  };
}

// The fields create and update share, as JSON Schema
const CHANGES_PROPERTIES: Record<string, unknown> = {
  image: {
    type: "object",
    description:
      "The image to run, without a tag or digest in the repository. Changing it on a live application deploys it.",
    properties: { repository: { type: "string" }, tag: { type: "string", description: "Defaults to latest." } },
    required: ["repository"],
  },
  replicas: { type: "integer", minimum: 0 },
  port: {
    type: ["integer", "null"],
    description: "The port it listens on. Leave it out, or null, to use the image's EXPOSE.",
  },
  healthCheckPath: {
    type: ["string", "null"],
    description: "A path that answers 200 once it's ready, such as /up or /healthz. null removes it.",
  },
  resources: {
    type: "object",
    description: "Kubernetes quantities, such as 250m or 512Mi. null removes one.",
    properties: Object.fromEntries(
      ["cpuRequest", "memoryRequest", "cpuLimit", "memoryLimit"].map((field) => [field, { type: ["string", "null"] }]),
    ),
  },
  postgres: {
    type: "boolean",
    description:
      "true gives it a database of its own on the namespace's Postgres, with DATABASE_URL and PG* variables. Can't be turned off from here.",
  },
  rabbitmq: {
    type: "boolean",
    description: "true gives it a RabbitMQ vhost and user, with AMQP_URL. Can't be turned off from here.",
  },
  bucket: {
    type: ["boolean", "object"],
    description:
      "true, or { quota }, gives it an S3 bucket with S3_* and AWS_* variables. Can't be turned off from here.",
    properties: { quota: { type: "string", description: "Such as 10Gi." } },
  },
  migrations: {
    type: ["object", "null"],
    description:
      "A command run as a Job with each new image, the first one included, before the image is rolled out; the old version keeps serving until it succeeds. It runs once per image, so it must be safe to run again, and must leave the schema usable by the image still running. null stops running one. See the server's instructions on migrations.",
    properties: {
      command: {
        type: "array",
        items: { type: "string" },
        description:
          'Replaces the image\'s entrypoint and runs without a shell: ["bin/rails", "db:migrate"], not ["bin/rails db:migrate"]. For &&, pipes or $VARIABLES, use ["/bin/sh", "-c", "..."].',
      },
      args: { type: "array", items: { type: "string" } },
      timeoutSeconds: {
        type: "integer",
        minimum: 1,
        description: "How long it may run before it counts as failed: 1800 (30 minutes) unless said.",
      },
    },
    required: ["command"],
  },
  env: {
    type: "object",
    description:
      "Plain environment variables by name: a string sets one, null removes it. Anyone who can see the application can read these, so never put secrets here: ask for them in secrets.",
    additionalProperties: { type: ["string", "null"] },
  },
  secrets: {
    type: "array",
    description:
      "Secrets it needs, such as API keys, added to those it has: a name and what it is, never a value. A person sets the value in Meteorologist, and the application isn't rolled out until each has one. Each is set as a variable of its name.",
    items: {
      type: "object",
      properties: {
        name: { type: "string", description: "The variable's name, such as STRIPE_SECRET_KEY." },
        description: {
          type: "string",
          description:
            "What it is and where to get it, for the person setting it: \"Stripe's secret key, from the dashboard's API keys page\".",
        },
      },
      required: ["name"],
    },
  },
  shared: {
    type: "array",
    description:
      "The namespace's shared values it reads, added to those it reads: get_capabilities lists them, plain ones with their values and secret ones by name. Each is set as a variable of its name, or of as.",
    items: {
      type: "object",
      properties: {
        name: { type: "string" },
        as: { type: "string", description: "The variable to set it as, when the application expects another name." },
      },
      required: ["name"],
    },
  },
  volumes: {
    type: "array",
    description:
      "Volumes to add. A disk volume (fast, the default, on NVMe; sata; hdd) is one claim on one node, shared by every copy, which ties the application to that node and makes rollouts stop the old copies before starting the new. ram is a RAM disk per pod, emptied on restart, counted as memory. Migrations don't mount volumes. Existing ones can't be changed or removed from here. See the server's instructions on volumes.",
    items: {
      type: "object",
      properties: {
        name: { type: "string" },
        mountPath: { type: "string" },
        size: { type: "string", description: "Such as 10Gi." },
        type: { type: "string", enum: ["fast", "sata", "hdd", "ram"] },
      },
      required: ["name", "mountPath", "size"],
    },
  },
  connections: {
    type: "array",
    description:
      "ServiceOfferings to connect to, added to those it has. Its variables start with the name, or the offering's name.",
    items: {
      type: "object",
      properties: {
        offering: { type: "string" },
        namespace: { type: "string", description: "Where the offering is, when it isn't this namespace." },
        name: { type: "string" },
      },
      required: ["offering"],
    },
  },
  gitlab: {
    type: "object",
    description:
      "Roll out each image the project's pipelines build. connection is the namespace's GitLab connection, as another application's gitlab.connection shows, or ask a person.",
    properties: {
      project: { type: "string", description: "Its path, such as group/project." },
      connection: { type: "string" },
      url: { type: "string", description: "The GitLab instance; defaults to https://gitlab.com." },
      ref: { type: "string", description: "The branch; defaults to main." },
    },
    required: ["project", "connection"],
  },
};

/**
 * Reads an application, or nothing when there's no such thing.
 *
 * @param context
 * @param name
 * @returns
 */
async function find(context: ToolContext, name: string): Promise<WebApplication | undefined> {
  try {
    return await context.kube.getWebApplication(context.namespace, name);
  } catch (error) {
    if (isNotFound(error)) return undefined;
    throw error;
  }
}

/**
 * The name argument, or nothing if it's missing.
 *
 * @param args
 * @returns
 */
function nameFrom(args: Record<string, unknown>): string | undefined {
  return typeof args.name === "string" && args.name.trim() !== "" ? args.name.trim() : undefined;
}

/**
 * The changes in a tool's arguments: everything but the name.
 *
 * @param args
 * @returns the changes, or why they can't be made: an argument that
 *   isn't one of the fields, such as hostnames, is refused rather than
 *   quietly dropped
 */
function changesFrom(args: Record<string, unknown>): ApplicationChanges | string {
  const { name: _name, wait: _wait, timeoutSeconds: _timeout, ...changes } = args;
  const unknown = Object.keys(changes).filter((field) => !(field in CHANGES_PROPERTIES));
  if (unknown.length > 0) {
    return `${unknown.join(", ")} can't be set from here.${unknown.includes("hostnames") ? " A person gives an application its hostnames in Meteorologist." : ""}`;
  }
  return changes as ApplicationChanges;
}

// Arguments about waiting, which create and update take beside the
// fields
const WAIT_PROPERTIES: Record<string, unknown> = {
  wait: {
    type: "boolean",
    description:
      "true waits for Cirrus to roll it out before answering, with progress as it goes, as wait_for_rollout does.",
  },
  timeoutSeconds: {
    type: "integer",
    minimum: 1,
    maximum: MAX_WAIT_SECONDS,
    description: `How long to wait, ${DEFAULT_WAIT_SECONDS} seconds unless said. If it runs out, call wait_for_rollout.`,
  },
};

/**
 * How long to wait, from a tool's arguments.
 *
 * @param args
 * @returns
 */
function waitSeconds(args: Record<string, unknown>): number {
  const asked = typeof args.timeoutSeconds === "number" ? Math.floor(args.timeoutSeconds) : DEFAULT_WAIT_SECONDS;
  return Math.min(Math.max(asked, 1), MAX_WAIT_SECONDS);
}

/**
 * Waits for an application's rollout, saying how it's going.
 *
 * @param context
 * @param name
 * @param timeoutSeconds
 * @param generation the change to wait for
 * @returns
 */
async function waitFor(
  context: ToolContext,
  name: string,
  timeoutSeconds: number,
  generation?: number,
): Promise<RolloutOutcome> {
  return waitForRollout(context.kube, context.namespace, name, {
    generation,
    timeoutSeconds,
    onProgress: context.progress,
    signal: context.signal,
  });
}

/**
 * What a wait found, for the answer: whether it's done, and what to
 * do next if it isn't.
 *
 * @param outcome
 * @returns
 */
/**
 * The secrets and shared values an application is waiting for.
 *
 * @param app
 * @returns
 */
function unsetValues(app: WebApplication): string[] {
  const environment = app.status?.environment;
  return [
    ...(environment?.secrets ?? []).filter((each) => !each.set).map((each) => `the secret ${each.name}`),
    ...(environment?.shared ?? []).filter((each) => !each.set).map((each) => `the shared value ${each.name}`),
  ];
}

function rolloutSummary(outcome: RolloutOutcome): Record<string, unknown> {
  const migrationJob = outcome.app.status?.migrationJob;
  let next: string | undefined;
  if (outcome.timedOut) {
    next = "It's still going. Call wait_for_rollout to keep waiting.";
  } else if (!outcome.ok && outcome.health.state === "failing" && unsetValues(outcome.app).length > 0) {
    const waiting = unsetValues(outcome.app);
    next = `It's waiting for ${waiting.join(", ")}. Ask a person to set ${waiting.length === 1 ? "it" : "them"} in Meteorologist: secrets on the application's page (page, in this answer), shared values on the namespace's Environment tab. Then call wait_for_rollout.`;
  } else if (!outcome.ok && outcome.health.state === "failing") {
    next = migrationJob
      ? `Its migration Job is ${migrationJob}, and it won't run again for this image. A person can read its logs, or delete it to run it again; or fix it and roll out a new image.`
      : "Fix what the message says, then update the application to try again.";
  }
  return {
    finished: outcome.finished,
    ok: outcome.ok,
    timedOut: outcome.timedOut,
    state: describeState(outcome),
    waitedSeconds: outcome.waitedSeconds,
    ...(next ? { next } : {}),
  };
}

// How many times an update starts again when someone else wrote the
// application between its read and its write
const UPDATE_ATTEMPTS = 3;

/**
 * What an application already has, which asking for again isn't
 * asking for anything new.
 *
 * @param app
 * @param namespace its own
 * @returns
 */
function existing(
  app: WebApplication,
  namespace: string,
): { services: ReadonlySet<string>; connections: ReadonlySet<string> } {
  const services = new Set<string>();
  if (app.spec.postgres !== undefined) services.add("postgres");
  if (app.spec.rabbitmq !== undefined) services.add("rabbitmq");
  if (app.spec.bucket !== undefined) services.add("bucket");
  const connections = new Set(
    (app.spec.connections ?? []).map((each) => `${each.namespace ?? namespace}/${each.offering}`),
  );
  return { services, connections };
}

export const TOOLS: Tool[] = [
  {
    name: "get_capabilities",
    title: "What this namespace can have",
    description:
      "What Cirrus can give applications here, which differs between installs and namespaces: Postgres, RabbitMQ and buckets, each available or not and why; the storage types for volumes; whether applications can have public hostnames; whether network policies limit what they can reach; and the services they can connect to. Read it before creating an application.",
    inputSchema: { type: "object", properties: {} },
    annotations: { readOnlyHint: true, openWorldHint: false },
    run: async (context) => {
      const capabilities = await readCapabilities(context.kube, context.namespace);
      if (capabilities === undefined) {
        return answer({
          namespace: context.namespace,
          reported: false,
          note: "Cirrus hasn't reported what's available here, so nothing is held back; if something isn't, the application's Provisioned condition will say so.",
        });
      }
      return answer({ reported: true, ...capabilities });
    },
  },
  {
    name: "list_applications",
    title: "List applications",
    description: "The web applications in this namespace, with what each runs and how it's doing.",
    inputSchema: { type: "object", properties: {} },
    annotations: { readOnlyHint: true, openWorldHint: false },
    run: async (context) => {
      const apps = await context.kube.listWebApplications(context.namespace);
      return answer({
        namespace: context.namespace,
        applications: apps.map((app) => ({
          name: app.metadata.name,
          image: specImage(app),
          health: appHealth(app).label,
          url: app.status?.url,
          gitlab: app.spec.source?.gitlab && {
            project: app.spec.source.gitlab.project,
            connection: app.spec.source.gitlab.tokenSecret.name,
          },
        })),
      });
    },
  },
  {
    name: "get_application",
    title: "Get an application",
    description:
      "One web application: its settings, health, Cirrus's conditions, the latest release, and the Dockerfile LABEL for what it needs.",
    inputSchema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
    annotations: { readOnlyHint: true, openWorldHint: false },
    run: async (context, args) => {
      const name = nameFrom(args);
      if (name === undefined) return refusal("Say which application, by name.");
      const app = await find(context, name);
      return app === undefined
        ? refusal(`There's no application called ${name} in ${context.namespace}.`)
        : answer(describeApplication(app, context.publicUrl));
    },
  },
  {
    name: "create_application",
    title: "Create an application",
    description:
      "Makes a web application, which Cirrus deploys with what it asks for. Work out what it needs from the project first (see the server's instructions). It has no hostname, so it's only reachable inside the cluster until a person gives it one in Meteorologist.",
    inputSchema: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description: "Lower-case letters, digits and hyphens, starting with a letter. Its Service has this name.",
        },
        ...CHANGES_PROPERTIES,
        ...WAIT_PROPERTIES,
      },
      required: ["name", "image"],
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    run: async (context, args) => {
      const name = nameFrom(args);
      if (name === undefined) return refusal("Give the application a name.");
      const changes = changesFrom(args);
      if (typeof changes === "string") return refusal(changes);
      if (changes.image === undefined) return refusal("Say which image it runs.");
      const capabilities = await readCapabilities(context.kube, context.namespace);
      const { form, problems: invalid } = applyChanges(
        { ...emptyForm(context.namespace), name, imageSource: "other" },
        changes,
      );
      const problems = [
        ...unavailable(changes, capabilities, { services: new Set(), connections: new Set() }),
        ...invalid,
      ];
      if (problems.length > 0) return refusal(`Nothing was made:\n- ${problems.join("\n- ")}`);
      const created = await context.kube.createWebApplication(fromForm(form));
      if (args.wait !== true) {
        return answer({ created: true, ...describeApplication(created, context.publicUrl) });
      }
      const outcome = await waitFor(context, name, waitSeconds(args), created.metadata.generation);
      return answer({
        created: true,
        rollout: rolloutSummary(outcome),
        ...describeApplication(outcome.app, context.publicUrl),
      });
    },
  },
  {
    name: "update_application",
    title: "Update an application",
    description:
      "Changes the fields given, and only those; everything else stays as it is. Hostnames aren't changed here, and services, volumes and Secret-backed variables can't be taken away.",
    inputSchema: {
      type: "object",
      properties: { name: { type: "string" }, ...CHANGES_PROPERTIES, ...WAIT_PROPERTIES },
      required: ["name"],
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    run: async (context, args) => {
      const name = nameFrom(args);
      if (name === undefined) return refusal("Say which application, by name.");
      const changes = changesFrom(args);
      if (typeof changes === "string") return refusal(changes);
      const capabilities = await readCapabilities(context.kube, context.namespace);
      for (let attempt = 1; ; attempt += 1) {
        const current = await find(context, name);
        if (current === undefined) return refusal(`There's no application called ${name} in ${context.namespace}.`);
        const { form, problems: invalid } = applyChanges(toForm(current), changes);
        const problems = [...unavailable(changes, capabilities, existing(current, context.namespace)), ...invalid];
        if (problems.length > 0) return refusal(`Nothing was changed:\n- ${problems.join("\n- ")}`);
        try {
          // Over the resource as it was read, so its resourceVersion
          // makes the write fail if anyone changed it since
          const saved = await context.kube.replaceWebApplication(fromForm(form, current));
          if (args.wait !== true) {
            return answer({ updated: true, ...describeApplication(saved, context.publicUrl) });
          }
          const outcome = await waitFor(context, name, waitSeconds(args), saved.metadata.generation);
          return answer({
            updated: true,
            rollout: rolloutSummary(outcome),
            ...describeApplication(outcome.app, context.publicUrl),
          });
        } catch (error) {
          const conflict = error instanceof KubeError && error.status === 409;
          if (!conflict || attempt >= UPDATE_ATTEMPTS) throw error;
        }
      }
    },
  },
  {
    name: "wait_for_rollout",
    title: "Wait for a rollout",
    description: `Waits until Cirrus has rolled out the application's latest change and it's healthy, or it fails, or the time runs out (${DEFAULT_WAIT_SECONDS} seconds unless said, at most ${MAX_WAIT_SECONDS}), with progress as it goes: provisioning, migrating, rolling out. If the time runs out it's still going; call this again.`,
    inputSchema: {
      type: "object",
      properties: { name: { type: "string" }, timeoutSeconds: WAIT_PROPERTIES.timeoutSeconds },
      required: ["name"],
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
    run: async (context, args) => {
      const name = nameFrom(args);
      if (name === undefined) return refusal("Say which application, by name.");
      const current = await find(context, name);
      if (current === undefined) return refusal(`There's no application called ${name} in ${context.namespace}.`);
      const outcome = await waitFor(context, name, waitSeconds(args), current.metadata.generation);
      return answer({ rollout: rolloutSummary(outcome), ...describeApplication(outcome.app, context.publicUrl) });
    },
  },
];

/**
 * The tools as a client is shown them: create and update without what
 * the namespace can't have.
 *
 * @param capabilities
 * @returns
 */
export function listTools(capabilities: Capabilities | undefined) {
  return TOOLS.map(({ name, title, description, inputSchema, annotations }) => ({
    name,
    title,
    description,
    inputSchema:
      name === "create_application" || name === "update_application"
        ? {
            ...inputSchema,
            properties: availableProperties(inputSchema.properties as Record<string, unknown>, capabilities),
          }
        : inputSchema,
    annotations,
  }));
}

/**
 * Whether a call will wait, and so should be answered as a stream: a
 * quiet connection held open for minutes is one a proxy may close.
 *
 * @param name
 * @param args
 * @returns
 */
export function waits(name: string, args: Record<string, unknown>): boolean {
  return name === "wait_for_rollout" || args.wait === true;
}

/**
 * Runs a tool by name, turning a failure into an answer the agent can
 * read.
 *
 * @param context
 * @param name
 * @param args
 * @returns nothing when there's no such tool
 */
export async function callTool(
  context: ToolContext,
  name: string,
  args: Record<string, unknown>,
): Promise<ToolResult | undefined> {
  const tool = TOOLS.find((each) => each.name === name);
  if (tool === undefined) return undefined;
  try {
    return await tool.run(context, args);
  } catch (error) {
    return refusal(describeError(error));
  }
}
