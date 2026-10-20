/**
 * @file
 * The mail servers the cluster's applications send through, one set
 * of credentials per namespace.
 *
 * Nearly everything sends email — invoices, signing requests,
 * password resets, invitations — and every application wants to be
 * told about the mail server in its own words. Laravel wants a scheme,
 * Node's mailer a "secure" flag, Authentik a choice between two
 * booleans. So the configuration says it once and this turns it into
 * what each kind of application needs: a handful of derived values
 * every template can read as ".Values.mail", and a Secret with the
 * credentials, which applications read and templates leave alone.
 *
 * Once per namespace, rather than once for the cluster. The danger
 * with mail is less that it fails than that it succeeds too well:
 * something that gets into a namespace — a compromised application,
 * a plugin doing more than it said — finds working mail credentials
 * in its environment and starts sending. With one set shared by the
 * cluster, that's every namespace's mail stopped when the provider
 * suspends the account, and no way to say which one did it. With a set
 * each, the provider's own limits and logs are per namespace, one set
 * can be revoked without touching the rest, and a namespace that was
 * never given mail has nothing to send with.
 *
 * It's a little protection rather than a wall. A namespace's
 * credentials are readable by anything running in it, and nothing here
 * stops a pod connecting to some other mail server of its own.
 *
 * The servers are assumed to be somewhere else — a provider, or a
 * relay run by whoever runs the network. Running a mail server well is
 * its own job, mostly about reputation rather than software, and a
 * cluster in somebody's office is in no position to do it.
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

// The Secret the credentials go in, in each namespace given mail
export const MAIL_SECRET = "cc-smtp";

/**
 * Where a namespace's mail goes.
 *
 * - host: the mail server
 * - port: defaults to the usual one for "security"
 * - security: see MailSecurity. Defaults to starttls.
 * - fromDomain: the domain mail is sent from. Applications send as
 *   something@ this — invoices@, documents@ — and most providers only
 *   accept mail from a domain they've verified. Defaults to the
 *   cluster's main domain.
 */
export interface MailServer {
  host?: string;
  port?: number | string;
  security?: string;
  fromDomain?: string;
}

/**
 * One namespace's mail: a server, or the parts of one that differ from
 * the defaults, and the credentials that are its alone.
 *
 * - username, password: left out for a relay that takes mail without
 *   them, which applications then don't attempt
 */
export interface NamespaceMail extends MailServer {
  username?: string;
  password?: string;
}

/**
 * The smtp section of a configuration.
 *
 * - defaults: server settings every namespace starts from. Never
 *   credentials — those are each namespace's own, which is the point.
 * - namespaces: the namespaces that may send mail, by name. One that
 *   isn't here sends none.
 */
export interface MailConfig {
  defaults?: MailServer;
  namespaces?: Record<string, NamespaceMail>;
}

/**
 * What a template sees as ".Values.mail", for the namespace it's being
 * rendered for.
 *
 * Every field is always there, mail or no mail, so a template can
 * test "enabled" and otherwise refer to anything without rendering a
 * hole. The flags are strings because they go into environment
 * variables, which are strings, and every application reads "true".
 *
 * - enabled: whether the namespace was given mail at all
 * - host, port: where it goes
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
 * The namespaces given mail.
 *
 * @param raw the whole configuration
 * @returns
 */
export function getMailNamespaces(raw: Record<string, any>): string[] {
  return Object.keys(getMailConfig(raw)?.namespaces ?? {});
}

/**
 * A namespace's mail, with the defaults filled in, or nothing if the
 * namespace wasn't given any.
 *
 * @param raw the whole configuration
 * @param namespace
 * @returns
 */
export function getNamespaceMail(
  raw: Record<string, any>,
  namespace: string | undefined,
): NamespaceMail | undefined {
  const mail = getMailConfig(raw);

  if (namespace === undefined || mail === undefined) {
    return undefined;
  }

  const own = mail.namespaces?.[namespace];
  if (own === undefined || own === null) {
    return undefined;
  }

  // Only the server settings come from the defaults, whatever else
  // someone has put there. A namespace naming a host of its own is
  // naming a different server, so it takes nothing about the shared
  // one's connection — its port and security belong to a server it
  // isn't using — and only the domain it sends from.
  const { host, port, security, fromDomain } = mail.defaults ?? {};
  const inherited = own.host !== undefined && own.host !== ""
    ? { fromDomain }
    : { host, port, security, fromDomain };
  const defaults = Object.fromEntries(
    Object.entries(inherited).filter(([, value]) => value !== undefined),
  );

  return { ...defaults, ...own };
}

