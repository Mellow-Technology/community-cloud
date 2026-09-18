/**
 * @file
 * The credentials the installer makes up, and the manifests that use
 * them.
 *
 * The invariant worth guarding is the one no type can catch: a Secret
 * declared in packages.ts and a Secret named in a DatabaseRole are
 * joined only by a string, and if they drift apart the role silently
 * stops being created — the cluster looks fine and one application
 * can't log in.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseAllDocuments } from "yaml";

import { TerminalCommandSpec, joinCommand } from "../cli/commands/Command.ts";
import {
  BASIC_AUTH,
  buildCreateSecretCommand,
  buildSecretManifest,
  buildVerifySecretsCommand,
} from "../cli/commands/Secrets.ts";
import { packageCatalogue } from "../cli/commands/packages.ts";
import {
  PASSWORD_WORDS,
  USERNAME_WORDS,
  generatePassword,
  generateUsername,
} from "../util/credentials.ts";
import { INSTALLER_ROOT, REPO_ROOT } from "./helpers.ts";

const ROLES_FILE = join(REPO_ROOT, "k8s", "apps", "office", "Office.roles.yaml");

// Lower case words joined by hyphens, which is safe in a shell word, a
// YAML scalar, a Postgres password and a connection string
const SAFE_PHRASE = /^[a-z]+(-[a-z]+)*$/;

/**
 * Every credential the catalogue declares, keyed by where it goes.
 */
function declaredSecrets(): Map<string, any> {
  const declared = new Map<string, any>();

  for (const definition of packageCatalogue) {
    for (const secret of definition.secrets ?? []) {
      declared.set(`${secret.namespace ?? definition.namespace}/${secret.name}`, secret);
    }
  }

  return declared;
}

/**
 * The DatabaseRole documents the installer ships.
 */
function shippedRoles(): any[] {
  return parseAllDocuments(readFileSync(ROLES_FILE, "utf8"))
    .map((document) => document.toJS())
    .filter((document: any) => document?.kind === "DatabaseRole");
}

describe("generated credentials", () => {
  it("makes a username of the declared number of words", () => {
    assert.equal(generateUsername().split("-").length, USERNAME_WORDS);
  });

  it("makes a password of the declared number of words", () => {
    assert.equal(generatePassword().split("-").length, PASSWORD_WORDS);
  });

  it("uses only characters that are safe everywhere they end up", () => {
    assert.match(generateUsername(), SAFE_PHRASE);
    assert.match(generatePassword(), SAFE_PHRASE);
  });

  it("does not repeat itself", () => {
    // A seeded generator handed the same seed twice would give one
    // password to the whole cluster, which is the failure this is for
    const many = new Set(Array.from({ length: 200 }, () => generatePassword()));
    assert.equal(many.size, 200);
  });
});

describe("the roles the installer ships", () => {
  const declared = declaredSecrets();
  const roles = shippedRoles();

  it("has roles to check", () => {
    assert.ok(roles.length > 0, `no DatabaseRole documents in ${ROLES_FILE}`);
  });

  for (const role of roles) {
    describe(role.metadata.name, () => {
      const key = `${role.metadata.namespace}/${role.spec.passwordSecret?.name}`;
      const secret = declared.get(key);

      it("names a credential the installer creates", () => {
        assert.ok(
          secret !== undefined,
          `${key} is named by the role and declared by no package`,
        );
      });

      it("carries the role's Postgres name as its username", () => {
        // CloudNativePG compares the two and refuses the role if they
        // differ, so this is the Postgres name and not the Secret's
        assert.equal(secret?.username, role.spec.name);
      });

      it("is labelled so a changed password reaches Postgres", () => {
        // The operator only watches Secrets carrying this. Without it
        // the first password is applied and no later one ever is.
        assert.equal(secret?.labels?.["cnpg.io/reload"], "true");
      });
    });
  }
});

describe("the Secret a package produces", () => {
  const sample = declaredSecrets().get("cc-office/twenty-crm");
  const manifest: any = parseAllDocuments(
    buildSecretManifest(sample, "cc-office"),
  )[0]!.toJS();

  it("is basic auth, which is what CloudNativePG reads", () => {
    assert.equal(manifest.type, BASIC_AUTH);
  });

  it("carries both halves of the pair", () => {
    assert.equal(typeof manifest.stringData.username, "string");
    assert.equal(typeof manifest.stringData.password, "string");
  });

  it("uses the fixed username rather than generating one", () => {
    assert.equal(manifest.stringData.username, "twenty_crm");
  });
});

describe("the commands that put credentials in the cluster", () => {
  const sample = declaredSecrets().get("cc-office/twenty-crm");
  const command = buildCreateSecretCommand(sample, "cnpg-system") as TerminalCommandSpec;
  const text = joinCommand(
    typeof command.command === "function"
      ? command.command({}, {})
      : command.command,
  );
  const payload = (command.stdin as Function)();

  it("keeps the password off the command line", () => {
    const password = payload.match(/password: (.*)/)![1]!;
    assert.ok(!text.includes(password), "it travels on standard input");
  });

  it("only ever creates, so a second run can't overwrite", () => {
    assert.ok(text.includes("kubectl create -f -"));
    assert.ok(!text.includes("apply"), "apply would replace a live password");
  });

  it("leaves an existing credential alone", () => {
    assert.ok(text.includes("get secret"));
    assert.ok(text.includes("exit 0"));
  });

  it("verifies shape without reading values", () => {
    const verify = joinCommand(
      (buildVerifySecretsCommand([sample], "cnpg-system", "test") as TerminalCommandSpec)
        .command as string[],
    );

    assert.ok(verify.includes("{.type}:{.data.username}:{.data.password}"));
    assert.ok(!verify.includes("base64"), "nothing decodes a stored password");
  });
});

describe("the README", () => {
  const readme = readFileSync(join(INSTALLER_ROOT, "README.md"), "utf8");

  it("describes the word counts the code uses", () => {
    assert.ok(readme.includes("three-word") && USERNAME_WORDS === 3);
    assert.ok(readme.includes("five-word") && PASSWORD_WORDS === 5);
  });

  it("explains the reload label", () => {
    assert.ok(
      readme.includes("cnpg.io/reload"),
      "the reason a rotated password propagates is worth writing down",
    );
  });
});
