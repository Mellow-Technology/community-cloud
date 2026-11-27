# Meteorologist

Community Cloud's web interface. It's for the things that are specific
to Community Cloud, which a general Kubernetes UI like Headlamp doesn't
know about:

- **Overview**: how every WebApplication is doing, worked out from the
  conditions Cirrus sets, and which ones need looking at. Health is the
  application's own: whether Cirrus rolled it out and how its pods are
  doing, from Cirrus's `Healthy` condition. Whether Cirrus can hear
  about new releases (the GitLab webhook, and checking for the newest
  pipeline) is shown apart, as its forge status, so a running
  application with a broken webhook isn't called degraded. This, the
  applications list and each application's page update by themselves
  (see [Live status](#live-status)).
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
  six tabs: General (capabilities, Postgres, usage against its quota
  and settings), Applications (the applications list, for that
  namespace alone), Environment (values its applications share; see
  [Environment and secrets](#environment-and-secrets)), DNS, Forges
  (GitLab connections) and Agents
  (tokens for managing its applications over MCP; see
  [Agents and MCP](#agents-and-mcp)). The tab shown
  is in the address, as `?tab=dns` or `?tab=forges`, except
  Applications, which is its own route,
  `/namespaces/<name>/applications`. Links to the old `?tab=integration`
  still land on Forges. The settings are all
  made the way Kubernetes itself does them, so they hold for
  everything in the namespace, not just what Cirrus makes:
  - **Region**: the `placement.community-cloud.technology/region`
    and `/affinity` labels that the installer's `placement` also
    sets. The installer's admission policy gives every pod in the
    namespace, Postgres included, an affinity for the region's nodes,
    required or preferred. A namespace placed with the old
    `scheduler.alpha.kubernetes.io/node-selector` annotation is shown
    with its region, and moved to the labels when it's saved. Regions
    are shown by name, such as North America for `nam`, from a copy of
    the installer's list (`src/lib/regions.ts`, kept in step with
    `installer/src/topology/regions.ts` by its test). The form offers
    the regions the cluster's nodes are in, or every region when the
    nodes can't be listed.
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
  - **GitLab connections** (the Forges tab): GitLab
    tokens kept in the namespace, apart from any one application. Each
    is an Opaque Secret labelled
    `community-cloud.technology/gitlab-connection=true`, with its
    instance in the `community-cloud.technology/gitlab-url` annotation
    and the token under `token`. The token is checked with GitLab
    before it's saved, and is what the application form lists projects
    and their registry images with. Cirrus uses the same Secret for its
    webhook and pipeline checks.
  - **GitLab CI builds** (also the Forges tab): builds Meteorologist
    serves for a project's `.gitlab-ci.yml` to include, so a project
    needs nothing more than a Dockerfile or a bake file. See
    [GitLab CI builds](#gitlab-ci-builds).
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

- **Applications**: list, view, create, edit and delete `WebApplication`
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
  Secret's own `.dockerconfigjson` for those it didn't. Deleting asks
  first, listing what goes and what stays, and takes the
  application's name typed to confirm. Volumes (`spec.volumes`) are
  rows of name, mount path, size and storage type (`fast`, `sata` or
  `hdd`, Community Cloud's StorageClasses, or `ram`, a RAM disk whose size Cirrus adds to the container's memory), checked as Cirrus checks
  them; the delete dialog says their claims are kept. Connections (`spec.connections`) are picked
  from the ServiceOfferings the namespace may use, its own and those
  shared with it, each with its title and what it does, and say which
  variables they'll set and whether credentials come too; "Offer it to
  other applications" (`spec.offers`) has Cirrus make one for the
  application. Its page lists what it connects to, and, when it offers
  itself, what's connected to it. Cirrus's finalizer removes the
  RabbitMQ vhost and GitLab webhook, and Kubernetes the rest it made;
  the database and the bucket's contents are kept. An application
  waiting on that shows as Deleting.

- **Storage**, in two tabs, each with its own address and the
  namespace filter carried between them:
  - **Buckets** (`/storage`): list, view, create, edit and delete
    SeaweedFS `Bucket` resources (`seaweed.seaweedfs.com/v1`,
    `src/lib/storage/`). The list
    starts with how many are ready, how much is stored against their
    quotas, and how many objects there are; each row shows its status,
    how full it is, its versioning, who may use it, and whether Cirrus
    (for an application) or the installer (for a package) looks after
    it, since those set their own fields again. A bucket's page has its
    usage, settings, access and conditions. The form sets the quota and
    whether it's enforced, versioning (which, once on, can only be
    suspended), object lock (only when it's made), per-user access from
    the namespace's S3Identities, anonymous reads, what happens to the
    contents when it's deleted, and placement. A new bucket's name in
    SeaweedFS is `<namespace>-<name>` unless another is typed, as Cirrus
    names them, since every namespace's buckets share one list. SeaweedFS
    only makes buckets for namespaces with the Buckets capability.
  - **Users** (`/storage/users`): SeaweedFS's S3 users, from its
    `S3Identity` resources, with the Secret each one's keys are in (from
    its `S3Credentials`, by name only), every bucket that names it and
    what it may do there, and what looks after it. **Add user** (`/storage/users/new`) makes an S3Identity, with its first key if asked (on by default, since nothing can use a user without one), and then opens the user's Access Keys tab, where the secret key can be seen. S3Identity, S3Credentials and Bucket are all namespaced, but a user's name in SeaweedFS is one list across every namespace, so it's `<namespace>-<name>` unless another is typed, and can't change later. A user's name opens its page, which shows its keys and the buckets it may use above two tabs. **Edit** (`/storage/users/<namespace>/<name>/edit`) changes what can change on an S3Identity: its display name and email, whether it's disabled, and whether deleting it takes the user out of SeaweedFS (its reclaim policy); its name in SeaweedFS can't change once set. **Access Keys** (`…/keys`) lists its key pairs, its `S3Credentials`, with each access key's ID, the Secret it's in and when it was made. The secret key is read from the Secret only when asked, as the person asking, so only those who can read Secrets there see it. It makes new keys, into a Secret named for the user unless another is given, so a key can be replaced without a gap, and deletes old ones, which takes the key out of SeaweedFS unless its reclaim policy is Retain.
- **Office**: the office applications the installer put on the
  cluster, such as ProjectSend, Plane and Twenty, each with its
  address, its health, how people sign in, and how an administrator
  gets in. It's made from the record each package's install leaves:
  a ConfigMap in `community-cloud` labelled
  `community-cloud.technology/package`, with the record as JSON under
  `record.json` (see `installer/src/cli/commands/PackageRecord.ts`).
  Health comes from the Deployments and StatefulSets the install
  waited for.
  - Where the install made an administrator, the record names the
    Secret holding the password, never the password itself.
    "Show password" reads it on request, as the signed-in person, so
    it needs `get` on that Secret, which in `cc-office` means a
    cluster admin. Nothing secret is in the page as it's sent. A
    record can only name a Secret in its own package's namespace.
  - Where nobody was made one, the record says how to become the
    administrator, such as Authentik's initial setup page or
    "the first person to sign up".
  - A cluster installed before records existed gets them from
    `community-cloud run-bundle package-records <server> cc.config.json`,
    which records every enabled package without installing anything.

  The records are also the start of installing from here: they say
  what's installed, at which version, and what to wait for. What's
  still missing is a record of what's available, and a way for
  Meteorologist to start the installer in the cluster.

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

Every page is a few rounds of requests to the API server, so how far
away it is decides how fast Meteorologist feels. Two things keep that
short:

- **It runs beside an API server.** The Deployment requires a
  control-plane node, and `KUBE_API_SERVER` is that node's own address
  (`https://$(NODE_IP):6443`, from `status.hostIP`), which K3s's
  certificate names. The `kubernetes` Service could send a request to
  another server in another location once there's more than one. On
  Prime, where nodes are a quarter of a second apart, each request
  from another node waited that long.
- **Connections are kept and shared.** `@kubernetes/client-node` makes
  a new connection pool for every request, so each call opened a
  connection and paid a TLS handshake first. Requests made with a
  token use one pool instead (`sharedPool` in `apiServer.ts`), with
  idle connections kept for a minute. That's safe because the token is
  in each request's `Authorization` header, not the connection. A
  development kubeconfig's client certificate is part of the
  connection, so it keeps the library's own.

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
   do. Headlamp works the same way.
4. Only members of a `k8s-*` group get in at all. Authentik turns
   everyone else away before they reach Meteorologist (a policy in
   `k8s/apps/meteorologist/Meteorologist.blueprint.yaml`), and the
   callback asks the API server who the person is before making a
   session (`src/lib/auth/access.ts`). Someone it refuses gets no
   session and lands on `/auth/no-access`, which says who to ask.
5. `src/proxy.ts` refreshes the ID token shortly before it expires.

Everything is done as the person. Meteorologist's own account can list
namespaces (see [Limited access](#limited-access)) and get one ConfigMap
by name (see [GitLab CI builds](#gitlab-ci-builds)), and nothing else;
the pod otherwise only provides the API server's address and CA.

**The API server only accepts tokens issued to clients it knows
about.** Installed by the installer's `meteorologist` package, its
Authentik client is `meteorologist`, which the API server trusts once
the package is enabled and the `cluster-sign-in` bundle has run (see
`k8s/apps/meteorologist/`). Run anywhere else, its client has to be
listed in `k3s.signInClients`.

### Limited access

Not everyone is a cluster admin. To give a team a namespace, bind one of
Kubernetes's own roles to its group there:

```sh
kubectl -n team-shop create rolebinding team-shop \
  --clusterrole=edit --group=authentik:k8s-team-shop
```

`edit` lets them deploy, and `view` lets them look. Cirrus's manifests
add WebApplications to both (`k8s/operators/cirrus/Cirrus.rbac.yaml`).
Neither role can change a namespace or its quota, so capabilities,
region and limits stay with cluster admins. Those people see them but
can't change them, and an action RBAC wouldn't allow isn't offered,
which is worked out with `SelfSubjectAccessReview`.

The cluster-wide reads most pages start with are refused for them, so
pages go through `src/lib/namespace/access.ts`, which falls back to
reading each namespace in turn.

**How their namespaces are found is a stopgap.** Kubernetes can say
whether someone may do something in a namespace, but not which
namespaces they have access to. So Meteorologist's own account lists
every namespace's name, using a token in its own volume, and each name
is tried as the person. They only see the ones the API server gives
them. It's one of two reads not made as the person; the other is the
GitLab CI build, below.

That was chosen over binding `list namespaces` to
`system:authenticated`, or to each group, either of which would show
every tenant's namespace names to anyone using the API directly. The
costs are that a bug here could expose namespace names and labels, and
that a page load makes one request per namespace in the cluster for
these people. It's expected to be replaced with something more
sophisticated; see CC-41.

### GitLab CI builds

`src/lib/gitlab/builds.ts` and `src/lib/gitlab/serveBuild.ts`. A
project's `.gitlab-ci.yml` includes one remote file from Meteorologist.
There are two, side by side, and the path picks which:

- **Dockerfile**, at `/ci/gitlab/<namespace>/<key>/<group>/<project>.yml`:
  `docker build` with a Dockerfile, `Dockerfile` unless another path is
  given, in the repository's top directory. The path is the `DOCKERFILE`
  variable, so a CI/CD variable on the project overrides it too.
- **Bake**, at `/ci/gitlab-bake/<namespace>/<key>/<group>/<project>.yml`:
  `docker buildx bake` with a target (`default` unless another is named)
  from a bake file (bake's own search, `docker-bake.hcl` then compose
  files, unless a path is given), as `BAKE_TARGET` and `BAKE_FILE`.
  `BAKE_TARGET` may name several targets, separated by spaces (a list
  in the form), and any of them may be a group, for a repository that builds several images,
  such as an application and the API that goes with it. The job asks
  bake which targets they resolve to (`--print`, read with `jq`) and
  sets each one's tags and cache with `--set "<target>.tags=…"`, which
  replaces any the file gives: a build of one target is pushed to the
  project's own registry repository, as before, and a group's each go
  to one of their own under it, target `api` to `<project>/api`, its
  name in lower case. The main target (`BAKE_MAIN_TARGET`), when one is
  set, is pushed to the project's own repository instead, so an
  application that was there before its project built others beside it
  stays where it is. Each image is then an application of its own:
  they all name the same GitLab project, each with its own image
  repository, and Cirrus finds each one's image by the commit in that
  repository.

Either runs Docker in Docker on every push to the default branch, tags
the image with `$CI_COMMIT_SHORT_SHA` (one of the tags Cirrus looks for)
and `latest`, and pushes both to the project's registry. Where each
finds its Dockerfile, bake file, target and main target is set for the namespace on
the Forges tab, and a project with any of them somewhere else sets them
on its application's page, which also has both include lines to copy.

The settings are the ConfigMap `meteorologist-gitlab-builds` in the
namespace: `key`; the namespace's `dockerfile`, `bakeFile` and
`bakeTarget`; and `projects`, a JSON object by project path of whichever
of those a project has of its own, the rest being the namespace's. A
project's entry may also be a string, a Dockerfile path, which is how
they were written before bake. People change it as themselves, so it
takes the `edit` role.

GitLab fetches the file signed in as no one, so `src/proxy.ts` lets
`/ci/gitlab/` and `/ci/gitlab-bake/` through, and it's read with Meteorologist's own account,
which may get a ConfigMap of that name in any namespace and no other
(`k8s/apps/meteorologist/Meteorologist.yaml`). The key stands in for
signing in: a wrong one, or any other way of not finding the file, is
the same 404. It's in the path rather than a query parameter because
GitLab only includes a remote file whose last path segment, query and
all, ends in `.yml` or `.yaml`. Changing the key (Forges tab) breaks
every project's include until its line is replaced.

### Loading

A namespace's Applications tab draws its header and tabs as soon as the
namespace is read, and the list streams in after them, with
placeholder rows under its real columns until it does (a `<Suspense>`
around `ApplicationList`). Its route's `loading.tsx` stands in for the
whole tab before even the namespace is read, as when the tab is first
clicked. The placeholders are `src/components/Placeholder.tsx`: grey
bars that pulse, and hold still under `prefers-reduced-motion`, announced once
to screen readers as loading. GUI Mellow has no spinner or placeholder
of its own yet; when it does (GM-15), these move there.

### Live status

`src/components/LiveRefresh.tsx` opens a server-sent event stream at
`/apps/live`, which holds a watch on WebApplications as the person. The
stream only says that something changed, and the page redraws itself.
A watch runs for four minutes and then the browser starts another,
which is what gets it a refreshed token: the API server only checks a
token when a watch starts. Nothing runs while the tab is hidden.

### Environment and secrets

`src/lib/environment.ts`. An application's environment variables are
plain, secret or shared, each in a field of its own in the
WebApplication (see "Secrets and shared values" in
`operators/cirrus/README.md`):

- **Plain** ones are `spec.env`, written into the WebApplication.
  Anyone who can see the application can read them.
- **Secret** ones, switched on per variable in the form, are
  `spec.secrets`: names in the resource, values in the application's own
  Secret, `<app>-secrets`, which the WebApplication owns, so it goes
  when the application does. The form never reads them back: a kept
  secret is blank, leaving it blank keeps it, typing replaces it, and
  "Show" reads it on request as the person, so only someone who may
  read Secrets there sees it. A new value is written before the
  application is saved, and one no longer used is removed after. A
  secret's description, such as one an agent gave when asking for it,
  is shown beside it, and one still without a value has to be given one
  before saving.
- **Shared** ones are `spec.shared`: the namespace's values, kept once
  on its Environment tab for whatever several workloads use, plain
  values in the ConfigMap `community-cloud-env` and secret ones in the
  Secret of the same name. An application chooses the ones it reads in
  its form. The tab says which applications read each value, and one
  still read can't be removed. Changing them takes `edit`.

Everything Meteorologist writes here is labelled
`community-cloud.technology/environment`, and a Secret or ConfigMap of
the same name that isn't is left alone rather than written over.
Variables in `spec.env` read from a Secret or ConfigMap, or from the
pod's own fields, are shown and kept as they are. Cirrus holds the
rollout until every secret and shared value has a value, says which do
in `status.environment`, and restarts an application when a value it
reads changes.

Over MCP, an agent asks for a secret by name and description and never
gives or sees a value: a person sets it here, and `wait_for_rollout`
says what the application is waiting for. Agents see the namespace's
shared values in `get_capabilities`, plain ones with their values and
secret ones by name, and use them through `shared`.

### Agents and MCP

`/mcp` is an [MCP](https://modelcontextprotocol.io) server that lets
an AI agent, such as Claude Code working in a project's repository,
manage one namespace's applications. It has nine tools (in
`src/lib/mcp/tools.ts`), six for applications and three for
offerings:

- `get_capabilities`, what Cirrus can give applications in this
  namespace, from its `cirrus-capabilities` ConfigMap (see "What's
  available" in `operators/cirrus/README.md`): which of Postgres,
  RabbitMQ and buckets it can provide and why not, the storage types,
  whether applications can have public hostnames, whether egress is
  limited, and the ServiceOfferings shared with it. The same report
  trims `create_application` and `update_application` in `tools/list`,
  leaving out a service that isn't available and storage types with no
  StorageClass, and both refuse what isn't available, with Cirrus's
  reason (`src/lib/mcp/capabilities.ts`). Without a report, from an
  older Cirrus, nothing is held back.
- `list_applications` and `get_application`, for what's there and how
  it's doing
- `create_application`, which works out nothing itself: the agent
  reads the project's files for what it needs, guided by the server's
  instructions (`src/lib/mcp/instructions.ts`)
- `update_application`, which changes the fields it's given and only
  those
- `wait_for_rollout`, which waits until Cirrus has rolled out the
  latest change and it's healthy, or it fails, or the time runs out
  (five minutes unless asked, ten at most), saying what Cirrus is
  doing as it goes: provisioning, migrating, rolling out. Create and
  update do the same before answering when given `wait: true`. It
  watches the application, as the live pages do, with a poll beside
  the watch (`src/lib/mcp/rollout.ts`). When the time runs out it isn't
  an answer either way, and the agent is told to call it again.

The instructions also explain how Cirrus runs migrations, since an
agent setting `migrations` needs to know: a Job with the new image
before it's rolled out, `command` with no shell, once per image (so
it must be safe to run twice), one at a time, retried once with a
30-minute default timeout, and a failure leaving the old version
serving with the Job's name to hand to a person. And how volumes
work: local to one node and shared by every copy, rollouts that stop
the old copies first, storage types needing a node with those disks,
RAM disks emptied on restart and counted as memory, migrations not
mounting them, and kept when the application is deleted. And how
buckets work: their name and keys, the variables Cirrus sets,
path-style addressing, and that `S3_ENDPOINT` is only inside the
cluster, so links for browsers are signed for `S3_PUBLIC_ENDPOINT`.
And how connections work: what a ServiceOffering is, the variables a
connection sets and how their names are made, that credentials come
only from the namespace's own offerings, when two applications can
simply use each other's Service, and `offers`. An agent may make its
application an offering for its own namespace, and change its title,
description, protocol and path; `shareWith` and taking an offer away
are refused, for a person to do here. And how to offer a service, of
both kinds: an application through `offers`, and a Service that isn't
an application's through `create_offering`, `update_offering` and
`get_offering` (`src/lib/mcp/offerings.ts`), with an example call for
each. Those set an offering's title, description, protocol, Service and
port, path and plain values. `shareWith` and `secret` are refused and
kept as a person set them, an application's own offering is changed
only through the application, and there's no deleting one.

A change is laid over the form made from the live resource and saved
the way the application form saves (`src/lib/mcp/changes.ts`), so the
same validation applies, nothing the agent doesn't mention is lost, and
a write over someone else's is refused and tried again. Some things
are left to people, here, and are refused with a reason rather than
dropped: deleting an application, its hostnames (one made over MCP is
only reachable inside the cluster until a person gives it one; see
CC-45), turning a database, bucket or queue off, changing or removing a
volume, and anything read from a Secret, which the agent sees only by
reference.

Secrets and shared values work as described in
[Environment and secrets](#environment-and-secrets): agents ask for
secrets, never set them, and use what the namespace shares.

Every answer about an application includes the Dockerfile `LABEL`
for what it needs (`src/lib/webapp/labels.ts`), and the agent is asked
to write it into the project. The labels are CC-56's
`technology.community-cloud.*` ones (`postgres`, `rabbitmq`,
`bucket`, `migrate` and `health`). With them in the Dockerfile, the
next agent reads them rather than working it out again, and Cirrus can
read them from the image once CC-56 is done.

An agent is a ServiceAccount in the namespace labelled
`community-cloud.technology/agent=true`, with a RoleBinding to
`cirrus-webapplications-edit` that the ServiceAccount owns, made on
the Agents tab (`src/lib/agents/tokens.ts`). Its token is a
TokenRequest token, lasting from a week to a year, shown once and kept
nowhere; "New token" makes another, and "Revoke" deletes the
ServiceAccount, which ends all of them. `/mcp` hands the bearer token
to the API server as it is, just as a person's ID token is handed on,
and takes the namespace from the API server's answer about who the
token is (a SelfSubjectReview). So RBAC limits the agent, and
Meteorologist still has no access of its own. Making or revoking an
agent binds a role, so it takes the namespace's `admin` or a cluster
admin. `edit` can't do it.

The transport is Streamable HTTP without sessions: nothing is kept
between POSTs, so GET (for a stream) is refused. A POST is answered
with JSON, except a tool call that waits, which is answered as
server-sent events on that request: a `notifications/progress` for
each new step, when the client gave a `progressToken`, a comment every
15 seconds so the Gateway doesn't take the connection for idle, and the
result last. That needs no session. Since the API server checks a
token only when a watch starts, a token revoked mid-wait still sees
that wait out, which is at most ten minutes. `src/proxy.ts` lets `/mcp` through, and a request carrying a
browser's `Origin` other than Meteorologist's own is refused. In the
development modes there's no token, and the namespace comes from the
address: `/mcp?namespace=team-shop`.

Beyond its applications, the token may read only that one ConfigMap.
How much more of the cluster an agent should see, such as a failed
migration's logs, is CC-58.

The token's role would also let it delete applications through the
API server directly; only the tools hold that back. That's no more
than `edit` gives a person.

### Development without signing in

There are two other modes. Neither is ever used unless you ask for it
by name:

- `METEOROLOGIST_KUBE_MODE=fixtures` uses a pretend cluster held in
  memory. It has namespaces and applications in every state the pages
  draw (healthy, migrating, blocked, crash looping with no webhook,
  not yet seen by Cirrus). Changes
  last until the server restarts. Nothing reaches a real cluster.
  `METEOROLOGIST_FIXTURE_NAMESPACES=team-shop,sandbox` shows the pages
  as someone with the `edit` role in only those namespaces.
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
| `METEOROLOGIST_NAMESPACE_LISTER_TOKEN_FILE`    | limited access               | A token that may list namespaces. Without it, people who can't list namespaces themselves find none                                                                                                                              |
| `METEOROLOGIST_FIXTURE_NAMESPACES`             |                              | In `fixtures` mode, the namespaces to act as if limited to, comma separated                                                                                                                                                      |

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
bun run test           # bun test: capabilities, form conversion, warnings, health, sessions, office records
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
  app/                      pages, and the /auth/*, /healthz and /mcp routes
  components/               the form, switches, and local pieces GUI Mellow lacks, such as loading placeholders (GM-15)
  lib/
    capabilities.ts         the namespace capability registry
    environment.ts          where secret and shared environment values are kept
    actions.ts              server actions: every change made to the cluster
    config.ts               settings, from the environment
    auth/                   OIDC and the session cookie
    agents/                 agent tokens: ServiceAccounts for MCP clients
    kube/                   the KubeClient interface and its implementations
    mcp/                    the MCP endpoint's protocol, tools and instructions
    namespace/              namespace settings, and what someone with limited access can reach
    office.ts               the installer's package records: reading them, office applications, their health
    postgres.ts             the Postgres Cirrus gives each namespace, mirroring Cirrus's defaults
    regions.ts              region codes and names, mirroring the installer's list
    webapp/                 WebApplication types, form conversion, warnings, health, live status
```

`src/lib/webapp/types.ts` mirrors `operators/cirrus/src/crd.rs`, which
is the authoritative schema. Change them together.
