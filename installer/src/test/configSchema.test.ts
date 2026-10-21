/**
 * @file
 * The configuration schema says what the installer reads, and checking
 * against it says so in words.
 *
 * The schema is a JSON file beside a codebase that has its own idea of
 * the same things — node types, roles, regions — in enums, and the two
 * can drift. Where they overlap, the code is the authority and the
 * schema is checked against it.
 *
 * It's also checked against the configure wizard, which is how keys
 * nothing read got into configurations in the first place: the wizard
 * asked about them and wrote them down, and nothing ever looked.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { checkSchema, getConfigSchema } from "../util/configSchema.ts";
import { StorageClass } from "../cli/commands/LVM.ts";
import { MailSecurity } from "../util/mail.ts";
import { regions } from "../topology/regions.ts";
import { GatewayMode, K3SInstallationType, NodeRole } from "../util/types.ts";
import { FIXTURE_CONFIG, INSTALLER_ROOT, TEST_DIR } from "./helpers.ts";

const SCHEMA = getConfigSchema() as any;

const SERVER = { name: "srv", address: "srv", type: "server" };

/**
 * Follow a reference, as the checker does.
 */
function resolve(node: any): any {
  return node?.$ref !== undefined ? resolve(SCHEMA.$defs[node.$ref.replace("#/$defs/", "")]) : node;
}

/**
 * The schema for a dotted path, if it names a setting.
 *
 * Only a key the schema names counts. An open object like "values"
 * takes anything, which is right for a configuration and no help in
 * telling whether something was meant to be read.
 */
function findSetting(path: string): any {
  let node: any = SCHEMA;

  for (const part of path.split(".")) {
    node = resolve(node);

    // "nodes.type" means the type of each node
    if (node?.type === "array") {
      node = resolve(node.items);
    }

    const next = node?.properties?.[part] ?? (typeof node?.additionalProperties === "object" ? node.additionalProperties : undefined);

    if (next === undefined || resolve(next).deprecated === true) {
      return undefined;
    }

    node = next;
  }

  return resolve(node);
}

function enumAt(path: string): unknown[] {
  const found = findSetting(path);
  return found?.enum ?? resolve(found?.items)?.enum;
}

describe("the schema", () => {
  it("only refers to what it defines", () => {
    const refs = [...JSON.stringify(SCHEMA).matchAll(/"\$ref":"#\/\$defs\/([^"]+)"/g)].map((match) => match[1]!);
    const missing = refs.filter((name) => SCHEMA.$defs[name] === undefined);

    assert.deepEqual(missing, []);
  });

  it("is met by the fixture, with nothing to warn about", () => {
    const raw = JSON.parse(readFileSync(FIXTURE_CONFIG, "utf8"));
    assert.deepEqual(checkSchema(raw), { problems: [], warnings: [] });
  });

  it("is met by the fixture full of secrets", () => {
    const raw = JSON.parse(readFileSync(join(TEST_DIR, "fixtures", "secretive.fixture.json"), "utf8"));
    assert.deepEqual(checkSchema(raw), { problems: [], warnings: [] });
  });
});

describe("the schema agrees with the code about", () => {
  const cases: [string, string, unknown[]][] = [
    ["node types", "nodes.type", Object.values(K3SInstallationType)],
    ["node roles", "nodes.roles", Object.values(NodeRole)],
    ["regions", "nodes.region", regions.map((region) => region.code)],
    ["gateway modes", "network.gateway.mode", Object.values(GatewayMode)],
    ["mail security", "smtp.defaults.security", Object.values(MailSecurity)],
    ["storage classes", "storage.diskClasses.ssd", Object.values(StorageClass)],
  ];

  for (const [what, path, expected] of cases) {
    it(what, () => {
      assert.deepEqual([...(enumAt(path) ?? [])].sort(), [...new Set(expected)].sort());
    });
  }
});

