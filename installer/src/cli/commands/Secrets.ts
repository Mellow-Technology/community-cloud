/**
 * @file
 * The credentials applications connect with.
 *
 * A DatabaseRole takes its password from a Secret rather than from
 * the manifest, which is right — a manifest is a file in a repository
 * and a password shouldn't be — but it leaves the Secret itself to
 * somebody. Left to a person it becomes a step in a runbook that gets
 * skipped, or the same password on every cluster. So the installer
 * makes them up.
 *
 * The one rule everything here is built around is that a password is
 * created once and never again. An install can be re-run, and every
 * other command in here is written so that running it twice is the
 * same as running it once. That can't be done by writing the same
 * value again, because the value is random; it's done by not writing
 * at all when there's already one there. A cluster's passwords are
 * set the first time it's installed and outlive every install after.
 *
 * Which is also why nothing here records what it generated. The
 * password exists in the cluster and nowhere else. Anything needing
 * it reads the Secret, and a person needing it reads the Secret too.
 *
 * Requires:
 * - a running cluster with a readable kubeconfig
 * - the namespace the secret goes in
 */
import { stringify } from "yaml";

import {
  CommandPurpose,
  CommandSpec,
  CommandTarget,
  OutputType,
} from "./Command.ts";
import {
  generateKey,
  generatePassword,
  generateUsername,
} from "../../util/credentials.ts";
import { buildKubeEnv } from "../../util/kube.ts";
import { quoteForShell } from "../../util/shell.ts";

// What a pair of credentials is, as far as Kubernetes is concerned.
// The type matters: CloudNativePG won't read a password out of a
// Secret that isn't this, and neither will most charts.
export const BASIC_AUTH = "kubernetes.io/basic-auth";

/**
 * A set of credentials the cluster should have.
 *
 * - name: the Secret's name, which is what a manifest refers to
 * - namespace: where it goes. Defaults to the package's own namespace,
 *   which is usually not where these belong — a database credential
 *   lives with the application, not with the operator that made it.
 * - username: the username, when something downstream requires a
 *   particular one. Left unset it's generated, which is right for
 *   anything that only has to match itself.
 *
 *   CloudNativePG is the reason this is here. A DatabaseRole's Secret
 *   has to carry the role's own name — the reconciler compares the
 *   two and refuses the role outright if they differ ("the username
 *   in secret %q does not match role %q") — so for those the name is
 *   already decided and only the password is ours to invent.
 * - type: the Secret type. Basic auth unless something wants another.
 * - labels: anything else that has to be on it. Some operators find
 *   the secrets they care about by label rather than by reference.
 * - keyBytes: make the password a key of this many random bytes, in
 *   hex, rather than a phrase. For the things that aren't passwords
 *   at all but encryption keys of a fixed length, which refuse a
 *   phrase for being the wrong size — Laravel's application key wants
 *   exactly 32 characters, and oauth2-proxy's cookie secret 16, 24
 *   or 32.
 * - certificate: make a self-signed certificate instead of a pair of
 *   credentials. The Secret holds a PKCS#12 bundle under
 *   "certificate" and the passphrase sealing it under "password".
 *   For something that signs rather than something that logs in —
 *   Documenso puts a signature in every document it completes, and
 *   won't sign anything without a certificate to do it with.
 */
export interface SecretDefinition {
  name: string;
  description: string;
  namespace?: string;
  username?: string;
  type?: string;
  labels?: Record<string, string>;
  keyBytes?: number;
  certificate?: SelfSignedCertificate;
}

/**
 * A certificate to make up.
 *
 * - commonName: who it says it belongs to, which is what a PDF reader
 *   shows as the signer
 * - days: how long it lasts. Long, since replacing it is by hand: the
 *   Secret is made once, like every other, and never touched again.
 */
export interface SelfSignedCertificate {
  commonName: string;
  days: number;
}

// The Secret type a certificate is kept as. Not basic auth, because
// what's in it isn't a username and a password.
export const OPAQUE = "Opaque";

/**
 * Where a secret goes, which is its own namespace if it named one and
 * otherwise the namespace of whatever asked for it.
 *
 * @param definition
 * @param fallback
 * @returns
 */
export function getSecretNamespace(
  definition: SecretDefinition,
  fallback: string,
): string {
  return definition.namespace !== undefined ? definition.namespace : fallback;
}

