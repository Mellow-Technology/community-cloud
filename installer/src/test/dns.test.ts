/**
 * @file
 * ExternalDNS, one per provider account and namespace.
 *
 * What's guarded here is the separation: a route in one namespace
 * must never be able to put a record in a domain given to another.
 * Nothing in the cluster would complain if it could. The records would
 * simply appear, pointing a client's name at the office, or the other
 * way round, and the first anyone heard of it would be from outside.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parse } from "yaml";

import { TerminalCommandSpec, joinCommand } from "../cli/commands/Command.ts";
import { DnsCommands, buildDnsCredentialsManifest } from "../cli/commands/Dns.ts";
import { buildExternalDnsValues, checkDnsConfig, getDnsInstances } from "../util/dns.ts";
import { redact, REDACTED } from "../util/redact.ts";
import { GatewayMode } from "../util/types.ts";
import { configFrom, loadFixtureConfig } from "./helpers.ts";

const BASE = { values: { domain: { main: "example.test" } } };

/**
 * Preflight's view of a dns section.
 */
function problems(dns: Record<string, unknown>, mode = GatewayMode.Floating) {
  return checkDnsConfig({ ...BASE, dns }, mode);
}

const office = {
  name: "office",
  provider: "cloudflare",
  domains: ["example.test"],
  namespaces: ["cc-office"],
};

describe("the instances", () => {
  it("runs one for each namespace a provider serves", () => {
    const instances = getDnsInstances({
      ...BASE,
      dns: { providers: [{ ...office, namespaces: ["cc-office", "cc-team"] }] },
    });

    assert.deepEqual(
      instances.map((instance) => instance.release),
      ["external-dns-office-cc-office", "external-dns-office-cc-team"],
    );
  });

  it("gives each its own mark on the records it makes", () => {
    const instances = getDnsInstances({
      ...BASE,
      dns: { providers: [{ ...office, namespaces: ["cc-office", "cc-team"] }] },
    });

    assert.equal(new Set(instances.map((instance) => instance.ownerId)).size, 2);
  });

  it("marks them differently on another cluster sharing the zone", () => {
    const here = getDnsInstances({ ...BASE, dns: { providers: [office] } })[0]!;
    const there = getDnsInstances({ values: { domain: { main: "other.test" } }, dns: { providers: [office] } })[0]!;

    assert.notEqual(here.ownerId, there.ownerId);
  });

  it("takes the cluster's target unless a provider gives its own", () => {
    const [shared, own] = getDnsInstances({
      ...BASE,
      dns: {
        target: "203.0.113.10",
        providers: [office, { ...office, name: "other", namespaces: ["x"], target: "198.51.100.7" }],
      },
    });

    assert.equal(shared!.target, "203.0.113.10");
    assert.equal(own!.target, "198.51.100.7");
  });
});

describe("what an instance is told", () => {
  const [instance] = getDnsInstances({
    ...BASE,
    dns: {
      target: "203.0.113.10",
      providers: [{ ...office, credentials: { CF_API_TOKEN: "secret-token" }, args: ["--cloudflare-proxied"] }],
    },
  });
  const values = parse(buildExternalDnsValues(instance!));

  it("reads only its own namespace's routes", () => {
    assert.ok(values.extraArgs.includes("--namespace=cc-office"));
  });

  it("writes only its own domains", () => {
    assert.deepEqual(values.domainFilters, ["example.test"]);
  });

  it("follows routes through their ListenerSets", () => {
    assert.equal(values.enableGatewayListenerSets, true);
    assert.deepEqual(values.sources, ["gateway-httproute"]);
  });

  it("points records at the public address, not the Gateway's own", () => {
    assert.ok(values.extraArgs.includes("--default-targets=203.0.113.10"));
    assert.ok(values.extraArgs.includes("--force-default-targets"));
  });

  it("leaves the Gateway's address alone when there's no target", () => {
    const [plain] = getDnsInstances({ ...BASE, dns: { providers: [office] } });
    const args = parse(buildExternalDnsValues(plain!)).extraArgs;

    assert.ok(!args.some((arg: string) => arg.startsWith("--default-targets")));
  });

  it("passes provider settings through", () => {
    assert.ok(values.extraArgs.includes("--cloudflare-proxied"));
  });

  it("reads its credentials from the Secret, so the values never hold them", () => {
    const rendered = buildExternalDnsValues(instance!);

    assert.ok(!rendered.includes("secret-token"));
    assert.deepEqual(values.env, [
      { name: "CF_API_TOKEN", valueFrom: { secretKeyRef: { name: "external-dns-office", key: "CF_API_TOKEN" } } },
    ]);
  });
});

