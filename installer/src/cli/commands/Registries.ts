/**
 * @file
 * Give K3s the credentials for the cluster's private registries.
 *
 * K3s reads /etc/rancher/k3s/registries.yaml at startup and turns it
 * into containerd's registry configuration. Without it a node can only
 * pull from registries that need nothing, which for this project means
 * nothing that matters: the applications live in a private registry.
 *
 * The file is written from the "registries" section of the
 * configuration, and only the parts a registry actually asked for are
 * written out, so a registry needing nothing but a username and
 * password produces four lines rather than a template full of empty
 * keys.
 *
 * Requires:
 * - sudo
 * - curl, for the reachability check, which is skipped without it
 */
import { stringify } from "yaml";

import { CommandOutput, CommandSpec, OutputType } from "./Command.ts";
import CloudConfig from "../../util/CloudConfig.ts";
import { K3SRegistriesConfiguration, K3sRegistry } from "../../util/types.ts";
import { quoteForShell } from "../../util/shell.ts";

// Where K3s looks for it
const CONFIG_DIRECTORY = "/etc/rancher/k3s";
const CONFIG_FILE = `${CONFIG_DIRECTORY}/registries.yaml`;

// The services K3s installs, either of which might be the one on
// this node
const SERVICES = ["k3s", "k3s-agent"];

// How long to wait for K3s to come back after a restart
const RESTART_TIMEOUT_SECONDS = 120;

// How long to give a registry to answer before calling it unreachable
const PROBE_TIMEOUT_SECONDS = 10;

/**
 * The shape of registries.yaml.
 *
 * These are containerd's field names rather than the configuration's,
 * which is the whole job of this file: "certFile" in a Community Cloud
 * configuration becomes "cert_file" here.
 */
interface ContainerdAuth {
  username?: string;
  password?: string;
  auth?: string;
  identitytoken?: string;
}

interface ContainerdTls {
  ca_file?: string;
  cert_file?: string;
  key_file?: string;
  insecure_skip_verify?: boolean;
}

interface ContainerdMirror {
  endpoint?: string[];
  rewrite?: Record<string, string>;
}

interface ContainerdConfig {
  auth?: ContainerdAuth;
  tls?: ContainerdTls;
}

interface RegistriesFile {
  mirrors?: Record<string, ContainerdMirror>;
  configs?: Record<string, ContainerdConfig>;
}

/**
 * Read the registries section of the configuration.
 *
 * @param config
 * @returns
 */
function getRegistries(config: CloudConfig): K3SRegistriesConfiguration {
  const { registries } = config.getConfig();
  return registries !== undefined && registries !== null ? registries : {};
}

/**
 * The registry names a configuration lists.
 *
 * @param config
 * @returns
 */
function getRegistryNames(config: CloudConfig): string[] {
  return Object.keys(getRegistries(config));
}

/**
 * Whether there's anything to do at all.
 *
 * A node with no private registries is a perfectly ordinary node, so
 * this bundle stands down rather than complaining.
 *
 * @param config
 * @returns
 */
function hasRegistries(config: CloudConfig): boolean {
  return getRegistryNames(config).length > 0;
}

/**
 * Build the contents of registries.yaml.
 *
 * Only "configs" is written unless a registry asks for more. The
 * "mirrors" section exists to send a name somewhere else, and a
 * private registry referred to by its own name doesn't need one —
 * credentials in "configs" apply either way.
 *
 * @param config
 * @returns
 */
function buildRegistriesFile(config: CloudConfig): string {
  const registries = getRegistries(config);

  const mirrors: Record<string, ContainerdMirror> = {};
  const configs: Record<string, ContainerdConfig> = {};

  for (const [name, registry] of Object.entries(registries)) {
    const mirror = buildMirror(registry);
    if (mirror !== undefined) {
      mirrors[name] = mirror;
    }

    const entry = buildConfig(name, registry);
    if (entry !== undefined) {
      configs[name] = entry;
    }
  }

  const document: RegistriesFile = {};
  if (Object.keys(mirrors).length > 0) {
    document.mirrors = mirrors;
  }
  if (Object.keys(configs).length > 0) {
    document.configs = configs;
  }

  return [
    "# Managed by Community Cloud",
    "# https://docs.k3s.io/installation/private-registry",
    stringify(document),
  ].join("\n");
}

/**
 * The mirrors entry for a registry, when it wants one.
 *
 * @param registry
 * @returns
 */
function buildMirror(registry: K3sRegistry): ContainerdMirror | undefined {
  const mirror: ContainerdMirror = {};

  if (Array.isArray(registry.endpoint) && registry.endpoint.length > 0) {
    mirror.endpoint = registry.endpoint;
  }

  if (registry.rewrite !== undefined && Object.keys(registry.rewrite).length > 0) {
    mirror.rewrite = registry.rewrite;
  }

  return Object.keys(mirror).length > 0 ? mirror : undefined;
}