describe("what checking a configuration finds", () => {
  it("nothing in a small, correct one", () => {
    assert.deepEqual(checkSchema({ k3s: { token: "t" }, nodes: [SERVER] }), { problems: [], warnings: [] });
  });

  it("a value of the wrong type, by where it is", () => {
    const { problems } = checkSchema({ network: { gateway: { addresses: "192.0.2.1" } } });
    assert.deepEqual(problems, ['"network.gateway.addresses" should be a list, and it\'s text.']);
  });

  it("a value that isn't one of those allowed", () => {
    const { problems } = checkSchema({ nodes: [{ ...SERVER, type: "master" }] });
    assert.deepEqual(problems, ['"nodes[srv].type" is "master", and has to be one of: server, agent.']);
  });

  it("a node by its name, and one with no name by its place", () => {
    const { problems } = checkSchema({ nodes: [{ roles: ["wroker"] }] });
    assert.match(problems[0] ?? "", /^"nodes\[0\]\.roles\[0\]" is "wroker"/);
  });

  it("a port out of range", () => {
    assert.match(checkSchema({ nodes: [{ ...SERVER, port: 70000 }] }).problems.join(), /can't be more than 65535/);
  });

  it("a whole number where a whole number is wanted", () => {
    assert.match(checkSchema({ nodes: [{ ...SERVER, port: 22.5 }] }).problems.join(), /should be a whole number/);
  });

  it("without repeating a value that might be a secret", () => {
    const { problems } = checkSchema({ k3s: { token: 123456789 } });
    assert.equal(problems.length, 1);
    assert.doesNotMatch(problems[0]!, /123456789/);
  });

  it("a key with dots in it, quoted", () => {
    const { warnings } = checkSchema({ registries: { "registry.gitlab.com": { username: "u" } } });
    assert.deepEqual(warnings, ['"registries["registry.gitlab.com"].username" isn\'t a setting, so nothing reads it.']);
  });

  it("a misspelt key, with what was meant", () => {
    const { warnings } = checkSchema({ network: { congestionControll: "bbr" } });
    assert.match(warnings[0] ?? "", /Did you mean "congestionControl"\?/);
  });

  it("no suggestion for a short key that's merely similar", () => {
    // "hots" is two edits from both "host" and "port"
    const { warnings } = checkSchema({ smtp: { defaults: { hots: "h" } } });
    assert.equal(warnings.length, 1);
    assert.doesNotMatch(warnings[0]!, /Did you mean/);
  });

  it("a top-level key, pointing at values", () => {
    const { warnings } = checkSchema({ resiliency: "balanced" });
    assert.match(warnings[0] ?? "", /^"resiliency" isn't one of the installer's settings\..*belongs under "values"/);
  });

  it("older keys, with where they belong now", () => {
    const { problems, warnings } = checkSchema({
      config: { adminEmail: "a@example.test" },
      packages: { description: "my packages" },
      nodes: [{ ...SERVER, sshHost: "srv" }],
    });

    assert.deepEqual(problems, []);
    assert.equal(warnings.length, 3);
    assert.match(warnings.join(), /values\.adminEmail/);
    assert.match(warnings.join(), /"packages\.description" isn't a package/);
    assert.match(warnings.join(), /"nodes\[srv\]\.sshHost" is an older name for "address"/);
  });

  it("nothing about a Nebula \"id\", which preflight explains itself", () => {
    assert.deepEqual(checkSchema({ network: { nebula: { id: "x" } } }), { problems: [], warnings: [] });
  });

  it("nothing about values it doesn't know, since plugins and manifests add their own", () => {
    assert.deepEqual(checkSchema({ values: { mastodonDomain: "m.example.test", domain: { blog: "b.example.test" } } }), {
      problems: [],
      warnings: [],
    });
  });

  it("a package as true, as settings, and as neither", () => {
    assert.deepEqual(checkSchema({ packages: { "cert-manager": true, topolvm: { enabled: true, version: "15.5.2" } } }).problems, []);
    assert.deepEqual(checkSchema({ packages: { topolvm: "yes" } }).problems, [
      '"packages.topolvm" should be true or false or an object, and it\'s text.',
    ]);
  });

  it("labels as pairs, or in the older shape as a list", () => {
    assert.deepEqual(checkSchema({ nodes: [{ ...SERVER, labels: { rack: "a" } }] }).problems, []);
    assert.deepEqual(checkSchema({ nodes: [{ ...SERVER, labels: ["worker"] }] }).problems, []);
  });
});

describe("the configure wizard", () => {
  const sections = join(INSTALLER_ROOT, "src", "cli", "configure", "sections");

  // Every path a section writes as a plain string. The ones built from
  // a template are hostnames under "values.domain", one per service.
  const written = readdirSync(sections).flatMap((file) =>
    [...readFileSync(join(sections, file), "utf8").matchAll(/writePath\(\s*draft,\s*"([^"]+)"/g)].map((match) => match[1]!),
  );

  it("was found writing something", () => {
    assert.ok(written.length > 10, `only found ${written.length}`);
  });

  it("only writes settings the schema names", () => {
    const unknown = [...new Set(written)].filter((path) => findSetting(path) === undefined);
    assert.deepEqual(unknown, []);
  });
});
