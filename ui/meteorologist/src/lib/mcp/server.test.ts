import { beforeEach, describe, expect, test } from "bun:test";

import { fixtureClient } from "../kube/fixtures";
import { INVALID_PARAMS, METHOD_NOT_FOUND, handleMessage, isWaitingCall } from "./server";
import type { ToolContext } from "./tools";

const context = async (): Promise<ToolContext> => ({
  kube: fixtureClient(),
  namespace: "team-shop",
  publicUrl: "https://meteorologist.example.org",
});

/**
 * Calls a tool, as an agent would.
 *
 * @param name
 * @param args
 * @returns the tool's result
 */
async function call(name: string, args: Record<string, unknown>) {
  const answer = await handleMessage(
    { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } },
    context,
  );
  return answer?.result as {
    isError?: boolean;
    content: Array<{ text: string }>;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- read field by field in each test
    structuredContent: Record<string, any>;
  };
}

beforeEach(() => {
  // A fresh cluster for each
  (globalThis as { __meteorologistFixtures?: unknown }).__meteorologistFixtures = undefined;
});

describe("the protocol", () => {
  test("starts with the version the client asked for, and the instructions", async () => {
    const answer = await handleMessage(
      { jsonrpc: "2.0", id: 0, method: "initialize", params: { protocolVersion: "2025-06-18" } },
      context,
    );
    expect(answer?.result).toMatchObject({ protocolVersion: "2025-06-18", capabilities: { tools: {} } });
    expect((answer?.result as { instructions: string }).instructions).toContain("technology.community-cloud.");
  });

  test("offers its newest version for one it doesn't know", async () => {
    const answer = await handleMessage(
      { jsonrpc: "2.0", id: 0, method: "initialize", params: { protocolVersion: "1999-01-01" } },
      context,
    );
    expect((answer?.result as { protocolVersion: string }).protocolVersion).toBe("2025-11-25");
  });

  test("doesn't answer a notification", async () => {
    expect(await handleMessage({ jsonrpc: "2.0", method: "notifications/initialized" }, context)).toBeUndefined();
  });

  test("lists create and update, and nothing that deletes", async () => {
    const answer = await handleMessage({ jsonrpc: "2.0", id: 2, method: "tools/list" }, context);
    const names = (answer?.result as { tools: Array<{ name: string }> }).tools.map((tool) => tool.name);
    expect(names).toEqual([
      "get_capabilities",
      "list_applications",
      "get_application",
      "create_application",
      "update_application",
      "wait_for_rollout",
    ]);
  });

  test("says when there's no such method or tool", async () => {
    expect((await handleMessage({ jsonrpc: "2.0", id: 3, method: "resources/list" }, context))?.error?.code).toBe(
      METHOD_NOT_FOUND,
    );
    expect(
      (
        await handleMessage(
          { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "delete_application" } },
          context,
        )
      )?.error?.code,
    ).toBe(INVALID_PARAMS);
  });
});

describe("the tools", () => {
  test("list the namespace's applications, and only its", async () => {
    const result = await call("list_applications", {});
    const names = result.structuredContent.applications.map((app: { name: string }) => app.name);
    expect(names).toContain("shop");
    expect(names).not.toContain("notes");
  });

  test("show an application with its labels, and Secrets by reference only", async () => {
    const app = (await call("get_application", { name: "shop" })).structuredContent;
    expect(app.dockerfileLabels).toContain('technology.community-cloud.postgres="true"');
    expect(app.env).toContainEqual({ name: "STRIPE_KEY", from: { secretKeyRef: { name: "shop-stripe", key: "key" } } });
    expect(app.page).toBe("https://meteorologist.example.org/apps/team-shop/shop");
  });

  test("create an application in the token's namespace", async () => {
    const result = await call("create_application", {
      name: "blog",
      image: { repository: "ghcr.io/acme/blog" },
      postgres: true,
    });
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent.dockerfileLabels).toBe('LABEL technology.community-cloud.postgres="true"');
    const made = await fixtureClient().getWebApplication("team-shop", "blog");
    expect(made.spec.postgres).toEqual({});
  });

  test("refuse hostnames rather than drop them", async () => {
    const result = await call("create_application", {
      name: "blog",
      image: { repository: "ghcr.io/acme/blog" },
      hostnames: ["blog.example.org"],
    });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("A person gives an application its hostnames");
  });

  test("refuse to create one that isn't valid, and make nothing", async () => {
    const before = (await fixtureClient().listWebApplications("team-shop")).length;
    const result = await call("create_application", { name: "Blog", image: { repository: "x:1" } });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("name:");
    expect(await fixtureClient().listWebApplications("team-shop")).toHaveLength(before);
  });

  test("update only what's asked, keeping its hostnames", async () => {
    const result = await call("update_application", { name: "shop", replicas: 3, rabbitmq: true });
    expect(result.isError).toBeUndefined();
    const app = await fixtureClient().getWebApplication("team-shop", "shop");
    expect(app.spec.replicas).toBe(3);
    expect(app.spec.rabbitmq).toEqual({});
    expect(app.spec.hostnames).toEqual(["shop.example.org"]);
    expect(app.spec.source?.gitlab?.imageTag).toBe("{commit_sha}");
  });

  test("say so when the application isn't there", async () => {
    const result = await call("update_application", { name: "nope", replicas: 1 });
    expect(result.isError).toBe(true);
  });
});