/**
 * The configs entry for a registry: its credentials and TLS settings,
 * translated into the names containerd uses.
 *
 * @param name
 * @param registry
 * @returns
 */
function buildConfig(name: string, registry: K3sRegistry): ContainerdConfig | undefined {
  const entry: ContainerdConfig = {};

  if (registry.auth !== undefined) {
    const { username, password, auth, identityToken } = registry.auth;

    // Either a username and password, or one of the encoded forms.
    // Half a credential is a configuration mistake worth catching here
    // rather than at the first pull.
    if ((username === undefined) !== (password === undefined)) {
      throw new Error(
        `The registry "${name}" has only one of a username and a password. Set both, or use "auth" or "identityToken" instead.`,
      );
    }

    const credentials: ContainerdAuth = {};
    if (username !== undefined) {
      credentials.username = username;
      credentials.password = password;
    }
    if (auth !== undefined) {
      credentials.auth = auth;
    }
    if (identityToken !== undefined) {
      credentials.identitytoken = identityToken;
    }

    if (Object.keys(credentials).length === 0) {
      throw new Error(
        `The registry "${name}" has an empty "auth" section. Give it a username and password, or remove it.`,
      );
    }

    entry.auth = credentials;
  }

  if (registry.tls !== undefined) {
    const { caFile, certFile, keyFile, insecureSkipVerify } = registry.tls;

    const tls: ContainerdTls = {};
    if (caFile !== undefined) {
      tls.ca_file = caFile;
    }
    if (certFile !== undefined) {
      tls.cert_file = certFile;
    }
    if (keyFile !== undefined) {
      tls.key_file = keyFile;
    }
    if (insecureSkipVerify !== undefined) {
      tls.insecure_skip_verify = insecureSkipVerify;
    }

    if (Object.keys(tls).length > 0) {
      entry.tls = tls;
    }
  }

  return Object.keys(entry).length > 0 ? entry : undefined;
}

/**
 * Read a field out of a split line, treating a missing one as empty.
 *
 * @param fields
 * @param index
 * @returns
 */
function field(fields: string[], index: number): string {
  const value = fields[index];
  return value !== undefined ? value : "";
}

/**
 * Split output into non-empty lines.
 *
 * @param output
 * @returns
 */
function readLines(output: CommandOutput): string[] {
  const text = typeof output.parsed === "string" ? output.parsed : output.stdout;

  return (text !== null && text !== undefined ? text : "")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
}