/**
 * Build the Secret, with a password that has never existed before.
 *
 * "stringData" rather than "data" so the values go in as they are and
 * Kubernetes does the encoding. Base64 isn't secrecy and writing it
 * by hand here would only make the manifest harder to read without
 * making the password harder to read.
 *
 * @param definition
 * @param namespace
 * @returns
 */
export function buildSecretManifest(
  definition: SecretDefinition,
  namespace: string,
): string {
  const document = {
    apiVersion: "v1",
    kind: "Secret",
    metadata: {
      name: definition.name,
      namespace,
      labels: {
        "app.kubernetes.io/managed-by": "community-cloud",
        ...(definition.labels !== undefined ? definition.labels : {}),
      },
    },
    type: definition.type !== undefined ? definition.type : BASIC_AUTH,
    stringData: {
      username:
        definition.username !== undefined ? definition.username : generateUsername(),
      password:
        definition.keyBytes !== undefined
          ? generateKey(definition.keyBytes)
          : generatePassword(),
    },
  };

  return stringify(document);
}

/**
 * Create a set of credentials, unless the cluster already has them.
 *
 * The check and the create are two steps and something could happen
 * in between, so the create is "create" rather than "apply": the
 * worst a lost race can do is fail, which is recoverable, instead of
 * replacing a password half the cluster is already using, which
 * isn't.
 *
 * The manifest goes over standard input. It holds the password, and a
 * command line does not — it's readable by every user on the machine
 * through a process listing, and gets quoted back in any error the
 * command produces.
 *
 * @param definition
 * @param fallbackNamespace
 * @returns
 */
export function buildCreateSecretCommand(
  definition: SecretDefinition,
  fallbackNamespace: string,
): CommandSpec {
  if (definition.certificate !== undefined) {
    return buildCreateCertificateCommand(definition, definition.certificate, fallbackNamespace);
  }

  const namespace = getSecretNamespace(definition, fallbackNamespace);
  const quotedNamespace = quoteForShell(namespace);
  const quotedName = quoteForShell(definition.name);

  return {
    name: `create-secret-${namespace}-${definition.name}`,
    description: `Create the ${definition.name} credentials: ${definition.description}`,
    purpose: CommandPurpose.Apply,
    runOn: CommandTarget.ControlPlane,
    env: buildKubeEnv,
    command: [
      // Nothing is read from standard input on this path, so the
      // password that was generated for this run is simply never used
      `if kubectl -n ${quotedNamespace} get secret ${quotedName} > /dev/null 2>&1`,
      "then",
      `  echo "${definition.name} is already in ${namespace}, keeping the password it has"`,
      "  exit 0",
      "fi",
      // Deliberately not "apply". This only ever creates.
      `kubectl create -f - || { echo "Couldn't create the secret ${definition.name} in ${namespace}" >&2; exit 1; }`,
    ],
    stdin: () => buildSecretManifest(definition, namespace),
    output: OutputType.Raw,
  };
}

/**
 * Make a self-signed certificate, unless the cluster already has it.
 *
 * Made on the control plane with openssl rather than in here, for the
 * same reason the passwords travel on standard input: the private key
 * should never be in this process, in a command line, or anywhere it
 * could be logged. It is written to a directory only the installing
 * user can read, put in the Secret by kubectl reading the files, and
 * removed whatever happens.
 *
 * The passphrase is generated there too. A PKCS#12 bundle without one
 * is technically allowed, and Documenso refuses it, failing to find a
 * private key in it.
 *
 * openssl is on any machine that has ca-certificates, which K3s's own
 * installer needs, so it's checked for rather than installed.
 *
 * @param definition
 * @param certificate
 * @param fallbackNamespace
 * @returns
 */
