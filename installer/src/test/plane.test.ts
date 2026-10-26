/**
 * @file
 * Plane, and the RabbitMQ it brings into the cluster.
 *
 * Plane is the first application here with a message queue, and the
 * names that hold it together are spread across a lot of files: the
 * Secrets the pods read, which come from three different operators
 * and the installer; the vhost in its AMQP_URL and the one the
 * topology operator makes; the bucket Plane signs links for and the
 * path the Gateway sends to SeaweedFS. None of it fails on a laptop.
 * It fails as a pod that never starts, or an upload that's refused,
 * so it's checked here.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseAllDocuments } from "yaml";

import { TerminalCommandSpec, joinCommand } from "../cli/commands/Command.ts";
import { buildPackageCommands } from "../cli/commands/Helm.ts";
import { getPackage, resolveInstallOrder } from "../cli/commands/packages.ts";
import { MAIL_SECRET } from "../util/mail.ts";
import { renderInstallerFile } from "../util/template.ts";
import { loadFixtureConfig, withoutConsole } from "./helpers.ts";

const PLANE = getPackage("plane")!;
const RABBITMQ = getPackage("rabbitmq-operator")!;
const REDIS = getPackage("redis-operator")!;

/**
 * Every document in some manifests, rendered as an install would.
 */
async function render(...paths: string[]): Promise<any[]> {
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
  return [...(pod.initContainers ?? []), ...pod.containers].flatMap((container: any) =>
    (container.env ?? [])
      .filter((each: any) => each.valueFrom?.secretKeyRef !== undefined)
      .map((each: any): [string, string] => [each.valueFrom.secretKeyRef.name, each.valueFrom.secretKeyRef.key]),
  );
}

/**
 * The value of an environment variable in a container.
 */
function envValue(container: any, name: string): any {
  return container.env?.find((each: any) => each.name === name)?.value;
}

describe("installing Plane", () => {
  it("brings the database, the Redis, the RabbitMQ and the object store, in order", async () => {
    const config = await loadFixtureConfig({ packages: { plane: true } });
    const order = await withoutConsole(() => resolveInstallOrder(config).map((entry) => entry.name));

    for (const dependency of ["cloudnative-pg", "redis-operator", "rabbitmq-operator", "seaweedfs"]) {
      assert.ok(order.indexOf(dependency) < order.indexOf("plane"), dependency);
    }
    assert.ok(order.indexOf("cert-manager") < order.indexOf("rabbitmq-operator"));
    assert.ok(order.indexOf("topolvm") < order.indexOf("rabbitmq-operator"));
  });

  it("waits for its vhost, user, bucket and keys before its own workloads", () => {
    const names = buildPackageCommands(PLANE).map((command) => command.name);
    const queue = names.indexOf("helm-manifest-after-plane-plane-queue");
    const ready = names.indexOf("ready-plane");

    assert.ok(queue >= 0 && ready >= 0, names.join("\n"));
    assert.ok(queue < ready);
    assert.ok(ready < names.indexOf("rollout-plane"));
  });

  it("waits for the shared Redis and RabbitMQ first", () => {
    assert.deepEqual(PLANE.rollout!.slice(0, 2), ["statefulset/redis", "statefulset/rabbitmq-server"]);
  });
});

