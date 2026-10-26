/**
 * @file
 * The buckets applications keep their files in, and the way browsers
 * reach them.
 *
 * Each application's bucket is three requests to the SeaweedFS
 * operator, and the application reads the keys it's given from a
 * Secret the operator writes. Nothing on a laptop notices when the
 * names in those don't line up — the pod just waits for a Secret that
 * never arrives — so they're checked here, for every application with
 * a bucket.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { parseAllDocuments } from "yaml";

import { TerminalCommandSpec, joinCommand } from "../cli/commands/Command.ts";
import { buildCreateSecretCommand, buildVerifySecretsCommand } from "../cli/commands/Secrets.ts";
import { getPackage } from "../cli/commands/packages.ts";
import { renderInstallerFile } from "../util/template.ts";
import { loadFixtureConfig } from "./helpers.ts";

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
 * The Secret names and keys a set of documents reads, wherever they
 * read them — a pod's env, or a chart's values.
 */
function secretKeyRefs(value: any): [string, string][] {
  if (Array.isArray(value)) {
    return value.flatMap(secretKeyRefs);
  }
  if (value === null || typeof value !== "object") {
    return [];
  }
  if (value.secretKeyRef !== undefined) {
    return [[value.secretKeyRef.name, value.secretKeyRef.key]];
  }
  return Object.values(value).flatMap(secretKeyRefs);
}

// Most read the keys from the Secret themselves. Mattermost names the
// Secret to its operator, which reads it under its own key names.
const APPLICATIONS: { name: string; bucket: string; uses: string[]; operatorReads?: boolean }[] = [
  { name: "Lago", bucket: "embed://apps/lago/Lago.bucket.yaml", uses: ["embed://apps/lago/Lago.yaml"] },
  { name: "Twenty", bucket: "embed://apps/twenty/Twenty.storage.yaml", uses: ["embed://apps/twenty/Twenty.yaml"] },
  {
    name: "Mattermost",
    bucket: "embed://apps/mattermost/Mattermost.storage.yaml",
    uses: ["embed://apps/mattermost/Mattermost.yaml"],
    operatorReads: true,
  },
  {
    name: "Authentik",
    bucket: "embed://apps/authentik/Authentik.storage.yaml",
    uses: ["embed://apps/authentik/Authentik.values.yaml"],
  },
];

describe("an application's bucket", () => {
  for (const application of APPLICATIONS) {
    describe(application.name, async () => {
      const requests = await render(application.bucket);
      const [seaweed] = await render("embed://storage/SeaweedFS/SeaweedFS.yaml");
      const identity = requests.find((document) => document.kind === "S3Identity");
      const credentials = requests.find((document) => document.kind === "S3Credentials");
      const bucket = requests.find((document) => document.kind === "Bucket");

      it("is in the cluster's SeaweedFS", () => {
        const cluster = { name: seaweed.metadata.name, namespace: seaweed.metadata.namespace };
        assert.deepEqual(bucket.spec.clusterRef, cluster);
        assert.deepEqual(identity.spec.seaweedRef, cluster);
        assert.deepEqual(credentials.spec.seaweedRef, cluster);
      });

      it("gives its keys to its own user, and only that user the bucket", () => {
        assert.equal(credentials.spec.identityRef.name, identity.metadata.name);
        assert.deepEqual(
          bucket.spec.access.map((grant: any) => grant.user),
          [identity.metadata.name],
        );
        assert.ok(!bucket.spec.access[0].actions.includes("Admin"));
      });

      it("reads its keys from the Secret the operator writes", async () => {
        if (application.operatorReads === true) {
          const [mattermost] = await render(...application.uses);
          assert.equal(mattermost.spec.fileStore.external.secret, credentials.spec.secretRef.name);
          assert.equal(mattermost.spec.fileStore.external.bucket, bucket.metadata.name);
          assert.equal(credentials.spec.secretRef.accessKeyField, "accesskey");
          assert.equal(credentials.spec.secretRef.secretKeyField, "secretkey");
          return;
        }

        const keys = secretKeyRefs(await render(...application.uses))
          .filter(([name]) => name === credentials.spec.secretRef.name)
          .map(([, key]) => key);

        assert.deepEqual([...new Set(keys)].sort(), ["accessKey", "secretKey"]);
      });

      it("is in a namespace allowed buckets", async () => {
        const [namespace] = await render("embed://apps/office/Office.namespace.yaml");
        assert.equal(bucket.metadata.namespace, namespace.metadata.name);
        assert.equal(namespace.metadata.labels["storage.community-cloud.technology/buckets"], "true");
      });
    });
  }
});

describe("Authentik's links to its files", async () => {
  const values = (await render("embed://apps/authentik/Authentik.values.yaml"))[0];
  const env = new Map<string, any>(values.global.env.map((each: any) => [each.name, each.value]));

  it("talk to SeaweedFS inside the cluster", () => {
    assert.equal(env.get("AUTHENTIK_STORAGE__S3__ENDPOINT"), "http://seaweed-s3.seaweedfs.svc:8333");
    assert.equal(env.get("AUTHENTIK_STORAGE__S3__ADDRESSING_STYLE"), "path");
  });

  it("hand browsers the public hostname, with the bucket in the path", () => {
    assert.equal(env.get("AUTHENTIK_STORAGE__S3__CUSTOM_DOMAIN"), "s3.example.test/authentik");
    assert.equal(env.get("AUTHENTIK_STORAGE__S3__BUCKET_NAME"), "authentik");
    assert.equal(env.get("AUTHENTIK_STORAGE__S3__SECURE_URLS"), "true");
  });
});

