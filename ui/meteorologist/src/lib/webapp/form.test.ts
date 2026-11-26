import { describe, expect, test } from "bun:test";

import { emptyForm, fromForm, soleConnection, splitList, toForm, validateForm, type WebApplicationForm } from "./form";
import type { WebApplication } from "./types";

/**
 * A form for a typical new application.
 *
 * @param changes
 * @returns
 */
function form(changes: Partial<WebApplicationForm> = {}): WebApplicationForm {
  return { ...emptyForm("team"), name: "shop", repository: "registry.gitlab.com/acme/shop", ...changes };
}

// An application using everything, as someone might have written it
const full: WebApplication = {
  apiVersion: "community-cloud.technology/v1alpha1",
  kind: "WebApplication",
  metadata: { name: "shop", namespace: "team", resourceVersion: "42", generation: 3, labels: { tier: "web" } },
  spec: {
    image: { repository: "registry.gitlab.com/acme/shop", tag: "main" },
    replicas: 2,
    port: 3000,
    env: [
      { name: "NODE_ENV", value: "production" },
      { name: "STRIPE_KEY", valueFrom: { secretKeyRef: { name: "stripe", key: "key" } } },
    ],
    resources: {
      requests: { cpu: "100m", memory: "256Mi", "ephemeral-storage": "1Gi" },
      limits: { memory: "512Mi" },
    },
    imagePullSecrets: ["registry"],
    healthCheck: { path: "/healthz" },
    hostnames: ["shop.example.org"],
    postgres: {},
    bucket: { quota: "10Gi" },
    rabbitmq: {},
    migrations: { command: ["npm", "run", "migrate"], args: ["--verbose"], timeoutSeconds: 600 },
    source: {
      gitlab: {
        url: "https://gitlab.example.org",
        project: "acme/shop",
        ref: "release",
        tokenSecret: { name: "shop-token", key: "pat" },
        imageTag: "{short_sha}",
      },
    },
  },
  status: { deployedImage: "registry.gitlab.com/acme/shop@sha256:1" },
};

describe("a new application from the form", () => {
  test("has only what was asked for", () => {
    const app = fromForm(form());
    expect(app).toEqual({
      apiVersion: "community-cloud.technology/v1alpha1",
      kind: "WebApplication",
      metadata: { name: "shop", namespace: "team" },
      // No port: Cirrus reads it from the image
      spec: { image: { repository: "registry.gitlab.com/acme/shop", tag: "latest" }, replicas: 1 },
    });
  });

  test("keeps a port that was typed in", () => {
    expect(fromForm(form({ port: "3000" })).spec.port).toBe(3000);
  });

  test("drops the port when it's cleared, so the image's is used", () => {
    const withPort = fromForm(form({ port: "3000" }));
    expect(fromForm(form({ port: "" }), withPort).spec.port).toBeUndefined();
  });

  test("asks for a service with an empty block", () => {
    const spec = fromForm(form({ postgres: true, rabbitmq: true, bucket: true })).spec;
    expect(spec.postgres).toEqual({});
    expect(spec.rabbitmq).toEqual({});
    expect(spec.bucket).toEqual({});
  });

  test("gives the bucket its quota", () => {
    expect(fromForm(form({ bucket: true, bucketQuota: " 5Gi " })).spec.bucket).toEqual({ quota: "5Gi" });
  });

  test("turns lines into the migration command", () => {
    const spec = fromForm(
      form({ migrations: true, migrationCommand: "npm\n\nrun\nmigrate\n", migrationTimeoutSeconds: "60" }),
    ).spec;
    expect(spec.migrations).toEqual({ command: ["npm", "run", "migrate"], timeoutSeconds: 60 });
  });

  test("fills the GitLab defaults in", () => {
    const spec = fromForm(
      form({ gitlab: true, gitlabProject: "acme/shop", gitlabTokenSecretName: "token", gitlabUrl: "", gitlabRef: "" }),
    ).spec;
    expect(spec.source?.gitlab).toEqual({
      url: "https://gitlab.com",
      project: "acme/shop",
      ref: "main",
      tokenSecret: { name: "token", key: "token" },
    });
  });

  test("leaves the image tag out for Cirrus to find, and clears one emptied", () => {
    const app: WebApplication = {
      apiVersion: "community-cloud.technology/v1alpha1",
      kind: "WebApplication",
      metadata: { name: "shop", namespace: "team" },
      spec: {
        image: { repository: "registry.gitlab.com/acme/shop" },
        source: {
          gitlab: { project: "acme/shop", tokenSecret: { name: "token" }, imageTag: "{commit_sha}" },
        },
      },
    };
    const existing = toForm(app);
    expect(existing.gitlabImageTag).toBe("{commit_sha}");
    const cleared = fromForm({ ...existing, gitlabImageTag: " " }, app).spec.source?.gitlab;
    expect(cleared).not.toHaveProperty("imageTag");
    expect(cleared).not.toHaveProperty("findImageByPushTime");

    const byTime = fromForm({ ...existing, gitlabImageTag: "", gitlabFindByPushTime: true }, app).spec.source?.gitlab;
    expect(byTime?.findImageByPushTime).toBe(true);
  });

  test("tidies hostnames, environment and pull secrets", () => {
    const spec = fromForm(
      form({
        hostnames: ["Shop.Example.org", "", "shop.example.org"],
        env: [
          { name: " LOG_LEVEL ", value: "info" },
          { name: "", value: "" },
        ],
        imagePullSecrets: "one, two three",
      }),
    ).spec;
    expect(spec.hostnames).toEqual(["shop.example.org"]);
    expect(spec.env).toEqual([{ name: "LOG_LEVEL", value: "info" }]);
    expect(spec.imagePullSecrets).toEqual(["one", "two", "three"]);
  });
});

