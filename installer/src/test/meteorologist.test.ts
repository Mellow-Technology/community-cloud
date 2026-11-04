/**
 * @file
 * Meteorologist, as the installer puts it on a cluster, and the bundle
 * that has a running cluster's API server trust it.
 *
 * Meteorologist's own behaviour is tested in ui/meteorologist. What
 * can go wrong here is what has to agree across files for anyone to
 * sign in: the client Authentik is told about, the issuer and client
 * Meteorologist asks for, the callback it's sent back to, and what the
 * API server accepts. And, since it acts as whoever signed in, that
 * its pod has no access of its own to fall back on.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse, parseAllDocuments } from "yaml";

import { CommandSpec } from "../cli/commands/Command.ts";
import { buildPackageCommands } from "../cli/commands/Helm.ts";
import { getPackage } from "../cli/commands/packages.ts";
import {
  AUTHENTICATION_CONFIG_PATH,
  CLUSTER_GROUP_PREFIX,
  METEOROLOGIST_CLIENT_ID,
  buildAuthenticationConfig,
  getClusterIssuer,
} from "../cli/commands/ClusterSignIn.ts";
import { ClusterSignInCommands, K3sCommands } from "../cli/commands/K3s.ts";
import { bundles } from "../cli/commands/bundles.ts";
import { renderInstallerFile } from "../util/template.ts";
import { REPO_ROOT, loadFixtureConfig, makeTempDirectory } from "./helpers.ts";

const METEOROLOGIST = getPackage("meteorologist")!;

/**
 * Every document in some manifests, rendered as an install would.
 *
 * @param paths
 * @returns
 */
async function render(...paths: string[]): Promise<any[]> {
  const config = await loadFixtureConfig({ packages: { meteorologist: true } });
  return paths.flatMap((path) =>
    parseAllDocuments(renderInstallerFile(config, path, { templateNamespace: "community-cloud" })).map((document) => {
      assert.deepEqual(document.errors, [], path);
      return document.toJS();
    }),
  );
}

/**
 * A container's environment, by name, with references kept as they are.
 *
 * @param container
 * @returns
 */
function envOf(container: any): any {
  return Object.fromEntries(container.env.map((each: any) => [each.name, each.value ?? each.valueFrom]));
}