describe("checking a dns section", () => {
  it("accepts the fixture's office and client, kept apart", async () => {
    const config = await loadFixtureConfig();
    assert.deepEqual(checkDnsConfig(config.getConfig(), GatewayMode.PortForward), []);
  });

  it("catches a client's domain inside the office's", () => {
    const found = problems({
      providers: [office, { ...office, name: "acme", domains: ["acme.example.test"], namespaces: ["client-acme"] }],
    });

    assert.match(found.join("\n"), /excludeDomains/);
  });

  it("accepts it once the office gives it away", () => {
    assert.deepEqual(
      problems({
        providers: [
          { ...office, excludeDomains: ["acme.example.test"] },
          { ...office, name: "acme", domains: ["acme.example.test"], namespaces: ["client-acme"] },
        ],
      }),
      [],
    );
  });

  it("catches one domain given to two sets of namespaces", () => {
    const found = problems({ providers: [office, { ...office, name: "twice", namespaces: ["other"] }] });

    assert.equal(found.length, 1);
    assert.match(found[0]!, /given to both/);
  });

  it("lets one set of namespaces use two providers for the same domain", () => {
    // The same namespaces either way, so neither can reach anything the
    // other can't
    assert.deepEqual(problems({ providers: [office, { ...office, name: "backup", provider: "aws" }] }), []);
  });

  it("won't publish a LAN address from behind a router", () => {
    assert.match(problems({ providers: [office] }, GatewayMode.PortForward).join(), /dns\.target/);
    assert.deepEqual(problems({ target: "203.0.113.10", providers: [office] }, GatewayMode.PortForward), []);
  });

  it("insists on domains, so no instance can write any zone it reaches", () => {
    assert.match(problems({ providers: [{ ...office, domains: [] }] }).join(), /no "domains"/);
  });

  it("catches a name too long to be a release", () => {
    assert.match(problems({ providers: [{ ...office, name: "a".repeat(40) }] }).join(), /longer than Helm allows/);
  });

  it("catches a credential that can't be an environment variable", () => {
    assert.match(problems({ providers: [{ ...office, credentials: { "api-token": "x" } }] }).join(), /environment variable/);
  });
});

describe("the bundle", () => {
  it("puts each account's credentials in place before installing anything", async () => {
    const config = await loadFixtureConfig();
    const names = DnsCommands(config).map((command) => command.name);
    const firstInstall = names.findIndex((name) => name.startsWith("helm-install-"));

    assert.ok(names.indexOf("dns-credentials-office") < firstInstall);
    assert.ok(names.indexOf("dns-credentials-acme") < firstInstall);
    assert.ok(names.includes("helm-install-external-dns-office-cc-office"));
    assert.ok(names.includes("helm-install-external-dns-acme-client-acme"));
  });

  it("pins the chart", async () => {
    const config = await loadFixtureConfig();
    const install = DnsCommands(config).find((command) => command.name === "helm-install-external-dns-office-cc-office") as TerminalCommandSpec;
    const text = (install.command as Function)();

    assert.match(text, /--version '1\.23\.0'/);
    assert.match(text, /--namespace 'external-dns'/);
  });

  it("keeps tokens on standard input", async () => {
    const config = await loadFixtureConfig();
    const command = DnsCommands(config).find((each) => each.name === "dns-credentials-office") as TerminalCommandSpec;

    assert.ok(!joinCommand(command.command as string[]).includes("not-a-real-token"));
    assert.ok((command.stdin as Function)().includes("not-a-real-token"));
  });

  it("has nothing to do without providers", () => {
    const names = DnsCommands(configFrom(BASE)).map((command) => command.name);
    assert.deepEqual(names, ["no-dns-configured"]);
  });

  it("keeps the credentials out of what the cluster records about itself", () => {
    const redacted = redact({ dns: { providers: [{ name: "office", credentials: { CF_API_TOKEN: "t" } }] } });
    assert.equal(redacted.dns.providers[0].credentials, REDACTED);
  });

  it("makes an Opaque Secret of exactly the credentials given", () => {
    const manifest = parse(buildDnsCredentialsManifest({ ...office, credentials: { CF_API_TOKEN: "t" } }));
    assert.equal(manifest.type, "Opaque");
    assert.equal(manifest.metadata.namespace, "external-dns");
    assert.deepEqual(manifest.stringData, { CF_API_TOKEN: "t" });
  });
});
