/**
 * @file
 * Prometheus, Alertmanager and Grafana.
 *
 * Most of what can go wrong here doesn't fail anything. A Grafana whose
 * client disagrees with Authentik is a sign in that goes nowhere; an
 * Alertmanager with a password in its configuration works perfectly;
 * a monitor pointed at the wrong port is a graph with nothing on it.
 * And the templates here sit next to two other kinds of template,
 * Prometheus's and Grafana's, in the same double braces. So those are
 * what's checked: that the pieces agree with each other, and that what
 * stays private stays out of what's rendered.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseAllDocuments } from "yaml";

import { buildPackageCommands } from "../cli/commands/Helm.ts";
import { CLUSTER_NAMESPACE, getPackage, resolveInstallOrder } from "../cli/commands/packages.ts";
import { renderInstallerFile } from "../util/template.ts";
import type CloudConfig from "../util/CloudConfig.ts";
import { configFrom, loadFixtureConfig } from "./helpers.ts";

const MONITORING = getPackage("monitoring")!;

const MAIL_PASSWORD = "not-a-real-monitoring-password";

/**
 * The fixture, with mail for the namespace monitoring is in.
 */
async function withMail(): Promise<CloudConfig> {
  const raw = (await loadFixtureConfig({ packages: { monitoring: true } })).getConfig();
  return configFrom({
    ...raw,
    smtp: {
      ...raw.smtp,
      namespaces: {
        ...raw.smtp.namespaces,
        [CLUSTER_NAMESPACE]: { username: "fixture-alerts", password: MAIL_PASSWORD },
      },
    },
  });
}

/**
 * Every document in a manifest, rendered as an install would.
 */
function render(config: CloudConfig, path: string): any[] {
  return parseAllDocuments(renderInstallerFile(config, path, { templateNamespace: CLUSTER_NAMESPACE })).map(
    (document) => {
      assert.deepEqual(document.errors, [], path);
      return document.toJS();
    },
  );
}

describe("installing monitoring", () => {
  const names = buildPackageCommands(MONITORING).map((command) => command.name);
  const position = (prefix: string) => names.findIndex((each) => each.startsWith(prefix));

  it("is pinned, since Helm won't upgrade the chart's CRDs", () => {
    assert.match(MONITORING.version!, /^\d+\.\d+\.\d+$/);
  });

  it("runs the cluster, so it's in community-cloud", () => {
    assert.equal(MONITORING.namespace, CLUSTER_NAMESPACE);
  });

  it("doesn't depend on Postgres", async () => {
    const config = await loadFixtureConfig({ packages: { monitoring: true } });
    const order = resolveInstallOrder(config, true).map((each) => each.name);
    assert.ok(!order.includes("cloudnative-pg"), order.join(", "));
  });

  it("goes after what it watches when they're installed together", async () => {
    const config = await loadFixtureConfig({
      packages: { monitoring: true, "cloudnative-pg": true, "cert-manager": true },
    });
    const order = resolveInstallOrder(config, true).map((each) => each.name);
    assert.ok(order.indexOf("cloudnative-pg") < order.indexOf("monitoring"));
    assert.ok(order.indexOf("cert-manager") < order.indexOf("monitoring"));
  });

  it("makes Grafana's credentials ahead of the chart that reads them", () => {
    const chart = position("helm-install-monitoring");
    assert.ok(position("create-secret-community-cloud-grafana-oidc") < chart);
    assert.ok(position("create-secret-community-cloud-grafana-admin") < chart);
    assert.ok(position("authentik-blueprint-monitoring") < chart);
  });

  it("applies the monitors after the chart that brings their CRDs", () => {
    const chart = position("helm-install-monitoring");
    for (const manifest of ["monitors", "rules"]) {
      assert.ok(position(`helm-manifest-after-monitoring-monitoring-${manifest}`) > chart, manifest);
    }
  });
});

