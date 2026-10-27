/**
 * @file
 * Cirrus, as the installer puts it on a cluster.
 *
 * Cirrus's own behaviour is tested in Rust, in operators/cirrus. What
 * can go wrong here is the seam: the services it provisions through
 * not being installed first, the ServiceAccount the Deployment runs as
 * not being the one the ClusterRole is bound to, the webhook address
 * it registers with GitLab not being the one the Gateway routes, or
 * the route exposing more of Cirrus than its webhooks.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseAllDocuments } from "yaml";

import { buildPackageCommands } from "../cli/commands/Helm.ts";
import { getPackage, resolveInstallOrder } from "../cli/commands/packages.ts";
import { renderInstallerFile } from "../util/template.ts";
import { loadFixtureConfig, withoutConsole } from "./helpers.ts";

const CIRRUS = getPackage("cirrus")!;

/**
 * Every document in some manifests, rendered as an install would.
 *
 * @param paths
 * @returns
 */
async function render(...paths: string[]): Promise<any[]> {
  const config = await loadFixtureConfig();
  return paths.flatMap((path) =>
    parseAllDocuments(renderInstallerFile(config, path, { templateNamespace: "community-cloud" })).map((document) => {
      assert.deepEqual(document.errors, [], path);
      return document.toJS();
    }),
  );
}

describe("installing Cirrus", () => {
  it("comes after every service it provisions through", async () => {
    const config = await loadFixtureConfig({ packages: { cirrus: true } });
    const order = await withoutConsole(() => resolveInstallOrder(config).map((entry) => entry.name));

    for (const dependency of ["cert-manager", "cloudnative-pg", "seaweedfs", "rabbitmq-operator"]) {
      assert.ok(order.includes(dependency), dependency);
      assert.ok(order.indexOf(dependency) < order.indexOf("cirrus"), dependency);
    }
  });

  it("applies the CRD before the operator that watches it", () => {
    const names = buildPackageCommands(CIRRUS).map((command) => command.name);
    const crd = names.findIndex((name) => name.includes("cirrus-crd"));
    const operator = names.findIndex((name) => name.includes("manifest-after") && name.endsWith("cirrus-cirrus"));

    assert.ok(crd >= 0 && operator >= 0, names.join("\n"));
    assert.ok(crd < operator);
  });

  it("defines WebApplication, with the short name webapp", async () => {
    const [crd] = await render(...CIRRUS.manifests!.before!.filter((path) => path.endsWith("Cirrus.crd.yaml")));

    assert.equal(crd.kind, "CustomResourceDefinition");
    assert.equal(crd.spec.group, "community-cloud.technology");
    assert.equal(crd.spec.names.kind, "WebApplication");
    assert.deepEqual(crd.spec.names.shortNames, ["webapp"]);
    assert.equal(crd.spec.scope, "Namespaced");
  });

  it("runs as the ServiceAccount its ClusterRole is bound to", async () => {
    const documents = await render(
      "embed://operators/cirrus/Cirrus.rbac.yaml",
      "embed://operators/cirrus/Cirrus.yaml",
    );
    const deployment = documents.find((each) => each.kind === "Deployment");
    const binding = documents.find((each) => each.kind === "ClusterRoleBinding");

    assert.equal(deployment.metadata.namespace, "community-cloud");
    assert.deepEqual(binding.subjects, [
      { kind: "ServiceAccount", name: deployment.spec.template.spec.serviceAccountName, namespace: "community-cloud" },
    ]);
    assert.match(deployment.spec.template.spec.containers[0].image, /^ghcr\.io\/mellow-technology\/cirrus:\d+\.\d+\.\d+$/);
  });

  it("registers webhooks on the hostname the Gateway routes to it, and routes nothing else", async () => {
    const documents = await render(
      "embed://operators/cirrus/Cirrus.yaml",
      "embed://operators/cirrus/Cirrus.network.yaml",
    );
    const container = documents.find((each) => each.kind === "Deployment").spec.template.spec.containers[0];
    const baseUrl = container.env.find((each: any) => each.name === "CIRRUS_WEBHOOK_BASE_URL").value;
    const route = documents.find((each) => each.kind === "HTTPRoute" && each.metadata.name === "cirrus");

    assert.equal(baseUrl, "https://cirrus.example.test");
    assert.deepEqual(route.spec.hostnames, ["cirrus.example.test"]);
    assert.deepEqual(
      route.spec.rules.flatMap((rule: any) => rule.matches.map((match: any) => match.path.value)),
      ["/hooks/"],
    );
  });
});
