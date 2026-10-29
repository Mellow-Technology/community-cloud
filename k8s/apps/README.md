# Community Cloud Applications

The applications a Community Cloud instance runs. Most live in the
`cc-office` namespace, created by `office/Office.namespace.yaml`.

Each one is a package in the installer, and the `helm-charts` bundle
installs every package the configuration enables. Most also have a
bundle of their own — `community-cloud run-bundle <name> <node>
cc.config.json` installs it and what it needs on its own. Headlamp
has no bundle and is installed through `helm-charts`; Authentik comes
from a plugin.

Each application is split by what each piece is, so it can be read
one at a time: `.database.yaml` for its database, `.storage.yaml` or
`.bucket.yaml` for where it keeps files, `.config.yaml` for its
settings, `.network.yaml` for how it's reached. A `.values.yaml` is
Helm values rather than a manifest. All of them are templates,
rendered against `cc.config.json`; to see one as the installer would
apply it:

```bash
community-cloud run-template embed://apps/twenty/Twenty.yaml cc.config.json --dry-run --namespace cc-office
```

Without `--dry-run`, `run-template` applies it. `--namespace` says
whose mail settings to render `.Values.mail` with.

## The shared namespace (`office/`)

| File | What it is |
|---|---|
| `Office.namespace.yaml` | The `cc-office` namespace, labelled so its listeners may attach to the cluster Gateway and its applications may keep buckets in SeaweedFS. |
| `Office.database.yaml` | The shared CloudNativePG cluster, `cc-postgres`. |
| `Office.roles.yaml` | The database roles for Twenty, Mattermost and Authentik. |
| `RedisStandalone.yaml` | The Redis the applications share, made by the OpsTree operator. |
| `RabbitmqCluster.yaml` | The RabbitMQ the applications share, made by the RabbitMQ Cluster Operator. |
| `MariaDB.yaml` | The MariaDB the applications that need MySQL share, `cc-mariadb`, made by the MariaDB operator. |

The cluster and the roles come with the `cloudnative-pg` package,
which also makes each role's Secret. Applications added since bring
their own role instead.

The Redis comes with the `redis-operator` package, which installs the
operator into `community-cloud` and applies `RedisStandalone.yaml`. It's `redis` on 6379 in
`cc-office`, with its password in the `cc-redis` Secret; each
application keeps to a database number of its own.

The RabbitMQ comes with the `rabbitmq-operator` package, which
installs the RabbitMQ team's operators and applies
`RabbitmqCluster.yaml`. It's `rabbitmq` on 5672 in `cc-office`. Each
application has a vhost of its own and a user that can only use it,
from `Vhost`, `User` and `Permission` resources the Messaging Topology
Operator carries out; it writes the user's credentials into
`<user>-user-credentials`.

The MariaDB comes with the `mariadb-operator` package, which installs
the MariaDB operator into `community-cloud` (its resource types come
from `mariadb-operator-crds`) and applies `MariaDB.yaml`. It's
`cc-mariadb` on 3306 in `cc-office`, for the applications that only
run on MySQL, with its root password in the `cc-mariadb` Secret. As
with cc-postgres, an application brings its own `Database`, `User` and
`Grant`, with the user's password in a Secret of its own, and only the
operator connects as root. It has no backups yet.

## Authentik (`authentik/`)

