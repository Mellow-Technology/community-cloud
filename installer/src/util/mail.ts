/**
 * @file
 * The mail server the cluster's applications send through.
 *
 * Nearly everything sends email — invoices, signing requests,
 * password resets, invitations — and every application wants to be
 * told about the mail server in its own words. Laravel wants a scheme,
 * Node's mailer a "secure" flag, Authentik a choice between two
 * booleans. Asking the person running the cluster for each of those
 * is asking them to learn every application's configuration to say
 * one thing, and to say it again, slightly differently, for the next.
 *
 * So the configuration says it once, in "smtp", and this turns it
 * into what each kind of application needs: a handful of derived
 * values every template can read as ".Values.mail", and a Secret with
 * the credentials, which applications read and templates leave alone.
 *
 * The server is assumed to be somewhere else — a provider, or a relay
 * run by whoever runs the network. Running a mail server well is its
 * own job, mostly about reputation rather than software, and a cluster
 * in somebody's office is in no position to do it.
 *
 * A cluster without "smtp" is fine. Every application that sends mail
 * has somewhere sensible to put it otherwise, usually its own log, and
 * the derived values say mail is off so their templates can choose.
 */
import { createHash } from "node:crypto";

// How a connection is secured.
//
// - starttls: connect in the clear and upgrade, which is what port
//   587 means almost everywhere
// - tls: TLS from the first byte, which is what 465 means
// - none: no encryption at all. For a relay on the same network that
//   doesn't offer it; never for anything across the internet, since
//   the credentials would cross it in the clear.
export enum MailSecurity {
  StartTls = "starttls",
  Tls = "tls",
  None = "none",
}

// The port each kind of security usually means, for when the
// configuration doesn't give one
const DEFAULT_PORTS: Record<MailSecurity, number> = {
  [MailSecurity.StartTls]: 587,
  [MailSecurity.Tls]: 465,
  [MailSecurity.None]: 25,
};

// The Secret the credentials go in, in each namespace an application
// that sends mail runs in
export const MAIL_SECRET = "cc-smtp";

/**
 * The smtp section of a configuration.
 *
 * - host: the mail server
 * - port: defaults to the usual one for "security"
 * - security: see MailSecurity. Defaults to starttls.
 * - username, password: left out for a relay that takes mail without
 *   them, which applications then don't attempt
 * - fromDomain: the domain mail is sent from. Applications send as
 *   something@ this — invoices@, documents@ — and most providers only
 *   accept mail from a domain they've verified. Defaults to the
 *   cluster's main domain.
 */
export interface MailConfig {
  host?: string;
  port?: number | string;
  security?: string;
  username?: string;
  password?: string;
  fromDomain?: string;
}

/**
 * What a template sees as ".Values.mail".
 *
 * Every field is always there, mail or no mail, so a template can
 * test "enabled" and otherwise refer to anything without rendering a
 * hole. The flags are strings because they go into environment
 * variables, which are strings, and every application reads "true".
 *
 * - enabled: whether there's a mail server at all
 * - host, port: where it is
 * - implicitTls: "true" when TLS starts with the connection — what
 *   Node's mailer calls "secure" and Authentik "use_ssl"
 * - startTls: "true" when the connection is upgraded — Authentik's
 *   "use_tls"
 * - ignoreTls: "true" when TLS isn't to be attempted at all
 * - scheme: "smtps" or "smtp", which is how Symfony's mailer, and so
 *   Laravel's, says the same thing
 * - fromDomain: where mail comes from
 * - revision: changes whenever anything above, or the username, does.
 *   For a pod annotation, so applications restart and pick up a new
 *   server: Kubernetes doesn't restart anything for a changed
 *   ConfigMap or Secret. The password isn't in it, to keep anything
 *   derived from it out of the pod spec, so a new password alone
 *   needs a restart by hand.
 */
export interface MailValues {
  enabled: boolean;
  host: string;
  port: string;
  implicitTls: string;
  startTls: string;
  ignoreTls: string;
  scheme: string;
  fromDomain: string;
  revision: string;
}

/**
 * Read the smtp section, if there is one.
 *
 * @param raw the whole configuration
 * @returns
 */
