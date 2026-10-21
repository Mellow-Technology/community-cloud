/**
 * @file
 * The office applications that sign in through Authentik, and the
 * order their install happens in.
 *
 * The order is the thing worth guarding, because every step in it is
 * there for a reason that only shows up on a real cluster: the client
 * credentials have to exist before Authentik is told about them,
 * Authentik has to know the client before anything starts and asks it
 * for its configuration, and none of it should start at all on a
 * cluster with no Authentik to sign in through. Get any of those
 * backwards and the install passes on a laptop and fails on hardware.
 *
 * Gates are tested with a package made up for the purpose, since
 * nothing in the catalogue uses one yet.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { CommandPurpose, TerminalCommandSpec, joinCommand } from "../cli/commands/Command.ts";
import { buildPackageCommands, buildPackageInventoryCommand } from "../cli/commands/Helm.ts";
import { buildGateBlueprint, buildGateManifest } from "../cli/commands/OAuth2Proxy.ts";
import {
  buildCreateSecretCommand,
  buildSecretManifest,
  buildVerifySecretsCommand,
} from "../cli/commands/Secrets.ts";
import {
  PackageDefinition,
  getPackage,
  resolveInstallOrder,
} from "../cli/commands/packages.ts";
import { checkConfiguration } from "../runners/preflight.ts";
import { configFrom, loadFixtureConfig, withoutConsole } from "./helpers.ts";
import { parseAllDocuments } from "yaml";
import { execFileSync } from "node:child_process";

const APPLICATIONS = ["invoice-ninja", "documenso"];

/**
 * The names of a package's install commands, in order.
 */
function commandNames(name: string): string[] {
  return buildPackageCommands(getPackage(name)!).map((command) => command.name);
}

describe("an application signing in through Authentik", () => {
  for (const name of APPLICATIONS) {
    describe(name, () => {
      const names = commandNames(name);
      const position = (prefix: string) => names.findIndex((each) => each.startsWith(prefix));

      it("checks Authentik is there before installing anything", () => {
        assert.equal(names[0], `require-authentik-${name}`);
      });

      it("installs no chart", () => {
        const helm = names.filter(
          (each) => each.startsWith("helm-repo-") || each.startsWith("helm-install-") || each.startsWith("helm-verify-"),
        );
        assert.deepEqual(helm, []);
      });

      it("makes the client credentials before Authentik is told about them", () => {
        const secret = getPackage(name)!.authentik!.secret;
        assert.ok(position(`create-secret-cc-office-${secret}`) < position("authentik-blueprint-"));
      });

      it("tells Authentik before the application starts", () => {
        assert.ok(position("authentik-blueprint-") < position("helm-manifest-after-"));
      });

      it("waits for it to come up, then checks it and Authentik", () => {
        assert.ok(position("rollout-") > position("helm-manifest-after-"));
        assert.ok(position("verify-rollout-") > position("rollout-"));
        assert.ok(position("verify-authentik-") > position("rollout-"));
      });
    });
  }
});

