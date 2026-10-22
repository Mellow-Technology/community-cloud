/**
 * @file
 * Lago, and the Redis it brings into the cluster.
 *
 * Lago is the first application here that needs Redis, the first with
 * a bucket in SeaweedFS, and the first that can't sign in through
 * Authentik, so the order its install runs in is different from the
 * others and worth pinning down. So is what its manifests ask of the
 * cluster: a Secret a container names and nothing makes is a pod that
 * never starts, and on a laptop that looks exactly like a pod that
 * would.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { parseAllDocuments } from "yaml";

import { TerminalCommandSpec, joinCommand } from "../cli/commands/Command.ts";
import { buildPackageCommands } from "../cli/commands/Helm.ts";
import { buildCreateSecretCommand, buildVerifySecretsCommand } from "../cli/commands/Secrets.ts";
import { getPackage, resolveInstallOrder } from "../cli/commands/packages.ts";
import { MAIL_SECRET } from "../util/mail.ts";
import { renderInstallerFile } from "../util/template.ts";
import { checkConfiguration } from "../runners/preflight.ts";
import { configFrom, loadFixtureConfig, withoutConsole } from "./helpers.ts";

const LAGO = getPackage("lago")!;
const REDIS = getPackage("redis-operator")!;
const SEAWEEDFS = getPackage("seaweedfs")!;

/**
 * Every document in a package's manifests, rendered as an install
 * would render them.
 */
async function renderManifests(paths: string[]): Promise<any[]> {
  const config = await loadFixtureConfig();
  return paths.flatMap((path) =>
    parseAllDocuments(renderInstallerFile(config, path, { templateNamespace: "cc-office" })).map((document) => {
      assert.deepEqual(document.errors, [], path);
      return document.toJS();
    }),
  );
}

/**
 * Everything in a pod spec that reads a Secret, as [name, key].
 */
function secretReferences(pod: any): [string, string][] {
  const containers = [...(pod.initContainers ?? []), ...pod.containers];
  const fromEnv = containers.flatMap((container: any) =>
    (container.env ?? [])
      .filter((each: any) => each.valueFrom?.secretKeyRef !== undefined)
      .map((each: any) => [each.valueFrom.secretKeyRef.name, each.valueFrom.secretKeyRef.key]),
  );
  const fromVolumes = (pod.volumes ?? [])
    .filter((volume: any) => volume.secret !== undefined)
    .flatMap((volume: any) => volume.secret.items.map((item: any) => [volume.secret.secretName, item.key]));

  return [...fromEnv, ...fromVolumes];
}

describe("installing Lago", () => {
  const names = buildPackageCommands(LAGO).map((command) => command.name);
  const position = (prefix: string) => names.findIndex((each) => each.startsWith(prefix));

  it("doesn't wait for Authentik, which it can't sign in through", () => {
    assert.ok(!names.some((each) => each.includes("authentik")), names.join("\n"));
  });

  it("makes its credentials and mail before anything starts", () => {
    const firstManifest = position("helm-manifest-after-");

    for (const secret of LAGO.secrets!) {
      assert.ok(position(`create-secret-cc-office-${secret.name}`) < firstManifest, secret.name);
    }
    assert.ok(position("apply-smtp-cc-office") < firstManifest);
  });

  it("waits for the Redis before Lago itself", () => {
    assert.equal(LAGO.rollout![0], "statefulset/redis");
  });

  it("waits for its bucket and the keys to it before its own workloads", () => {
    assert.ok(position("ready-lago") > position("helm-manifest-after-lago-Lago-bucket"));
    assert.ok(position("ready-lago") < position("rollout-lago"));
    assert.deepEqual(LAGO.ready, ["buckets.seaweed.seaweedfs.com/lago", "s3credentials.seaweed.seaweedfs.com/lago"]);
  });

  it("brings the Postgres, the Redis and the storage under both, in order", async () => {
    const config = await loadFixtureConfig({ packages: { lago: true } });
    const order = await withoutConsole(() => resolveInstallOrder(config).map((entry) => entry.name));

    assert.ok(order.indexOf("topolvm") < order.indexOf("redis-operator"));
    assert.ok(order.indexOf("redis-operator") < order.indexOf("lago"));
    assert.ok(order.indexOf("cloudnative-pg") < order.indexOf("lago"));
    assert.ok(order.indexOf("topolvm") < order.indexOf("seaweedfs"));
    assert.ok(order.indexOf("seaweedfs") < order.indexOf("lago"));
  });
});