describe("an existing application through the form", () => {
  test("reads every field", () => {
    const read = toForm(full);
    expect(read).toMatchObject({
      namespace: "team",
      name: "shop",
      tag: "main",
      replicas: "2",
      port: "3000",
      imagePullSecrets: "registry",
      cpuRequest: "100m",
      memoryLimit: "512Mi",
      hostnames: ["shop.example.org"],
      postgres: true,
      bucket: true,
      bucketQuota: "10Gi",
      rabbitmq: true,
      migrationCommand: "npm\nrun\nmigrate",
      migrationArgs: "--verbose",
      migrationTimeoutSeconds: "600",
      gitlab: true,
      gitlabRef: "release",
      gitlabTokenSecretKey: "pat",
      gitlabImageTag: "{short_sha}",
      env: [{ name: "NODE_ENV", value: "production" }],
    });
    expect(read.preservedEnv).toEqual([full.spec.env![1]!]);
  });

  test("comes back unchanged when nothing is edited", () => {
    const back = fromForm(toForm(full), full);
    expect(back.spec).toEqual(full.spec);
    expect(back.metadata).toEqual(full.metadata);
  });

  test("doesn't change what it was given", () => {
    const before = structuredClone(full);
    fromForm({ ...toForm(full), postgres: false, cpuRequest: "" }, full);
    expect(full).toEqual(before);
  });

  test("keeps resources the form doesn't show", () => {
    const spec = fromForm({ ...toForm(full), cpuRequest: "", memoryRequest: "", memoryLimit: "" }, full).spec;
    expect(spec.resources).toEqual({ requests: { "ephemeral-storage": "1Gi" } });
  });

  test("drops what's switched off", () => {
    const spec = fromForm(
      {
        ...toForm(full),
        postgres: false,
        bucket: false,
        rabbitmq: false,
        migrations: false,
        gitlab: false,
        hostnames: [],
      },
      full,
    ).spec;
    for (const key of ["postgres", "bucket", "rabbitmq", "migrations", "source", "hostnames"] as const) {
      expect(spec).not.toHaveProperty(key);
    }
  });

  test("keeps the version, so a stale edit is refused", () => {
    expect(fromForm(toForm(full), full).metadata.resourceVersion).toBe("42");
  });

  test("fills in defaults the resource left out", () => {
    const sparse: WebApplication = {
      ...full,
      spec: { image: { repository: "nginx" } },
    };
    expect(toForm(sparse)).toMatchObject({ tag: "latest", replicas: "1", port: "", gitlab: false });
  });
});

