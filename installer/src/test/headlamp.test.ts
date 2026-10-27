/**
 * @file
 * Headlamp, signed into through Authentik, with Community Cloud's own
 * plugins.
 *
 * Three things have to agree for anyone to get in, and they're written
 * in three places: the client Authentik is told about, what Headlamp
 * asks Authentik for, and what K3s's API server accepts. A mismatch in
 * any of them is a sign in that works and then a Headlamp that can see
 * nothing, which on a laptop looks like success. So they're checked
 * against each other here, along with the order the install happens
 * in and the plugins it carries.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parse, parseAllDocuments } from "yaml";

import { buildPackageCommands } from "../cli/commands/Helm.ts";
import { getPackage } from "../cli/commands/packages.ts";
import {
  AUTHENTICATION_CONFIG_PATH,
  AUTHENTIK_PREFIX,
  CLUSTER_CLIENT_ID,
  buildApiServerAuthArgs,
  buildAuthenticationConfig,
  getClusterIssuer,
} from "../cli/commands/ClusterSignIn.ts";
import { K3sCommands } from "../cli/commands/K3s.ts";
import { checkConfiguration } from "../runners/preflight.ts";
import { listEmbeddedFiles } from "../util/embedded.ts";
import { renderInstallerFile } from "../util/template.ts";
import { configFrom, loadFixtureConfig } from "./helpers.ts";

const HEADLAMP = getPackage("headlamp")!;

/**
 * Every document in some manifests, rendered as an install would.
 */
async function render(...paths: string[]): Promise<any[]> {
  const config = await loadFixtureConfig({ packages: { headlamp: true } });
  return paths.flatMap((path) =>
    parseAllDocuments(renderInstallerFile(config, path, { templateNamespace: "community-cloud" })).map((document) => {
      assert.deepEqual(document.errors, [], path);
      return document.toJS();
    }),
  );
}

describe("installing Headlamp", () => {
  const names = buildPackageCommands(HEADLAMP).map((command) => command.name);
  const position = (prefix: string) => names.findIndex((each) => each.startsWith(prefix));

  it("checks Authentik is there before anything else", () => {
    assert.equal(names[0], "require-authentik-headlamp");
  });

  it("has its plugins, its client's credentials and Authentik's client before the chart", () => {
    const chart = position("helm-install-headlamp");
    assert.ok(position("helm-manifest-before-headlamp-Headlamp-plugins") < chart);
    assert.ok(position("create-secret-community-cloud-headlamp-oidc") < chart);
    assert.ok(position("authentik-blueprint-headlamp") < chart);
  });

  it("makes its namespace before its credentials", () => {
    assert.ok(position("namespace-headlamp") < position("create-secret-community-cloud-headlamp-oidc"));
  });

  it("is a client with the fixed ID the API server is told", () => {
    const secret = HEADLAMP.secrets!.find((each) => each.name === HEADLAMP.authentik!.secret)!;
    assert.equal(secret.username, CLUSTER_CLIENT_ID);
    assert.equal(HEADLAMP.authentik!.slug, CLUSTER_CLIENT_ID);
  });

  it("goes through no gate, since it signs people in itself", () => {
    assert.equal(HEADLAMP.gate, undefined);
  });
});

