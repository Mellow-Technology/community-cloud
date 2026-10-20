/**
 * @file
 * Putting a namespace's mail credentials where its applications can
 * read them, and taking them away again.
 *
 * The rest of the mail configuration reaches applications through
 * their templates — see util/mail.ts. The username and password go a
 * different way, into a Secret in the application's namespace, so they
 * aren't written into a ConfigMap anyone in the namespace can read or
 * into a rendered manifest left on the control plane.
 *
 * Unlike the generated credentials in Secrets.ts, these are applied
 * rather than created once. Those are made up by the installer and
 * nothing else knows them, so writing them again would break whatever
 * is using them. These come from the configuration, which is where
 * they're changed: a new password goes in the file, the install is
 * run, and the namespace has it.
 *
 * And which is where they're revoked. Mail is per namespace so that a
 * namespace sending what it shouldn't can be cut off on its own, and
 * cutting it off means taking its entry out of the configuration — so
 * a namespace with no entry has its credentials removed, not merely
 * left where they were. Only a Secret the installer made is removed;
 * one someone put there by hand is theirs.
 *
 * A package says it sends mail with "mail: true", and gets this ahead
 * of its manifests.
 */
import { stringify } from "yaml";

import {
  CommandPurpose,
  CommandSpec,
  CommandTarget,
  OutputType,
} from "./Command.ts";
import { BASIC_AUTH } from "./Secrets.ts";
import CloudConfig from "../../util/CloudConfig.ts";
import { buildKubeEnv } from "../../util/kube.ts";
import { MAIL_SECRET, buildMailValues, getNamespaceMail } from "../../util/mail.ts";
import { quoteForShell } from "../../util/shell.ts";

// What marks a Secret as the installer's to remove
const MANAGED_LABEL = "app.kubernetes.io/managed-by";
const MANAGED_VALUE = "community-cloud";

/**
 * Whether a namespace was given mail.
 *
 * @param config
 * @param namespace
 * @returns
 */
function hasMail(config: CloudConfig, namespace: string): boolean {
  return buildMailValues(config.getConfig(), namespace).enabled;
}

/**
 * The Secret holding a namespace's mail credentials.
 *
 * Both keys are always there, empty for a relay that needs no login.
 * An application handed an empty username doesn't try to log in.
 *
 * @param config
 * @param namespace
 * @returns
 */
export function buildMailSecretManifest(config: CloudConfig, namespace: string): string {
  const mail = getNamespaceMail(config.getConfig(), namespace) ?? {};

  return stringify({
    apiVersion: "v1",
    kind: "Secret",
    metadata: {
      name: MAIL_SECRET,
      namespace,
      labels: { [MANAGED_LABEL]: MANAGED_VALUE },
    },
    type: BASIC_AUTH,
    stringData: {
      username: mail.username ?? "",
      password: mail.password ?? "",
    },
  });
}

/**
 * The shell that reads whether the namespace's Secret is the
 * installer's, into "$managed".
 *
 * @param namespace
 * @returns
 */
function readManaged(namespace: string): string {
  return `managed=$(kubectl -n ${quoteForShell(namespace)} get secret ${MAIL_SECRET} -o jsonpath='{.metadata.labels.${MANAGED_LABEL.replace(/\./g, "\\.")}}' 2>/dev/null)`;
}

/**
 * Give a namespace its mail credentials, or take them away.
 *
 * Over standard input, like every other credential, so the password is
 * never on a command line. Nothing goes over it when they're being
 * taken away, and the command reads nothing.
 *
 * @param namespace
 * @returns
 */
