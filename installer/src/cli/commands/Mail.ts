/**
 * @file
 * Putting the mail server's credentials where applications can read
 * them.
 *
 * The rest of the mail configuration reaches applications through
 * their templates — see util/mail.ts. The username and password go a
 * different way, into a Secret in the application's namespace, so they
 * aren't written into a ConfigMap anyone in the namespace can read or
 * into a rendered manifest left on the control plane.
 *
 * Unlike the generated credentials in Secrets.ts, this one is applied
 * rather than created once. Those are made up by the installer and
 * nothing else knows them, so writing them again would break whatever
 * is using them. This one comes from the configuration, which is where
 * it's changed: a new password goes in the file, the install is run,
 * and the cluster has it.
 *
 * A package says it sends mail with "mail: true", and gets this ahead
 * of its manifests. Nothing happens when the configuration has no
 * mail server.
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
import { MAIL_SECRET, buildMailValues, getMailConfig } from "../../util/mail.ts";
import { quoteForShell } from "../../util/shell.ts";

/**
 * Whether the configuration has a mail server.
 *
 * @param config
 * @returns
 */
function hasMail(config: CloudConfig): boolean {
  return buildMailValues(config.getConfig()).enabled;
}

/**
 * The Secret holding the mail server's credentials.
 *
 * Both keys are always there, empty for a relay that needs no login.
 * An application handed an empty username doesn't try to log in, and
 * one handed no key at all fails to start.
 *
 * @param config
 * @param namespace
 * @returns
 */
export function buildMailSecretManifest(config: CloudConfig, namespace: string): string {
  const mail = getMailConfig(config.getConfig()) ?? {};

  return stringify({
    apiVersion: "v1",
    kind: "Secret",
    metadata: {
      name: MAIL_SECRET,
      namespace,
      labels: { "app.kubernetes.io/managed-by": "community-cloud" },
    },
    type: BASIC_AUTH,
    stringData: {
      username: mail.username ?? "",
      password: mail.password ?? "",
    },
  });
}

/**
 * Put the mail server's credentials in a namespace.
 *
 * Over standard input, like every other credential, so the password is
 * never on a command line.
 *
 * @param namespace
 * @returns
 */
export function buildApplyMailSecretCommand(namespace: string): CommandSpec {
  return {
    name: `apply-smtp-${namespace}`,
    description: `Give applications in ${namespace} the mail server's credentials`,
    purpose: CommandPurpose.Apply,
    runOn: CommandTarget.ControlPlane,
    env: buildKubeEnv,
    skipWhen: (config: CloudConfig) => !hasMail(config),
    command: [
      // Apply, because the configuration is where this is changed
      `kubectl apply -f - || { echo "Couldn't put the mail server's credentials in ${namespace}" >&2; exit 1; }`,
    ],
    stdin: (config: CloudConfig) => buildMailSecretManifest(config, namespace),
    output: OutputType.Raw,
  };
}

/**
 * Check the credentials are there, when there's a mail server to have
 * them for.
 *
 * @param namespace
 * @returns
 */
export function buildVerifyMailSecretCommand(namespace: string): CommandSpec {
  return {
    name: `verify-smtp-${namespace}`,
    description: `Verify applications in ${namespace} have the mail server's credentials`,
    purpose: CommandPurpose.Verify,
    runOn: CommandTarget.ControlPlane,
    env: buildKubeEnv,
    skipWhen: (config: CloudConfig) => !hasMail(config),
    command: [
      `kubectl -n ${quoteForShell(namespace)} get secret ${MAIL_SECRET} > /dev/null 2>&1 || { echo "There's a mail server in the configuration and no ${MAIL_SECRET} in ${namespace}. Run the install again." >&2; exit 1; }`,
      `echo "${MAIL_SECRET} is in ${namespace}"`,
    ],
    output: OutputType.Raw,
  };
}