function buildCreateCertificateCommand(
  definition: SecretDefinition,
  certificate: SelfSignedCertificate,
  fallbackNamespace: string,
): CommandSpec {
  const namespace = getSecretNamespace(definition, fallbackNamespace);
  const quotedNamespace = quoteForShell(namespace);
  const quotedName = quoteForShell(definition.name);
  const labels = {
    "app.kubernetes.io/managed-by": "community-cloud",
    ...(definition.labels !== undefined ? definition.labels : {}),
  };
  const fail = (what: string) =>
    `|| { echo "Couldn't make the certificate ${definition.name}: ${what}" >&2; exit 1; }`;

  return {
    name: `create-secret-${namespace}-${definition.name}`,
    description: `Create the ${definition.name} certificate: ${definition.description}`,
    purpose: CommandPurpose.Apply,
    runOn: CommandTarget.ControlPlane,
    env: buildKubeEnv,
    command: [
      `if kubectl -n ${quotedNamespace} get secret ${quotedName} > /dev/null 2>&1`,
      "then",
      `  echo "${definition.name} is already in ${namespace}, keeping the certificate it has"`,
      "  exit 0",
      "fi",
      `command -v openssl > /dev/null 2>&1 || { echo "Making the certificate ${definition.name} needs openssl on the control plane, and it isn't there. Install it and run this again." >&2; exit 1; }`,
      `work=$(mktemp -d) ${fail("no temporary directory")}`,
      `trap 'rm -rf "$work"' EXIT`,
      'chmod 0700 "$work"',
      // No newline: the passphrase is read back as the whole file by
      // whatever mounts the Secret, and a newline would be part of it
      `openssl rand -hex 24 | tr -d '\\n' > "$work/password" ${fail("couldn't generate a passphrase")}`,
      `openssl req -x509 -newkey rsa:2048 -nodes -keyout "$work/key.pem" -out "$work/cert.pem" -days ${certificate.days} -subj ${quoteForShell(`/CN=${certificate.commonName}`)} 2> /dev/null ${fail("openssl wouldn't make the key")}`,
      `openssl pkcs12 -export -out "$work/certificate.p12" -inkey "$work/key.pem" -in "$work/cert.pem" -passout "file:$work/password" ${fail("openssl wouldn't bundle it")}`,
      // Deliberately "create", as for every other credential
      `kubectl -n ${quotedNamespace} create secret generic ${quotedName} --from-file=certificate="$work/certificate.p12" --from-file=password="$work/password" ${fail("kubectl wouldn't create the Secret")}`,
      `kubectl -n ${quotedNamespace} label secret ${quotedName} ${Object.entries(labels)
        .map(([key, value]) => quoteForShell(`${key}=${value}`))
        .join(" ")} ${fail("kubectl wouldn't label the Secret")}`,
      `echo "Made the certificate ${definition.name} in ${namespace}, valid for ${certificate.days} days"`,
    ],
    output: OutputType.Raw,
  };
}

/**
 * Check a set of credentials is there and is usable.
 *
 * Usable means more than present: a Secret of the wrong type, or one
 * missing half the pair, is something CloudNativePG will refuse and
 * an application will fail to start against, and it looks exactly
 * like a working one in a listing.
 *
 * Only the shape is read. The values stay in the cluster.
 *
 * @param definitions
 * @param fallbackNamespace
 * @param owner what asked for these, to say so when one is missing
 * @returns
 */
export function buildVerifySecretsCommand(
  definitions: SecretDefinition[],
  fallbackNamespace: string,
  owner: string,
): CommandSpec {
  const checks = definitions.flatMap((definition) => {
    const namespace = getSecretNamespace(definition, fallbackNamespace);
    const quotedNamespace = quoteForShell(namespace);
    const quotedName = quoteForShell(definition.name);
    const isCertificate = definition.certificate !== undefined;
    const expected = isCertificate
      ? OPAQUE
      : definition.type !== undefined
        ? definition.type
        : BASIC_AUTH;

    // A certificate's first half is the bundle rather than a username
    const first = isCertificate ? "certificate" : "username";

    return [
      // One read rather than three. The fields are joined by colons,
      // which neither a Secret type nor base64 contains, so the
      // patterns below can tell "missing" from "half filled in".
      `found=$(kubectl -n ${quotedNamespace} get secret ${quotedName} -o jsonpath='{.type}:{.data.${first}}:{.data.password}' 2>/dev/null)`,
      `case "$found" in`,
      // "?*" is at least one character, so a key that exists but is
      // empty fails here rather than passing as present
      `  ${expected}:?*:?*) echo "  ${definition.name}: in ${namespace}" ;;`,
      `  "") echo "  ${definition.name}: missing from ${namespace}" >&2; failed=yes ;;`,
      `  *) echo "  ${definition.name}: in ${namespace} but not a complete ${expected} secret" >&2; failed=yes ;;`,
      "esac",
    ];
  });

  return {
    name: `verify-secrets-${owner}`,
    description: `Check the credentials ${owner} needs are in the cluster`,
    purpose: CommandPurpose.Verify,
    runOn: CommandTarget.ControlPlane,
    env: buildKubeEnv,
    command: [
      "failed=",
      ...checks,
      `[ -z "$failed" ] || { echo "Some of the credentials ${owner} needs aren't in the cluster. Run the install again to create them." >&2; exit 1; }`,
    ],
    output: OutputType.Raw,
  };
}