describe("waiting over the protocol", () => {
  test("sends progress with the client's token, then answers", async () => {
    const kube = fixtureClient();
    const ready = {
      ...(await kube.getWebApplication("team-shop", "shop")),
    };
    // As Cirrus would leave it: caught up and healthy
    ready.metadata.generation = 1;
    ready.status = {
      observedGeneration: 1,
      conditions: [
        { type: "Ready", status: "True", reason: "", message: "", lastTransitionTime: "2026-11-26T00:00:00Z" },
        { type: "Healthy", status: "True", reason: "", message: "", lastTransitionTime: "2026-11-26T00:00:00Z" },
      ],
    };
    const notes: unknown[] = [];
    const answer = await handleMessage(
      {
        jsonrpc: "2.0",
        id: 9,
        method: "tools/call",
        params: {
          name: "wait_for_rollout",
          arguments: { name: "shop", timeoutSeconds: 5 },
          _meta: { progressToken: "p1" },
        },
      },
      async () => ({
        kube: { ...kube, getWebApplication: async () => structuredClone(ready) },
        namespace: "team-shop",
        publicUrl: "https://meteorologist.example.org",
      }),
      { notify: (note) => notes.push(note) },
    );
    expect(notes).toEqual([
      {
        jsonrpc: "2.0",
        method: "notifications/progress",
        params: { progressToken: "p1", progress: 1, message: "Healthy" },
      },
    ]);
    expect((answer?.result as { structuredContent: { rollout: unknown } }).structuredContent.rollout).toMatchObject({
      finished: true,
      ok: true,
    });
  });

  test("sends no progress to a client that didn't ask", async () => {
    const notes: unknown[] = [];
    await handleMessage(
      {
        jsonrpc: "2.0",
        id: 10,
        method: "tools/call",
        params: { name: "wait_for_rollout", arguments: { name: "shop", timeoutSeconds: 1 } },
      },
      context,
      { notify: (note) => notes.push(note) },
    );
    expect(notes).toEqual([]);
  });

  test("knows which calls wait", () => {
    const call = (name: string, args: Record<string, unknown>) => ({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name, arguments: args },
    });
    expect(isWaitingCall(call("wait_for_rollout", { name: "shop" }))).toBe(true);
    expect(isWaitingCall(call("update_application", { name: "shop", wait: true }))).toBe(true);
    expect(isWaitingCall(call("update_application", { name: "shop" }))).toBe(false);
  });
});

test("creating with wait says it's still going when the time runs out", async () => {
  const result = await call("create_application", {
    name: "slow",
    image: { repository: "ghcr.io/acme/slow" },
    wait: true,
    timeoutSeconds: 1,
  });
  expect(result.structuredContent.created).toBe(true);
  expect(result.structuredContent.rollout).toMatchObject({ finished: false, timedOut: true });
  expect(result.structuredContent.rollout.next).toContain("wait_for_rollout");
});

