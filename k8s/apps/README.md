# Community Cloud Applications

The applications a Community Cloud instance runs. Most live in the
`cc-office` namespace, created by `office/Office.namespace.yaml`.

Each application is split by what each piece is, so they can be
applied in order and read one at a time: `.database.yaml` before the
application that needs it, `.storage.yaml` before anything that writes,
`.cert.yaml` and `.route.yaml` for how it's reached. A
`.values.yaml` is Helm values rather than a manifest.

All of them are templates, rendered against `cc.config.json`:

```bash
community-cloud run-template embed://apps/twenty/Twenty.yaml cc.config.json
```

## The shared namespace (`office/`)

| File | What it is |
|---|---|
| `Office.namespace.yaml` | The `cc-office` namespace, labelled so its listeners may attach to the cluster Gateway. |

The applications reach the outside through the cluster's own Gateway
in `networking/gateway/`, rather than one of their own.
| `Office.issuer.yaml` | A Let's Encrypt issuer scoped to the namespace. |
| `Office.database.yaml` | The shared CloudNativePG cluster. |
| `RedisStandalone.yaml` | Redis, for the applications that want a cache. |

## Twenty CRM (`twenty/`)

[Twenty](https://twenty.com) is an open-source CRM, deployed as a
server and a worker.

| File | What it is |
|---|---|
| `Twenty.yaml` | The server and worker deployments. |
| `Twenty.install.yaml` | The one-off database setup job. |
| `Twenty.database.yaml` | Its CloudNativePG database. |
| `Twenty.storage.yaml` | Volumes for uploads. |
| `Twenty.config.yaml` | Configuration and secrets. |
| `Twenty.cert.yaml` | Its certificate. |
| `Twenty.route.yaml` | The HTTPRoute that reaches it. |
| `Twenty.network.yaml` | Network policy. |

## Authentik (`authentik/`)

[Authentik](https://goauthentik.io) is the identity provider, and what
everything else authenticates against.

| File | What it is |
|---|---|
| `Authentik.values.yaml` | Helm values. |
| `Authentik.database.yaml` | A CloudNativePG database. |
| `Authentik.storage.yaml` | Media and template volumes. |
| `Authentik.config.yaml` | Configuration and secrets. |
| `Authentik.cert.yaml` | Its certificate. |

The chart bundles its own PostgreSQL. Community Cloud turns that off
and points it at CloudNativePG instead — one way of running Postgres
across the cluster is easier to back up, upgrade and reason about.

## Mattermost (`mattermost/`)

[Mattermost](https://mattermost.com) is team chat.

| File | What it is |
|---|---|
| `Mattermost.yaml` | The installation. |
| `Mattermost.values.yaml` | Helm values for the operator. |
| `Mattermost.database.yaml` | Its CloudNativePG database. |
| `Mattermost.storage.yaml` | Volumes for uploads. |

## Headlamp (`headlamp/`)

[Headlamp](https://headlamp.dev) is a web UI for the cluster itself.

| File | What it is |
|---|---|
| `Headlamp.values.yaml` | Helm values. |
| `Headlamp.plugins.yaml` | The plugins it loads, including Community Cloud's own. |

## Picoclaw (`picoclaw/`)

| File | What it is |
|---|---|
| `Picoclaw.deployment.yaml` | The deployment. |
| `Picoclaw.config.yaml` | Its configuration. |
| `Picoclaw.storage.yaml` | Its volumes. |
| `Picoclaw.route.yaml` | The HTTPRoute that reaches it. |

See [picoclaw/README.md](./picoclaw/README.md).

## What they share

- **Databases** are CloudNativePG, never a chart's bundled one
- **Storage** is TopoLVM through `cc-local-ssd-fast`
- **Certificates** are cert-manager and Let's Encrypt
- **Ingress** is the Gateway API, served by Cilium's Envoy, through a
  listener on the cluster Gateway
- **Domains** come from `values.domain.*` in the configuration, so an
  instance is rehomed by changing one file
