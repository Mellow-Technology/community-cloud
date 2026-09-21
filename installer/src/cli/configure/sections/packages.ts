/**
 * @file
 * What gets installed into the cluster, and where the images for it
 * come from.
 *
 * The list of packages comes from the catalogue rather than being
 * written out here, so what can be chosen is exactly what can actually
 * be installed. Offering something the installer has no chart for
 * would be a promise it can't keep.
 */
import { checkbox, confirm, input, password } from "@inquirer/prompts";
import { randomBytes } from "node:crypto";

import {
  ConfigDraft,
  ConfigSection,
  NOTHING_SET,

  readPath,
  required,
  writePath,
} from "../section.ts";
import { packageCatalogue } from "../../commands/packages.ts";

export const packagesSection: ConfigSection = {
  name: "packages",
  title: "Packages",

  describe: (draft) => {
    const packages = readPath(draft, "packages");

    if (packages === undefined || packages === null) {
      return NOTHING_SET;
    }

    const enabled = Object.entries(packages)
      .filter(([, selection]) => typeof selection !== "string" && selection !== false)
      .filter(([, selection]) => selection === true || (selection as any).enabled !== false)
      .map(([name]) => name);

    return enabled.length > 0 ? enabled.join(", ") : "none enabled";
  },

  run: async (draft: ConfigDraft) => {
    const packages: Record<string, unknown> =
      readPath(draft, "packages") !== undefined && readPath(draft, "packages") !== null
        ? { ...(readPath(draft, "packages") as Record<string, unknown>) }
        : {};

    const isEnabled = (name: string) => {
      const selection = packages[name];
      if (selection === undefined || typeof selection === "string") {
        return false;
      }

      return selection === true || (selection as any).enabled !== false;
    };

    const chosen = await checkbox({
      message: "Which packages should this cluster run?",
      choices: packageCatalogue.map((entry) => ({
        name: entry.name,
        value: entry.name,
        description: `${entry.description}${entry.requires !== undefined ? `. Requires: ${entry.requires.join(", ")}` : ""}`,
        checked: isEnabled(entry.name),
      })),
    });

    for (const entry of packageCatalogue) {
      const selection = packages[entry.name];

      if (chosen.includes(entry.name)) {
        // Leave any version or values overrides alone
        if (selection === undefined || selection === true || typeof selection === "string") {
          packages[entry.name] = true;
        }
        else {
          packages[entry.name] = { ...(selection as object), enabled: true };
        }

        continue;
      }

      // Not chosen. Remove it rather than writing enabled: false,
      // unless it carries settings worth keeping.
      if (selection !== undefined && typeof selection === "object") {
        packages[entry.name] = { ...(selection as object), enabled: false };
      }
      else {
        delete packages[entry.name];
      }
    }

    writePath(draft, "packages", packages);

    // Authentik needs a secret key of its own, and the chart won't
    // start without one
    if (chosen.includes("authentik") && readPath(draft, "values.authentik.secretKey") === undefined) {
      const generate = await confirm({
        message: "Authentik needs a secret key. Generate one now?",
        default: true,
      });

      if (generate) {
        writePath(draft, "values.authentik.secretKey", randomBytes(48).toString("base64"));
        console.log("  Generated. It's in the configuration file, so keep that file private.");
      }
    }
  },
};

export const registriesSection: ConfigSection = {
  name: "registries",
  title: "Container registries",

  describe: (draft) => {
    const registries = readPath(draft, "registries");

    if (registries === undefined || registries === null || Object.keys(registries).length === 0) {
      return NOTHING_SET;
    }

    return Object.keys(registries).join(", ");
  },

  run: async (draft: ConfigDraft) => {
    const registries: Record<string, any> =
      readPath(draft, "registries") !== undefined && readPath(draft, "registries") !== null
        ? { ...(readPath(draft, "registries") as Record<string, any>) }
        : {};

    console.log(`
  Credentials for registries the cluster pulls images from. These end
  up in /etc/rancher/k3s/registries.yaml on every node, readable only
  by root. A registry that needs nothing doesn't belong here.
`);

    // A cluster pulling only from public registries needs none of
    // this, so the first question is whether there's anything to add
    let adding = await confirm({
      message:
        Object.keys(registries).length > 0
          ? `Configured: ${Object.keys(registries).join(", ")}. Add or change one?`
          : "Does the cluster pull from a registry that needs credentials?",
      default: Object.keys(registries).length === 0 ? false : false,
    });

    while (adding) {
      const host = (
        await input({
          message: "Registry hostname (e.g. registry.gitlab.com)",
          validate: required("a hostname"),
        })
      ).trim();

      const username = (
        await input({
          message: `Username for ${host}`,
          default: readPath(draft, `registries.${host}.auth.username`),
          validate: required("a username"),
        })
      ).trim();

      const secret = await password({
        message: `Password or token for ${host} (blank keeps the existing one)`,
        mask: true,
      });

      const current = readPath(draft, `registries.${host}.auth.password`);
      if (secret.trim() === "" && current === undefined) {
        console.log("  No password given and none on file, so this registry was skipped.");
      }
      else {
        registries[host] = {
          ...(registries[host] !== undefined ? registries[host] : {}),
          auth: {
            username,
            password: secret.trim() !== "" ? secret.trim() : current,
          },
        };
      }

      adding = await confirm({ message: "Add another registry?", default: false });
    }

    writePath(draft, "registries", registries);
  },
};

export const k3sSection: ConfigSection = {
  name: "k3s",
  title: "K3s",

  describe: (draft) => {
    const token = readPath(draft, "k3s.token");
    return token !== undefined ? "cluster token set" : NOTHING_SET;
  },

  run: async (draft: ConfigDraft) => {
    const existing = readPath(draft, "k3s.token");

    if (existing !== undefined) {
      const keep = await confirm({
        message: "A cluster token is already set. Keep it?",
        default: true,
      });

      if (keep) {
        return;
      }

      console.log("  Replacing the token means existing agents will no longer be able to join.");
    }

    const generate = await confirm({
      message: "Generate a cluster token? Answer no to paste one from an existing cluster.",
      default: true,
    });

    if (generate) {
      writePath(draft, "k3s.token", randomBytes(32).toString("hex"));
      console.log("  Generated.");
      return;
    }

    const token = await password({
      message: "Cluster token, as the server reports it",
      mask: true,
    });

    writePath(draft, "k3s.token", token.trim());
  },
};