describe("installing Meteorologist", () => {
  const names = buildPackageCommands(METEOROLOGIST).map((command) => command.name);
  const position = (prefix: string) => names.findIndex((each) => each.startsWith(prefix));

  it("has its credentials and Authentik's client before it starts", () => {
    const deployment = position("helm-manifest-after-meteorologist-meteorologist");
    assert.ok(deployment > 0, names.join("\n"));
    assert.ok(position("create-secret-community-cloud-meteorologist-oidc") < deployment);
    assert.ok(position("create-secret-community-cloud-meteorologist-session") < deployment);
    assert.ok(position("apply-blueprint-meteorologist") < deployment, names.join("\n"));
  });

  it("asks Authentik for the client, issuer and callback Authentik is told about", async () => {
    const config = await loadFixtureConfig({ packages: { meteorologist: true } });
    const [deployment] = (await render("embed://apps/meteorologist/Meteorologist.yaml")).filter(
      (each) => each.kind === "Deployment",
    );
    const env = envOf(deployment.spec.template.spec.containers[0]);
    const blueprint = parse(
      renderInstallerFile(config, "embed://apps/meteorologist/Meteorologist.blueprint.yaml", {
        templateNamespace: "community-cloud",
      }).replace(/!(Context|Find|KeyOf)/g, ""),
    );
    const provider = blueprint.entries.find((entry: any) => entry.model.endsWith("oauth2provider"));
    const application = blueprint.entries.find((entry: any) => entry.model === "authentik_core.application");

    assert.equal(env.OIDC_ISSUER, getClusterIssuer(config, METEOROLOGIST_CLIENT_ID));
    assert.equal(application.identifiers.slug, METEOROLOGIST_CLIENT_ID);
    assert.deepEqual(env.OIDC_CLIENT_ID, { secretKeyRef: { name: "meteorologist-oidc", key: "username" } });
    const secret = METEOROLOGIST.secrets!.find((each) => each.name === "meteorologist-oidc")!;
    assert.equal(secret.username, METEOROLOGIST_CLIENT_ID);
    assert.deepEqual(provider.attrs.redirect_uris, [
      { matching_mode: "strict", url: `${env.METEOROLOGIST_URL}/auth/callback` },
    ]);
    assert.equal(env.METEOROLOGIST_URL, "https://meteorologist.example.test");
  });

  it("lets in, at Authentik, only those the API server will", async () => {
    const config = await loadFixtureConfig({ packages: { meteorologist: true } });
    const { entries } = parse(
      renderInstallerFile(config, "embed://apps/meteorologist/Meteorologist.blueprint.yaml", {
        templateNamespace: "community-cloud",
      }).replace(/!(Context|Find|KeyOf)/g, ""),
    );
    const application = entries.find((entry: any) => entry.model === "authentik_core.application");
    const policy = entries.find((entry: any) => entry.model === "authentik_policies_expression.expressionpolicy");
    const binding = entries.find((entry: any) => entry.model === "authentik_policies.policybinding");

    assert.deepEqual(binding.identifiers, { target: application.id, policy: policy.id });
    assert.equal(
      policy.attrs.expression.trim(),
      `return request.user.groups.filter(name__startswith="${CLUSTER_GROUP_PREFIX}").exists()`,
    );
    // The API server's rule is that prefix too, after Authentik's own
    const { jwt } = parse(buildAuthenticationConfig(config)!);
    assert.match(jwt[0].userValidationRules[0].expression, new RegExp(`'authentik:${CLUSTER_GROUP_PREFIX}'`));
  });

  it("is trusted by the API server once it's enabled", async () => {
    const config = await loadFixtureConfig({ packages: { meteorologist: true } });
    const { jwt } = parse(buildAuthenticationConfig(config)!);
    assert.deepEqual(
      jwt.map((each: any) => [each.issuer.url, each.issuer.audiences]),
      [[getClusterIssuer(config, METEOROLOGIST_CLIENT_ID), [METEOROLOGIST_CLIENT_ID]]],
    );
  });

  it("has no ServiceAccount token, only the API server's address and CA", async () => {
    const documents = await render("embed://apps/meteorologist/Meteorologist.yaml");
    const account = documents.find((each) => each.kind === "ServiceAccount");
    const pod = documents.find((each) => each.kind === "Deployment").spec.template.spec;
    const env = envOf(pod.containers[0]);

    assert.equal(account.automountServiceAccountToken, false);
    assert.equal(pod.automountServiceAccountToken, false);
    assert.equal(pod.serviceAccountName, account.metadata.name);
    assert.equal(env.METEOROLOGIST_KUBE_MODE, "user");
    assert.equal(env.KUBE_API_SERVER, "https://kubernetes.default.svc");
    const caVolume = pod.volumes.find((each: any) => each.configMap?.name === "kube-root-ca.crt");
    const mount = pod.containers[0].volumeMounts.find((each: any) => each.name === caVolume.name);
    assert.equal(env.KUBE_CA_FILE, `${mount.mountPath}/ca.crt`);
    assert.match(pod.containers[0].image, /^ghcr\.io\/mellow-technology\/meteorologist:\d+\.\d+\.\d+$/);
  });

  it("is routed on its own hostname, to its Service", async () => {
    const documents = await render(
      "embed://apps/meteorologist/Meteorologist.yaml",
      "embed://apps/meteorologist/Meteorologist.network.yaml",
    );
    const service = documents.find((each) => each.kind === "Service");
    const route = documents.find((each) => each.kind === "HTTPRoute" && each.metadata.name === "meteorologist");
    assert.deepEqual(route.spec.hostnames, ["meteorologist.example.test"]);
    assert.deepEqual(route.spec.rules[0].backendRefs, [{ name: service.metadata.name, port: service.spec.ports[0].port }]);
  });
});

