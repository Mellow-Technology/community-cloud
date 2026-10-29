/**
 * @file
 * ProjectSend, and the MariaDB it brings into the cluster.
 *
 * ProjectSend is the first application here on MySQL rather than
 * Postgres, the first that keeps its files in one of two places, and
 * the first whose settings have to be written into its own database
 * before it starts. Each of those is a way for an install to apply
 * cleanly and then not work — a pod waiting for a Secret nobody makes,
 * a user in a MariaDB that isn't there, a sign in pointed at the wrong
 * client — so what its manifests ask of the cluster is checked here.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseAllDocuments } from "yaml";

import { buildPackageCommands, buildPackagesBundle } from "../cli/commands/Helm.ts";
import { getPackage, resolveInstallOrder } from "../cli/commands/packages.ts";
import { MAIL_SECRET } from "../util/mail.ts";
import { buildProjectSendValues, checkProjectSendConfig, getProjectSendStorage } from "../util/projectsend.ts";
import { renderInstallerFile } from "../util/template.ts";
import { loadFixtureConfig, withoutConsole } from "./helpers.ts";

const PROJECTSEND = getPackage("projectsend")!;
const MARIADB = getPackage("mariadb-operator")!;
const REDIS = getPackage("redis-operator")!;

const S3 = { projectsend: { storage: "s3" } };

/**
 * Every document in some manifests, rendered as an install would, for
 * the fixture with anything in "overrides" laid over it.
 */
async function render(overrides: Record<string, unknown>, ...paths: string[]): Promise<any[]> {
  const config = await loadFixtureConfig(overrides);
  return paths.flatMap((path) =>
    parseAllDocuments(renderInstallerFile(config, path, { templateNamespace: "cc-office" }))
      .map((document) => {
        assert.deepEqual(document.errors, [], path);
        return document.toJS();
      })
      .filter((document) => document !== null),
  );
}

/**
 * ProjectSend's Deployment, for local storage or a bucket.
 */
async function deployment(overrides: Record<string, unknown> = {}): Promise<any> {
  const documents = await render(overrides, "embed://apps/projectsend/ProjectSend.yaml");
  return documents.find((document) => document.kind === "Deployment");
}

/**
 * Everything a pod reads from a Secret, as [name, key, optional].
 */
function secretReferences(pod: any): [string, string, boolean][] {
  return [...(pod.initContainers ?? []), ...pod.containers].flatMap((container: any) =>
    (container.env ?? [])
      .filter((each: any) => each.valueFrom?.secretKeyRef !== undefined)
      .map((each: any) => {
        const ref = each.valueFrom.secretKeyRef;
        return [ref.name, ref.key, ref.optional === true];
      }),
  );
}