describe("validation", () => {
  test("passes a sensible form", () => {
    expect(validateForm(form())).toEqual({});
  });

  test("wants a name a Service can have", () => {
    expect(validateForm(form({ name: "" })).name).toBeDefined();
    expect(validateForm(form({ name: "1shop" })).name).toBeDefined();
    expect(validateForm(form({ name: "Shop" })).name).toBeDefined();
    expect(validateForm(form({ name: "a".repeat(64) })).name).toBeDefined();
    expect(validateForm(form({ name: "my-shop2" })).name).toBeUndefined();
  });

  test("keeps the tag out of the image", () => {
    expect(validateForm(form({ repository: "nginx:1.27" })).repository).toContain("tag");
    expect(validateForm(form({ repository: "nginx@sha256:abc" })).repository).toContain("digest");
    expect(validateForm(form({ repository: "registry.local:5000/acme/shop" })).repository).toBeUndefined();
  });

  test("checks numbers", () => {
    expect(validateForm(form({ replicas: "two" })).replicas).toBeDefined();
    expect(validateForm(form({ replicas: "0" })).replicas).toBeUndefined();
    expect(validateForm(form({ port: "70000" })).port).toBeDefined();
    expect(validateForm(form({ port: "0" })).port).toBeDefined();
    expect(validateForm(form({ port: "" })).port, "blank reads it from the image").toBeUndefined();
  });

  test("checks quantities and paths", () => {
    expect(validateForm(form({ memoryLimit: "lots" })).memoryLimit).toBeDefined();
    expect(validateForm(form({ cpuRequest: "250m", memoryRequest: "1.5Gi" }))).toEqual({});
    expect(validateForm(form({ healthCheckPath: "healthz" })).healthCheckPath).toBeDefined();
  });

  test("checks hostnames", () => {
    expect(validateForm(form({ hostnames: ["shop"] })).hostnames).toContain("shop");
    expect(validateForm(form({ hostnames: ["*.shop.example.org", "Shop.example.org"] })).hostnames).toBeUndefined();
  });

  test("checks environment variables", () => {
    expect(validateForm(form({ env: [{ name: "1 BAD", value: "" }] })).env).toBeDefined();
    expect(
      validateForm(
        form({
          env: [
            { name: "A", value: "1" },
            { name: "A", value: "2" },
          ],
        }),
      ).env,
    ).toContain("twice");
    expect(validateForm(form({ env: [{ name: "", value: "orphan" }] })).env).toBeDefined();
  });

  test("only checks sections that are switched on", () => {
    expect(validateForm(form({ migrations: false, gitlab: false }))).toEqual({});
    const errors = validateForm(form({ migrations: true, gitlab: true }));
    expect(errors.migrationCommand).toBeDefined();
    expect(errors.gitlabProject).toBeDefined();
    expect(errors.gitlabTokenSecretName).toBeDefined();
  });
});

test("splitList takes commas and spaces", () => {
  expect(splitList(" a,b  c,, ")).toEqual(["a", "b", "c"]);
});

describe("an image from elsewhere", () => {
  test("never updates itself, whatever the switch says", () => {
    const app = fromForm(
      form({ imageSource: "other", gitlab: true, gitlabProject: "acme/shop", gitlabTokenSecretName: "token" }),
    );
    expect(app.spec.source).toBeUndefined();
    expect(validateForm(form({ imageSource: "other", gitlab: true }))).toEqual({});
  });

  test("is what an application without a source is read back as", () => {
    const sparse = fromForm(form({ imageSource: "other" }));
    expect(toForm(sparse).imageSource).toBe("other");
    const updating = fromForm(form({ gitlab: true, gitlabProject: "acme/shop", gitlabTokenSecretName: "token" }));
    expect(toForm(updating).imageSource).toBe("gitlab");
  });
});

