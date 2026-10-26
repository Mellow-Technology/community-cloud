/**
 * @file
 * Install ExternalDNS, once for each provider account and namespace.
 *
 * Why there are several, and how they're kept out of each other's
 * domains, is in util/dns.ts. This is the installing: each instance is
 * an ordinary Helm release of the ExternalDNS chart, built as a
 * package from the configuration and installed the way every other
 * package is, with values that differ only in the provider, the
 * domains and the namespace.
 *
 * The credentials go first, into a Secret per provider account in the
 * namespace the instances run in. They come from the configuration and
 * are applied rather than created once, like the mail server's: the
 * configuration is where a token is changed.
 *
 * Requires:
 * - Helm on the control plane
 * - the Gateway API, with ListenerSets, which Cilium's bundle installs
 */
import { stringify } from "yaml";

import {
  CommandPurpose,
  CommandSpec,
  CommandTarget,
  OutputType,
} from "./Command.ts";
import { buildPackageCommands, checkHelmAvailableCommand } from "./Helm.ts";
import { PackageDefinition } from "./packages.ts";
import CloudConfig from "../../util/CloudConfig.ts";
import {
  DNS_NAMESPACE,
  DnsInstance,
  DnsProvider,
  EXTERNAL_DNS_CHART,
  EXTERNAL_DNS_CHART_VERSION,
  buildExternalDnsValues,
  getCredentialsSecretName,
  getDnsConfig,
  getDnsInstances,
} from "../../util/dns.ts";
import { buildKubeEnv } from "../../util/kube.ts";
import { field, readRecordsOfKind } from "./output.ts";

/**
 * The Secret holding a provider account's credentials.
 *
 * @param provider
 * @returns
 */
export function buildDnsCredentialsManifest(provider: DnsProvider): string {
  return stringify({
    apiVersion: "v1",
    kind: "Secret",
    metadata: {
      name: getCredentialsSecretName(provider),
      namespace: DNS_NAMESPACE,
      labels: { "app.kubernetes.io/managed-by": "community-cloud" },
    },
    type: "Opaque",
    stringData: provider.credentials ?? {},
  });
}

/**
 * Put a provider account's credentials beside its instances.
 *
 * Over standard input, so no token is ever on a command line. The
 * namespace is made first if it isn't there, since the Secret has to
 * exist before the chart that creates the namespace otherwise would.
 *
 * @param provider
 * @returns
 */
function buildApplyCredentialsCommand(provider: DnsProvider): CommandSpec {
  return {
    name: `dns-credentials-${provider.name}`,
    description: `Put the ${provider.name} DNS credentials where its ExternalDNS can read them`,
    purpose: CommandPurpose.Apply,
    runOn: CommandTarget.ControlPlane,
    env: buildKubeEnv,
    command: [
      `kubectl get namespace ${DNS_NAMESPACE} > /dev/null 2>&1 || kubectl create namespace ${DNS_NAMESPACE} || { echo "Couldn't make the ${DNS_NAMESPACE} namespace" >&2; exit 1; }`,
      // Apply, because the configuration is where a token is changed
      `kubectl apply -f - || { echo "Couldn't put the ${provider.name} DNS credentials in ${DNS_NAMESPACE}" >&2; exit 1; }`,
    ],
    stdin: () => buildDnsCredentialsManifest(provider),
    output: OutputType.Raw,
  };
}

/**
 * One instance, as a package.
 *
 * @param instance
 * @returns
 */
export function buildDnsPackage(instance: DnsInstance): PackageDefinition {
  return {
    name: instance.release,
    description: `Publishes routes in ${instance.namespace} to ${instance.provider.provider}, for ${instance.provider.domains.join(", ")}`,
    chart: EXTERNAL_DNS_CHART,
    version: EXTERNAL_DNS_CHART_VERSION,
    namespace: DNS_NAMESPACE,
    valuesSource: () => buildExternalDnsValues(instance),

    // Helm calls a release deployed once its pod has started, and an
    // ExternalDNS with a token the provider refuses starts perfectly
    // well. This at least says whether it's still running, rather
    // than restarting.
    rollout: [`deployment/${instance.release}`],
  };
}

/**
 * Check a provider account's credentials are all there.
 *
 * Only that each key is present and not empty. Whether the provider
 * accepts them is the provider's to say, in the instance's own log.
 *
 * @param provider
 * @returns
 */
function buildVerifyCredentialsCommand(provider: DnsProvider): CommandSpec {
  const secret = getCredentialsSecretName(provider);

  return {
    name: `verify-dns-credentials-${provider.name}`,
    description: `Verify the ${provider.name} DNS credentials are in place`,
    purpose: CommandPurpose.Verify,
    runOn: CommandTarget.ControlPlane,
    env: buildKubeEnv,
    command: [
      "failed=",
      ...Object.keys(provider.credentials ?? {}).map(
        (key) =>
          `[ -n "$(kubectl -n ${DNS_NAMESPACE} get secret ${secret} -o jsonpath='{.data.${key}}' 2>/dev/null)" ] || { echo "  ${secret} has no ${key}" >&2; failed=yes; }`,
      ),
      `[ -z "$failed" ] || { echo "The ${provider.name} DNS credentials aren't all there. Run the dns bundle again." >&2; exit 1; }`,
      `echo "The ${provider.name} DNS credentials are in ${DNS_NAMESPACE}"`,
    ],
    output: OutputType.Raw,
  };
}

/**
 * A shell pattern matching a domain and everything under it.
 *
 * @param domains
 * @returns
 */
