/**
 * @file
 * The mail server the cluster's applications send through.
 *
 * Asked once, for everything: the applications are each told about it
 * in their own terms by their templates. See util/mail.ts.
 */
import { confirm, input, password, select } from "@inquirer/prompts";

import {
  ConfigDraft,
  ConfigSection,
  NOTHING_SET,
  readPath,
  required,
  validateHostname,
  writePath,
} from "../section.ts";
import { MailSecurity, getMailPort } from "../../../util/mail.ts";

export const mailSection: ConfigSection = {
  name: "mail",
  title: "Mail",

  describe: (draft) => {
    const host = readPath(draft, "smtp.host");

    if (host === undefined || host === "") {
      return NOTHING_SET;
    }

    return `${host}:${getMailPort(readPath(draft, "smtp"))}`;
  },

  run: async (draft: ConfigDraft) => {
    console.log(`
  The mail server applications send through: invoices, signing
  requests, password resets. It's somewhere else — a provider, or a
  relay on your network. Without one, applications keep their mail to
  themselves, mostly in their logs.
`);

    const wanted = await confirm({
      message: "Do the applications have a mail server to send through?",
      default: readPath(draft, "smtp.host") !== undefined,
    });

    if (!wanted) {
      writePath(draft, "smtp", undefined);
      return;
    }

    const host = await input({
      message: "Mail server hostname (e.g. smtp.example.com)",
      default: readPath(draft, "smtp.host"),
      validate: validateHostname,
    });

    const security = await select({
      message: "How is the connection secured?",
      default: readPath(draft, "smtp.security") ?? MailSecurity.StartTls,
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
      default: String(readPath(draft, "smtp.port") ?? getMailPort({ security })),
      validate: (value: string) => {
        const number = Number(value);
        return Number.isInteger(number) && number > 0 && number < 65536 ? true : "That isn't a port.";
      },
    });

    const authenticates = await confirm({
      message: "Does it need a username and password?",
      default: security !== MailSecurity.None,
    });

    let username: string | undefined;
    let secret: string | undefined;

    if (authenticates) {
      username = (
        await input({
          message: "Username",
          default: readPath(draft, "smtp.username"),
          validate: required("a username"),
        })
      ).trim();

      const entered = await password({
        message: "Password (blank keeps the existing one)",
        mask: true,
      });

      secret = entered.trim() !== "" ? entered.trim() : readPath(draft, "smtp.password");

      if (secret === undefined) {
        console.log("  No password given and none on file. Preflight will say so until there is one.");
      }
    }

    const fromDomain = await input({
      message: "Domain mail is sent from (blank for the cluster's main domain)",
      default: readPath(draft, "smtp.fromDomain") ?? "",
      validate: (value: string) => (value.trim() === "" ? true : validateHostname(value)),
    });

    writePath(draft, "smtp", {
      host: host.trim(),
      port: Number(port),
      security,
      ...(username !== undefined ? { username } : {}),
      ...(secret !== undefined ? { password: secret } : {}),
      ...(fromDomain.trim() !== "" ? { fromDomain: fromDomain.trim() } : {}),
    });

    console.log("  The password is in the configuration file, so keep that file private.");
  },
};
