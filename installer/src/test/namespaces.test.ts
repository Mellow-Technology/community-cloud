/**
 * @file
 * Which namespace each kind of package goes in.
 *
 * cc-office is for the applications, and community-cloud for what runs
 * the cluster, operators included — unless an operator's project says
 * to give it a namespace of its own. That's easy to get wrong when
 * adding an operator, by putting it next to the first thing that uses
 * it, so these hold the catalogue to it. See the top of packages.ts.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseAllDocuments } from "yaml";

import { CLUSTER_NAMESPACE, getPackage, packageCatalogue, resolveInstallOrder } from "../cli/commands/packages.ts";
import { renderInstallerFile } from "../util/template.ts";
import { configFrom } from "./helpers.ts";

// The operators whose own projects say where they go, and the
// namespace each is in. Anything else that's an operator belongs in
// community-cloud.
const OWN_NAMESPACE: Record<string, string> = {
  "cert-manager": "cert-manager",
  "cloudnative-pg": "cnpg-system",
  // The vendored manifests name it themselves
  "rabbitmq-operator": "rabbitmq-system",
  topolvm: "topolvm-system",
  // With the cluster it runs, which is labelled for the Gateway
  seaweedfs: "seaweedfs",
  "tailscale-operator": "tailscale",
};

/**
 * Whether a package installs an operator, by its name or its chart's.
 *
 * @param name
 * @returns
 */
function isOperator(name: string): boolean {
  const definition = getPackage(name)!;
  return /operator/.test(definition.name) || /operator/.test(definition.chart?.name ?? "");
}

describe("where packages go", () => {
  it("puts no operator in cc-office", () => {
    const misplaced = packageCatalogue
      .filter((definition) => definition.namespace === "cc-office" && isOperator(definition.name))
      .map((definition) => definition.name);
    assert.deepEqual(misplaced, []);
  });

  it("puts operators in community-cloud unless their project says otherwise", () => {
    for (const definition of packageCatalogue.filter((each) => isOperator(each.name))) {
      const expected = OWN_NAMESPACE[definition.name] ?? CLUSTER_NAMESPACE;
      assert.equal(definition.namespace, expected, definition.name);
    }
  });

  it("keeps the exceptions where their projects put them", () => {
    for (const [name, namespace] of Object.entries(OWN_NAMESPACE)) {
      assert.equal(getPackage(name)?.namespace, namespace, name);
    }
  });

  it("installs the Mattermost operator before the installation it runs", () => {
    const order = resolveInstallOrder(configFrom({ packages: { mattermost: true } })).map((each) => each.name);
    assert.ok(order.includes("mattermost-operator"));
    assert.ok(order.indexOf("mattermost-operator") < order.indexOf("mattermost"));
  });

  it("puts Headlamp with what runs the cluster, in a namespace the Gateway lets it attach from", () => {
    assert.equal(getPackage("headlamp")!.namespace, CLUSTER_NAMESPACE);

    const config = configFrom({});
    const [namespace] = parseAllDocuments(
      renderInstallerFile(config, "embed://networking/cilium/gateway/Gateway.namespace.yaml"),
    ).map((document) => document.toJS());
    const gateway = parseAllDocuments(renderInstallerFile(config, "embed://networking/cilium/gateway/Gateway.yaml"))
      .map((document) => document.toJS())
      .find((document) => document?.kind === "Gateway");

    assert.equal(namespace.metadata.name, CLUSTER_NAMESPACE);
    for (const [label, value] of Object.entries(gateway.spec.allowedListeners.namespaces.selector.matchLabels)) {
      assert.equal(namespace.metadata.labels[label], value, label);
    }
  });
});
