/**
 * @file
 * The mail server, said once and heard by every application.
 *
 * Most of what can go wrong with mail goes wrong silently: an
 * application configured for TLS talking to a server waiting for
 * STARTTLS hangs until it times out, and one with no mail server logs
 * what it would have sent and carries on. So what's guarded here is
 * the translation — that one "smtp" section becomes the right setting
 * in each application's own vocabulary — and that the password only
 * ever travels the way passwords are meant to.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { TerminalCommandSpec, joinCommand } from "../cli/commands/Command.ts";
import { buildPackageCommands } from "../cli/commands/Helm.ts";
import { buildApplyMailSecretCommand, buildMailSecretManifest } from "../cli/commands/Mail.ts";
import { getPackage } from "../cli/commands/packages.ts";
import { buildMailValues, checkMailConfig } from "../util/mail.ts";
import { redact, REDACTED } from "../util/redact.ts";
import { renderInstallerFile } from "../util/template.ts";
import { configFrom, loadFixtureConfig } from "./helpers.ts";

const BASE = { values: { domain: { main: "example.test" } } };

/**
 * The derived values for an smtp section.
 */
function valuesFor(smtp: Record<string, unknown> | undefined) {
  return buildMailValues({ ...BASE, ...(smtp !== undefined ? { smtp } : {}) });
}

describe("what templates are told about mail", () => {
  it("says mail is off when there's no server, and still gives every field", () => {
    const values = valuesFor(undefined);

    assert.equal(values.enabled, false);
    assert.equal(values.fromDomain, "example.test");
    for (const [key, value] of Object.entries(values)) {
      assert.notEqual(value, undefined, key);
    }
  });

  it("takes STARTTLS on 587 as the default", () => {
    const values = valuesFor({ host: "smtp.example.test" });

    assert.equal(values.port, "587");
    assert.equal(values.startTls, "true");
    assert.equal(values.implicitTls, "false");
    assert.equal(values.scheme, "smtp");
  });

  it("says TLS from the start in each application's terms", () => {
    const values = valuesFor({ host: "smtp.example.test", security: "tls" });

    assert.equal(values.port, "465");
    assert.equal(values.implicitTls, "true");
    assert.equal(values.startTls, "false");
    assert.equal(values.scheme, "smtps");
  });

  it("only turns TLS off when asked to", () => {
    assert.equal(valuesFor({ host: "relay.test", security: "none" }).ignoreTls, "true");
    assert.equal(valuesFor({ host: "relay.test" }).ignoreTls, "false");
  });

  it("sends from the domain it's given", () => {
    assert.equal(valuesFor({ host: "smtp.example.test", fromDomain: "mail.example.test" }).fromDomain, "mail.example.test");
  });

  it("restarts applications for a new server, without deriving anything from the password", () => {
    const one = valuesFor({ host: "smtp.example.test", username: "u", password: "first" });
    const samePassword = valuesFor({ host: "smtp.example.test", username: "u", password: "second" });
    const otherHost = valuesFor({ host: "other.example.test", username: "u", password: "first" });

    assert.equal(one.revision, samePassword.revision);
    assert.notEqual(one.revision, otherHost.revision);
  });
});

describe("checking an smtp section", () => {
  const problems = (smtp: Record<string, unknown>) => checkMailConfig({ smtp });

  it("accepts a complete one", () => {
    assert.deepEqual(problems({ host: "smtp.example.test", username: "u", password: "p" }), []);
  });

  it("accepts a relay that takes mail without logging in", () => {
    assert.deepEqual(problems({ host: "relay.test", port: 25, security: "none" }), []);
  });

  it("has nothing to say when there's no section", () => {
    assert.deepEqual(checkMailConfig({}), []);
  });

  it("asks for a host", () => {
    assert.equal(problems({ username: "u" }).length, 1);
  });

  it("catches STARTTLS on the TLS port, which hangs rather than failing", () => {
    assert.match(problems({ host: "smtp.example.test", port: 465 }).join(), /465/);
  });

  it("catches half a login", () => {
    assert.match(problems({ host: "smtp.example.test", username: "u" }).join(), /no password/);
  });

  it("won't send a password in the clear", () => {
    assert.match(problems({ host: "r.test", security: "none", username: "u", password: "p" }).join(), /in the clear/);
  });

  it("names the kinds of security there are", () => {
    assert.match(problems({ host: "smtp.example.test", security: "ssl" }).join(), /starttls, tls, none/);
  });
});