describe("Headlamp, Authentik and the API server agreeing", async () => {
  const [values] = await render(HEADLAMP.valuesFile!);
  const env = new Map<string, any>(values.env.map((each: any) => [each.name, each.value ?? each.valueFrom]));
  const [blueprint] = await render("embed://apps/headlamp/Headlamp.blueprint.yaml");
  const provider = blueprint.entries.find((entry: any) => entry.model === "authentik_providers_oauth2.oauth2provider");
  const config = await loadFixtureConfig({ packages: { headlamp: true } });

  it("asks the issuer the API server trusts", () => {
    assert.equal(env.get("OIDC_ISSUER_URL"), getClusterIssuer(config));
    assert.equal(getClusterIssuer(config), "https://auth.example.test/application/o/headlamp/");
  });

  it("is sent back where Authentik allows", () => {
    assert.deepEqual(provider.attrs.redirect_uris.map((uri: any) => uri.url), [env.get("OIDC_CALLBACK_URL")]);
  });

  it("reads its client from the Secret the installer makes", () => {
    assert.deepEqual(env.get("OIDC_CLIENT_ID"), { secretKeyRef: { name: "headlamp-oidc", key: "username" } });
    assert.deepEqual(env.get("OIDC_CLIENT_SECRET"), { secretKeyRef: { name: "headlamp-oidc", key: "password" } });
    assert.equal(values.config.oidc.externalSecret.name, "headlamp-oidc");
  });

  it("signs tokens with a key the API server can check", () => {
    assert.ok(JSON.stringify(provider.attrs.signing_key).includes("authentik Self-signed Certificate"));
  });

  it("hands over the username and groups the API server reads", () => {
    assert.match(env.get("OIDC_SCOPES"), /\bprofile\b/);
    assert.ok(JSON.stringify(provider.attrs.property_mappings).includes("scope-profile"));
  });

  it("gives Headlamp's own account nothing", () => {
    assert.equal(values.clusterRoleBinding.create, false);
  });
});

/**
 * The API server's sign in settings for a configuration, parsed.
 *
 * @param config
 * @returns
 */
function authenticationFor(config: any): any {
  const text = buildAuthenticationConfig(config);
  return text === undefined ? undefined : parse(text);
}

describe("the API server trusting Authentik", async () => {
  const fixture = await loadFixtureConfig();
  const withHeadlamp = await loadFixtureConfig({ packages: { headlamp: true } });

  it("does, for Headlamp's client, when Headlamp is enabled", () => {
    const [authenticator] = authenticationFor(withHeadlamp).jwt;
    assert.equal(authenticator.issuer.url, "https://auth.example.test/application/o/headlamp/");
    assert.deepEqual(authenticator.issuer.audiences, [CLUSTER_CLIENT_ID]);
    assert.deepEqual(buildApiServerAuthArgs(withHeadlamp), [`--kube-apiserver-arg=authentication-config=${AUTHENTICATION_CONFIG_PATH}`]);
  });

  it("names people by their Authentik username, with a prefix no group of the cluster's own has", () => {
    const { claimMappings } = authenticationFor(withHeadlamp).jwt[0];
    assert.deepEqual(claimMappings.username, { claim: "preferred_username", prefix: AUTHENTIK_PREFIX });
    assert.deepEqual(claimMappings.groups, { claim: "groups", prefix: AUTHENTIK_PREFIX });
  });

  it("only lets in members of a k8s- group", () => {
    const [rule] = authenticationFor(withHeadlamp).jwt[0].userValidationRules;
    assert.match(rule.expression, /startsWith\('authentik:k8s-'\)/);
  });

  it("also trusts the clients the configuration lists, such as one for kubectl", () => {
    const raw = { ...withHeadlamp.getConfig(), k3s: { token: "t", signInClients: [{ application: "community-cloud-prime", clientId: "kubernetes" }] } };
    const issuers = authenticationFor(configFrom(raw)).jwt.map((each: any) => [each.issuer.url, each.issuer.audiences]);
    assert.deepEqual(issuers, [
      ["https://auth.example.test/application/o/headlamp/", ["headlamp"]],
      ["https://auth.example.test/application/o/community-cloud-prime/", ["kubernetes"]],
    ]);
  });

  it("makes two clients of one application one issuer, which is all the API server allows", () => {
    const raw = { ...withHeadlamp.getConfig(), k3s: { token: "t", signInClients: [{ application: "headlamp", clientId: "kubectl" }] } };
    const { jwt } = authenticationFor(configFrom(raw));
    assert.equal(jwt.length, 1);
    assert.deepEqual(jwt[0].issuer.audiences, ["headlamp", "kubectl"]);
    assert.equal(jwt[0].issuer.audienceMatchPolicy, "MatchAny");
  });

  it("trusts a listed client without Headlamp", () => {
    const raw = { ...fixture.getConfig(), k3s: { token: "t", signInClients: [{ application: "cluster", clientId: "kubernetes" }] } };
    assert.equal(authenticationFor(configFrom(raw)).jwt.length, 1);
  });

  it("doesn't, with nothing to trust it for", async () => {
    assert.equal(buildAuthenticationConfig(fixture), undefined);
    assert.deepEqual(buildApiServerAuthArgs(fixture), []);
    assert.deepEqual(buildApiServerAuthArgs(await loadFixtureConfig({ packages: { headlamp: { enabled: false } } })), []);
  });

  it("doesn't, with no Authentik to trust", () => {
    const raw = JSON.parse(JSON.stringify(fixture.getConfig()));
    delete raw.values.domain.auth;
    raw.packages = { headlamp: true };
    assert.deepEqual(buildApiServerAuthArgs(configFrom(raw)), []);
  });

  it("is written on the servers before K3s is started there", () => {
    const names = K3sCommands.map((command) => command.name);
    assert.ok(names.indexOf("write-authentication-config") < names.indexOf("install-k3s-server"));
  });
});