export function buildApplyMailSecretCommand(namespace: string): CommandSpec {
  return {
    name: `apply-smtp-${namespace}`,
    description: `Give ${namespace} its mail credentials, or remove them if it has none`,
    purpose: CommandPurpose.Apply,
    runOn: CommandTarget.ControlPlane,
    env: buildKubeEnv,
    command: (config: CloudConfig) =>
      hasMail(config, namespace)
        ? [
            // Apply, because the configuration is where this is changed
            `kubectl apply -f - || { echo "Couldn't put the mail credentials in ${namespace}" >&2; exit 1; }`,
          ]
        : [
            readManaged(namespace),
            `if [ "$managed" = "${MANAGED_VALUE}" ]`,
            "then",
            `  kubectl -n ${quoteForShell(namespace)} delete secret ${MAIL_SECRET} || { echo "${namespace} has no mail in the configuration, and its old credentials couldn't be removed" >&2; exit 1; }`,
            `  echo "${namespace} has no mail in the configuration, so its credentials were removed"`,
            "else",
            `  echo "${namespace} has no mail in the configuration, so it gets no credentials"`,
            "fi",
          ],
    stdin: (config: CloudConfig) =>
      hasMail(config, namespace) ? buildMailSecretManifest(config, namespace) : "",
    output: OutputType.Raw,
  };
}

/**
 * Check a namespace has the credentials it was given, and none it
 * wasn't.
 *
 * Credentials the installer left in a namespace whose mail was taken
 * away are a failure: that namespace can still send.
 *
 * @param namespace
 * @returns
 */
export function buildVerifyMailSecretCommand(namespace: string): CommandSpec {
  return {
    name: `verify-smtp-${namespace}`,
    description: `Verify ${namespace} has the mail credentials it was given, and none it wasn't`,
    purpose: CommandPurpose.Verify,
    runOn: CommandTarget.ControlPlane,
    env: buildKubeEnv,
    command: (config: CloudConfig) =>
      hasMail(config, namespace)
        ? [
            `kubectl -n ${quoteForShell(namespace)} get secret ${MAIL_SECRET} > /dev/null 2>&1 || { echo "${namespace} has mail in the configuration and no ${MAIL_SECRET}. Run the install again." >&2; exit 1; }`,
            `echo "${namespace} has its mail credentials"`,
          ]
        : [
            readManaged(namespace),
            `[ "$managed" != "${MANAGED_VALUE}" ] || { echo "${namespace} has no mail in the configuration, and still has the credentials it used to — it can still send. Run the install again to remove them." >&2; exit 1; }`,
            `echo "${namespace} has no mail, and no credentials"`,
          ],
    output: OutputType.Raw,
  };
}

/**
 * Check a namespace's mail server can be reached.
 *
 * Asked from the control plane, which leaves the cluster the way the
 * applications' pods do. Plenty of networks block outgoing mail ports
 * — 25 most of all — and nothing else would say so: an application
 * that can't connect logs it somewhere nobody is looking and carries
 * on. A connection that opens is all this asks; whether the server
 * then accepts the login is for the application to find out.
 *
 * Bash's /dev/tcp rather than a tool that may not be installed,
 * bounded by timeout so a port that drops packets rather than
 * refusing them doesn't hang the check-up.
 *
 * @param namespace
 * @returns
 */
export function buildVerifyMailReachableCommand(namespace: string): CommandSpec {
  return {
    name: `verify-smtp-reachable-${namespace}`,
    description: `Verify ${namespace}'s mail server can be reached from the cluster`,
    purpose: CommandPurpose.Verify,
    runOn: CommandTarget.ControlPlane,
    skipWhen: (config: CloudConfig) => !hasMail(config, namespace),
    command: (config: CloudConfig) => {
      const { host, port } = buildMailValues(config.getConfig(), namespace);

      return [
        `timeout 5 bash -c ${quoteForShell(`exec 3<>/dev/tcp/${host}/${port}`)} 2> /dev/null || { echo "Couldn't connect to ${namespace}'s mail server at ${host}:${port} from the control plane. If it's right, something between here and there is blocking the port — mail ports are often blocked by home and cloud networks alike." >&2; exit 1; }`,
        `echo "${namespace}'s mail server at ${host}:${port} answers"`,
      ];
    },
    output: OutputType.Raw,
  };
}