describe("Grafana and Authentik agreeing", async () => {
  const config = await withMail();
  const [values] = render(config, MONITORING.valuesFile!);
  const [blueprint] = render(config, MONITORING.authentik!.blueprint);
  const ini = values.grafana["grafana.ini"];
  const entry = (model: string) => blueprint.entries.find((each: any) => each.model === model);

  it("is sent back where Authentik allows", () => {
    const provider = entry("authentik_providers_oauth2.oauth2provider");
    assert.deepEqual(
      provider.attrs.redirect_uris.map((uri: any) => uri.url),
      [`${ini.server.root_url}login/generic_oauth`],
    );
  });

  it("ends a session at the application Authentik knows", () => {
    assert.equal(
      ini.auth.signout_redirect_url,
      `https://auth.example.test/application/o/${MONITORING.authentik!.slug}/end-session/`,
    );
    assert.equal(entry("authentik_core.application").identifiers.slug, MONITORING.authentik!.slug);
  });

  it("reads its client from the Secret Authentik's is made from", () => {
    assert.equal(values.grafana.envValueFrom.GF_AUTH_GENERIC_OAUTH_CLIENT_ID.secretKeyRef.name, "grafana-oidc");
    assert.equal(values.grafana.envValueFrom.GF_AUTH_GENERIC_OAUTH_CLIENT_SECRET.secretKeyRef.name, "grafana-oidc");
    assert.equal(MONITORING.authentik!.secret, "grafana-oidc");
  });

  it("only lets in people Authentik has checked for a k8s- group", () => {
    const policy = entry("authentik_policies_expression.expressionpolicy");
    assert.match(policy.attrs.expression, /name__startswith="k8s-"/);
    assert.ok(entry("authentik_policies.policybinding"));
  });

  it("makes the cluster's administrators Grafana's, and nobody else", () => {
    assert.equal(
      ini["auth.generic_oauth"].role_attribute_path,
      "contains(groups[*], 'k8s-admins') && 'Admin' || 'Viewer'",
    );
  });

  it("follows a different administrator group", async () => {
    const raw = config.getConfig();
    const custom = configFrom({ ...raw, values: { ...raw.values, clusterAdminGroup: "k8s-operators" } });
    const [rendered] = render(custom, MONITORING.valuesFile!);
    assert.match(rendered.grafana["grafana.ini"]["auth.generic_oauth"].role_attribute_path, /'k8s-operators'/);
  });

  it("keeps the client's secret out of its configuration", () => {
    assert.equal(ini["auth.generic_oauth"].client_secret, undefined);
  });
});

describe("Alertmanager's mail", async () => {
  const config = await withMail();
  const [values] = render(config, MONITORING.valuesFile!);
  const { alertmanager } = values;

  it("sends to the cluster's administrator", () => {
    const email = alertmanager.config.receivers.find((each: any) => each.name === "email");
    assert.equal(email.email_configs[0].to, config.getConfig().values.adminEmail);
    assert.equal(alertmanager.config.route.receiver, "email");
  });

  it("reads the password from the Secret it mounts", () => {
    assert.deepEqual(alertmanager.alertmanagerSpec.secrets, ["cc-smtp"]);
    assert.equal(
      alertmanager.config.global.smtp_auth_password_file,
      "/etc/alertmanager/secrets/cc-smtp/password",
    );
  });

  it("never renders the password", () => {
    const rendered = renderInstallerFile(config, MONITORING.valuesFile!, { templateNamespace: CLUSTER_NAMESPACE });
    assert.ok(!rendered.includes(MAIL_PASSWORD));
  });

  it("gives booleans where Alertmanager wants them", () => {
    assert.equal(alertmanager.config.global.smtp_require_tls, true);
    assert.equal(alertmanager.config.global.smtp_force_implicit_tls, false);
  });

  it("doesn't email the alert that always fires", () => {
    const [route] = alertmanager.config.route.routes;
    assert.equal(route.receiver, "null");
    assert.match(route.matchers[0], /Watchdog/);
  });

  it("leaves a relay's credentials out", async () => {
    const raw = config.getConfig();
    const relay = configFrom({
      ...raw,
      smtp: { ...raw.smtp, namespaces: { ...raw.smtp.namespaces, [CLUSTER_NAMESPACE]: {} } },
    });
    const [rendered] = render(relay, MONITORING.valuesFile!);
    assert.equal(rendered.alertmanager.config.global.smtp_auth_username, undefined);
    assert.equal(rendered.alertmanager.config.global.smtp_auth_password_file, undefined);
  });

  it("asks for no Secret in a namespace with no mail", async () => {
    const raw = (await loadFixtureConfig({ packages: { monitoring: true } })).getConfig();
    const { defaults, ...smtp } = raw.smtp;
    const [rendered] = render(configFrom({ ...raw, smtp }), MONITORING.valuesFile!);
    assert.equal(rendered.alertmanager.config, undefined);
    assert.equal(rendered.alertmanager.alertmanagerSpec.secrets, undefined);
  });
});