describe("who administers the cluster", () => {
  it("is the Authentik group, as the API server names it", async () => {
    const [binding] = await render("embed://apps/headlamp/Headlamp.rbac.yaml");
    assert.equal(binding.roleRef.name, "cluster-admin");
    assert.deepEqual(binding.subjects.map((subject: any) => subject.name), [`${AUTHENTIK_PREFIX}k8s-admins`]);
  });

  it("can be another group", async () => {
    const base = await loadFixtureConfig();
    const config = await loadFixtureConfig({ values: { ...base.getConfig().values, clusterAdminGroup: "k8s-ops" } });
    const [binding] = parseAllDocuments(renderInstallerFile(config, "embed://apps/headlamp/Headlamp.rbac.yaml")).map(
      (document) => document.toJS() as any,
    );
    assert.deepEqual(binding.subjects.map((subject: any) => subject.name), ["authentik:k8s-ops"]);
  });

  it("has to be a group whose members may sign in", async () => {
    const base = await loadFixtureConfig();
    const raw = { ...base.getConfig(), packages: { headlamp: true }, values: { ...base.getConfig().values, clusterAdminGroup: "ops" } };
    const problems = checkConfiguration(configFrom(raw)).map((problem) => problem.what);
    assert.ok(problems.some((problem) => problem.includes("clusterAdminGroup")), problems.join("\n"));
  });
});

describe("the plugins Headlamp is given", async () => {
  const carried = [
    ...new Set(
      listEmbeddedFiles()
        .filter((path) => path.startsWith("headlamp-plugins/"))
        .map((path) => path.split("/")[1]!),
    ),
  ];
  const configMaps = (await render("embed://apps/headlamp/Headlamp.plugins.yaml")).filter(
    (document) => document.binaryData !== undefined,
  );
  const [values] = await render(HEADLAMP.valuesFile!);
  const sources = values.volumes[0].projected.sources.map((source: any) => source.configMap);

  it("are the ones in the repository, built", () => {
    assert.deepEqual(carried, ["cc-cumulus-theme", "cc-storage-explorer"]);
  });

  it("are each in a ConfigMap with both files", () => {
    assert.deepEqual(
      configMaps.map((map) => [map.metadata.name, Object.keys(map.binaryData).sort()]),
      carried.map((name) => [`headlamp-plugin-${name}`, ["main.js", "package.json"]]),
    );
  });

  it("are each mounted as a folder of its own, where Headlamp looks", () => {
    assert.deepEqual(
      sources.map((source: any) => [source.name, source.items.map((item: any) => item.path)]),
      carried.map((name) => [`headlamp-plugin-${name}`, [`${name}/main.js`, `${name}/package.json`]]),
    );
    assert.equal(values.volumeMounts[0].mountPath, values.config.pluginsDir);
  });

  it("restart Headlamp when they change", () => {
    assert.match(values.podAnnotations["community-cloud/headlamp-plugins"], /^[0-9a-f]{16}$/);
  });
});
