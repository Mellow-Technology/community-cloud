/**
 * @file
 * A sign in in front of something that has none of its own.
 *
 * Some of what a cluster runs can sign people in through Authentik by
 * itself — Documenso and Headlamp speak OpenID Connect. A good deal
 * can't: Picoclaw's console, and plenty of web interfaces that come
 * with infrastructure, assume whoever reaches them is allowed to, and
 * put nothing in the way. For those the answer is a gate: oauth2-proxy
 * takes every request, sends anyone without a session to Authentik,
 * and passes the rest through to the real thing.
 *
 * A package asks for one by declaring a "gate", and gets everything
 * else from here — the proxy's Deployment and Service, its client in
 * Authentik, and the credentials the two share. All of it is built
 * rather than written out per application, because none of it differs
 * between applications except the names, the hostname, and where
 * requests go once they're through. The package keeps its own route,
 * and points it at the gate's Service instead of its own:
 *
 *   backendRefs:
 *     - name: <gate name>-oauth2-proxy
 *       port: 4180
 *
 * A route straight to the application as well would be a way round
 * the gate, which is the one thing to be careful of.
 *
 * Requires:
 * - Authentik, as for anything that signs in through it
 * - the package's own Service, which the gate sends requests on to
 */
import { stringify } from "yaml";

import CloudConfig from "../../util/CloudConfig.ts";
import { buildTemplateValues } from "../../util/template.ts";
import { AuthentikClient, BlueprintSource } from "./Authentik.ts";
import { SecretDefinition } from "./Secrets.ts";

// The release the gate runs. Pinned, like every image here.
export const OAUTH2_PROXY_IMAGE = "quay.io/oauth2-proxy/oauth2-proxy:v7.15.5";

// Where it listens, and so the port a route sends to
export const OAUTH2_PROXY_PORT = 4180;

/**
 * A gate in front of an application.
 *
 * - name: names everything made for it. The Deployment and Service
 *   are "<name>-oauth2-proxy", and the application in Authentik has
 *   the slug "<name>".
 * - title: what the application is called in Authentik, which is
 *   what people see on its sign in page and in their list of apps
 * - hostname: where it's reached, as a path under "values" — the
 *   proxy has to know it to tell Authentik where to send people back
 * - upstream: where a request goes once it's through, as a URL to the
 *   application's own Service
 * - skipAuthRoutes: requests that go straight through, as regular
 *   expressions on the path, optionally "METHOD=" first. For the parts
 *   of an application that are meant to be public, or that check
 *   their own credentials; for an interface meant only for the people
 *   running the cluster, there shouldn't be any.
 */
export interface GateDefinition {
  name: string;
  title: string;
  hostname: string;
  upstream: string;
  skipAuthRoutes?: string[];
}

/**
 * The name of the gate's Deployment and Service.
 *
 * @param gate
 * @returns
 */
export function getGateName(gate: GateDefinition): string {
  return `${gate.name}-oauth2-proxy`;
}

/**
 * The Secret holding the client the gate signs in to Authentik as.
 *
 * @param gate
 * @returns
 */
function getClientSecretName(gate: GateDefinition): string {
  return `${gate.name}-gate-oidc`;
}

/**
 * The Secret holding the key the gate seals its cookie with.
 *
 * @param gate
 * @returns
 */
function getCookieSecretName(gate: GateDefinition): string {
  return `${gate.name}-gate-cookie`;
}

/**
 * The credentials a gate needs.
 *
 * The client it signs in to Authentik as, and the key it seals its
 * session cookie with. oauth2-proxy wants that key to be 16, 24 or 32
 * bytes, and 32 hex characters is one of those.
 *
 * @param gate
 * @returns
 */
export function getGateSecrets(gate: GateDefinition): SecretDefinition[] {
  return [
    {
      name: getClientSecretName(gate),
      description: `the client the gate in front of ${gate.title} signs in to Authentik as`,
    },
    {
      name: getCookieSecretName(gate),
      description: `the key the gate in front of ${gate.title} seals sessions with`,
      keyBytes: 16,
    },
  ];
}

/**
 * The gate as an Authentik client, for the commands that register and
 * check one.
 *
 * @param gate
 * @returns
 */
export function getGateClient(gate: GateDefinition): Pick<AuthentikClient, "secret" | "slug"> {
  return { secret: getClientSecretName(gate), slug: gate.name };
}

/**
 * Read a value from the configuration the way a template would.
 *
 * @param config
 * @param path
 * @returns
 */
function readValue(config: CloudConfig, path: string): string {
  const value = path
    .split(".")
    .reduce(
      (current: any, part) => (current === undefined || current === null ? undefined : current[part]),
      (buildTemplateValues(config) as any).Values,
    );

  if (value === undefined || value === null || value === "") {
    throw new Error(`The gate needs "values.${path}", and it isn't set.`);
  }

  return String(value);
}

/**
 * The gate's Deployment and Service.
 *
 * @param gate
 * @param namespace
 * @returns what renders them against a configuration
 */