describe("what Prometheus does", async () => {
  const config = await withMail();
  const [values] = render(config, MONITORING.valuesFile!);

  it("takes monitors and rules from outside its own release", () => {
    const spec = values.prometheus.prometheusSpec;
    assert.equal(spec.serviceMonitorSelectorNilUsesHelmValues, false);
    assert.equal(spec.podMonitorSelectorNilUsesHelmValues, false);
    assert.equal(spec.ruleSelectorNilUsesHelmValues, false);
  });

  it("stops short of filling its volume", () => {
    const spec = values.prometheus.prometheusSpec;
    const volume = parseInt(spec.storageSpec.volumeClaimTemplate.spec.resources.requests.storage, 10);
    assert.ok(parseInt(spec.retentionSize, 10) < volume);
  });

  it("leaves alone what K3s doesn't expose, and the rules about it", () => {
    for (const component of ["kubeControllerManager", "kubeScheduler", "kubeEtcd", "kubeProxy"]) {
      assert.equal(values[component].enabled, false, component);
    }
    for (const rule of ["etcd", "kubeControllerManager", "kubeProxy", "kubeSchedulerAlerting"]) {
      assert.equal(values.defaultRules.rules[rule], false, rule);
    }
  });

  it("keeps node-exporter off public addresses", () => {
    assert.equal(values["prometheus-node-exporter"].service.listenOnAllInterfaces, false);
  });
});

describe("reaching it", async () => {
  const config = await withMail();
  const documents = render(config, "embed://monitoring/Monitoring.network.yaml");

  it("gives Grafana a route, and only Grafana", () => {
    const backends = documents
      .filter((each) => each.kind === "HTTPRoute")
      .flatMap((route) => route.spec.rules)
      .flatMap((rule) => rule.backendRefs ?? [])
      .map((backend) => backend.name);
    assert.deepEqual(backends, ["monitoring-grafana"]);
  });

  it("serves the hostname Grafana believes it's on", () => {
    const [values] = render(config, MONITORING.valuesFile!);
    const [listenerSet] = documents;
    assert.equal(`https://${listenerSet.spec.listeners[1].hostname}/`, values.grafana["grafana.ini"].server.root_url);
  });
});

describe("the double braces", async () => {
  const config = await withMail();

  it("leaves Prometheus's rule expressions as they were written", () => {
    const [rules] = render(config, "embed://monitoring/Monitoring.rules.yaml");
    const expressions = rules.spec.groups.flatMap((group: any) => group.rules).map((rule: any) => rule.expr);
    assert.ok(expressions.some((each: string) => each.includes('{condition="False"}')));
  });

  it("keeps every dashboard valid JSON", () => {
    const [dashboards] = render(config, "embed://monitoring/Monitoring.dashboards.yaml");
    const files = Object.values<string>(dashboards.data);
    assert.ok(files.length > 0);
    for (const file of files) {
      assert.ok(JSON.parse(file).panels.length > 0);
    }
  });

  it("labels the dashboards for Grafana to find", () => {
    const [dashboards] = render(config, "embed://monitoring/Monitoring.dashboards.yaml");
    assert.equal(dashboards.metadata.labels.grafana_dashboard, "1");
  });
});
