/**
 * @file
 * Mail, configured per namespace.
 *
 * Two things are guarded here. One is the translation — that a
 * namespace's mail settings become the right setting in each
 * application's own vocabulary, since most mail failures are silent.
 * The other is the separation, which is why mail is per namespace at
 * all: a namespace gets its own credentials and nobody else's, a
 * namespace given none has none, and one whose mail is taken away
 * loses the credentials it had.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { TerminalCommandSpec, joinCommand } from "../cli/commands/Command.ts";
import { buildPackageCommands } from "../cli/commands/Helm.ts";
import {
  buildApplyMailSecretCommand,
  buildMailSecretManifest,
  buildVerifyMailReachableCommand,
  buildVerifyMailSecretCommand,
} from "../cli/commands/Mail.ts";
import { getPackage } from "../cli/commands/packages.ts";
import { buildMailValues, checkMailConfig, getNamespaceMail } from "../util/mail.ts";
import { redact, REDACTED } from "../util/redact.ts";
import { renderInstallerFile } from "../util/template.ts";
import { configFrom, loadFixtureConfig } from "./helpers.ts";

const BASE = { values: { domain: { main: "example.test" } } };

/**
 * A configuration with this smtp section.
 */
function withMail(smtp: Record<string, unknown>) {
  return { ...BASE, smtp };
}

const SHARED = {
  defaults: { host: "smtp.example.test" },
  namespaces: {
    "cc-office": { username: "office", password: "office-password" },
    "client-acme": { host: "smtp.acme.test", security: "tls", username: "acme", password: "acme-password" },
  },
};

/**
 * The command's shell, for a configuration.
 */
function shellOf(command: TerminalCommandSpec, config: ReturnType<typeof configFrom>): string {
  return joinCommand(
    typeof command.command === "function" ? command.command(config, {}) : command.command,
  );
}

describe("whose mail a namespace gets", () => {
  it("gets the shared server with its own credentials", () => {
    const mail = getNamespaceMail(withMail(SHARED), "cc-office")!;

    assert.equal(mail.host, "smtp.example.test");
    assert.equal(mail.username, "office");
  });

  it("can send through a server of its own", () => {
    assert.equal(getNamespaceMail(withMail(SHARED), "client-acme")!.host, "smtp.acme.test");
  });

  it("takes nothing about the shared server's connection when it names its own", () => {
    const smtp = {
      defaults: { host: "smtp.example.test", port: 2525, fromDomain: "example.test" },
      namespaces: { a: { host: "own.test", security: "tls" } },
    };
    const mail = getNamespaceMail(withMail(smtp), "a")!;

    assert.equal(mail.port, undefined);
    assert.equal(buildMailValues(withMail(smtp), "a").port, "465");
    assert.equal(mail.fromDomain, "example.test");
  });

  it("gets none when it isn't given any", () => {
    assert.equal(getNamespaceMail(withMail(SHARED), "somewhere-else"), undefined);
    assert.equal(buildMailValues(withMail(SHARED), "somewhere-else").enabled, false);
  });

  it("never takes credentials from the shared server", () => {
    const smtp = { defaults: { host: "h", username: "everyone", password: "p" }, namespaces: { a: {} } };
    const mail = getNamespaceMail(withMail(smtp), "a")!;

    assert.equal(mail.username, undefined);
    assert.equal(mail.password, undefined);
  });

  it("is off for a template rendered for no namespace in particular", () => {
    assert.equal(buildMailValues(withMail(SHARED)).enabled, false);
  });
});

describe("what templates are told about a namespace's mail", () => {
  it("says mail is off when there's none, and still gives every field", () => {
    const values = buildMailValues(BASE, "cc-office");

    assert.equal(values.enabled, false);
    assert.equal(values.fromDomain, "example.test");
    for (const [key, value] of Object.entries(values)) {
      assert.notEqual(value, undefined, key);
    }
  });

  it("takes STARTTLS on 587 as the default", () => {
    const values = buildMailValues(withMail(SHARED), "cc-office");

    assert.equal(values.port, "587");
    assert.equal(values.startTls, "true");
    assert.equal(values.implicitTls, "false");
    assert.equal(values.scheme, "smtp");
  });

  it("says TLS from the start in each application's terms", () => {
    const values = buildMailValues(withMail(SHARED), "client-acme");

    assert.equal(values.port, "465");
    assert.equal(values.implicitTls, "true");
    assert.equal(values.scheme, "smtps");
  });

  it("only turns TLS off when asked to", () => {
    const relay = withMail({ defaults: { host: "relay.test", security: "none" }, namespaces: { a: {} } });
    assert.equal(buildMailValues(relay, "a").ignoreTls, "true");
    assert.equal(buildMailValues(withMail(SHARED), "cc-office").ignoreTls, "false");
  });

  it("restarts applications for a new server, without deriving anything from the password", () => {
    const one = buildMailValues(withMail(SHARED), "cc-office");
    const newPassword = buildMailValues(
      withMail({ ...SHARED, namespaces: { "cc-office": { username: "office", password: "changed" } } }),
      "cc-office",
    );
    const newHost = buildMailValues(
      withMail({ ...SHARED, defaults: { host: "other.example.test" } }),
      "cc-office",
    );

    assert.equal(one.revision, newPassword.revision);
    assert.notEqual(one.revision, newHost.revision);
  });
});

