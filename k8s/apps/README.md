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

## Invoice Ninja (`invoice-ninja/`)

[Invoice Ninja](https://invoiceninja.com) is invoicing, quotes and
payments. Install it with the `invoice-ninja` package, or the bundle of
the same name; it's reached at `values.domain.invoicing`.

| File | What it is |
|---|---|
| `InvoiceNinja.yaml` | The application: PHP-FPM, with nginx beside it in the same pod. |
| `InvoiceNinja.database.yaml` | Its MariaDB. |
| `InvoiceNinja.storage.yaml` | The volume for documents, PDFs and caches. |
| `InvoiceNinja.config.yaml` | Its configuration, and nginx's. |
| `InvoiceNinja.network.yaml` | Its listeners on the cluster Gateway, and its routes. |
| `InvoiceNinja.blueprint.yaml` | Its client in Authentik — a blueprint, not a manifest. |

The one exception to CloudNativePG: Invoice Ninja runs on MySQL or
MariaDB and nothing else, so it has a MariaDB of its own.

Its users sign in through Authentik with OpenID Connect, which
Invoice Ninja supports itself from 5.13.38. The client portal, where
customers open and pay invoices without an account, is left open —
it has to be.

## Documenso (`documenso/`)

[Documenso](https://documenso.com) is document signing. Install it
with the `documenso` package, or the bundle of the same name; it's
reached at `values.domain.signing`.

| File | What it is |
|---|---|
| `Documenso.yaml` | The application. |
| `Documenso.database.yaml` | Its role and database in cc-postgres. |
| `Documenso.config.yaml` | Its configuration. |
| `Documenso.network.yaml` | Its listeners on the cluster Gateway, and its routes. |
| `Documenso.blueprint.yaml` | Its client in Authentik — a blueprint, not a manifest. |

It signs in through Authentik with OpenID Connect, and only that way:
passwords are off, and an account is made for whoever Authentik lets
through. Signers open documents through the links they're sent, with
no account. Documents are kept in the database, so it needs no volume,
and completed ones are signed with a self-signed certificate the
installer generates.

## Mail

Mail is configured per namespace, under `smtp` in the configuration.
Applications that send email read their namespace's server as
`.Values.mail` — the installer renders a package's manifests for the
package's namespace — with `enabled`, `host`, `port`, `fromDomain`, and
the kind of TLS in the forms different applications want it: `scheme`
(`smtps` or `smtp`), `implicitTls`, `startTls`, `ignoreTls`. The
username and password are in the `cc-smtp` Secret in the namespace;
read them with `optional: true`, so the application still starts in a
namespace given no mail. A pod annotation of `.Values.mail.revision`
restarts it when the server changes.

## Single sign on

Both register a client with Authentik as they're installed: the
installer generates the client ID and secret into a Secret, then hands
Authentik the application's `.blueprint.yaml` with them. Who may sign
in is decided in Authentik, by what's bound to each application there.

Something with no sign in of its own goes behind a gate instead: a
package that declares one gets an oauth2-proxy in front of it,
registered with Authentik the same way, with nothing to write here —
the proxy and its blueprint are built by the installer. Its route then
sends requests to `<name>-oauth2-proxy` on port 4180, rather than to
the application.

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