describe("where ProjectSend keeps its files", () => {
  it("is a volume unless the configuration says a bucket", () => {
    assert.equal(getProjectSendStorage({}), "local");
    assert.equal(getProjectSendStorage({ values: { projectsend: { storage: "s3" } } }), "s3");
    assert.deepEqual(buildProjectSendValues({}), { storage: "local", s3: false });
    assert.equal(buildProjectSendValues({ values: { projectsend: { storage: "s3" } } })["s3"], true);
  });

  it("is refused when it's neither, rather than taken to mean the volume", () => {
    assert.throws(() => getProjectSendStorage({ values: { projectsend: { storage: "S3 " } } }), /values\.projectsend\.storage/);
    assert.equal(checkProjectSendConfig({ values: { projectsend: { storage: "disk" } } }, ["projectsend"]).length, 1);
  });

  it("needs SeaweedFS, and its public hostname, for a bucket", () => {
    const s3 = { values: { projectsend: { storage: "s3" }, domain: { storage: "s3.example.test" } } };
    assert.deepEqual(checkProjectSendConfig(s3, ["projectsend", "seaweedfs"]), []);
    assert.match(checkProjectSendConfig(s3, ["projectsend"]).join("\n"), /seaweedfs/);

    const noHost = { values: { projectsend: { storage: "s3" } } };
    assert.match(checkProjectSendConfig(noHost, ["projectsend", "seaweedfs"]).join("\n"), /domain\.storage/);
  });

  it("needs nothing else for a volume", () => {
    assert.deepEqual(checkProjectSendConfig({}, ["projectsend"]), []);
  });

  it("is a claim on local disk by default, and no bucket", async () => {
    const documents = await render({}, "embed://apps/projectsend/ProjectSend.storage.yaml");
    assert.deepEqual(documents.map((document) => document.kind), ["PersistentVolumeClaim"]);
    assert.equal(documents[0].spec.storageClassName, "cc-local-ssd-fast");
    assert.equal(documents[0].spec.resources.requests.storage, "50Gi");

    const pod = (await deployment()).spec.template.spec;
    const storage = pod.volumes.find((volume: any) => volume.name === "storage");
    assert.equal(storage.persistentVolumeClaim.claimName, documents[0].metadata.name);
    assert.ok(!secretReferences(pod).some(([name]) => name === "projectsend-s3"));
  });

  it("is a bucket, sized the same way, and no claim, when asked", async () => {
    const documents = await render(
      { ...S3, storage: { allocations: { projectsendGb: 200 } } },
      "embed://apps/projectsend/ProjectSend.storage.yaml",
    );
    assert.deepEqual(documents.map((document) => document.kind), ["S3Identity", "S3Credentials", "Bucket"]);
    assert.equal(documents[2].spec.quota.size, "200Gi");

    const pod = (await deployment(S3)).spec.template.spec;
    const storage = pod.volumes.find((volume: any) => volume.name === "storage");
    assert.deepEqual(storage.emptyDir, {});
    assert.equal(storage.persistentVolumeClaim, undefined);
  });

  it("is reached on SeaweedFS's public hostname, where a browser can follow the links", async () => {
    const [config] = await render(S3, "embed://apps/projectsend/ProjectSend.config.yaml");
    assert.equal(config.data.CC_STORAGE, "s3");
    assert.equal(config.data.CC_S3_ENDPOINT, "https://s3.example.test");
    assert.equal(config.data.CC_S3_BUCKET, "projectsend");

    const [local] = await render({}, "embed://apps/projectsend/ProjectSend.config.yaml");
    assert.equal(local.data.CC_STORAGE, "local");
    assert.equal(local.data.CC_S3_ENDPOINT, undefined);
  });
});

describe("what ProjectSend's pod reads", () => {
  const modes: [string, Record<string, unknown>][] = [["a volume", {}], ["a bucket", S3]];
  for (const [mode, overrides] of modes) {
    it(`is all made by something, with ${mode}`, async () => {
      const pod = (await deployment(overrides)).spec.template.spec;
      const made = new Set([
        ...PROJECTSEND.secrets!.map((secret) => secret.name),
        ...REDIS.secrets!.map((secret) => secret.name),
      ]);

      // The bucket's keys are written by the SeaweedFS operator, from
      // the S3Credentials it's asked for
      if (overrides === S3) {
        const requests = await render(overrides, "embed://apps/projectsend/ProjectSend.storage.yaml");
        made.add(requests.find((document) => document.kind === "S3Credentials").spec.secretRef.name);
      }

      for (const [name, key, optional] of secretReferences(pod)) {
        if (name === MAIL_SECRET) {
          assert.ok(optional, `${name}/${key} should be optional`);
          continue;
        }
        assert.ok(made.has(name), `${name}/${key} is read and nothing makes it`);
      }
    });
  }

  it("gives the first container and ProjectSend the same environment", async () => {
    const pod = (await deployment(S3)).spec.template.spec;
    const [provision] = pod.initContainers;
    const [projectsend] = pod.containers;
    assert.deepEqual(provision.env, projectsend.env);
    assert.deepEqual(provision.envFrom, projectsend.envFrom);
    assert.equal(provision.image, projectsend.image);
  });

  it("runs the provisioning through the image's own entrypoint", async () => {
    const pod = (await deployment()).spec.template.spec;
    const [provision] = pod.initContainers;
    const script = provision.args.at(-1);
    const mount = provision.volumeMounts.find((each: any) => script.startsWith(each.mountPath));
    const volume = pod.volumes.find((each: any) => each.name === mount.name);

    assert.deepEqual(provision.command, ["projectsend-entrypoint"]);
    const [config] = await render({}, "embed://apps/projectsend/ProjectSend.provision.yaml");
    assert.equal(volume.configMap.name, config.metadata.name);
    assert.ok(script.endsWith("/provision.sh") && "provision.sh" in config.data);
    assert.ok(config.data["provision.sh"].includes(`${mount.mountPath}/provision.php`));
  });
});