export function buildGateManifest(gate: GateDefinition, namespace: string) {
  return (config: CloudConfig): string => {
    const name = getGateName(gate);
    const client = getClientSecretName(gate);
    const cookie = getCookieSecretName(gate);
    const labels = { app: gate.name, role: "oauth2-proxy" };
    const managed = { "app.kubernetes.io/managed-by": "community-cloud" };
    const fromSecret = (secret: string, key: string) => ({
      valueFrom: { secretKeyRef: { name: secret, key } },
    });

    const service = {
      apiVersion: "v1",
      kind: "Service",
      metadata: { name, namespace, labels: managed },
      spec: {
        selector: labels,
        ports: [{ name: "http", port: OAUTH2_PROXY_PORT, targetPort: OAUTH2_PROXY_PORT }],
      },
    };

    const deployment = {
      apiVersion: "apps/v1",
      kind: "Deployment",
      metadata: { name, namespace, labels: managed },
      spec: {
        // Holds nothing but configuration, and a session lives in the
        // cookie, so it could be more than one. One is plenty.
        replicas: 1,
        selector: { matchLabels: labels },
        template: {
          metadata: { labels: { ...labels, ...managed } },
          spec: {
            nodeSelector: { "node-role.kubernetes.io/worker": "worker" },
            containers: [
              {
                name: "oauth2-proxy",
                image: OAUTH2_PROXY_IMAGE,
                imagePullPolicy: "IfNotPresent",
                args: [
                  `--http-address=0.0.0.0:${OAUTH2_PROXY_PORT}`,
                  `--upstream=${gate.upstream}`,

                  // Authentik's issuer is per application, and has to
                  // match to the trailing slash
                  "--provider=oidc",
                  "--provider-display-name=Community Cloud",
                  `--oidc-issuer-url=https://${readValue(config, "domain.auth")}/application/o/${gate.name}/`,
                  `--redirect-url=https://${readValue(config, gate.hostname)}/oauth2/callback`,
                  "--scope=openid email profile",
                  "--code-challenge-method=S256",

                  // Who may get through is decided in Authentik, by
                  // what's bound to the application there
                  "--email-domain=*",

                  // Straight to Authentik, since it's the only way in
                  "--skip-provider-button=true",

                  // TLS ends at the Gateway, which says so in the
                  // forwarded headers
                  "--reverse-proxy=true",
                  "--cookie-secure=true",
                  `--cookie-name=_cc_${gate.name.replace(/[^a-z0-9]/g, "_")}`,

                  ...(gate.skipAuthRoutes ?? []).map((route) => `--skip-auth-route=${route}`),
                ],
                env: [
                  { name: "OAUTH2_PROXY_CLIENT_ID", ...fromSecret(client, "username") },
                  { name: "OAUTH2_PROXY_CLIENT_SECRET", ...fromSecret(client, "password") },
                  { name: "OAUTH2_PROXY_COOKIE_SECRET", ...fromSecret(cookie, "password") },
                ],
                ports: [{ name: "http", containerPort: OAUTH2_PROXY_PORT }],
                // Answers whether or not Authentik is reachable, which
                // is right: the proxy being up and Authentik being
                // down are different problems, and restarting this
                // fixes neither
                readinessProbe: { httpGet: { path: "/ping", port: "http" }, periodSeconds: 10 },
                livenessProbe: { httpGet: { path: "/ping", port: "http" }, periodSeconds: 20 },
                resources: { requests: { memory: "32Mi", cpu: "25m" } },
              },
            ],
          },
        },
      },
    };

    return [stringify(service), stringify(deployment)].join("---\n");
  };
}

/**
 * The gate's client in Authentik, as a blueprint.
 *
 * Written as text rather than built as an object, because a blueprint
 * leans on YAML tags — "!Find", "!KeyOf", "!Context" — that are its
 * whole way of referring to things, and a YAML library writing out a
 * plain object has no way to produce them. What's interpolated is
 * quoted as JSON, which YAML reads as a double quoted string.
 *
 * @param gate
 * @returns
 */
export function buildGateBlueprint(gate: GateDefinition): BlueprintSource {
  return (config: CloudConfig): string => {
    const hostname = readValue(config, gate.hostname);
    const quote = (value: string) => JSON.stringify(value);

    return `version: 1
metadata:
  name: ${quote(`Community Cloud - ${gate.title}, gated`)}
entries:
  # oauth2-proxy turns away an address Authentik calls unverified, and
  # Authentik's own mapping calls every address that. The same mapping
  # the applications' own blueprints declare; see
  # k8s/apps/documenso/Documenso.blueprint.yaml for why it's safe only
  # while administrators make the accounts.
  - model: authentik_providers_oauth2.scopemapping
    id: email-verified
    identifiers:
      name: "Community Cloud: email, as verified"
    attrs:
      scope_name: email
      description: "Email address"
      expression: |
        return {
            "email": request.user.email,
            "email_verified": True,
        }

  - model: authentik_providers_oauth2.oauth2provider
    id: provider
    identifiers:
      name: ${quote(`${gate.title} (gate)`)}
    attrs:
      client_type: confidential
      client_id: !Context client_id
      client_secret: !Context client_secret
      authorization_flow: !Find [authentik_flows.flow, [slug, default-provider-authorization-implicit-consent]]
      invalidation_flow: !Find [authentik_flows.flow, [slug, default-provider-invalidation-flow]]
      signing_key: !Find [authentik_crypto.certificatekeypair, [name, authentik Self-signed Certificate]]
      redirect_uris:
        - matching_mode: strict
          url: ${quote(`https://${hostname}/oauth2/callback`)}
      property_mappings:
        - !Find [authentik_providers_oauth2.scopemapping, [managed, goauthentik.io/providers/oauth2/scope-openid]]
        - !Find [authentik_providers_oauth2.scopemapping, [managed, goauthentik.io/providers/oauth2/scope-profile]]
        - !KeyOf email-verified

  - model: authentik_core.application
    identifiers:
      slug: ${quote(gate.name)}
    attrs:
      name: ${quote(gate.title)}
      provider: !KeyOf provider
      meta_launch_url: ${quote(`https://${hostname}/`)}
      policy_engine_mode: any
`;
  };
}