describe("S3 from outside the cluster", async () => {
  const documents = await render(
    "embed://storage/SeaweedFS/SeaweedFS.namespace.yaml",
    "embed://storage/SeaweedFS/SeaweedFS.network.yaml",
  );
  const namespace = documents.find((document) => document.kind === "Namespace");
  const listeners = documents.find((document) => document.kind === "ListenerSet");
  const route = documents.find((document) => document.kind === "HTTPRoute" && document.metadata.name === "s3");

  it("is on values.domain.storage", () => {
    assert.deepEqual(
      [...new Set(listeners.spec.listeners.map((listener: any) => listener.hostname))],
      ["s3.example.test"],
    );
  });

  it("goes to the S3 gateway", () => {
    assert.deepEqual(route.spec.rules[0].backendRefs, [{ name: "seaweed-s3", port: 8333 }]);
  });

  it("is in a namespace the cluster Gateway takes listeners from", () => {
    assert.equal(namespace.metadata.name, listeners.metadata.namespace);
    assert.equal(namespace.metadata.labels.whereWereGoing, "weDontNeedRoads");
  });

  it("makes the namespace before the chart can, without the label", () => {
    assert.deepEqual(getPackage("seaweedfs")!.manifests!.before, ["embed://storage/SeaweedFS/SeaweedFS.namespace.yaml"]);
  });

  it("is a hostname preflight asks for", () => {
    assert.ok(getPackage("seaweedfs")!.values!.includes("domain.storage"));
  });
});

describe("a connection string", () => {
  const definition = getPackage("mattermost")!.secrets!.find((each) => each.connectionString !== undefined)!;
  const command = buildCreateSecretCommand(definition, "cc-office") as TerminalCommandSpec;
  const text = joinCommand(command.command as string[]);

  it("is built from the role's own Secret, which CloudNativePG's package makes", () => {
    const roles = getPackage("cloudnative-pg")!.secrets!.map((each) => each.name);
    assert.ok(roles.includes(definition.connectionString!.role));
    assert.match(text, /get secret 'mattermost' -o jsonpath='\{\.data\.password\}' \| base64 -d > "\$work\/password"/);
  });

  it("never has the password on a command line", () => {
    assert.equal(command.stdin, undefined);
    assert.ok(!/\$\(cat "\$work\/password"\)/.test(text));
    assert.match(text, /--from-file=DB_CONNECTION_STRING="\$work\/url"/);
  });

  it("points at the shared cluster's primary, over TLS", () => {
    assert.match(text, /'cc-postgres-rw:5432' 'mattermost' 'sslmode=require/);
  });

  it("follows the role's password, rather than being made once", () => {
    assert.match(text, /kubectl apply -f -/);
    assert.match(text, /label --overwrite secret/);
  });

  it("is shell", () => {
    execFileSync("/bin/sh", ["-n", "-c", text]);
  });

  it("is checked for as the one key the operator reads", () => {
    const verify = joinCommand(
      (buildVerifySecretsCommand([definition], "cc-office", "mattermost") as TerminalCommandSpec).command as string[],
    );
    assert.match(verify, /jsonpath='\{\.type\}:\{\.data\.DB_CONNECTION_STRING\}'/);
    assert.match(verify, / {2}Opaque:\?\*\) /);
  });

  it("is what Mattermost is told to read", async () => {
    const [mattermost] = await render("embed://apps/mattermost/Mattermost.yaml");
    assert.equal(mattermost.spec.database.external.secret, definition.name);
  });
});

describe("Mattermost", async () => {
  const [mattermost] = await render("embed://apps/mattermost/Mattermost.yaml");
  const network = await render("embed://apps/mattermost/Mattermost.network.yaml");
  const env = new Map<string, string>(mattermost.spec.mattermostEnv.map((each: any) => [each.name, each.value]));

  it("runs one server, since more needs a licence", () => {
    assert.equal(mattermost.spec.replicas, 1);
  });

  it("talks to SeaweedFS by host and port, without TLS", () => {
    assert.equal(mattermost.spec.fileStore.external.url, "seaweed-s3.seaweedfs.svc:8333");
    assert.equal(env.get("MM_FILESETTINGS_AMAZONS3SSL"), "false");
  });

  it("is reached through the Gateway rather than an Ingress", () => {
    assert.equal(mattermost.spec.ingress.enabled, false);
    const route = network.find((document) => document.kind === "HTTPRoute" && document.metadata.name === "mattermost");
    const service = network.find((document) => document.kind === "Service");
    assert.deepEqual(route.spec.rules[0].backendRefs, [{ name: service.metadata.name, port: 8065 }]);
    assert.equal(service.spec.selector["installation.mattermost.com/installation"], mattermost.metadata.name);
  });

  it("links to its own hostname", () => {
    assert.equal(env.get("MM_SERVICESETTINGS_SITEURL"), "https://chat.example.test");
  });
});