describe("ProjectSend's provisioning script", () => {
  const php = (() => {
    try {
      execFileSync("php", ["--version"], { stdio: "ignore" });
      return true;
    } catch {
      return false;
    }
  })();

  it("is PHP that parses", { skip: !php && "php isn't installed" }, async () => {
    const [config] = await render({}, "embed://apps/projectsend/ProjectSend.provision.yaml");
    const directory = mkdtempSync(join(tmpdir(), "projectsend-"));
    try {
      const file = join(directory, "provision.php");
      writeFileSync(file, config.data["provision.php"]);
      execFileSync("php", ["-l", file], { stdio: "pipe" });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("is a shell script that parses", async () => {
    const [config] = await render({}, "embed://apps/projectsend/ProjectSend.provision.yaml");
    execFileSync("sh", ["-n"], { input: config.data["provision.sh"] });
  });

  it("only writes what the environment gives it", async () => {
    const [config] = await render(S3, "embed://apps/projectsend/ProjectSend.config.yaml");
    const [provision] = await render({}, "embed://apps/projectsend/ProjectSend.provision.yaml");
    const pod = (await deployment(S3)).spec.template.spec;
    const given = new Set([
      ...Object.keys(config.data),
      ...pod.containers[0].env.map((each: any) => each.name),
    ]);

    const read = [...provision.data["provision.php"].matchAll(/(?:getenv|\$required)\('([A-Z_0-9]+)'\)/g)].map(
      (match) => match[1],
    );
    assert.ok(read.length > 0);
    for (const name of read) {
      assert.ok(given.has(name), `${name} is read and never set`);
    }
  });
});

describe("ProjectSend's database", () => {
  it("is in the MariaDB the operator's package makes, as the user its Secret is for", async () => {
    const [mariadb] = await render({}, "embed://apps/office/MariaDB.yaml");
    const documents = await render({}, "embed://apps/projectsend/ProjectSend.database.yaml");
    const database = documents.find((document) => document.kind === "Database");
    const user = documents.find((document) => document.kind === "User");
    const grant = documents.find((document) => document.kind === "Grant");

    for (const each of [database, user, grant]) {
      assert.equal(each.spec.mariaDbRef.name, mariadb.metadata.name);
      assert.equal(each.metadata.namespace, mariadb.metadata.namespace);
    }

    const secret = PROJECTSEND.secrets!.find((each) => each.name === user.spec.passwordSecretKeyRef.name)!;
    assert.equal(secret.username, user.spec.name);
    assert.equal(grant.spec.username, user.spec.name);
    assert.equal(grant.spec.database, database.spec.name);
  });

  it("outlives its resource being deleted", async () => {
    const documents = await render({}, "embed://apps/projectsend/ProjectSend.database.yaml");
    assert.equal(documents.find((document) => document.kind === "Database").spec.cleanupPolicy, "Skip");
  });

  it("is what ProjectSend connects to", async () => {
    const [mariadb] = await render({}, "embed://apps/office/MariaDB.yaml");
    const [config] = await render({}, "embed://apps/projectsend/ProjectSend.config.yaml");
    assert.equal(config.data.DB_HOST, mariadb.metadata.name);
    assert.equal(config.data.DB_DATABASE, "projectsend");
  });

  it("has a root password the operator's package makes, in the MariaDB's namespace", async () => {
    const [mariadb] = await render({}, "embed://apps/office/MariaDB.yaml");
    const root = MARIADB.secrets!.find((each) => each.name === mariadb.spec.rootPasswordSecretKeyRef.name)!;
    assert.equal(root.namespace, mariadb.metadata.namespace);
    assert.equal(mariadb.spec.rootPasswordSecretKeyRef.generate, false);
  });

  it("is waited for before ProjectSend, by the name the operator gives its StatefulSet", async () => {
    const [mariadb] = await render({}, "embed://apps/office/MariaDB.yaml");
    assert.equal(PROJECTSEND.rollout![0], `statefulset/${mariadb.metadata.name}`);
    assert.ok(PROJECTSEND.rollout!.includes("statefulset/redis"));
    assert.equal(PROJECTSEND.rollout!.at(-1), "deployment/projectsend");
  });
});

describe("ProjectSend's share of the Redis", () => {
  it("is databases no other application uses", async () => {
    const [config] = await render({}, "embed://apps/projectsend/ProjectSend.config.yaml");
    const ours = [config.data.REDIS_DB, config.data.REDIS_CACHE_DB];
    assert.equal(new Set(ours).size, 2);

    const others = await render(
      {},
      "embed://apps/twenty/Twenty.yaml",
      "embed://apps/lago/Lago.config.yaml",
      "embed://apps/plane/Plane.config.yaml",
    );
    const used: string[] = JSON.stringify(others).match(/redis:6379\/(\d+)/g) ?? [];
    for (const each of ours) {
      assert.ok(!used.includes(`redis:6379/${each}`), `database ${each} is someone else's`);
    }
  });
});

describe("ProjectSend's client in Authentik", () => {
  it("sends people back to where ProjectSend takes them, on its hostname", async () => {
    const [blueprint] = await render({}, "embed://apps/projectsend/ProjectSend.blueprint.yaml");
    const provider = blueprint.entries.find((entry: any) => entry.model === "authentik_providers_oauth2.oauth2provider");
    assert.deepEqual(
      provider.attrs.redirect_uris.map((each: any) => each.url),
      ["https://files.example.test/auth/oidc/callback"],
    );
  });

  it("is the application ProjectSend is pointed at", async () => {
    const [blueprint] = await render({}, "embed://apps/projectsend/ProjectSend.blueprint.yaml");
    const [config] = await render({}, "embed://apps/projectsend/ProjectSend.config.yaml");
    const application = blueprint.entries.find((entry: any) => entry.model === "authentik_core.application");

    assert.equal(application.identifiers.slug, PROJECTSEND.authentik!.slug);
    assert.equal(config.data.CC_OIDC_ISSUER, `https://auth.example.test/application/o/${PROJECTSEND.authentik!.slug}`);
  });
});

describe("installing ProjectSend", () => {
  it("brings the MariaDB operator, after its resource types, and the Redis", async () => {
    const config = await loadFixtureConfig({ packages: { projectsend: true } });
    const order = await withoutConsole(() => resolveInstallOrder(config).map((entry) => entry.name));

    assert.ok(order.indexOf("mariadb-operator-crds") < order.indexOf("mariadb-operator"));
    assert.ok(order.indexOf("mariadb-operator") < order.indexOf("projectsend"));
    assert.ok(order.indexOf("redis-operator") < order.indexOf("projectsend"));
  });

  it("doesn't bring SeaweedFS, which only a bucket needs", async () => {
    const config = await loadFixtureConfig({ packages: { projectsend: true } });
    const order = await withoutConsole(() => resolveInstallOrder(config).map((entry) => entry.name));
    assert.ok(!order.includes("seaweedfs"));
  });

  it("goes after SeaweedFS when that's being installed too", async () => {
    const config = await loadFixtureConfig({ packages: { projectsend: true, seaweedfs: true } });
    const order = await withoutConsole(() => resolveInstallOrder(config).map((entry) => entry.name));
    assert.ok(order.indexOf("seaweedfs") < order.indexOf("projectsend"));
  });

  it("makes its credentials before anything starts", () => {
    const names = buildPackageCommands(PROJECTSEND).map((command) => command.name);
    const firstManifest = names.findIndex((each) => each.startsWith("helm-manifest-after-"));

    for (const secret of PROJECTSEND.secrets!) {
      const made = names.findIndex((each) => each.startsWith(`create-secret-cc-office-${secret.name}`));
      assert.ok(made >= 0 && made < firstManifest, secret.name);
    }
  });
});

describe("the mariadb bundle", () => {
  it("installs the resource types, then the operator, checking for Helm once", async () => {
    const config = await loadFixtureConfig();
    const names = buildPackagesBundle(["mariadb-operator-crds", "mariadb-operator"])(config).map(
      (command) => command.name,
    );

    assert.equal(names.filter((each) => each === "check-helm-available").length, 1);
    assert.equal(new Set(names).size, names.length);

    const crds = names.findIndex((each) => each.startsWith("helm-install-mariadb-operator-crds"));
    const operator = names.findIndex((each) => each === "helm-install-mariadb-operator");
    assert.ok(crds >= 0 && operator > crds, names.join("\n"));
  });
});