[Authentik](https://goauthentik.io) is the identity provider, and what
everything else authenticates against, the cluster's own API server
included. It's installed by the `authentik` package, from these files;
it's reached at `values.domain.auth`.

| File | What it is |
|---|---|
| `Authentik.values.yaml` | Helm values. |
| `Authentik.database.yaml` | Its CloudNativePG database. |
| `Authentik.storage.yaml` | Its bucket in SeaweedFS, for icons, backgrounds and reports, and keys to only that. |
| `Authentik.network.yaml` | Its listeners on the cluster Gateway, and its routes. |

The chart bundles its own PostgreSQL. Community Cloud turns that off
and points it at CloudNativePG instead — one way of running Postgres
across the cluster is easier to back up, upgrade and reason about.
Browsers load its icons and backgrounds straight from its bucket on
`values.domain.storage`. Those links aren't signed, so the bucket
allows anonymous reads of its objects, though not listing them.

## Twenty CRM (`twenty/`)

[Twenty](https://twenty.com) is an open-source CRM, deployed as a
server and a worker. Install it with the `twenty` package; it's
reached at `values.domain.crm`.

| File | What it is |
|---|---|
| `Twenty.yaml` | The server, which sets up and migrates its database as it starts, and the worker. |
| `Twenty.database.yaml` | Its CloudNativePG database. |
| `Twenty.storage.yaml` | Its bucket in SeaweedFS, for uploads, and keys to only that. |
| `Twenty.config.yaml` | Its settings, mail included. |
| `Twenty.network.yaml` | Its listeners on the cluster Gateway, and its routes. |

Its queues are in the shared Redis. It signs sessions with a key in
the `twenty-crm-app-secret` Secret and encrypts stored credentials with
another in `twenty-crm-encryption-key`, both generated by the
installer. A `twenty-crm-fallback-encryption-key` Secret, if there is
one, is an older key it can still decrypt with while it re-encrypts.
It sends mail through the namespace's mail server. It has its own
accounts; signing in through Authentik needs Twenty's enterprise key.

## Plane (`plane/`)

[Plane](https://plane.so) is projects, issues and docs. Install it
with the `plane` package; it's reached at `values.domain.plane`, with
its parts divided by path — `/api` and `/auth` to its API, `/live` to
its live collaboration server, `/spaces` to its public pages,
`/god-mode` to its admin pages, `/mcp/http/api-key` to its MCP server,
and everything else to its web app.

| File | What it is |
|---|---|
| `Plane.yaml` | Its API, worker, scheduler and live server, and its three web apps. |
| `Plane.database.yaml` | Its role and database in cc-postgres. |
| `Plane.queue.yaml` | Its vhost in the shared RabbitMQ, and a user limited to it. |
| `Plane.bucket.yaml` | Its bucket in SeaweedFS, `uploads`, and keys to only that. |
| `Plane.config.yaml` | Its settings, and the script that makes its first administrator. |
| `Plane.mcp.yaml` | Its [MCP server](https://github.com/makeplane/plane-mcp-server), for AI agents. |
| `Plane.network.yaml` | Its listeners on the cluster Gateway, and its routes. |

Plane signs the links it gives browsers for its files for its own
hostname, with the bucket in the path, so `/uploads` on that hostname
goes to SeaweedFS — through a ReferenceGrant in `seaweedfs` that lets
Plane's route reach SeaweedFS's Service — and SeaweedFS checks the
signature against the hostname the request arrives with. The bucket
has to be called `uploads`, which Plane's exports assume.

Its free edition has no OpenID Connect, so it isn't signed into
through Authentik. Sign up is off. Its admin pages make whoever
reaches them first its administrator, so the install does that
first: with `values.adminEmail` and the password in the `plane-admin`
Secret, and only while there's no administrator at all. Most of its
settings, mail among them, live in its database once it's running,
and are changed from its admin pages.

Its MCP server gives an AI agent Plane's projects, work items, cycles
and the rest, as whoever connects: each person uses their own Plane
API token (Workspace Settings → API tokens), so the agent can do what
they can and no more, and no one's credentials are kept in the
cluster. Point an MCP client at it with two headers:

```json
{
  "mcpServers": {
    "plane": {
      "type": "http",
      "url": "https://<values.domain.plane>/mcp/http/api-key/mcp",
      "headers": {
        "Authorization": "Bearer <Plane API token>",
        "X-Workspace-slug": "<workspace>"
      }
    }
  }
}
```

The server can also sign people in with OAuth, but that needs an OAuth
application registered with Plane, so only the API token route is
reachable. What people ask through it is kept out of its logs.

## Lago (`lago/`)

[Lago](https://getlago.com) is billing: plans, subscriptions, usage
and invoices. Install it with the `lago` package; its web app is
reached at `values.domain.billing` and its API at
`values.domain.billingApi`.

| File | What it is |
|---|---|
| `Lago.yaml` | The API, which migrates first, and the worker and the clock, which wait for it. |
| `Lago.front.yaml` | The web app. |
| `Lago.pdf.yaml` | Gotenberg, which renders the invoices. |
| `Lago.database.yaml` | Its role and database in cc-postgres. |
| `Lago.bucket.yaml` | Its bucket in SeaweedFS, for PDFs, exports and logos, and keys to only that. |
| `Lago.config.yaml` | Its configuration, the web app's, and a Rails initializer of ours. |
| `Lago.network.yaml` | Its listeners on the cluster Gateway, and its routes. |

Lago has no OpenID Connect, so it isn't signed into through Authentik.
Sign up is off, and the first account is made on first start with
`values.adminEmail` and a generated password, in the `lago-admin`
Secret; everyone else is invited from inside Lago. Its queues and
cache are in the shared Redis, and its files in a bucket in the
cluster's SeaweedFS, so it needs the `redis-operator` and `seaweedfs`
packages, which it brings with it.

Links to its files go to its API, which fetches them from the bucket
and sends them on, rather than redirecting to the bucket as Rails
would by default. Rails would sign that redirect for the address Lago
reaches SeaweedFS on, inside the cluster, so a customer following it
to an invoice would get nowhere. Lago has no setting for it, so it's a
one line initializer in `Lago.config.yaml`.

## Documenso (`documenso/`)

[Documenso](https://documenso.com) is document signing. Install it
with the `documenso` package; it's reached at `values.domain.signing`.

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

## ProjectSend (`projectsend/`)

[ProjectSend](https://projectsend.org) is file sharing with clients.
Install it with the `projectsend` package; it's reached at
`values.domain.files`.

| File | What it is |
|---|---|
| `ProjectSend.yaml` | The application: nginx, PHP, its queue workers and scheduler in the one official image. |
| `ProjectSend.database.yaml` | Its database, user and grant in cc-mariadb. |
| `ProjectSend.storage.yaml` | Where its files go: a volume, or a bucket in SeaweedFS and keys to only that. |
| `ProjectSend.config.yaml` | Its configuration. |
| `ProjectSend.provision.yaml` | The script its first container runs, which writes its sign in and storage settings. |
| `ProjectSend.network.yaml` | Its listeners on the cluster Gateway, and its routes. |
| `ProjectSend.blueprint.yaml` | Its client in Authentik — a blueprint, not a manifest. |

It only runs on MySQL, so its database is in cc-mariadb rather than
cc-postgres, and its sessions, cache and queue are in the shared Redis
(databases 4 and 5). Its files are on a TopoLVM volume, or with
`values.projectsend.storage` set to `s3`, in a bucket in SeaweedFS.
ProjectSend hands a download over as a link signed for the bucket, so
it talks to SeaweedFS on `values.domain.storage`, where a browser can
follow the link, rather than inside the cluster.

ProjectSend keeps its settings in its database, with nothing to set
them from outside. So its first container waits for the database,
migrates it, and writes the two settings it can't start without
through ProjectSend's own models: signing in through Authentik with
the client in `projectsend-oidc`, and for `s3`, the bucket. The client
and the bucket are kept in step on every start. Whether the sign in is
on, and whether it makes accounts, are set the first time only, and
are an administrator's to change after that.

It signs in through Authentik with OpenID Connect, or with a password.
The first administrator is made with `values.adminEmail` and the
password in the `projectsend-admin` Secret. Signing in through
Authentik with the same address is the same account, since the
blueprint has Authentik vouch for addresses, as Documenso's does.
Anyone else Authentik lets through becomes a client.

## Mattermost (`mattermost/`)

[Mattermost](https://mattermost.com) is team chat. Install it with the
`mattermost` package; it's reached at `values.domain.mattermost`. The
package needs `mattermost-operator`, which installs the Mattermost
operator into `community-cloud`; the operator runs the installation in
`Mattermost.yaml`, in `cc-office`.

| File | What it is |
|---|---|
| `Mattermost.yaml` | The installation the operator runs: one replica, external database and file store. |
| `Mattermost.values.yaml` | Helm values for the operator. |
| `Mattermost.database.yaml` | Its CloudNativePG database. |
| `Mattermost.storage.yaml` | Its bucket in SeaweedFS, for uploads, and keys to only that. |
| `Mattermost.network.yaml` | A Service for its pods, and its listeners and routes on the cluster Gateway. |

## Headlamp (`headlamp/`)

[Headlamp](https://headlamp.dev) is a web UI for the cluster itself.
Install it with the `headlamp` package; it's reached at
`values.domain.headlamp`. It runs the cluster rather than being one
of the applications on it, so it goes in `community-cloud`, not
`cc-office`. People sign in through Authentik, and Headlamp talks to
the cluster as them: the installer has K3s's API server trust
Authentik for the client `headlamp` (see
[signing in to the cluster](../../installer/README.md#signing-in-to-the-cluster)),
so what someone can see is what RBAC gives `authentik:<their username>`
and their `authentik:<group>`s. Only members of a `k8s-` group get in;
members of `values.clusterAdminGroup` (`k8s-admins` unless it's set)
are cluster admins. Unlike the other applications' clients, Headlamp's
client ID is fixed as `headlamp`, since the API server is told it.

| File | What it is |
|---|---|
| `Headlamp.values.yaml` | Helm values: OpenID Connect, and the plugins mounted. |
| `Headlamp.blueprint.yaml` | Its client in Authentik — a blueprint, not a manifest. |
| `Headlamp.plugins.yaml` | Community Cloud's plugins, a ConfigMap each. |
| `Headlamp.rbac.yaml` | Cluster admin for the members of `values.clusterAdminGroup`. |
| `Headlamp.network.yaml` | Its listeners on the cluster Gateway, and its routes. |

The plugins are built from `headlamp/plugins/` at the top of the
repository and carried inside the installer: `bun run build:plugins`,
then `bun run build:embedded`. Their ConfigMaps are applied before
the chart, and Headlamp is restarted when they change.

## Meteorologist (`meteorologist/`)

Community Cloud's own web interface, built from `ui/meteorologist`:
namespaces, with their quotas, defaults and registries, and the
WebApplications Cirrus runs. Install it with the `meteorologist`
package; it's reached at `values.domain.meteorologist`, in
`community-cloud`. It works as Headlamp does: people sign in through
Authentik, and it calls the API with their token, so what they can do
is what RBAC already lets them. Its client ID is fixed as
`meteorologist`, since the API server is told it; the `cluster-sign-in`
bundle tells a running cluster.

| File | What it is |
|---|---|
| `Meteorologist.yaml` | Its Deployment and Service. No ServiceAccount token is mounted; it's given the API server's CA from `kube-root-ca.crt`. |
| `Meteorologist.blueprint.yaml` | Its client in Authentik — a blueprint, not a manifest. |
| `Meteorologist.network.yaml` | Its listeners on the cluster Gateway, and its routes. |

The image is pinned in `Meteorologist.yaml` and released with
`scripts/release/meteorologist.ts`, which sets the pin.

## Picoclaw (`picoclaw/`)

An AI agent with a web console. Install it with the `picoclaw`
package; it's reached at `values.domain.agent`, behind an Authentik
gate, since its agents run commands.

| File | What it is |
|---|---|
| `Picoclaw.yaml` | The agent and its console, and their Service. |
| `Picoclaw.config.yaml` | The configuration it starts with, the first time. |
| `Picoclaw.storage.yaml` | Its home: its saved configuration and its workspace. |
| `Picoclaw.network.yaml` | Its listeners on the cluster Gateway, and a route to its gate. |

See [picoclaw/README.md](./picoclaw/README.md).

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

Applications that sign in through Authentik, like Documenso, register
a client with Authentik as they're installed: the installer generates
the client ID and secret into a Secret, then hands Authentik the
application's `.blueprint.yaml` with them. Who may sign
in is decided in Authentik, by what's bound to each application there.

Something with no sign in of its own goes behind a gate instead: a
package that declares one gets an oauth2-proxy in front of it,
registered with Authentik the same way, with nothing to write here —
the proxy and its blueprint are built by the installer. Its route then
sends requests to `<name>-oauth2-proxy` on port 4180, rather than to
the application. Picoclaw is the one that does.

## What they share

- **Databases** are CloudNativePG, never a chart's bundled one, or
  for an application that only runs on MySQL, the shared MariaDB from
  the MariaDB operator
- **Files** are in a bucket each in SeaweedFS, or on a TopoLVM volume
  through `cc-local-ssd-fast` where an application needs a disk
- **Certificates** are cert-manager and Let's Encrypt, from the
  `cc-lets-encrypt` ClusterIssuer the `cert-manager` package applies
- **Ingress** is the Gateway API, served by Cilium's Envoy, through a
  ListenerSet on the cluster Gateway, `cc-letsencrypt-web-gateway`,
  which the `gateway` bundle makes
- **Domains** come from `values.domain.*` in the configuration, so an
  instance is rehomed by changing one file