test("a namespace's only connection is chosen for you", () => {
  const work = { name: "work", url: "https://gitlab.example.test" };
  expect(soleConnection({ gitlabConnections: [work] })).toMatchObject({
    gitlabTokenSecretName: "work",
    gitlabUrl: "https://gitlab.example.test",
  });
  expect(soleConnection({ gitlabConnections: [work, { ...work, name: "other" }] }).gitlabTokenSecretName).toBe("");
  expect(soleConnection(undefined).gitlabTokenSecretName).toBe("");
});

describe("volumes", () => {
  const rows = [
    { name: "uploads", mountPath: "/app/uploads", size: "200Gi", type: "hdd" as const },
    { name: "cache", mountPath: "/app/cache", size: "10Gi", type: "fast" as const },
  ];

  test("are written with fast left out, as it's Cirrus's default, and blank rows dropped", () => {
    const app = fromForm(form({ volumes: [...rows, { name: "", mountPath: "", size: "", type: "fast" }] }));
    expect(app.spec.volumes).toEqual([
      { name: "uploads", mountPath: "/app/uploads", size: "200Gi", type: "hdd" },
      { name: "cache", mountPath: "/app/cache", size: "10Gi" },
    ]);
    expect(fromForm(form()).spec.volumes).toBeUndefined();
  });

  test("come back as they were", () => {
    const app = fromForm(form({ volumes: rows }));
    expect(toForm(app).volumes).toEqual(rows);
  });

  test("include a RAM disk, written as type ram", () => {
    const ram = { name: "scratch", mountPath: "/tmp/scratch", size: "512Mi", type: "ram" as const };
    const app = fromForm(form({ volumes: [ram] }));
    expect(app.spec.volumes).toEqual([ram]);
    expect(toForm(app).volumes).toEqual([ram]);
    expect(validateForm(form({ volumes: [ram] })).volumes).toBeUndefined();
  });

  test("are checked as Cirrus checks them", () => {
    expect(validateForm(form({ volumes: rows })).volumes).toBeUndefined();
    const bad = (row: Partial<(typeof rows)[number]>) =>
      validateForm(form({ volumes: [{ ...rows[0]!, ...row }] })).volumes;
    expect(bad({ name: "Uploads" })).toContain("lower-case");
    expect(bad({ mountPath: "uploads" })).toContain("absolute path");
    expect(bad({ mountPath: "/" })).toContain("absolute path");
    expect(bad({ size: "lots" })).toContain("size");
    expect(bad({ size: "" })).toContain("size");
    expect(
      validateForm(form({ volumes: [rows[0]!, { ...rows[1]!, mountPath: "/app/uploads/thumbs" }] })).volumes,
    ).toContain("overlaps");
    expect(validateForm(form({ volumes: [rows[0]!, { ...rows[1]!, name: "uploads" }] })).volumes).toContain(
      "two volumes",
    );
  });
});

describe("connections and offers", () => {
  test("connections leave out their namespace when it's the app's, and a name that's the offering's", () => {
    const app = fromForm(
      form({
        serviceConnections: [
          { offering: "cache", namespace: "cc-office", name: "" },
          { offering: "search", namespace: "team", name: "search" },
          { offering: "", namespace: "", name: "" },
        ],
      }),
    );
    expect(app.spec.connections).toEqual([{ offering: "cache", namespace: "cc-office" }, { offering: "search" }]);
    expect(toForm(app).serviceConnections).toEqual([
      { offering: "cache", namespace: "cc-office", name: "" },
      { offering: "search", namespace: "", name: "" },
    ]);
  });

  test("an offer is written with only what was given, and goes when it's turned off", () => {
    const offered = fromForm(
      form({ offers: true, offerDescription: " Orders. ", offerPath: "/api", offerShareWith: "web, admin" }),
    );
    expect(offered.spec.offers).toEqual({ description: "Orders.", path: "/api", shareWith: ["web", "admin"] });
    expect(toForm(offered)).toMatchObject({ offers: true, offerProtocol: "http", offerShareWith: "web, admin" });
    expect(fromForm(form({ offers: true, offerProtocol: "grpc" })).spec.offers).toEqual({ protocol: "grpc" });
    expect(fromForm(form({ ...toForm(offered), offers: false }), offered).spec.offers).toBeUndefined();
  });

  test("are checked", () => {
    expect(validateForm(form({ offers: true, offerShareWith: "Web" })).offerShareWith).toBeDefined();
    expect(validateForm(form({ offers: true, offerPath: "api" })).offerPath).toBeDefined();
    expect(
      validateForm(
        form({
          serviceConnections: [
            { offering: "search", namespace: "", name: "" },
            { offering: "search", namespace: "other", name: "" },
          ],
        }),
      ).serviceConnections,
    ).toContain("both set SEARCH_*");
  });
});