describe("what Plane's manifests ask of the cluster", async () => {
  const documents = await render(...PLANE.manifests!.after!);
  const deployments = documents.filter((document) => document.kind === "Deployment");
  const byName = (name: string) => deployments.find((document) => document.metadata.name === name);
  const config = documents.find((document) => document.kind === "ConfigMap" && document.metadata.name === "plane").data;

  it("only Secrets something makes, by keys they have", () => {
    const user = documents.find((document) => document.kind === "User");
    const credentials = documents.find((document) => document.kind === "S3Credentials");

    const made = new Map<string, string[]>([
      ...PLANE.secrets!.map((secret): [string, string[]] => [secret.name, ["username", "password"]]),
      ...REDIS.secrets!.map((secret): [string, string[]] => [secret.name, ["username", "password"]]),
      [MAIL_SECRET, ["username", "password"]],
      // The topology operator's, named after the User
      [`${user.metadata.name}-user-credentials`, ["username", "password"]],
      // The SeaweedFS operator's
      [credentials.spec.secretRef.name, ["accessKey", "secretKey"]],
    ]);

    for (const deployment of deployments) {
      for (const [name, key] of secretReferences(deployment.spec.template.spec)) {
        assert.ok(made.get(name)?.includes(key), `${deployment.metadata.name} reads ${name}.${key}, which nothing makes`);
      }
    }
  });

  it("queues in its own vhost, which its user may use", () => {
    const vhost = documents.find((document) => document.kind === "Vhost");
    const user = documents.find((document) => document.kind === "User");
    const permission = documents.find((document) => document.kind === "Permission");
    const api = byName("plane-api").spec.template.spec.containers[0];

    assert.match(envValue(api, "AMQP_URL"), new RegExp(`@rabbitmq:5672/${vhost.spec.name}$`));
    assert.equal(permission.spec.vhost, vhost.spec.name);
    assert.equal(permission.spec.userReference.name, user.metadata.name);
  });

  it("uses the shared RabbitMQ", async () => {
    const [cluster] = await render(RABBITMQ.manifests!.after!.at(-1)!);

    for (const document of documents.filter((each) => each.apiVersion === "rabbitmq.com/v1beta1")) {
      assert.equal(document.spec.rabbitmqClusterReference.name, cluster.metadata.name, document.kind);
    }
    assert.equal(cluster.metadata.namespace, "cc-office");
  });

  it("keeps its files in a bucket called uploads, which its exports insist on", () => {
    const bucket = documents.find((document) => document.kind === "Bucket");
    assert.equal(bucket.spec.name, "uploads");
    assert.equal(config.AWS_S3_BUCKET_NAME, bucket.spec.name);
  });

  it("signs browsers' links for its own hostname, and talks to SeaweedFS inside the cluster", () => {
    assert.equal(config.USE_MINIO, "1");
    assert.equal(config.MINIO_ENDPOINT_SSL, "1");
    assert.equal(config.AWS_S3_ENDPOINT_URL, "http://seaweed-s3.seaweedfs.svc:8333");
  });

  it("sends the bucket's path on its hostname to SeaweedFS, which it's allowed to", () => {
    const route = documents.find((document) => document.kind === "HTTPRoute" && document.metadata.name === "plane");
    const uploads = route.spec.rules.find((rule: any) => rule.matches[0].path.value === "/uploads");
    const grant = documents.find((document) => document.kind === "ReferenceGrant");

    assert.deepEqual(uploads.backendRefs, [{ name: "seaweed-s3", namespace: "seaweedfs", port: 8333 }]);
    assert.equal(uploads.filters, undefined, "a rewrite would break the signatures");
    assert.equal(grant.metadata.namespace, "seaweedfs");
    assert.deepEqual(grant.spec.from, [{ group: "gateway.networking.k8s.io", kind: "HTTPRoute", namespace: "cc-office" }]);
    assert.deepEqual(grant.spec.to, [{ group: "", kind: "Service", name: "seaweed-s3" }]);
  });

  it("routes each path to the part of Plane that serves it", () => {
    const route = documents.find((document) => document.kind === "HTTPRoute" && document.metadata.name === "plane");
    const services = new Set(documents.filter((document) => document.kind === "Service").map((each) => each.metadata.name));
    const to = (path: string) =>
      route.spec.rules.find((rule: any) => rule.matches.some((match: any) => match.path.value === path)).backendRefs[0].name;

    assert.equal(to("/api"), "plane-api");
    assert.equal(to("/auth"), "plane-api");
    assert.equal(to("/live"), "plane-live");
    assert.equal(to("/spaces"), "plane-space");
    assert.equal(to("/god-mode"), "plane-admin");
    assert.equal(to("/"), "plane-web");

    for (const rule of route.spec.rules) {
      for (const backend of rule.backendRefs.filter((each: any) => each.namespace === undefined)) {
        assert.ok(services.has(backend.name), backend.name);
      }
    }
  });

  it("migrates, then claims the instance for its administrator, before the API starts", () => {
    const [migrate, claim] = byName("plane-api").spec.template.spec.initContainers;
    assert.deepEqual(migrate.command, ["./bin/docker-entrypoint-migrator.sh"]);
    assert.match(claim.args[0], /register_instance/);
    assert.match(claim.args[0], /claim\.py/);
  });

  it("only ever claims an instance nobody has set up", () => {
    const script = documents.find((document) => document.metadata?.name === "plane-claim").data["claim.py"];
    assert.match(script, /if instance\.is_setup_done or InstanceAdmin\.objects\.exists\(\):/);
  });

  it("only ever runs one scheduler", () => {
    assert.equal(byName("plane-beat").spec.strategy.type, "Recreate");
  });

  it("waits for every workload it starts", () => {
    assert.deepEqual(
      PLANE.rollout!.filter((each) => each.startsWith("deployment/")).sort(),
      deployments.map((each) => `deployment/${each.metadata.name}`).sort(),
    );
  });

  it("is told about the mail server in the form it reads", () => {
    assert.equal(config.EMAIL_USE_TLS, "1");
    assert.equal(config.EMAIL_USE_SSL, "0");
  });

  it("lets nobody sign up", () => {
    assert.equal(config.ENABLE_SIGNUP, "0");
  });
});

describe("the RabbitMQ operators", () => {
  it("are applied server-side, since their CRDs are too large not to be", () => {
    const command = buildPackageCommands(RABBITMQ).find((each) =>
      each.name === "helm-manifest-after-rabbitmq-operator-rabbitmq-cluster-operator",
    ) as TerminalCommandSpec;
    const text = joinCommand((command.command as Function)({}, {}) as string[]);
    assert.match(text, /kubectl apply --server-side --force-conflicts -f/);
  });

  it("are the ones the RabbitMQ team publishes, pinned", async () => {
    const [cluster, topology] = await Promise.all(
      RABBITMQ.manifests!.after!.slice(0, 2).map((path) => render(path)),
    );
    const image = (documents: any[]) =>
      documents.find((document) => document?.kind === "Deployment").spec.template.spec.containers[0].image;

    assert.match(image(cluster!), /^ghcr\.io\/rabbitmq\/cluster-operator:\d+\.\d+\.\d+$/);
    assert.match(image(topology!), /^ghcr\.io\/rabbitmq\/messaging-topology-operator:\d+\.\d+\.\d+$/);
  });

  it("wait for the operators they install", () => {
    assert.deepEqual(RABBITMQ.rollout, ["deployment/rabbitmq-cluster-operator", "deployment/messaging-topology-operator"]);
  });
});