describe("what Lago's manifests ask of the cluster", async () => {
  const documents = await renderManifests(LAGO.manifests!.after!);
  const pods = documents
    .filter((document) => document.kind === "Deployment")
    .map((document) => document.spec.template.spec);
  const lago = (role: string) =>
    documents.find((document) => document.kind === "Deployment" && document.spec.selector.matchLabels.role === role);

  it("only Secrets something makes, by keys they have", () => {
    const made = new Map<string, string[]>([
      // The keys to its bucket, which the SeaweedFS operator makes
      ...documents
        .filter((document) => document.kind === "S3Credentials")
        .map((document): [string, string[]] => [document.spec.secretRef.name, ["accessKey", "secretKey"]]),
      ...LAGO.secrets!.map((secret): [string, string[]] => [
        secret.name,
        secret.privateKey !== undefined ? ["privateKey"] : ["username", "password"],
      ]),
      ...REDIS.secrets!.map((secret): [string, string[]] => [secret.name, ["username", "password"]]),
      [MAIL_SECRET, ["username", "password"]],
    ]);

    for (const [name, key] of pods.flatMap(secretReferences)) {
      assert.ok(made.get(name)?.includes(key), `${name}.${key} isn't made by anything`);
    }
  });

  it("gives every Lago process the key it signs sessions with, and our initializer", () => {
    for (const role of ["server", "worker", "clock"]) {
      const pod = lago(role).spec.template.spec;

      for (const container of [...pod.initContainers, ...pod.containers]) {
        const mounts = new Map(container.volumeMounts.map((each: any) => [each.name, each.mountPath]));
        assert.equal(mounts.get("rsa"), "/app/config/keys", `${role} ${container.name}`);
        assert.equal(mounts.get("initializers"), "/app/config/initializers/community_cloud.rb", `${role} ${container.name}`);
      }
    }
  });

  it("serves its files through the API, so the bucket never has to be public", () => {
    const initializers = documents.find((document) => document.kind === "ConfigMap" && document.metadata.name === "lago-initializers");
    assert.match(initializers.data["community_cloud.rb"], /resolve_model_to_route = :rails_storage_proxy/);
  });

  it("keeps its files in its bucket, in the cluster's SeaweedFS", () => {
    const config = documents.find((document) => document.kind === "ConfigMap" && document.metadata.name === "lago").data;
    const bucket = documents.find((document) => document.kind === "Bucket");

    assert.equal(config.LAGO_USE_AWS_S3, "true");
    assert.equal(config.LAGO_AWS_S3_ENDPOINT, "http://seaweed-s3.seaweedfs.svc:8333");
    assert.equal(config.LAGO_AWS_S3_PATH_STYLE, "true");
    assert.equal(config.LAGO_AWS_S3_BUCKET, bucket.metadata.name);
  });

  it("gives the keys to its bucket to nothing but its bucket", () => {
    const bucket = documents.find((document) => document.kind === "Bucket");
    const credentials = documents.find((document) => document.kind === "S3Credentials");

    assert.deepEqual(bucket.spec.access, [{ user: credentials.spec.identityRef.name, actions: ["Read", "Write", "List", "Tagging"] }]);
  });

  it("keeps nothing on a disk, so the API and worker roll", () => {
    assert.ok(!documents.some((document) => document.kind === "PersistentVolumeClaim"));
    assert.equal(lago("server").spec.strategy.type, "RollingUpdate");
    assert.equal(lago("worker").spec.strategy.type, "RollingUpdate");
  });

  it("only ever runs one clock", () => {
    assert.equal(lago("clock").spec.replicas, 1);
    assert.equal(lago("clock").spec.strategy.type, "Recreate");
  });

  it("migrates in the API, and has everything else wait for it", () => {
    assert.match(lago("server").spec.template.spec.initContainers[0].args[0], /migrate\.sh/);

    for (const role of ["worker", "clock"]) {
      const [wait] = lago(role).spec.template.spec.initContainers;
      assert.match(wait.args[0], /needs_migration\?/, role);
    }
  });

  it("waits for every workload it starts", () => {
    const deployments = documents
      .filter((document) => document.kind === "Deployment")
      .map((document) => `deployment/${document.metadata.name}`);
    assert.deepEqual(LAGO.rollout!.filter((each) => each.startsWith("deployment/")).sort(), deployments.sort());
  });

  it("runs every container from the same release", () => {
    const tags = new Set(
      pods
        .flatMap((pod) => [...(pod.initContainers ?? []), ...pod.containers])
        .map((container: any) => container.image)
        .filter((image: string) => image.startsWith("getlago/"))
        .map((image: string) => image.split(":")[1]),
    );
    assert.equal(tags.size, 1, [...tags].join(", "));
  });

  it("keeps the API's metrics inside the cluster", () => {
    const route = documents.find((document) => document.kind === "HTTPRoute" && document.metadata.name === "lago-api");
    const metrics = route.spec.rules.find((rule: any) => rule.matches?.[0]?.path?.value === "/metrics");

    assert.ok(metrics !== undefined);
    assert.equal(metrics.backendRefs, undefined);
  });

  it("serves both hostnames from the fixture", () => {
    const listeners = documents.find((document) => document.kind === "ListenerSet").spec.listeners;
    assert.deepEqual(
      [...new Set(listeners.map((listener: any) => listener.hostname))],
      ["billing.example.test", "billing-api.example.test"],
    );
  });
});