describe("checking an smtp section", () => {
  it("accepts namespaces with credentials of their own", () => {
    assert.deepEqual(checkMailConfig(withMail(SHARED)), []);
  });

  it("accepts a relay that takes mail without logging in", () => {
    assert.deepEqual(
      checkMailConfig(withMail({ defaults: { host: "relay.test", port: 25, security: "none" }, namespaces: { a: {} } })),
      [],
    );
  });

  it("has nothing to say when there's no section", () => {
    assert.deepEqual(checkMailConfig(BASE), []);
  });

  it("catches one login shared by two namespaces", () => {
    const shared = withMail({
      defaults: { host: "smtp.example.test" },
      namespaces: { a: { username: "same", password: "p" }, b: { username: "same", password: "p" } },
    });

    assert.match(checkMailConfig(shared).join(), /same user/);
  });

  it("refuses credentials in the defaults", () => {
    const leaky = withMail({ defaults: { host: "h", username: "u", password: "p" }, namespaces: { a: { username: "a", password: "p" } } });
    assert.match(checkMailConfig(leaky).join(), /has credentials in it/);
  });

  it("explains the cluster-wide shape it used to have", () => {
    assert.match(checkMailConfig(withMail({ host: "smtp.example.test" })).join(), /per namespace/);
  });

  it("asks for a host when neither the namespace nor the defaults has one", () => {
    assert.match(checkMailConfig(withMail({ namespaces: { a: {} } })).join(), /nowhere to send/);
  });

  it("asks for at least one namespace", () => {
    assert.match(checkMailConfig(withMail({ defaults: { host: "h" } })).join(), /gives no namespace mail/);
  });

  it("catches STARTTLS on the TLS port, which hangs rather than failing", () => {
    assert.match(checkMailConfig(withMail({ namespaces: { a: { host: "h", port: 465 } } })).join(), /465/);
  });

  it("catches half a login", () => {
    assert.match(checkMailConfig(withMail({ namespaces: { a: { host: "h", username: "u" } } })).join(), /no password/);
  });

  it("won't send a password in the clear", () => {
    assert.match(
      checkMailConfig(withMail({ namespaces: { a: { host: "h", security: "none", username: "u", password: "p" } } })).join(),
      /in the clear/,
    );
  });
});

describe("a namespace's credentials", () => {
  it("are kept out of what the cluster records about itself", () => {
    const redacted = redact({ smtp: SHARED });
    assert.equal(redacted.smtp.namespaces["cc-office"].password, REDACTED);
  });

  it("are its own, and nobody else's", () => {
    const config = configFrom(withMail(SHARED));
    const office = buildMailSecretManifest(config, "cc-office");

    assert.ok(office.includes("office-password"));
    assert.ok(!office.includes("acme-password"));
  });

  it("travel on standard input, and are applied so a new password lands", () => {
    const config = configFrom(withMail(SHARED));
    const command = buildApplyMailSecretCommand("cc-office") as TerminalCommandSpec;

    assert.ok((command.stdin as Function)(config).includes("office-password"));
    assert.ok(!shellOf(command, config).includes("office-password"));
    assert.match(shellOf(command, config), /kubectl apply -f -/);
  });

  it("are removed from a namespace whose mail was taken away", () => {
    const config = configFrom(withMail(SHARED));
    const text = shellOf(buildApplyMailSecretCommand("client-other") as TerminalCommandSpec, config);

    assert.match(text, /delete secret cc-smtp/);
    assert.ok(!text.includes("apply"));
  });

  it("are only removed when the installer put them there", () => {
    const config = configFrom(BASE);
    const text = shellOf(buildApplyMailSecretCommand("cc-office") as TerminalCommandSpec, config);

    assert.match(text, /if \[ "\$managed" = "community-cloud" \]/);
  });

  it("leave both keys there, empty, for a relay that needs no login", () => {
    const manifest = buildMailSecretManifest(
      configFrom(withMail({ defaults: { host: "relay.test" }, namespaces: { "cc-office": {} } })),
      "cc-office",
    );
    assert.match(manifest, /username: ""/);
    assert.match(manifest, /password: ""/);
  });
});

