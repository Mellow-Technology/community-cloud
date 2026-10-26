/**
 * @file
 * Registering an application with Authentik, so it can sign people in
 * through it.
 *
 * Single sign on needs both ends to agree on a client: Authentik has
 * to know the application, where to send people back to, and the
 * secret it will present, and the application has to be given the
 * same. Done by hand that is a trip through Authentik's admin pages
 * per application, copying a generated secret from one browser tab
 * into a Kubernetes Secret, which is exactly the kind of step that
 * gets done once on the first cluster and never written down.
 *
 * So the installer makes the credentials — an ordinary generated
 * Secret, whose username is the client ID and whose password is the
 * client secret — and tells Authentik about them with a blueprint.
 * Blueprints are Authentik's own declarative format: each entry is
 * found by its identifiers and created or updated to match, so
 * applying one twice is the same as applying it once, and an
 * application's provider can be put back the way it should be by
 * running the install again.
 *
 * How the blueprint gets in is the part with a choice in it.
 * Authentik reads blueprints from files under /blueprints, and its
 * chart can mount ConfigMaps there — but Authentik is installed by a
 * plugin, or by hand, with values this installer doesn't own, and a
 * mount listed in those values would have to know about every
 * application in advance. "ak apply_blueprint" doesn't help either:
 * it only reads paths inside /blueprints, which the worker can't
 * write to. What's left is the importer itself, run in the worker
 * through "ak shell" with the blueprint on standard input. It is the
 * same code "apply_blueprint" calls, and Authentik records each
 * change it makes as an event from "authentik-shell", so what the
 * installer did shows up in Authentik's own log.
 *
 * The client ID and secret travel the same way, ahead of the
 * blueprint, and reach it through "!Context". They're read out of
 * the Secret and piped straight into the worker without ever being
 * a word on a command line, here or there.
 *
 * Requires:
 * - Authentik running in cc-office, as the release "authentik"
 * - the client's Secret, made by the package's "secrets"
 */
import {
  CommandPurpose,
  CommandSpec,
  CommandTarget,
  OutputType,
} from "./Command.ts";
import CloudConfig from "../../util/CloudConfig.ts";
import { buildKubeEnv } from "../../util/kube.ts";
import { quoteForShell } from "../../util/shell.ts";
import { renderInstallerFile } from "../../util/template.ts";

// Where Authentik runs. The plugin installs it here, into the same
// namespace as the office applications it signs people into.
export const AUTHENTIK_NAMESPACE = "cc-office";

// The chart names its worker after the release, and the release is
// "authentik". The worker rather than the server because blueprints
// are applied there, and because it's the one that isn't answering
// requests from people signing in.
export const AUTHENTIK_WORKER = "authentik-worker";

/**
 * The single sign on client a package needs.
 *
 * - blueprint: an Authentik blueprint describing the provider and the
 *   application. Rendered as a template first, like everything else
 *   in k8s/, so it can name the application's own domain. It refers
 *   to the credentials as "!Context client_id" and
 *   "!Context client_secret".
 * - secret: the generated Secret holding them, in the package's own
 *   namespace — the username is the client ID and the password the
 *   client secret
 * - slug: the application's slug in the blueprint, which is how the
 *   check afterwards finds it
 */
export interface AuthentikClient {
  blueprint: string;
  secret: string;
  slug: string;
}

// Run in the worker by "ak shell". Reads the client ID and secret off
// the first two lines of standard input and the blueprint from the
// rest, then does what "ak apply_blueprint" does: validate, say why if
// it isn't valid, and apply. Validation runs inside a transaction that
// is rolled back, so an invalid blueprint changes nothing at all
// rather than half of what it describes.
const APPLY_BLUEPRINT = [
  "import sys",
  "from authentik.blueprints.v1.importer import Importer",
  "context = {",
  '    "client_id": sys.stdin.readline().strip(),',
  '    "client_secret": sys.stdin.readline().strip(),',
  "}",
  "importer = Importer.from_string(sys.stdin.read(), context)",
  "valid, logs = importer.validate()",
  "if not valid:",
  "    for log in logs:",
  '        print(f"  {log.event} {log.attributes}", file=sys.stderr)',
  "    sys.exit(1)",
  "if not importer.apply():",
  "    sys.exit(1)",
].join("\n");

/**
 * The Python that checks an application is there with a provider
 * behind it.
 *
 * @param slug
 * @returns
 */
function buildCheckApplication(slug: string): string {
  return [
    "import sys",
    "from authentik.core.models import Application",
    `application = Application.objects.filter(slug=${JSON.stringify(slug)}).first()`,
    "sys.exit(0 if application is not None and application.provider is not None else 1)",
  ].join("\n");
}

/**
 * The part of a command that runs something in the Authentik worker.
 *
 * @returns
 */