describe("the SeaweedFS cluster", async () => {
  const documents = await renderManifests(SEAWEEDFS.manifests!.after!);
  const seaweed = documents.find((document) => document.kind === "Seaweed");
  const grant = documents.find((document) => document.kind === "ResourceReferenceGrant");
  const namespace = (await renderManifests(["embed://apps/office/Office.namespace.yaml"]))[0];
  const bucket = (await renderManifests(["embed://apps/lago/Lago.bucket.yaml"])).find(
    (document) => document.kind === "Bucket",
  );

  it("is the one Lago's bucket is in", () => {
    assert.deepEqual(bucket.spec.clusterRef, { name: seaweed.metadata.name, namespace: seaweed.metadata.namespace });
  });

  it("is what the package waits for", () => {
    assert.deepEqual(SEAWEEDFS.ready, [`seaweeds.seaweed.seaweedfs.com/${seaweed.metadata.name}`]);
  });

  it("lets cc-office keep buckets in it, by the label on the namespace", () => {
    for (const from of grant.spec.from) {
      for (const [label, value] of Object.entries(from.namespaceSelector.matchLabels)) {
        assert.equal(namespace.metadata.labels[label], value, from.kind);
      }
    }
  });

  it("keeps the master's and the filer's state on disk", () => {
    assert.equal(seaweed.spec.master.persistence.enabled, true);
    assert.equal(seaweed.spec.filer.persistence.enabled, true);
  });

  it("pins a SeaweedFS version", () => {
    assert.match(seaweed.spec.image, /:\d+\.\d+$/);
  });
});

describe("the Redis", async () => {
  const [redis] = await renderManifests(REDIS.manifests!.after!);

  it("takes its password from the Secret the package makes", () => {
    assert.deepEqual(redis.spec.kubernetesConfig.redisSecret, { name: REDIS.secrets![0]!.name, key: "password" });
  });

  it("is in the namespace its password is", () => {
    assert.equal(redis.metadata.namespace, REDIS.secrets![0]!.namespace);
  });
});

describe("a private key", () => {
  const definition = LAGO.secrets!.find((each) => each.privateKey !== undefined)!;
  const command = buildCreateSecretCommand(definition, "cc-office") as TerminalCommandSpec;
  const text = joinCommand(command.command as string[]);

  it("is made on the control plane, so it never passes through here", () => {
    assert.equal(command.stdin, undefined);
    assert.match(text, /openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048/);
  });

  it("reaches the Secret from a file, never from a command line", () => {
    assert.match(text, /--from-file=privateKey="\$work\/key.pem"/);
  });

  it("is only ever made once", () => {
    assert.match(text, /get secret 'lago-rsa'/);
    assert.ok(!text.includes("apply"));
  });

  it("is shell", () => {
    execFileSync("/bin/sh", ["-n", "-c", text]);
  });

  it("is checked for as a key alone", () => {
    const verify = joinCommand(
      (buildVerifySecretsCommand([definition], "cc-office", "lago") as TerminalCommandSpec).command as string[],
    );
    assert.match(verify, /jsonpath='\{\.type\}:\{\.data\.privateKey\}'/);
    assert.match(verify, / {2}Opaque:\?\*\) /);
  });
});

describe("preflight, for Lago's mail", () => {
  const withSecurity = async (security: string) => {
    const config = await loadFixtureConfig();
    const raw = JSON.parse(JSON.stringify(config.getConfig()));
    raw.packages = { lago: true };
    raw.smtp.defaults = { host: "smtp.example.test", security };
    return checkConfiguration(configFrom(raw)).map((problem) => problem.what);
  };

  it("says when the server wants TLS from the start, which Rails can't do", async () => {
    const problems = await withSecurity("tls");
    assert.ok(problems.some((problem) => problem.startsWith("lago can't send mail")), problems.join("\n"));
  });

  it("is content with STARTTLS", async () => {
    assert.deepEqual(await withSecurity("starttls"), []);
  });
});