describe("the credentials", () => {
  it("are kept out of what the cluster records about itself", () => {
    const redacted = redact({ smtp: { host: "smtp.example.test", password: "p" } });
    assert.equal(redacted.smtp.password, REDACTED);
    assert.equal(redacted.smtp.host, "smtp.example.test");
  });

  it("travel on standard input, and are applied so a new password lands", async () => {
    const config = await loadFixtureConfig();
    const command = buildApplyMailSecretCommand("cc-office") as TerminalCommandSpec;
    const text = joinCommand(command.command as string[]);
    const payload = (command.stdin as Function)(config);

    assert.ok(payload.includes("not-a-real-password-this-is-a-fixture"));
    assert.ok(!text.includes("not-a-real-password"));
    assert.match(text, /kubectl apply -f -/);
  });

  it("are skipped when there's no mail server", () => {
    const command = buildApplyMailSecretCommand("cc-office");
    assert.equal(command.skipWhen!(configFrom(BASE), {}), true);
  });

  it("leave both keys there, empty, for a relay that needs no login", () => {
    const manifest = buildMailSecretManifest(configFrom({ ...BASE, smtp: { host: "relay.test" } }), "cc-office");
    assert.match(manifest, /username: ""/);
    assert.match(manifest, /password: ""/);
  });
});

describe("applications that send mail", () => {
  for (const name of ["invoice-ninja", "documenso"]) {
    it(`${name} is given the credentials before it starts`, () => {
      const names = buildPackageCommands(getPackage(name)!).map((command) => command.name);
      const firstManifest = names.findIndex((each) => each.startsWith("helm-manifest-after-"));

      assert.ok(names.indexOf("apply-smtp-cc-office") >= 0);
      assert.ok(names.indexOf("apply-smtp-cc-office") < firstManifest);
    });
  }

  it("share one set of credentials in a namespace", () => {
    const made = new Set<string>();
    const names = [
      ...buildPackageCommands(getPackage("invoice-ninja")!, made),
      ...buildPackageCommands(getPackage("documenso")!, made),
    ].map((command) => command.name);

    assert.equal(names.filter((each) => each === "apply-smtp-cc-office").length, 1);
  });

  describe("with no mail server", async () => {
    const config = await loadFixtureConfig();
    delete config.getConfig().smtp;

    it("Invoice Ninja logs what it would have sent", () => {
      const rendered = renderInstallerFile(config, "embed://apps/invoice-ninja/InvoiceNinja.config.yaml");
      assert.match(rendered, /MAIL_MAILER: "log"/);
      assert.ok(!rendered.includes("MAIL_HOST"));
    });

    it("Documenso is given no server", () => {
      const rendered = renderInstallerFile(config, "embed://apps/documenso/Documenso.config.yaml");
      assert.ok(!rendered.includes("NEXT_PRIVATE_SMTP_HOST"));
      assert.match(rendered, /NEXT_PRIVATE_SMTP_FROM_ADDRESS: "documents@example.test"/);
    });
  });

  describe("with one", async () => {
    const config = await loadFixtureConfig();

    it("Invoice Ninja sends through it", () => {
      const rendered = renderInstallerFile(config, "embed://apps/invoice-ninja/InvoiceNinja.config.yaml");
      assert.match(rendered, /MAIL_MAILER: "smtp"/);
      assert.match(rendered, /MAIL_HOST: "smtp.example.test"/);
    });

    it("Documenso sends through it", () => {
      const rendered = renderInstallerFile(config, "embed://apps/documenso/Documenso.config.yaml");
      assert.match(rendered, /NEXT_PRIVATE_SMTP_HOST: "smtp.example.test"/);
      assert.match(rendered, /NEXT_PRIVATE_SMTP_SECURE: "false"/);
    });

    it("no template is handed the password", () => {
      for (const file of [
        "embed://apps/invoice-ninja/InvoiceNinja.config.yaml",
        "embed://apps/documenso/Documenso.config.yaml",
        "embed://apps/authentik/Authentik.values.yaml",
      ]) {
        assert.ok(!renderInstallerFile(config, file).includes("not-a-real-password"), file);
      }
    });
  });
});