function domainPattern(domains: string[]): string {
  return domains.flatMap((domain) => [domain, `*.${domain}`]).join("|");
}

/**
 * Say what the names an instance publishes resolve to.
 *
 * A report rather than a check. Whether a name resolves, and to what,
 * depends on where it's asked from — the control plane's resolver may
 * cache, or answer from a split horizon — and on how long ago the
 * record changed. What it's good for is the question someone running
 * this actually has: is the name there, and is it pointing where it
 * should.
 *
 * The names are the hostnames on the routes in the instance's
 * namespace that fall within its domains, which is what it publishes.
 *
 * @param instance
 * @returns
 */
function buildInspectNamesCommand(instance: DnsInstance): CommandSpec {
  const { provider } = instance;
  const excluded = provider.excludeDomains ?? [];

  return {
    name: `inspect-dns-${instance.release}`,
    description: `Report what the names ${instance.release} publishes resolve to`,
    purpose: CommandPurpose.Inspect,
    runOn: CommandTarget.ControlPlane,
    env: buildKubeEnv,
    command: [
      `hosts=$(kubectl -n ${instance.namespace} get httproutes -o jsonpath='{range .items[*]}{range .spec.hostnames[*]}{@}{"\\n"}{end}{end}' 2>/dev/null | sort -u)`,
      'found=',
      'for host in $hosts',
      "do",
      `  case "$host" in ${domainPattern(provider.domains)}) ;; *) continue ;; esac`,
      ...(excluded.length > 0 ? [`  case "$host" in ${domainPattern(excluded)}) continue ;; esac`] : []),
      "  found=yes",
      `  addresses=$(getent ahosts "$host" 2>/dev/null | awk '{ print $1 }' | sort -u | tr '\\n' ' ')`,
      `  echo "  $host → \${addresses:-nothing yet}"`,
      "done",
      `[ -n "$found" ] || echo "  Nothing in ${instance.namespace} is routed on ${provider.domains.join(", ")} yet"`,
      ...(instance.target !== undefined
        ? [`echo "  Each should resolve to ${instance.target}"`]
        : []),
    ],
    output: OutputType.Raw,
  };
}

/**
 * Say which ExternalDNS instances are running that the configuration
 * no longer describes.
 *
 * An instance taken out of the configuration isn't uninstalled, and
 * keeps publishing — and, with the "sync" policy, deleting — records
 * for the domains it was given. Nothing else would say it's still
 * there.
 *
 * Every Helm release in the namespace the instances run in counts,
 * since nothing else is installed there.
 *
 * @param config
 * @returns
 */
export function buildDnsInventoryCommand(config: CloudConfig): CommandSpec {
  const configured = new Set(getDnsInstances(config.getConfig()).map((instance) => instance.release));

  return {
    name: "inventory-dns",
    description: "Report ExternalDNS instances the configuration no longer describes",
    purpose: CommandPurpose.Inspect,
    runOn: CommandTarget.ControlPlane,
    env: buildKubeEnv,
    command: [
      // No namespace and no Helm are both "nothing installed"
      `command -v helm > /dev/null 2>&1 || exit 0`,
      `helm list --namespace ${DNS_NAMESPACE} --short 2>/dev/null | while read -r release`,
      "do",
      '  [ -n "$release" ] && echo "release|$release"',
      "done",
      "true",
    ],
    output: OutputType.Raw,
    postProcessHooks: [
      (output: any) => readRecordsOfKind(output, "release").map((fields) => field(fields, 0)),
    ],
    saveToContext: (output: any) => {
      const leftover = (output.processed as string[] ?? []).filter((release) => !configured.has(release));

      if (leftover.length === 0) {
        console.log("  No ExternalDNS instances left over from an earlier configuration");
      }

      for (const release of leftover) {
        console.log(
          `  ⚠️  ${release} is still running in ${DNS_NAMESPACE} and isn't in the configuration, so it keeps publishing records for its domains. Remove it with "helm uninstall ${release} --namespace ${DNS_NAMESPACE}" if it's no longer wanted.`,
        );
      }

      return {};
    },
  };
}

/**
 * Build the bundle that installs ExternalDNS.
 *
 * Built from the configuration, since only the configuration knows
 * how many instances there are.
 *
 * @param config
 * @returns
 */
export function DnsCommands(config: CloudConfig): CommandSpec[] {
  const raw = config.getConfig();
  const instances = getDnsInstances(raw);

  if (instances.length === 0) {
    return [
      {
        name: "no-dns-configured",
        purpose: CommandPurpose.Inspect,
        description: "Report that no DNS providers are configured",
        runOn: CommandTarget.ControlPlane,
        command:
          'echo "No DNS providers are configured, so nothing will be published. Add them under \\"dns.providers\\"."',
        output: OutputType.Raw,
      },
      buildDnsInventoryCommand(config),
    ];
  }

  const commands: CommandSpec[] = [checkHelmAvailableCommand];

  const providers = (getDnsConfig(raw)?.providers ?? []).filter(
    (provider) => Object.keys(provider.credentials ?? {}).length > 0,
  );

  for (const provider of providers) {
    commands.push(buildApplyCredentialsCommand(provider));
  }

  const made = new Set<string>();
  for (const instance of instances) {
    commands.push(...buildPackageCommands(buildDnsPackage(instance), made));
  }

  // What a check-up asks: credentials, then what's being published
  for (const provider of providers) {
    commands.push(buildVerifyCredentialsCommand(provider));
  }

  for (const instance of instances) {
    commands.push(buildInspectNamesCommand(instance));
  }

  commands.push(buildDnsInventoryCommand(config));

  return commands;
}