describe("secret and shared variables", () => {
  const base: import("./types").WebApplication = {
    apiVersion: "community-cloud.technology/v1alpha1",
    kind: "WebApplication",
    metadata: { name: "shop", namespace: "team-shop" },
    spec: {
      image: { repository: "ghcr.io/acme/shop" },
      env: [
        { name: "LOG_LEVEL", value: "info" },
        { name: "POD_IP", valueFrom: { fieldRef: { fieldPath: "status.podIP" } } },
      ],
      secrets: [{ name: "STRIPE_KEY", description: "From Stripe's dashboard" }, { name: "WEBHOOK_SECRET" }],
      shared: [{ name: "SMTP_HOST" }, { name: "SENDGRID", as: "MAIL_KEY" }],
    },
    status: { environment: { secrets: [{ name: "STRIPE_KEY", set: true }] } },
  };

  test("are edited as rows, with which secrets have a value", () => {
    const form = toForm(base);
    expect(form.env).toEqual([
      { name: "LOG_LEVEL", value: "info" },
      { name: "STRIPE_KEY", value: "", secret: true, stored: true, description: "From Stripe's dashboard" },
      { name: "WEBHOOK_SECRET", value: "", secret: true, stored: false },
    ]);
    expect(form.sharedEnv).toEqual([
      { key: "SMTP_HOST", name: "SMTP_HOST" },
      { key: "SENDGRID", name: "MAIL_KEY" },
    ]);
    expect(form.preservedEnv.map((each) => each.name)).toEqual(["POD_IP"]);
    // The Secret's own keys, when they can be read, over Cirrus's report
    expect(toForm(base, ["WEBHOOK_SECRET"]).env.map((row) => row.stored)).toEqual([undefined, false, true]);
  });

  test("are written back as names, never values", () => {
    const form = toForm(base);
    const typed = { ...form, env: [...form.env, { name: "API_TOKEN", value: "t0ken", secret: true }] };
    const spec = fromForm(typed, base).spec;
    expect(spec.secrets).toEqual([
      { name: "STRIPE_KEY", description: "From Stripe's dashboard" },
      { name: "WEBHOOK_SECRET" },
      { name: "API_TOKEN" },
    ]);
    expect(spec.shared).toEqual([{ name: "SMTP_HOST" }, { name: "SENDGRID", as: "MAIL_KEY" }]);
    expect(spec.env).toEqual(base.spec.env);
    expect(JSON.stringify(spec)).not.toContain("t0ken");
  });

  test("a new secret needs a value; a kept one doesn't", () => {
    const form = { ...emptyForm("team-shop"), name: "shop", repository: "ghcr.io/acme/shop" };
    expect(validateForm({ ...form, env: [{ name: "KEY", value: "", secret: true }] }).env).toContain(
      "Give KEY a value",
    );
    expect(
      validateForm({ ...form, env: [{ name: "KEY", value: "", secret: true, stored: true }] }).env,
    ).toBeUndefined();
  });

  test("a name used twice across own and shared variables is caught", () => {
    const form = {
      ...emptyForm("team-shop"),
      name: "shop",
      repository: "ghcr.io/acme/shop",
      env: [{ name: "SMTP_HOST", value: "x" }],
      sharedEnv: [{ key: "SMTP_HOST", name: "SMTP_HOST" }],
    };
    expect(validateForm(form).env).toBe("SMTP_HOST is set twice.");
  });
});
