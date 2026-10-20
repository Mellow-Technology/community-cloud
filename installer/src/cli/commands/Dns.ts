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
    ];
  }

  const commands: CommandSpec[] = [checkHelmAvailableCommand];

  for (const provider of getDnsConfig(raw)?.providers ?? []) {
    if (Object.keys(provider.credentials ?? {}).length > 0) {
      commands.push(buildApplyCredentialsCommand(provider));
    }
  }

  const made = new Set<string>();
  for (const instance of instances) {
    commands.push(...buildPackageCommands(buildDnsPackage(instance), made));
  }

  return commands;
}