/**
 * The security asked for, or the default.
 *
 * @param mail
 * @returns
 */
function getSecurity(mail: MailServer): MailSecurity {
  return mail.security !== undefined ? (mail.security as MailSecurity) : MailSecurity.StartTls;
}

/**
 * The port asked for, or the usual one for the security.
 *
 * @param mail
 * @returns
 */
export function getMailPort(mail: MailServer): number {
  return mail.port !== undefined && mail.port !== "" ? Number(mail.port) : DEFAULT_PORTS[getSecurity(mail)];
}

/**
 * Build what templates see as ".Values.mail", for one namespace.
 *
 * @param raw the whole configuration
 * @param namespace the namespace being rendered for. Without one,
 *   mail is off: a template rendered for no namespace in particular
 *   has no namespace's credentials to use.
 * @returns
 */
export function buildMailValues(raw: Record<string, any>, namespace?: string): MailValues {
  const mail = getNamespaceMail(raw, namespace);
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
 * What's wrong with one namespace's mail, as sentences.
 *
 * @param namespace
 * @param mail with the defaults filled in
 * @returns
 */
function checkNamespaceMail(namespace: string, mail: NamespaceMail): string[] {
  const problems: string[] = [];
  const where = `"smtp.namespaces.${namespace}"`;

  if (mail.host === undefined || mail.host === "") {
    problems.push(`${where} has no "host", and neither does "smtp.defaults", so ${namespace} has nowhere to send mail.`);
    return problems;
  }

  const security = mail.security ?? MailSecurity.StartTls;
  if (!Object.values(MailSecurity).includes(security as MailSecurity)) {
    problems.push(`The mail security for ${namespace} is "${security}". It should be one of ${Object.values(MailSecurity).join(", ")}.`);
  }

  const port = getMailPort(mail);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    problems.push(`The mail port for ${namespace} is "${mail.port}", which isn't a port.`);
  }

  // The usual mistake, and one that fails as a hang rather than an
  // error: each end waiting for the other to start TLS
  if (port === 465 && security === MailSecurity.StartTls) {
    problems.push(`Mail for ${namespace} goes to port 465, which nearly always means TLS from the start, with "security" starttls. Set "security" to "tls".`);
  }

  if (port === 587 && security === MailSecurity.Tls) {
    problems.push(`Mail for ${namespace} goes to port 587, which nearly always means STARTTLS, with "security" tls. Set "security" to "starttls".`);
  }

  const hasUsername = mail.username !== undefined && mail.username !== "";
  const hasPassword = mail.password !== undefined && mail.password !== "";
  if (hasUsername !== hasPassword) {
    problems.push(`${where} has a ${hasUsername ? "username and no password" : "password and no username"}. Give both, or neither for a relay that doesn't ask.`);
  }

  if (hasPassword && security === MailSecurity.None) {
    problems.push(`Mail for ${namespace} has a password and no encryption — it would be sent to the mail server in the clear.`);
  }

  return problems;
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

  // The shape this had before it was per namespace
  if ("host" in mail || "username" in mail) {
    problems.push('"smtp" sets a mail server for the whole cluster, and mail is configured per namespace: put the server under "smtp.defaults" and give each namespace that sends mail its own credentials under "smtp.namespaces".');
    return problems;
  }

  const defaults = (mail.defaults ?? {}) as Record<string, unknown>;
  if ("username" in defaults || "password" in defaults) {
    problems.push('"smtp.defaults" has credentials in it. Each namespace has its own, so that one namespace sending more than it should doesn\'t cost every other its mail — they go under "smtp.namespaces".');
  }

  const namespaces = getMailNamespaces(raw);
  if (namespaces.length === 0) {
    problems.push('"smtp" gives no namespace mail. Add the ones that send it under "smtp.namespaces", or take the section out.');
  }

  for (const namespace of namespaces) {
    problems.push(...checkNamespaceMail(namespace, getNamespaceMail(raw, namespace)!));
  }

  // One login in two namespaces is one namespace's worth of protection
  const seen = new Map<string, string>();
  for (const namespace of namespaces) {
    const { host, username } = getNamespaceMail(raw, namespace)!;
    if (username === undefined || username === "") {
      continue;
    }

    const key = `${host}\n${username}`;
    const other = seen.get(key);
    if (other !== undefined) {
      problems.push(`${other} and ${namespace} send mail as the same user on ${host}, so either can use up or lose the other's mail. Give each its own.`);
    }
    seen.set(key, namespace);
  }

  return problems;
}
