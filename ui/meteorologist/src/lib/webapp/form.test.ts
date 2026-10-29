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
      spec: { image: { repository: "registry.gitlab.com/acme/shop", tag: "latest" }, replicas: 1, port: 8080 },
    });
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
      imageTag: "{commit_sha}",
    });
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
    expect(toForm(sparse)).toMatchObject({ tag: "latest", replicas: "1", port: "8080", gitlab: false });
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
    expect(validateForm(form({ port: "" })).port).toBeDefined();
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