describe("applications that send mail", () => {
  for (const name of ["lago", "documenso"]) {
    it(`${name} is given its namespace's credentials before it starts`, () => {
      const names = buildPackageCommands(getPackage(name)!).map((command) => command.name);
      const firstManifest = names.findIndex((each) => each.startsWith("helm-manifest-after-"));

      assert.ok(names.indexOf("apply-smtp-cc-office") >= 0);
      assert.ok(names.indexOf("apply-smtp-cc-office") < firstManifest);
    });
  }

  it("share their namespace's one set of credentials", () => {
    const made = new Set<string>();
    const names = [
      ...buildPackageCommands(getPackage("lago")!, made),
      ...buildPackageCommands(getPackage("documenso")!, made),
    ].map((command) => command.name);

    assert.equal(names.filter((each) => each === "apply-smtp-cc-office").length, 1);
    assert.equal(names.filter((each) => each === "verify-smtp-reachable-cc-office").length, 1);
  });

  describe("in a namespace with no mail", async () => {
    const config = await loadFixtureConfig();
    delete config.getConfig().smtp.namespaces["cc-office"];
    const forOffice = { templateNamespace: "cc-office" };

    it("Lago is given no server, and still a sender", () => {
      const rendered = renderInstallerFile(config, "embed://apps/lago/Lago.config.yaml", forOffice);
      assert.ok(!rendered.includes("LAGO_SMTP_ADDRESS"));
      assert.match(rendered, /LAGO_FROM_EMAIL: "billing@example.test"/);
    });

    it("Documenso is given no server", () => {
      const rendered = renderInstallerFile(config, "embed://apps/documenso/Documenso.config.yaml", forOffice);
      assert.ok(!rendered.includes("NEXT_PRIVATE_SMTP_HOST"));
      assert.match(rendered, /NEXT_PRIVATE_SMTP_FROM_ADDRESS: "documents@example.test"/);
    });
  });

  describe("in a namespace with mail", async () => {
    const config = await loadFixtureConfig();
    const forOffice = { templateNamespace: "cc-office" };

    it("Lago sends through its namespace's server, upgrading to TLS", () => {
      const rendered = renderInstallerFile(config, "embed://apps/lago/Lago.config.yaml", forOffice);
      assert.match(rendered, /LAGO_SMTP_ADDRESS: "smtp.example.test"/);
      assert.match(rendered, /LAGO_SMTP_ENABLE_STARTTLS_AUTO: "true"/);
    });

    it("Documenso sends through its namespace's server", () => {
      const rendered = renderInstallerFile(config, "embed://apps/documenso/Documenso.config.yaml", forOffice);
      assert.match(rendered, /NEXT_PRIVATE_SMTP_HOST: "smtp.example.test"/);
      assert.match(rendered, /NEXT_PRIVATE_SMTP_SECURE: "false"/);
    });

    it("the same template rendered for another namespace gets that namespace's", () => {
      const rendered = renderInstallerFile(config, "embed://apps/documenso/Documenso.config.yaml", {
        templateNamespace: "client-acme",
      });
      assert.match(rendered, /NEXT_PRIVATE_SMTP_HOST: "smtp.acme.example.test"/);
      assert.match(rendered, /NEXT_PRIVATE_SMTP_SECURE: "true"/);
    });

    it("no template is handed a password", () => {
      for (const file of [
        "embed://apps/lago/Lago.config.yaml",
        "embed://apps/documenso/Documenso.config.yaml",
        "embed://apps/authentik/Authentik.values.yaml",
      ]) {
        const rendered = renderInstallerFile(config, file, forOffice);
        assert.ok(!rendered.includes("not-a-real-password"), file);
        assert.ok(!rendered.includes("not-a-real-acme-password"), file);
      }
    });
  });
});

describe("what a check-up asks about mail", () => {
  it("fails a namespace still holding credentials it was no longer given", () => {
    const config = configFrom(BASE);
    const text = shellOf(buildVerifyMailSecretCommand("cc-office") as TerminalCommandSpec, config);

    assert.match(text, /it can still send/);
  });

  it("checks a namespace with mail has its credentials", () => {
    const config = configFrom(withMail(SHARED));
    const text = shellOf(buildVerifyMailSecretCommand("cc-office") as TerminalCommandSpec, config);

    assert.match(text, /get secret cc-smtp/);
  });

  it("connects to the namespace's own server, bounded so a dropped port can't hang it", async () => {
    const config = await loadFixtureConfig();
    const text = shellOf(buildVerifyMailReachableCommand("client-acme") as TerminalCommandSpec, config);

    assert.match(text, /timeout 5 bash -c 'exec 3<>\/dev\/tcp\/smtp\.acme\.example\.test\/465'/);
  });

  it("doesn't try to reach a server for a namespace with no mail", () => {
    assert.equal(buildVerifyMailReachableCommand("cc-office").skipWhen!(configFrom(BASE), {}), true);
  });
});