describe("what the namespace can have", () => {
  test("is Cirrus's report", async () => {
    const result = await call("get_capabilities", {});
    expect(result.structuredContent).toMatchObject({ reported: true, services: { bucket: { available: false } } });
  });

  test("is said to be unknown where Cirrus hasn't reported", async () => {
    const answer = await handleMessage(
      { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "get_capabilities", arguments: {} } },
      async () => ({ ...(await context()), namespace: "sandbox" }),
    );
    expect((answer?.result as { structuredContent: { reported: boolean } }).structuredContent.reported).toBe(false);
  });

  test("leaves out of the tools what isn't available", async () => {
    const answer = await handleMessage({ jsonrpc: "2.0", id: 2, method: "tools/list" }, context);
    const create = (
      answer?.result as {
        tools: Array<{
          name: string;
          inputSchema: { properties: Record<string, { items?: { properties: { type: { enum: string[] } } } }> };
        }>;
      }
    ).tools.find((tool) => tool.name === "create_application")!;
    expect(create.inputSchema.properties.bucket).toBeUndefined();
    expect(create.inputSchema.properties.postgres).toBeDefined();
    expect(create.inputSchema.properties.volumes?.items?.properties.type.enum).toEqual(["fast", "sata", "ram"]);
  });

  test("refuses what isn't available, with Cirrus's reason, and makes nothing", async () => {
    const result = await call("create_application", {
      name: "files-two",
      image: { repository: "ghcr.io/acme/files" },
      bucket: true,
      volumes: [{ name: "data", mountPath: "/data", size: "1Gi", type: "hdd" }],
    });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("bucket isn't available here");
    expect(result.content[0]?.text).toContain("can't be hdd");
    await expect(fixtureClient().getWebApplication("team-shop", "files-two")).rejects.toThrow();
  });

  test("refuses a connection to an offering that isn't shared here", async () => {
    const result = await call("update_application", {
      name: "shop",
      connections: [{ offering: "mariadb", namespace: "cc-office" }],
    });
    expect(result.content[0]?.text).toContain("cc-office/mariadb isn't offered to this namespace");
  });

  test("holds nothing back where there's no report", async () => {
    const answer = await handleMessage(
      {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: {
          name: "create_application",
          arguments: { name: "pail", image: { repository: "ghcr.io/acme/pail" }, bucket: true },
        },
      },
      async () => ({ ...(await context()), namespace: "sandbox" }),
    );
    expect((answer?.result as { isError?: boolean }).isError).toBeUndefined();
  });
});

describe("migrations", () => {
  test("are explained: no shell, once per image, and what a failure leaves", async () => {
    const answer = await handleMessage({ jsonrpc: "2.0", id: 0, method: "initialize", params: {} }, context);
    const instructions = (answer?.result as { instructions: string }).instructions;
    expect(instructions).toContain("runs without a shell");
    expect(instructions).toContain("safe to run twice");
    expect(instructions).toContain("leaves the old version running");
  });

  test("name their Job on the application", async () => {
    const kube = fixtureClient();
    const shop = await kube.getWebApplication("team-shop", "shop");
    const answer = await handleMessage(
      { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "get_application", arguments: { name: "shop" } } },
      async () => ({
        ...(await context()),
        kube: {
          ...kube,
          getWebApplication: async () => ({ ...shop, status: { ...shop.status, migrationJob: "shop-migrate-abc" } }),
        },
      }),
    );
    expect((answer?.result as { structuredContent: { migrationJob?: string } }).structuredContent.migrationJob).toBe(
      "shop-migrate-abc",
    );
  });
});

test("volumes are explained: one node, how rollouts change, and what ram is", async () => {
  const answer = await handleMessage({ jsonrpc: "2.0", id: 0, method: "initialize", params: {} }, context);
  const instructions = (answer?.result as { instructions: string }).instructions;
  expect(instructions).toContain("How volumes work");
  expect(instructions).toContain("stopping the old copies before starting the new");
  expect(instructions).toContain("Migrations don't mount volumes");
});