function execInWorker(): string {
  return `kubectl -n ${AUTHENTIK_NAMESPACE} exec -i deployment/${AUTHENTIK_WORKER} --`;
}

/**
 * Check Authentik is there and up, before trying to tell it anything.
 *
 * Its own command rather than part of the apply, so that a cluster
 * without Authentik is told that in so many words — and so that it
 * says so before the application is installed, rather than leaving
 * one running that nobody can sign in to.
 *
 * @param owner the package asking
 * @returns
 */
export function buildRequireAuthentikCommand(owner: string): CommandSpec {
  return {
    name: `require-authentik-${owner}`,
    description: `Check Authentik is running, for ${owner} to sign in through`,
    purpose: CommandPurpose.Require,
    runOn: CommandTarget.ControlPlane,
    env: buildKubeEnv,
    command: [
      `ready=$(kubectl -n ${AUTHENTIK_NAMESPACE} get deployment ${AUTHENTIK_WORKER} -o jsonpath='{.status.readyReplicas}' 2>/dev/null)`,
      `[ -n "$ready" ] && [ "$ready" -gt 0 ] || { echo "${owner} signs in through Authentik, and there's no ready ${AUTHENTIK_WORKER} in ${AUTHENTIK_NAMESPACE}. Install Authentik first — the authentik plugin, or its chart as the release \\"authentik\\"." >&2; exit 1; }`,
      `echo "Authentik is running in ${AUTHENTIK_NAMESPACE}"`,
    ],
    output: OutputType.Raw,
  };
}

/**
 * What produces a blueprint: a rendered file for an application's own
 * client, or one built in code for a gate.
 */
export type BlueprintSource = (config: CloudConfig, context: any) => string;

/**
 * A blueprint that is a template file, rendered against the
 * configuration like everything else in k8s/.
 *
 * @param path
 * @returns
 */
export function blueprintFromFile(path: string): BlueprintSource {
  return (config: CloudConfig, context: any) => renderInstallerFile(config, path, context);
}

/**
 * Register a client with Authentik.
 *
 * @param owner what asked, which names the command
 * @param client the Secret holding the client's credentials, and the
 *   application's slug
 * @param namespace where the client's Secret is
 * @param blueprint what to hand Authentik
 * @returns
 */
export function buildApplyBlueprintCommand(
  owner: string,
  client: Pick<AuthentikClient, "secret" | "slug">,
  namespace: string,
  blueprint: BlueprintSource,
): CommandSpec {
  const quotedNamespace = quoteForShell(namespace);
  const quotedSecret = quoteForShell(client.secret);
  const read = (key: string) =>
    `kubectl -n ${quotedNamespace} get secret ${quotedSecret} -o jsonpath='{.data.${key}}' | base64 -d`;

  return {
    name: `authentik-blueprint-${owner}`,
    description: `Register ${owner} with Authentik, so it can sign people in`,
    purpose: CommandPurpose.Apply,
    runOn: CommandTarget.ControlPlane,
    env: buildKubeEnv,
    command: [
      `kubectl -n ${quotedNamespace} get secret ${quotedSecret} > /dev/null 2>&1 || { echo "The client credentials ${client.secret} aren't in ${namespace}, so there's nothing to give Authentik" >&2; exit 1; }`,

      // The credentials first, a line each, then the rendered
      // blueprint this command was handed on its own standard input
      "{",
      `  ${read("username")}`,
      "  echo",
      `  ${read("password")}`,
      "  echo",
      "  cat",
      `} | ${execInWorker()} ak shell -c ${quoteForShell(APPLY_BLUEPRINT)} || { echo "Authentik wouldn't take the blueprint for ${owner}" >&2; exit 1; }`,
      `echo "${owner} is registered with Authentik as ${client.slug}"`,
    ],
    stdin: blueprint,
    output: OutputType.Raw,
  };
}

/**
 * Check the application made it into Authentik.
 *
 * Asks Authentik rather than trusting the apply's exit status: the
 * application is what a person signing in is sent to, and one that
 * exists without a provider behind it fails at exactly that moment.
 *
 * @param owner the package asking
 * @param client
 * @returns
 */
export function buildVerifyAuthentikCommand(
  owner: string,
  client: Pick<AuthentikClient, "slug">,
): CommandSpec {
  return {
    name: `verify-authentik-${owner}`,
    description: `Verify ${owner} is registered with Authentik`,
    purpose: CommandPurpose.Verify,
    runOn: CommandTarget.ControlPlane,
    env: buildKubeEnv,
    command: [
      `${execInWorker()} ak shell -c ${quoteForShell(buildCheckApplication(client.slug))} > /dev/null || { echo "Authentik has no application ${client.slug} with a provider behind it. Run the install again to register ${owner}." >&2; exit 1; }`,
      `echo "${owner} is registered with Authentik as ${client.slug}"`,
    ],
    output: OutputType.Raw,
  };
}
