/**
 * @file
 * The mail servers the cluster's applications send through, and which
 * namespaces may send.
 *
 * Asked as a server most namespaces share, then the namespaces one at a
 * time, each with credentials of its own. Why per namespace, and why
 * the credentials are never shared, is in util/mail.ts.
 */
import { confirm, input, password, select } from "@inquirer/prompts";

import {
  ConfigDraft,
  ConfigSection,
  NOTHING_SET,
  readPath,
  required,
  validateHostname,
  validateNodeName,
  writePath,
} from "../section.ts";
import { MailSecurity, NamespaceMail, getMailPort } from "../../../util/mail.ts";

/**
 * Ask for a server's settings.
 *
 * @param current what's set now, offered as the answers
 * @param optional whether every answer may be left blank, to fall back
 *   on the shared server
 * @returns
 */
async function askServer(current: NamespaceMail, optional: boolean): Promise<NamespaceMail> {
  const blank = optional ? " (blank for the shared server's)" : "";

  const host = (
    await input({
      message: `Mail server hostname${blank}`,
      default: current.host,
      validate: (value: string) =>
        optional && value.trim() === "" ? true : validateHostname(value),
    })
  ).trim();

  if (optional && host === "") {
    return {};
  }

  const security = await select({
    message: "How is the connection secured?",
    default: (current.security as MailSecurity | undefined) ?? MailSecurity.StartTls,
    choices: [
      {
        name: "STARTTLS, usually port 587 (Recommended)",
        value: MailSecurity.StartTls,
        description: "Connects, then upgrades to TLS. What most providers give you.",
      },
      {
        name: "TLS from the start, usually port 465",
        value: MailSecurity.Tls,
        description: "Encrypted from the first byte.",
      },
      {
        name: "None, usually port 25",
        value: MailSecurity.None,
        description: "Only for a relay on your own network that offers nothing better. Never with a password.",
      },
    ],
  });

  const port = await input({
    message: "Port",
    default: String(current.port ?? getMailPort({ security })),
    validate: (value: string) => {
      const number = Number(value);
      return Number.isInteger(number) && number > 0 && number < 65536 ? true : "That isn't a port.";
    },
  });

  const fromDomain = (
    await input({
      message: "Domain mail is sent from (blank for the cluster's main domain)",
      default: current.fromDomain ?? "",
      validate: (value: string) => (value.trim() === "" ? true : validateHostname(value)),
    })
  ).trim();

  return {
    host,
    port: Number(port),
    security,
    ...(fromDomain !== "" ? { fromDomain } : {}),
  };
}

export const mailSection: ConfigSection = {
  name: "mail",
  title: "Mail",

  describe: (draft) => {
    const namespaces = Object.keys(readPath(draft, "smtp.namespaces") ?? {});
    return namespaces.length > 0 ? `for ${namespaces.join(", ")}` : NOTHING_SET;
  },

  run: async (draft: ConfigDraft) => {
    console.log(`
  The mail servers applications send through: invoices, signing
  requests, password resets. They're somewhere else — a provider, or
  a relay on your network.

  Each namespace that sends mail gets credentials of its own, and a
  namespace that isn't given any sends none. If something in one
  namespace starts sending what it shouldn't, that namespace's
  credentials can be taken away without touching anyone else's.
`);

    const wanted = await confirm({
      message: "Should any namespace be able to send mail?",
      default: readPath(draft, "smtp.namespaces") !== undefined,
    });

    if (!wanted) {
      writePath(draft, "smtp", undefined);
      return;
    }

    console.log("\n  First, the server most namespaces send through. Each can use its own instead.\n");
    const defaults = await askServer(readPath(draft, "smtp.defaults") ?? {}, false);

    const namespaces: Record<string, NamespaceMail> = {
      ...(readPath(draft, "smtp.namespaces") ?? {}),
    };

    let adding = true;
    while (adding) {
      const configured = Object.keys(namespaces);
      if (configured.length > 0) {
        console.log(`\n  Namespaces with mail: ${configured.join(", ")}`);
      }

      const namespace = (
        await input({
          message: "Namespace to give mail (e.g. cc-office)",
          default: configured.length === 0 ? "cc-office" : undefined,
          validate: validateNodeName,
        })
      ).trim();

      const current = namespaces[namespace] ?? {};
      const ownServer = await confirm({
        message: `Does ${namespace} send through a server of its own?`,
        default: current.host !== undefined,
      });
      const server = ownServer ? await askServer(current, true) : {};

      const authenticates = await confirm({
        message: `Does ${namespace} log in to send?`,
        default: (server.security ?? defaults.security) !== MailSecurity.None,
      });

      let credentials: NamespaceMail = {};
      if (authenticates) {
        const username = (
          await input({
            message: `Username for ${namespace} — one of its own, not shared with another namespace`,
            default: current.username,
            validate: required("a username"),
          })
        ).trim();

        const entered = await password({
          message: "Password (blank keeps the existing one)",
          mask: true,
        });

        const secret = entered.trim() !== "" ? entered.trim() : current.password;
        if (secret === undefined) {
          console.log("  No password given and none on file. Preflight will say so until there is one.");
        }

        credentials = { username, ...(secret !== undefined ? { password: secret } : {}) };
      }

      namespaces[namespace] = { ...server, ...credentials };

      adding = await confirm({ message: "Give another namespace mail?", default: false });
    }

    writePath(draft, "smtp", { defaults, namespaces });
    console.log("  The passwords are in the configuration file, so keep that file private.");
  },
};