describe("secrets and shared values", () => {
  test("an agent asks for a secret by name, and no value goes anywhere", async () => {
    const result = await call("update_application", {
      name: "shop",
      secrets: [{ name: "STRIPE_SECRET_KEY", description: "Stripe's secret key, from the dashboard" }],
    });
    expect(result.isError).toBeUndefined();
    const app = await fixtureClient().getWebApplication("team-shop", "shop");
    expect(app.spec.secrets).toEqual([
      { name: "STRIPE_SECRET_KEY", description: "Stripe's secret key, from the dashboard" },
    ]);
    expect(await fixtureClient().listSecretKeys("team-shop", "shop-secrets")).toBeUndefined();
    expect(result.structuredContent.secrets).toEqual([
      { name: "STRIPE_SECRET_KEY", description: "Stripe's secret key, from the dashboard", set: false },
    ]);
  });

  test("a later change isn't held up by a secret still waiting for its value", async () => {
    await call("update_application", { name: "shop", secrets: [{ name: "STRIPE_SECRET_KEY" }] });
    const result = await call("update_application", { name: "shop", replicas: 3 });
    expect(result.isError).toBeUndefined();
  });

  test("an agent can't give a secret a value through env", async () => {
    await call("update_application", { name: "shop", secrets: [{ name: "STRIPE_SECRET_KEY" }] });
    const result = await call("update_application", { name: "shop", env: { STRIPE_SECRET_KEY: "sk_live_x" } });
    expect(result.isError).toBe(true);
  });

  test("an agent uses a shared value the namespace has, and not one it hasn't", async () => {
    const used = await call("update_application", {
      name: "shop",
      shared: [{ name: "SENDGRID_API_KEY", as: "MAIL_KEY" }],
    });
    expect(used.isError).toBeUndefined();
    expect((await fixtureClient().getWebApplication("team-shop", "shop")).spec.shared).toEqual([
      { name: "SENDGRID_API_KEY", as: "MAIL_KEY" },
    ]);
    const unknown = await call("update_application", { name: "shop", shared: [{ name: "NOPE" }] });
    expect(unknown.content[0]?.text).toContain("shares no value called NOPE");
  });

  test("shared values are listed, secret ones without their value", async () => {
    const shared = (await call("get_capabilities", {})).structuredContent.shared;
    expect(shared).toContainEqual({ name: "SMTP_HOST", kind: "plain", value: "smtp.example.org" });
    expect(shared).toContainEqual({ name: "SENDGRID_API_KEY", kind: "secret" });
    expect(JSON.stringify(shared)).not.toContain("SG.fixture");
  });
});

test("a rollout waiting for a secret says which, for the agent to pass on", async () => {
  const kube = fixtureClient();
  const shop = await kube.getWebApplication("team-shop", "shop");
  const waiting = {
    ...shop,
    metadata: { ...shop.metadata, generation: 1 },
    status: {
      observedGeneration: 1,
      conditions: [
        {
          type: "Ready",
          status: "False" as const,
          reason: "",
          message: "",
          lastTransitionTime: "2026-11-26T00:00:00Z",
        },
        {
          type: "Provisioned",
          status: "False" as const,
          reason: "Blocked",
          message: "the secret STRIPE_SECRET_KEY has no value yet",
          lastTransitionTime: "2026-11-26T00:00:00Z",
        },
      ],
      environment: { secrets: [{ name: "STRIPE_SECRET_KEY", set: false }] },
    },
  };
  const answer = await handleMessage(
    {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "wait_for_rollout", arguments: { name: "shop", timeoutSeconds: 2 } },
    },
    async () => ({ ...(await context()), kube: { ...kube, getWebApplication: async () => structuredClone(waiting) } }),
  );
  const rollout = (answer?.result as { structuredContent: { rollout: { finished: boolean; next: string } } })
    .structuredContent.rollout;
  expect(rollout.finished).toBe(true);
  expect(rollout.next).toContain("the secret STRIPE_SECRET_KEY");
});

test("buckets are explained: path style, and which endpoint browsers can use", async () => {
  const answer = await handleMessage({ jsonrpc: "2.0", id: 0, method: "initialize", params: {} }, context);
  const instructions = (answer?.result as { instructions: string }).instructions;
  expect(instructions).toContain("How buckets work");
  expect(instructions).toContain("path-style addressing");
  expect(instructions).toContain("S3_PUBLIC_ENDPOINT");
});