export const RegistryCommands: CommandSpec[] = [
  /**
   * Find out whether K3s is here yet, and under which unit.
   *
   * This bundle is useful before K3s is installed, since a file that's
   * already in place when K3s starts saves a restart, and useful after
   * it, when a restart is the only way to pick the file up. Knowing
   * which of those we're in is the difference.
   */
  {
    name: "check-k3s-service",
    description: "Find out whether K3s is installed and running on this node",
    command: [
      `for service in ${SERVICES.join(" ")}`,
      "do",
      '  [ -f "/etc/systemd/system/$service.service" ] || continue',
      '  printf "service|%s|%s\\n" "$service" "$(systemctl is-active "$service" 2>/dev/null || echo inactive)"',
      "done",
    ].join("\n"),
    output: OutputType.Raw,
    postProcessHooks: [
      (output: CommandOutput) => {
        for (const line of readLines(output)) {
          const fields = line.split("|");
          if (fields[0] === "service") {
            return { service: field(fields, 1), active: field(fields, 2) === "active" };
          }
        }

        return { service: undefined, active: false };
      },
    ],
    saveToContext: (output: any, _context: any, config: CloudConfig) => {
      const { service, active } = output.processed;

      console.log(
        service === undefined
          ? "K3s isn't installed here yet, so the file will be in place before it first starts"
          : `K3s is installed as ${service} and is ${active ? "running" : "not running"}`,
      );

      const names = getRegistryNames(config);
      console.log(
        names.length > 0
          ? `Registries to configure: ${names.join(", ")}`
          : 'No registries in the configuration, so there is nothing to write. Add them under "registries".',
      );

      return { k3sService: service, k3sServiceActive: active };
    },
  },

  /**
   * Write the file.
   *
   * It holds registry passwords, so it's owned by root and readable by
   * nobody else. K3s runs as root and is the only thing that reads it.
   */
  {
    name: "write-registries-config",
    description: "Write registries.yaml from the configured registries",
    skipWhen: (config: CloudConfig) => !hasRegistries(config),
    command: (config: CloudConfig) =>
      [
        `sudo mkdir -p ${CONFIG_DIRECTORY} || { echo "Couldn't create ${CONFIG_DIRECTORY}" >&2; exit 1; }`,
        `printf '%s' ${quoteForShell(buildRegistriesFile(config))} | sudo tee ${CONFIG_FILE} > /dev/null || { echo "Couldn't write ${CONFIG_FILE}" >&2; exit 1; }`,
        // The file carries credentials, so nothing but root sees it
        `sudo chown root:root ${CONFIG_FILE}`,
        `sudo chmod 0600 ${CONFIG_FILE}`,
        `ls -l ${CONFIG_FILE}`,
      ].join("\n"),
    output: OutputType.Raw,
  },

  /**
   * Restart K3s so it reads the file.
   *
   * Only when it's already running: on a node where K3s hasn't been
   * installed yet the file is simply waiting for it, and there's
   * nothing to restart.
   */
  {
    name: "restart-k3s",
    description: "Restart K3s so it picks up the registry configuration",
    skipWhen: (config: CloudConfig, context: any) =>
      !hasRegistries(config) || context.k3sServiceActive !== true,
    command: (_config: CloudConfig, context: any) => {
      const service = context.k3sService;

      return [
        `sudo systemctl restart ${service} || { echo "Couldn't restart ${service}" >&2; exit 1; }`,
        `for attempt in $(seq ${RESTART_TIMEOUT_SECONDS}); do systemctl is-active --quiet ${service} && break; sleep 1; done`,
        `systemctl is-active --quiet ${service} || { echo "${service} didn't come back within ${RESTART_TIMEOUT_SECONDS}s" >&2; systemctl status ${service} --no-pager --lines=20 >&2; exit 1; }`,
        `echo "${service} restarted and running"`,
      ].join("\n");
    },
    output: OutputType.Raw,
  },

  /**
   * Check the node can actually reach each registry.
   *
   * Deliberately an HTTP probe rather than a pull. A private registry
   * has no image whose name we can know in advance, and pulling one to
   * find out would put a slow step into every install. Asking /v2/ is
   * the registry API's own handshake: it says the name resolves, the
   * node can get out to it, TLS is agreed, and something on the other
   * end is a registry. A 401 is a pass, not a failure — it's what a
   * private registry is supposed to say to an anonymous caller, and it
   * proves everything except the password.
   *
   * No credentials are sent, which also keeps them off the command
   * line here.
   */
  {
    name: "verify-registry-access",
    description: "Check the node can reach each configured registry",
    skipWhen: (config: CloudConfig) => !hasRegistries(config),
    command: (config: CloudConfig) => {
      const names = getRegistryNames(config).map(quoteForShell).join(" ");

      return [
        'if ! command -v curl > /dev/null 2>&1',
        'then echo "curl isn\'t installed, so the registries couldn\'t be checked from this node"',
        "  exit 0",
        "fi",
        `for registry in ${names}`,
        "do",
        `  response=$(curl -sS -i --max-time ${PROBE_TIMEOUT_SECONDS} "https://$registry/v2/" 2>&1 | tr -d '\\r')`,
        `  status=$(printf '%s\\n' "$response" | awk 'NR==1 {print $2}')`,
        `  scheme=$(printf '%s\\n' "$response" | awk 'tolower($1) == "www-authenticate:" {print $2; exit}')`,
        '  printf "registry|%s|%s|%s\\n" "$registry" "${status:-none}" "${scheme:-none}"',
        "done",
      ].join("\n");
    },
    output: OutputType.Raw,
    postProcessHooks: [
      (output: CommandOutput) => {
        const results: { registry: string; status: string; scheme: string }[] = [];

        for (const line of readLines(output)) {
          const fields = line.split("|");
          if (fields[0] === "registry") {
            results.push({
              registry: field(fields, 1),
              status: field(fields, 2),
              scheme: field(fields, 3),
            });
          }
        }

        return results;
      },
    ],
    saveToContext: (output: any) => {
      const results: { registry: string; status: string; scheme: string }[] =
        output.processed;

      const unreachable: string[] = [];

      for (const { registry, status, scheme } of results) {
        // 200 is an open registry, 401 a private one asking who we are.
        // Both mean we got there and found a registry.
        if (status === "200" || status === "401") {
          const wants = scheme !== "none" ? `, authenticates with ${scheme}` : "";
          console.log(`  ${registry}: reachable (HTTP ${status}${wants})`);
          continue;
        }

        unreachable.push(registry);
        console.log(
          `  ${registry}: NOT reachable (${status === "none" ? "no response" : "HTTP " + status})`,
        );
      }

      if (unreachable.length > 0) {
        throw new Error(
          `This node couldn't reach: ${unreachable.join(", ")}. The credentials are written either way, but pulls from those registries will fail.`,
        );
      }

      return { registriesReachable: results.map((result) => result.registry) };
    },
  },
];
