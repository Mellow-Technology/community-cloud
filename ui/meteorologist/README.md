# Meteorologist

Community Cloud's web interface. It's for the things that are specific
to Community Cloud, which a general Kubernetes UI like Headlamp doesn't
know about:

- **Overview**: how every WebApplication is doing, worked out from the
  conditions Cirrus sets, and which ones need looking at.
- **Namespaces**: which Community Cloud capabilities each namespace has,
  with a switch to turn each one on or off. A capability is a label
  that the cluster's shared services select on:
  - `whereWereGoing=weDontNeedRoads` lets the cluster Gateway accept
    ListenerSets from the namespace
    (`k8s/networking/cilium/gateway/Gateway.yaml`).
  - `storage.community-cloud.technology/buckets=true` lets SeaweedFS
    make buckets there (`k8s/storage/SeaweedFS/SeaweedFS.yaml`).

  They're listed once, in `src/lib/capabilities.ts`. Adding a
  capability means adding one entry there.

  A namespace can be created from here, and each one has a page in
  three tabs: General (capabilities, Postgres, usage and settings), DNS
  and Integration (GitLab connections). The tab shown is in the
  address, as `?tab=dns` or `?tab=integration`. The settings are all
  made the way Kubernetes itself does them, so they hold for
  everything in the namespace, not just what Cirrus makes:
  - **Region**: the `scheduler.alpha.kubernetes.io/node-selector`
    annotation that the installer's `placement` also sets. It pins
    every pod in the namespace, Postgres included, to the region's
    nodes.
  - **Limits**: a ResourceQuota (`requests.cpu`, `limits.memory`,
    `requests.storage`) for the namespace's totals. There's also a
    LimitRange with each container's defaults, which a quota needs:
    without them, Kubernetes refuses every pod that doesn't state its
    own. Both are named `community-cloud`, and quotas made by hand are
    left alone.
  - **Private registries**: `kubernetes.io/dockerconfigjson` Secrets,
    named on the namespace's `default` ServiceAccount, so every pod
    pulls with them unless it names its own. Each one made here
    records its registry in the `community-cloud.technology/registry`
    annotation.
  - **GitLab connections** (the Integration tab): GitLab
    tokens kept in the namespace, apart from any one application. Each
    is an Opaque Secret labelled
    `community-cloud.technology/gitlab-connection=true`, with its
    instance in the `community-cloud.technology/gitlab-url` annotation
    and the token under `token`. The token is checked with GitLab
    before it's saved, and is what the application form lists projects
    and their registry images with. Cirrus uses the same Secret for its
    webhook and pipeline checks.
  - **DNS**: the `DnsProvider`s (Cirrus's cluster-scoped resource)
    publishing the namespace's hostnames. From here a namespace can
    join an existing provider, stop, or get a new one with its own
    account's credentials. Those go in a Secret in `external-dns`,
    where Cirrus runs one ExternalDNS per provider and namespace.
    Domains are checked against every other provider first, by the
    same rule as the installer's: two providers publishing different
    namespaces may not share a domain unless the broader one excludes
    it. Only cluster admins can see or change providers.

  The page also shows the namespace's Postgres: the CloudNativePG
  Cluster `cirrus-postgres`, which Cirrus starts for the first
  application there that asks for a database. The forms warn when a
  storage quota has no room for its 20Gi volume. That size mirrors
  Cirrus's default in `src/lib/postgres.ts`.

- **Applications**: list, view, create and edit `WebApplication`
  resources (`community-cloud.technology/v1alpha1`), which the Cirrus
  operator turns into a Deployment, its database, bucket, queue, routes
  and rollouts. Creating and editing go through a guided form. The form
  explains what each shared service provides, warns when the namespace
  is missing a label that a choice needs, and can add it on the spot.
  An image from GitLab is chosen rather than typed: through one of the
  namespace's connections, from the projects its token can see, with
  the image taken from the project's container registry. "Update
  automatically on image builds" then has Cirrus roll out each image a
  successful pipeline builds. Registry credentials follow the image:
  of the namespace's pull Secrets, the ones for the image's registry
  are chosen, read from the `community-cloud.technology/registry`
  annotation Meteorologist puts on those it makes, or from the
  Secret's own `.dockerconfigjson` for those it didn't.

It's a Next.js (App Router) app built on
[GUI Mellow](https://github.com/Mellow-Technology/gui-mellow).

## How it reaches the cluster

Browsers can't call the Kubernetes API directly, so Next's server sits
in between. Pages and server actions only go through the `KubeClient`
interface in `src/lib/kube/client.ts`. That interface has two
implementations:

- `apiServer.ts`, the real API, using `@kubernetes/client-node`
- `fixtures.ts`, an in-memory pretend cluster

To change how the API is reached, you only touch those files.

### Signing in (the default, `METEOROLOGIST_KUBE_MODE=user`)

1. People sign in through Authentik with OpenID Connect, using the
   authorization code flow with PKCE (`src/lib/auth/oidc.ts`).
2. The ID token and refresh token are stored in an encrypted, httpOnly
   cookie (`src/lib/auth/session.ts`), so there's no session store.
3. Every call to the Kubernetes API sends that ID token as a bearer
   token. The API server already trusts Authentik (see
   `installer/src/cli/commands/ClusterSignIn.ts`), so each request is
   made as `authentik:<username>`, with that person's
   `authentik:<group>` groups, and ordinary RBAC decides what they may
   do. Only members of a `k8s-*` group get in at all. Headlamp works
   the same way.
4. `src/proxy.ts` refreshes the ID token shortly before it expires.

Meteorologist itself needs no RBAC. Its pod's service account token is
never used; the pod only provides the API server's address and CA.

**The API server only accepts tokens issued to clients it knows
about.** Installed by the installer's `meteorologist` package, its
Authentik client is `meteorologist`, which the API server trusts once
the package is enabled and the `cluster-sign-in` bundle has run (see
`k8s/apps/meteorologist/`). Run anywhere else, its client has to be
listed in `k3s.signInClients`.

### Development without signing in

There are two other modes. Neither is ever used unless you ask for it
by name:

- `METEOROLOGIST_KUBE_MODE=fixtures` uses a pretend cluster held in
  memory. It has namespaces and applications in every state the pages
  draw (healthy, migrating, blocked, not yet seen by Cirrus). Changes
  last until the server restarts. Nothing reaches a real cluster.
- `METEOROLOGIST_KUBE_MODE=kubeconfig` makes every request as the user
  in the file that `METEOROLOGIST_KUBECONFIG` names. That variable is
  the only one read. `KUBECONFIG` and `~/.kube/config` are never picked
  up on their own, so a shell pointed at production can't be used by
  accident. Pointing `METEOROLOGIST_KUBECONFIG` at one of those files is
  fine, because that's a deliberate choice. A production build refuses
  this mode unless `METEOROLOGIST_ALLOW_KUBECONFIG_IN_PRODUCTION=true`
  is also set, for a local test of `next start`.

A bar across the top of every page shows which development mode is in
use.

You can also set `METEOROLOGIST_KUBECONFIG` in the default `user` mode.
Then only the kubeconfig's cluster address and CA are used; people
still sign in and act as themselves. That's how you try the real
sign-in from a laptop.

## Settings

| Variable                                       | Needed for                   | Meaning                                                                                                                                                                                                                          |
| ---------------------------------------------- | ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `METEOROLOGIST_KUBE_MODE`                      |                              | `user`, `kubeconfig` or `fixtures`. Deployed, it's always `user`. Locally, when unset, it follows from what's set: `OIDC_ISSUER` means `user`, `METEOROLOGIST_KUBECONFIG` alone means `kubeconfig`, and nothing means `fixtures` |
| `METEOROLOGIST_URL`                            | `user`, deployed             | The public address, e.g. `https://meteorologist.example.org`. Redirect URIs are built from it. Locally it defaults to `http://localhost:$PORT` (3000)                                                                            |
| `OIDC_ISSUER`                                  | `user`                       | The Authentik application's issuer, e.g. `https://auth.example.org/application/o/meteorologist/`                                                                                                                                 |
| `OIDC_CLIENT_ID`                               | `user`                       | The provider's client ID                                                                                                                                                                                                         |
| `OIDC_CLIENT_SECRET`                           | `user`, confidential clients | The provider's client secret                                                                                                                                                                                                     |
| `OIDC_SCOPES`                                  |                              | Defaults to `openid profile email offline_access`                                                                                                                                                                                |
| `SESSION_SECRET`                               | `user`                       | At least 32 characters; `openssl rand -base64 48`                                                                                                                                                                                |
| `KUBE_API_SERVER`, `KUBE_CA_FILE`              | outside a cluster            | The API server's address and CA. Inside a pod, the in-cluster ones are used                                                                                                                                                      |
| `KUBE_INSECURE_SKIP_TLS_VERIFY`                |                              | `true` to skip checking the API server's certificate (development only)                                                                                                                                                          |
| `METEOROLOGIST_KUBECONFIG`                     | `kubeconfig`                 | Path to a kubeconfig; a leading `~` works                                                                                                                                                                                        |
| `METEOROLOGIST_KUBECONFIG_CONTEXT`             |                              | A context in it other than the current one                                                                                                                                                                                       |
| `METEOROLOGIST_ALLOW_KUBECONFIG_IN_PRODUCTION` |                              | `true` to let `next start` use the kubeconfig mode                                                                                                                                                                               |

Put local settings in `.env.local`, which git ignores.

Anything the mode needs that's missing is listed, all of it at once,
as the response to every page and in the server's log, rather than
as a stack trace. A plain-HTTP `OIDC_ISSUER`, such as an Authentik
running on your machine, is accepted outside production.

## Running it locally

You need Bun 1.4.2. The scripts run Next under Node; Next 16 works on
Node 26.

```sh
cd ui/meteorologist
bun install
bun run dev:fixtures        # http://localhost:3000, a pretend cluster
```

`bun run dev` with nothing set up does the same.

Against a cluster, as a kubeconfig's user — naming the kubeconfig is
enough:

```sh
METEOROLOGIST_KUBECONFIG=~/.kube/dev-cluster.yaml bun run dev
```

Whoever that kubeconfig is, Meteorologist acts as them for everyone
who opens the page, so mind which cluster it points at.

With the real sign-in, from a laptop:

```sh
# .env.local
OIDC_ISSUER=https://auth.example.org/application/o/meteorologist/
OIDC_CLIENT_ID=meteorologist
OIDC_CLIENT_SECRET=...
SESSION_SECRET=...
METEOROLOGIST_KUBECONFIG=~/.kube/dev-cluster.yaml   # for the address and CA only
```

For this to work, the Authentik provider has to allow
`http://localhost:3000/auth/callback` as a redirect URI.

## Checks

```sh
bun run typecheck
bun run lint
bun run test           # bun test: capabilities, form conversion, warnings, health, sessions
bun run format:check   # Prettier, 120 columns, like the installer
bun run build          # next build, standalone output
```

## The image

`Dockerfile` builds the app with Bun and runs Next's standalone
`server.js` on Node, as the unprivileged `node` user, on port 3000.
`/healthz` answers as soon as the server is up, for probes. The build
fetches fonts from Google Fonts, so it needs network access.

```sh
docker build -t meteorologist ui/meteorologist
docker run -p 3000:3000 -e METEOROLOGIST_KUBE_MODE=fixtures meteorologist
```

## Releasing

`.github/workflows/meteorologist.yml` checks Meteorologist (typecheck,
lint, formatting, tests) and builds the image for amd64 and arm64 on
every pull request. Pushes to `main` publish
`ghcr.io/mellow-technology/meteorologist:main` and `:sha-<commit>`. A
tag `meteorologist-v<version>` publishes `:<version>` and `:latest`; a
version with a hyphen, like `0.2.0-rc.1`, leaves `:latest` alone.

The version is `package.json`'s, and the release script pushes the tag
for it, from the repository's root:

```bash
bun scripts/release/meteorologist.ts set minor   # or set 0.2.0; commit and merge it
bun scripts/release/meteorologist.ts --dry-run   # the checks alone
bun scripts/release/meteorologist.ts             # the checks, then the tag, pushed
```

It tags only what's on `origin/main`, with nothing uncommitted, and
only a version newer than the last released. The workflow checks the
tag against `package.json` too.

## Layout

```text
src/
  proxy.ts                  sign-in check and token refresh, before every page
  app/                      pages, and the /auth/* and /healthz routes
  components/               the form, switches, and local pieces GUI Mellow lacks
  lib/
    capabilities.ts         the namespace capability registry
    actions.ts              server actions: every change made to the cluster
    config.ts               settings, from the environment
    auth/                   OIDC and the session cookie
    kube/                   the KubeClient interface and its implementations
    namespace/              namespace settings: the form, and the resources it becomes
    postgres.ts             the Postgres Cirrus gives each namespace, mirroring Cirrus's defaults
    webapp/                 WebApplication types, form conversion, warnings, health
```

`src/lib/webapp/types.ts` mirrors `operators/cirrus/src/crd.rs`, which
is the authoritative schema. Change them together.