export function getMailConfig(raw: Record<string, any>): MailConfig | undefined {
  const { smtp } = raw;

  return smtp !== undefined && smtp !== null && typeof smtp === "object" ? smtp : undefined;
}

/**
 * The security asked for, or the default.
 *
 * @param mail
 * @returns
 */
function getSecurity(mail: MailConfig): MailSecurity {
  return mail.security !== undefined ? (mail.security as MailSecurity) : MailSecurity.StartTls;
}

/**
 * The port asked for, or the usual one for the security.
 *
 * @param mail
 * @returns
 */
export function getMailPort(mail: MailConfig): number {
  return mail.port !== undefined && mail.port !== "" ? Number(mail.port) : DEFAULT_PORTS[getSecurity(mail)];
}

/**
 * Build what templates see as ".Values.mail".
 *
 * @param raw the whole configuration
 * @returns
 */
export function buildMailValues(raw: Record<string, any>): MailValues {
  const mail = getMailConfig(raw);
  const values = raw["values"] ?? {};
  const mainDomain = values.domain?.main ?? raw["domain"]?.main ?? "";

  if (mail === undefined || mail.host === undefined || mail.host === "") {
    return {
      enabled: false,
      host: "",
      port: "",
      implicitTls: "false",
      startTls: "false",
      ignoreTls: "false",
      scheme: "smtp",
      fromDomain: mainDomain,
      revision: "none",
    };
  }

  const security = getSecurity(mail);
  const port = String(getMailPort(mail));
  const fromDomain = mail.fromDomain !== undefined && mail.fromDomain !== "" ? mail.fromDomain : mainDomain;

  return {
    enabled: true,
    host: mail.host,
    port,
    implicitTls: String(security === MailSecurity.Tls),
    startTls: String(security === MailSecurity.StartTls),
    ignoreTls: String(security === MailSecurity.None),
    scheme: security === MailSecurity.Tls ? "smtps" : "smtp",
    fromDomain,
    revision: createHash("sha256")
      .update([mail.host, port, security, mail.username ?? "", fromDomain].join("\n"))
      .digest("hex")
      .slice(0, 12),
  };
}

/**
 * What's wrong with the smtp section, as sentences.
 *
 * @param raw the whole configuration
 * @returns
 */
export function checkMailConfig(raw: Record<string, any>): string[] {
  const mail = getMailConfig(raw);
  const problems: string[] = [];

  if (mail === undefined) {
    return problems;
  }

  if (mail.host === undefined || mail.host === "") {
    problems.push('"smtp" is there but has no "host", so applications will keep their mail to themselves. Give it the mail server, or take the section out.');
    return problems;
  }

  const security = mail.security ?? MailSecurity.StartTls;
  if (!Object.values(MailSecurity).includes(security as MailSecurity)) {
    problems.push(`"smtp.security" is "${security}". It should be one of ${Object.values(MailSecurity).join(", ")}.`);
  }

  const port = getMailPort(mail);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    problems.push(`"smtp.port" is "${mail.port}", which isn't a port.`);
  }

  // The usual mistake, and one that fails as a hang rather than an
  // error: each end waiting for the other to start TLS
  if (port === 465 && security === MailSecurity.StartTls) {
    problems.push('"smtp.port" is 465, which nearly always means TLS from the start, and "smtp.security" is starttls. Set "security" to "tls".');
  }

  if (port === 587 && security === MailSecurity.Tls) {
    problems.push('"smtp.port" is 587, which nearly always means STARTTLS, and "smtp.security" is tls. Set "security" to "starttls".');
  }

  const hasUsername = mail.username !== undefined && mail.username !== "";
  const hasPassword = mail.password !== undefined && mail.password !== "";
  if (hasUsername !== hasPassword) {
    problems.push(`"smtp" has a ${hasUsername ? "username and no password" : "password and no username"}. Give both, or neither for a relay that doesn't ask.`);
  }

  if (hasPassword && security === MailSecurity.None) {
    problems.push('"smtp.security" is none, and there\'s a password — it would be sent to the mail server in the clear.');
  }

  return problems;
}