describe("the cluster-sign-in bundle", () => {
  it("is the sign in steps of the k3s bundle, and nothing that touches K3s", () => {
    const names = ClusterSignInCommands.map((command) => command.name);
    assert.deepEqual(names, ["write-authentication-config", "verify-authentication-config"]);
    const bundle = bundles.find((each) => each.name === "cluster-sign-in")!;
    assert.deepEqual((bundle.commands as CommandSpec[]).map((command) => command.name), names);
    const k3s = K3sCommands.map((command) => command.name);
    assert.ok(k3s.indexOf("verify-authentication-config") < k3s.indexOf("install-k3s-server"));
  });

  /**
   * The check's script, run against a pretend /etc with sudo doing
   * nothing, so what it says is what a server would say.
   *
   * @param files what's in /etc, by path under it
   * @param expected what the configuration says the settings are
   * @returns its exit status and what it printed
   */
  function check(files: Record<string, string>, expected = "jwt: []\n") {
    const verify = ClusterSignInCommands.find((command) => command.name === "verify-authentication-config")!;
    const root = makeTempDirectory("cluster-sign-in");
    try {
      for (const [path, contents] of Object.entries(files)) {
        const full = join(root.path, path);
        mkdirSync(join(full, ".."), { recursive: true });
        // Paths in what's written point into the pretend /etc too
        writeFileSync(full, contents.replaceAll("/etc/", `${root.path}/etc/`));
      }
      const script = ((verify as { command: string[] }).command).join("\n").replaceAll("/etc/", `${root.path}/etc/`);
      try {
        const output = execFileSync("/bin/sh", ["-c", `sudo() { "$@"; }\n${script}`], {
          input: expected,
          encoding: "utf8",
          stdio: ["pipe", "pipe", "pipe"],
        });
        return { status: 0, output };
      } catch (error: any) {
        return { status: error.status as number, output: `${error.stdout}${error.stderr}` };
      }
    } finally {
      root.remove();
    }
  }

  const ours = `'--kube-apiserver-arg=authentication-config=${AUTHENTICATION_CONFIG_PATH}' \\\n`;
  const unit = `[Service]\nExecStart=/usr/local/bin/k3s \\\n    server \\\n    ${ours}`;

  it("passes when K3s hands the API server the file, and it's current", () => {
    const result = check({ "etc/systemd/system/k3s.service": unit, "etc/rancher/k3s/authentication.yaml": "jwt: []\n" });
    assert.equal(result.status, 0, result.output);
    assert.match(result.output, /reads \S*\/etc\/rancher\/k3s\/authentication.yaml, and it's current/);
  });

  it("says when the file is stale", () => {
    const result = check({ "etc/systemd/system/k3s.service": unit, "etc/rancher/k3s/authentication.yaml": "jwt: [old]\n" });
    assert.notEqual(result.status, 0);
    assert.match(result.output, /Run the cluster-sign-in bundle to rewrite it/);
  });

  it("says when K3s was never told to read it", () => {
    const result = check({
      "etc/systemd/system/k3s.service": "[Service]\nExecStart=/usr/local/bin/k3s server\n",
      "etc/rancher/k3s/authentication.yaml": "jwt: []\n",
    });
    assert.notEqual(result.status, 0);
    assert.match(result.output, /isn't started with authentication-config/);
  });

  it("names a hand-written setting that would win over the installer's", () => {
    const result = check({
      "etc/systemd/system/k3s.service": unit,
      "etc/rancher/k3s/authentication.yaml": "jwt: []\n",
      "etc/rancher/k3s/config.yaml.d/oidc.yaml": 'kube-apiserver-arg:\n  - "authentication-config=/etc/rancher/k3s/oidc-auth.yaml"\n',
    });
    assert.notEqual(result.status, 0);
    assert.match(result.output, /config\.yaml\.d\/oidc\.yaml:authentication-config=\S*\/etc\/rancher\/k3s\/oidc-auth\.yaml/);
  });
});

// The release script sets the pinned image, so a moved line would
// leave it setting nothing
it("pins the image where scripts/release/meteorologist.ts looks for it", () => {
  const manifest = readFileSync(join(REPO_ROOT, "k8s/apps/meteorologist/Meteorologist.yaml"), "utf8");
  assert.match(manifest, /image:\s*ghcr\.io\/mellow-technology\/meteorologist:\S+/);
});