describe("the command that registers a client", () => {
  const command = buildPackageCommands(getPackage("documenso")!).find((each) =>
    each.name.startsWith("authentik-blueprint-"),
  ) as TerminalCommandSpec;
  const text = joinCommand(command.command as string[]);

  it("changes something, so a check-up never runs it", () => {
    assert.equal(command.purpose, CommandPurpose.Apply);
  });

  it("reads the credentials into a pipe rather than onto a command line", () => {
    // The only place a credential appears is a kubectl read piped
    // straight on; no variable holding one is ever expanded into a
    // command's arguments
    assert.ok(text.includes("jsonpath='{.data.password}' | base64 -d"));
    assert.ok(!/\$\{?(password|secret)/i.test(text));
  });

  it("hands Authentik the blueprint on standard input", () => {
    assert.ok(text.includes("ak shell -c"));
    assert.equal(typeof command.stdin, "function");
  });
});

describe("the order they're installed in", () => {
  const authentik = { repo: "https://charts.goauthentik.io", chart: "authentik", namespace: "cc-office" };

  it("puts Authentik first when it's being installed too", async () => {
    const config = await loadFixtureConfig({
      // Listed after, so only "after" can be what puts it first
      packages: { "invoice-ninja": true, documenso: true, authentik },
    });
    const order = await withoutConsole(() => resolveInstallOrder(config).map((entry) => entry.name));

    assert.ok(order.indexOf("authentik") < order.indexOf("invoice-ninja"));
    assert.ok(order.indexOf("authentik") < order.indexOf("documenso"));
  });

  it("doesn't install Authentik when it wasn't asked for", async () => {
    const config = await loadFixtureConfig({ packages: { documenso: true } });
    const order = await withoutConsole(() => resolveInstallOrder(config).map((entry) => entry.name));

    assert.ok(!order.includes("authentik"));
    assert.ok(order.indexOf("cloudnative-pg") < order.indexOf("documenso"));
  });
});

describe("keys that aren't passwords", () => {
  const manifest = (name: string, secret: string) => {
    const definition = getPackage(name)!.secrets!.find((each) => each.name === secret)!;
    return (parseAllDocuments(buildSecretManifest(definition, "cc-office"))[0]!.toJS() as any)
      .stringData.password as string;
  };

  it("gives Laravel a key of exactly 32 characters", () => {
    assert.match(manifest("invoice-ninja", "invoice-ninja-app-key"), /^[0-9a-f]{32}$/);
  });

  it("gives Documenso keys of at least 32 characters", () => {
    for (const secret of ["documenso-session", "documenso-encryption", "documenso-encryption-secondary"]) {
      assert.ok(manifest("documenso", secret).length >= 32, secret);
    }
  });
});

describe("preflight, for an application", () => {
  it("asks for the hostname the application is served on", async () => {
    const config = await loadFixtureConfig();
    const raw = JSON.parse(JSON.stringify(config.getConfig()));
    delete raw.values.domain.signing;
    raw.packages = { documenso: true };

    const problems = checkConfiguration(configFrom(raw)).map((problem) => problem.what);
    assert.ok(problems.some((problem) => problem.includes("values.domain.signing")), problems.join("\n"));
  });

  it("is satisfied by the fixture", async () => {
    const config = await loadFixtureConfig();
    const raw = JSON.parse(JSON.stringify(config.getConfig()));
    raw.packages = { "invoice-ninja": true, documenso: true };

    assert.deepEqual(checkConfiguration(configFrom(raw)).map((problem) => problem.what), []);
  });
});

describe("a gate in front of something without a sign in", () => {
  const gated: PackageDefinition = {
    name: "console",
    description: "A made up interface with no sign in of its own",
    namespace: "cc-office",
    manifests: { after: ["embed://apps/office/Office.namespace.yaml"] },
    gate: {
      name: "console",
      title: "Console",
      hostname: "domain.crm",
      upstream: "http://console:8080",
      skipAuthRoutes: ["^/healthz$"],
    },
  };
  const commands = buildPackageCommands(gated);
  const names = commands.map((command) => command.name);
  const position = (name: string) => names.indexOf(name);

  it("checks Authentik is there first", () => {
    assert.equal(names[0], "require-authentik-console");
  });

  it("makes the client and the cookie key before registering the client", () => {
    assert.ok(position("create-secret-cc-office-console-gate-oidc") < position("authentik-blueprint-console-gate"));
    assert.ok(position("create-secret-cc-office-console-gate-cookie") >= 0);
  });

  it("registers the client before the proxy starts and asks for it", () => {
    assert.ok(position("authentik-blueprint-console-gate") < position("helm-manifest-after-console-oauth2proxy"));
  });

  it("waits for the proxy and checks Authentik has the application", () => {
    const rollout = commands.find((command) => command.name === "rollout-console") as TerminalCommandSpec;
    assert.match(joinCommand(rollout.command as string[]), /deployment\/console-oauth2-proxy/);
    assert.ok(position("verify-authentik-console-gate") > position("rollout-console"));
  });

  describe("the proxy it runs", async () => {
    const config = await loadFixtureConfig();
    const [service, deployment] = parseAllDocuments(buildGateManifest(gated.gate!, "cc-office")(config)).map(
      (document) => document.toJS() as any,
    );
    const args: string[] = deployment.spec.template.spec.containers[0].args;

    it("is a Service a route can send to", () => {
      assert.equal(service.metadata.name, "console-oauth2-proxy");
      assert.equal(service.spec.ports[0].port, 4180);
    });

    it("signs in through the application's own issuer in Authentik", () => {
      assert.ok(args.includes("--oidc-issuer-url=https://auth.example.test/application/o/console/"));
      assert.ok(args.includes("--redirect-url=https://crm.example.test/oauth2/callback"));
    });

    it("forwards to the application", () => {
      assert.ok(args.includes("--upstream=http://console:8080"));
    });

    it("lets through only what it was told to", () => {
      assert.deepEqual(
        args.filter((arg) => arg.startsWith("--skip-auth-route")),
        ["--skip-auth-route=^/healthz$"],
      );
    });

    it("takes its credentials from Secrets rather than arguments", () => {
      const env = deployment.spec.template.spec.containers[0].env;
      assert.deepEqual(
        env.map((each: any) => each.valueFrom.secretKeyRef.name),
        ["console-gate-oidc", "console-gate-oidc", "console-gate-cookie"],
      );
    });
  });

  describe("its client in Authentik", async () => {
    const config = await loadFixtureConfig();
    const blueprint = buildGateBlueprint(gated.gate!)(config, {});

    it("is a blueprint YAML can read, tags and all", () => {
      const [document] = parseAllDocuments(blueprint) as any[];
      assert.deepEqual(document.errors, []);
    });

    it("sends people back to the proxy and nowhere else", () => {
      assert.match(blueprint, /url: "https:\/\/crm\.example\.test\/oauth2\/callback"/);
    });

    it("takes the credentials from context, not from the text", () => {
      assert.match(blueprint, /client_id: !Context client_id/);
      assert.match(blueprint, /client_secret: !Context client_secret/);
    });
  });

  it("builds commands that are shell", async () => {
    const config = await loadFixtureConfig();
    for (const command of commands as TerminalCommandSpec[]) {
      const text = joinCommand(
        typeof command.command === "function" ? command.command(config, {}) : command.command,
      );
      execFileSync("/bin/sh", ["-n", "-c", text]);
    }
  });
});

describe("a signing certificate", () => {
  const definition = getPackage("documenso")!.secrets!.find((each) => each.name === "documenso-signing")!;
  const command = buildCreateSecretCommand(definition, "cc-office") as TerminalCommandSpec;
  const text = joinCommand(command.command as string[]);

  it("is made on the control plane, so the key never passes through here", () => {
    assert.equal(command.stdin, undefined);
    assert.match(text, /openssl req -x509/);
    assert.match(text, /openssl pkcs12 -export/);
  });

  it("is sealed with a passphrase, which Documenso insists on", () => {
    assert.match(text, /-passout "file:\$work\/password"/);
  });

  it("reaches the Secret from files, never from a command line", () => {
    assert.match(text, /--from-file=certificate=/);
    assert.match(text, /--from-file=password=/);
  });

  it("is only ever made once", () => {
    assert.match(text, /get secret 'documenso-signing'/);
    assert.ok(!text.includes("apply"));
  });

  it("is shell", () => {
    execFileSync("/bin/sh", ["-n", "-c", text]);
    execFileSync("/bin/bash", ["-n", "-c", text]);
  });

  it("is checked for as a certificate, not as a username and password", () => {
    const verify = joinCommand(
      (buildVerifySecretsCommand([definition], "cc-office", "documenso") as TerminalCommandSpec)
        .command as string[],
    );
    assert.match(verify, /\{\.data\.certificate\}/);
    assert.match(verify, /Opaque:\?\*:\?\*/);
  });
});

describe("what's installed that the configuration doesn't enable", () => {
  it("asks about every package that isn't enabled, and none that are", async () => {
    // The fixture enables cert-manager and CloudNativePG
    const config = await loadFixtureConfig();
    const command = buildPackageInventoryCommand(config) as TerminalCommandSpec;
    const text = joinCommand(command.command as string[]);

    assert.match(text, /unconfigured\|invoice-ninja/);
    assert.match(text, /unconfigured\|documenso/);
    assert.ok(!text.includes("unconfigured|cert-manager"));
    assert.ok(!text.includes("unconfigured|cloudnative-pg"));
  });

  it("is a report, not a check, since a package installed on its own was still wanted", async () => {
    const command = buildPackageInventoryCommand(await loadFixtureConfig());
    assert.equal(command.purpose, CommandPurpose.Inspect);
  });
});
