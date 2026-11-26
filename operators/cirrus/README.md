# Cirrus

Cirrus runs web applications on Community Cloud. A `WebApplication`
says what an application needs, and Cirrus builds it out of the
services the cluster already runs:

| Asked for | What Cirrus makes | Through |
|---|---|---|
| always | a Deployment and a Service | Kubernetes |
| `hostnames` | a ListenerSet on `cc-letsencrypt-web-gateway`, a route, an HTTP→HTTPS redirect, and a certificate | the Gateway API, cert-manager |
| `postgres: {}` | a role and a database in the namespace's own Postgres, `cirrus-postgres` | CloudNativePG |
| `bucket: {}` | a bucket, an S3 user limited to it, and its keys | the SeaweedFS operator |
| `rabbitmq: {}` | a vhost, and a user limited to it | RabbitMQ's topology operator |
| `volumes` | a PersistentVolumeClaim for each, on one of Community Cloud's storage types, mounted into every copy; or a RAM disk | TopoLVM, Kubernetes |
| `connections` | environment variables for each ServiceOffering it uses: `<NAME>_HOST`, `_PORT`, `_URL`… | ServiceOfferings |
| `offers` | a ServiceOffering for its own Service, so others can connect to it | ServiceOfferings |
| `migrations` | a Job, run with each new image before the rollout | Kubernetes |
| `secrets` | a variable for each, read from the application's Secret `<app>-secrets` | Kubernetes |
| `shared` | a variable for each of the namespace's shared values, from `community-cloud-env` | Kubernetes |
| `source.gitlab` | a project webhook; each successful pipeline on `ref` rolls out | GitLab's API |

It runs in `community-cloud`, and the installer's `cirrus` package
installs it along with everything above.

It also runs ExternalDNS for each `DnsProvider`, so a namespace's
hostnames are put in DNS without anyone editing records; see
[Publishing DNS](#publishing-dns).

## A WebApplication

```yaml
apiVersion: community-cloud.technology/v1alpha1
kind: WebApplication
metadata:
  name: shop
  namespace: acme
spec:
  image:
    repository: registry.gitlab.com/acme/shop
    tag: main
  healthCheck:
    path: /up
  hostnames: [shop.acme.example]
  postgres: {}
  bucket:
    quota: 5Gi
  rabbitmq: {}
  migrations:
    command: ["bin/rails", "db:migrate"]
  source:
    gitlab:
      project: acme/shop
      ref: main
      tokenSecret:
        name: gitlab-token     # key "token" by default
      # imageTag: "{ref}-{short_sha}"  # only if CI doesn't tag by commit
```

More in [examples/](./examples):

| Example | Shows |
|---|---|
| [`static-site.yaml`](./examples/static-site.yaml) | The least there is: an image on two hostnames, no source |
| [`rails-app.yaml`](./examples/rails-app.yaml) | Everything at once — Postgres, a bucket, RabbitMQ, migrations, GitLab — with the labelled namespace and token Secret it needs |
| [`internal-api.yaml`](./examples/internal-api.yaml) | No hostname, a self-managed GitLab, a release branch and a custom image tag |
| [`uploads-app.yaml`](./examples/uploads-app.yaml) | Volumes: uploads on spinning disks and a cache on NVMe |
| [`connected-apps.yaml`](./examples/connected-apps.yaml) | Connections: one application offering itself to another namespace, another connecting to it, and an offering written by hand for a Redis |
| [`dns-provider.yaml`](./examples/dns-provider.yaml) | A DnsProvider publishing one namespace's hostnames in Cloudflare, and its credentials |

`tests/examples.rs` reads every WebApplication and DnsProvider in there with the
operator's own types, so a field the operator doesn't know as typed
fails the build — though an unknown field is ignored, as the API
server's pruning would.

`kubectl get webapp` shows the deployed image, readiness and address.
`kubectl describe webapp shop` shows the conditions — `Provisioned`,
`RolledOut`, `Healthy`, `WebhookRegistered`, `ReleaseChecked` and
`Ready` — and what each is waiting on.

`Ready` means Cirrus has done its part: everything is provisioned and
the newest image rolled out. `Healthy` is how the pods are doing
since then, read from the pods themselves, which Cirrus watches:

| Reason | When |
|---|---|
| `PodsReady` | every pod asked for is ready |
| `PodsStarting` | fewer are ready than asked for, with nothing wrong yet |
| `PodsDegraded` | something is serving, but a pod is stuck, or a container restarted in the last 15 minutes |
| `PodsFailing` | nothing is serving, and a pod is stuck |
| `NotDeployed` | there's no Deployment yet |

A pod is stuck when a container is in `CrashLoopBackOff`,
`ImagePullBackOff` or another state that waiting won't fix, when it
can't be scheduled, or when it's been running for five minutes
without passing its readiness check. The message names the pods and
why, such as the last exit of a crash looping container. `ReleaseChecked` is false when Cirrus couldn't
ask GitLab for the newest release (reason `CheckFailed`); it tries
again within a couple of minutes, and until then runs the last release
it found, or `spec.image.tag` if it never found one. When GitLab
refuses, the message says whether the token's scope or its user's role
is what's missing.

It's also false, with reason `NoImage`, when the newest successful
pipeline's image can't be found (see [Finding the image](#finding-the-image)).
That isn't retried, since asking again won't change it. Cirrus looks
back through the last few pipelines for one that did publish an image
and rolls that out, and the message lists the tags the registry does
have, with the `imageTag` that matches them when one of the usual ones
does.

### Its port

Left out, `port` is read from the image: the one TCP port its
Dockerfile `EXPOSE`s, from the image's config in its registry. Cirrus
reads it once per image, with the pull Secrets the pods use
(`imagePullSecrets`, or the namespace's defaults), and records it in
`status.imagePorts`. `status.port` is the port the Service is on.

An image that declares no port, or several, isn't guessed at:
`RolledOut` is False with reason `PortUnknown`, names the ports it
found, and asks for `spec.port`. So is one whose registry can't be
read, which is retried. Either way the image isn't migrated for or
rolled out, and what's running keeps running. Setting `port` skips all
of this.

A new image that declares a different port is rolled out on it. The
Service and route move to the new port with it, and other
applications reaching it by `<app>:<port>` have to follow.

### What the application is given

- **Postgres:** the Secret `<app>-postgres`, loaded whole, with
  `DATABASE_URL`, `PGHOST`, `PGPORT`, `PGDATABASE`, `PGUSER` and
  `PGPASSWORD`. The role and the database are both called `<app>`,
  with any `-` as `_`.
- **Bucket:** `S3_ENDPOINT`, `S3_BUCKET`, `S3_REGION`,
  `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, and the `AWS_*`
  equivalents AWS's SDKs read on their own. The bucket is called
  `<namespace>-<app>`. Address it by path, not by virtual host.
- **RabbitMQ:** the Secret `<app>-rabbitmq`, loaded whole, with
  `AMQP_URL` and `RABBITMQ_HOST`, `_PORT`, `_USERNAME`, `_PASSWORD`
  and `_VHOST`.

Anything in `spec.env` comes after these, so it wins.

### Secrets and shared values

```yaml
  secrets:
    - name: STRIPE_SECRET_KEY
      description: Stripe's secret key, from the dashboard's API keys page
  shared:
    - name: SMTP_HOST
    - name: SENDGRID_API_KEY
      as: MAIL_KEY       # the variable it's set as; its own name unless said
```

`secrets` are the application's own: only their names are in the
resource, and their values are in the Secret `<app>-secrets` under the
same names, which Meteorologist writes and the WebApplication owns.
`shared` are values the namespace keeps once for all its applications,
plain ones in the ConfigMap `community-cloud-env` and secret ones in the
Secret of the same name; whether one is plain or secret is the
namespace's to say, so Cirrus looks it up. Each becomes a variable that
refers to its value, so nothing secret is written into the Deployment,
and they come after what Cirrus provides and before `spec.env`
(`src/reconcile/environment.rs`).

A secret without a value, or a shared value the namespace doesn't have,
holds the rollout: `Provisioned` is False, `Blocked`, saying which and
where to set it. That's how an application can ask for a secret nobody
has given it yet, such as one an agent found it needs, and wait for a
person. `status.environment` says which have a value (`set`), and for
shared ones whether they're plain or secret, never what the value is,
for whoever can read the application but not its Secrets.

A container only reads its environment when it starts, so Cirrus hashes
the values the application reads, from these and from any
`secretKeyRef` or `configMapKeyRef` in `spec.env`, into the pod
template's `community-cloud.technology/config-hash` annotation
(`src/reconcile/config_hash.rs`). It looks again whenever one of those
Secrets or ConfigMaps changes, so a changed value is a rollout, as a new
image is. Only the keys it reads count: changing one shared value
restarts only the applications reading it. An application reading
nothing from Secrets or ConfigMaps has no annotation.

### Postgres

Each namespace has a Postgres of its own rather than a share of
`cc-postgres`: a CloudNativePG Cluster, `cirrus-postgres`, that Cirrus
makes when the first application in the namespace asks for a database
and that every later one shares. Keeping it in the namespace keeps it
with the application. A namespace given a region under the installer's
`placement` has every pod in it, Postgres's included, pinned there,
so an application never queries a database in another region.

Cirrus makes the Cluster once, from the `CIRRUS_POSTGRES_*` settings
below, and after that leaves it alone. Grow its volume, add instances
or set up backups on it as on any CloudNativePG Cluster, and Cirrus
won't put them back. It isn't owned by any application, so it and its
data outlive the last one; delete it by hand when the namespace is
done with it.

A namespace already placed elsewhere when its Postgres was made keeps
it where it is until it's restarted, as for any pod.

### Volumes

```yaml
  volumes:
    - name: uploads
      mountPath: /app/public/uploads
      size: 200Gi
      type: hdd          # fast (the default), sata, hdd, or ram
    - name: scratch
      mountPath: /tmp/scratch
      size: 512Mi
      type: ram          # a RAM disk
```

Each volume is a PersistentVolumeClaim, `<application>-<name>`, on one
of Community Cloud's storage types. Those are TopoLVM device classes,
each a volume group of one kind of disk, with a StorageClass of its own
(`k8s/storage/StorageClass`):

| `type` | StorageClass | Disks |
|---|---|---|
| `fast` | `cc-local-ssd-fast` | NVMe |
| `sata` | `cc-local-ssd-sata` | SSDs behind a SATA controller |
| `hdd` | `cc-local-hdd` | spinning disks |
| `ram` | none: a RAM disk | memory |

A RAM disk (`ram`) isn't a claim: it's a memory-backed `emptyDir` no
bigger than its `size`, each pod's own, and emptied whenever the pod
restarts. For caches and scratch space, never for anything to keep.
What's in it counts against the container's memory, so Cirrus adds
each RAM disk's size to the container's memory request, and to its
limit when there is one (the default 256Mi is both); a full RAM disk
can't then get the application killed. On its own it doesn't tie the
pods to a node or change how they're rolled out.

The disk types are local to a node. A volume is made on the node its first pod is
scheduled to, and a type no node has a volume group for waits forever,
so check which nodes have which (`storage.community-cloud.technology/classes`
on the nodes) before asking for `sata` or `hdd`.

So each volume on disk is shared by every copy of the application,
which all run on that node, and an application with one is rolled out by
stopping the old copies before starting the new (`Recreate`) rather
than side by side: a rolling update's extra copy could wait forever for
a node it can't have. There's a moment with nothing running.

A volume can grow, by raising its `size`, but not shrink, and its
`type` can't change; asking for either leaves the volume as it is and
says so in `Provisioned`. Names, mount paths and sizes are checked the
same way: lower-case names, unique; absolute mount paths that don't
overlap; sizes as quantities such as `10Gi`.

The claims count against the namespace's storage quota, like any
other.

Migrations don't mount the volumes: a migration Job runs while the
application is still up on the old image, and could be scheduled on
another node.

### Connecting to services

A **ServiceOffering** is a service saying what it is and how to reach
it, so applications connect to it by name instead of by copying
addresses and passwords around:

```yaml
apiVersion: community-cloud.technology/v1alpha1
kind: ServiceOffering
metadata: { name: search, namespace: catalogue }
spec:
  title: Product search
  description: 'Full-text search over the catalogue. POST /query with {"q": "..."}.'
  protocol: http          # http (default), https, grpc, postgres, mysql, redis, amqp, tcp
  service:
    name: search          # a Service in this namespace
    port: http            # name or number; its only port, or "http", when left out
  path: /v1               # added to the URL: a path, a database, a vhost
  shareWith: [shop]       # other namespaces that may connect
  secret: search-api      # a Secret here whose keys go to connections from here
  values: { region: sea } # more for every connection
```

An application then connects to it:

```yaml
  connections:
    - offering: search
      namespace: catalogue   # when it isn't this application's
      name: search           # what the variables start with; the offering's name by default
```

and gets `SEARCH_HOST` (`search.catalogue.svc.cluster.local`),
`SEARCH_PORT`, `SEARCH_URL` (`http://search.catalogue.svc.cluster.local:8080/v1`),
`SEARCH_TYPE` (`http`) and `SEARCH_REGION`. The naming follows Radius's
connections (`CONNECTION_<NAME>_<PROPERTY>`), less the first word. An
application can offer itself without writing one:

```yaml
  offers:
    title: Shop API
    description: Orders and baskets. Bearer tokens from Authentik.
    path: /api
    shareWith: [web]
```

makes an offering named for the application, for its Service's `http`
port, owned by it, and removed with it or when `offers` goes.

**Who may connect.** Namespaces are tenants, so an offering is usable
from its own namespace and the ones in `shareWith`, and nowhere else;
a connection from another namespace is refused in `Provisioned`. An
offering's status lists every application connected to it, and whether
each may.

**Credentials** go only as far as the namespace. A pod can only read
Secrets in its own, so `secret`'s keys (`username` and `password`
become `SEARCH_USERNAME` and `SEARCH_PASSWORD`) reach connections from
the offering's namespace, as references to its binding Secret, and
connections from elsewhere get the address alone.

**The binding Secret.** Each offering gets `<name>-binding`, named in
`status.binding`, holding the
[Service Binding Specification](https://servicebinding.io/spec/core/1.1.0/)'s
well-known entries (`type`, `provider`, `host`, `port`, `uri`) and the
offering's values and Secret's keys, which can't replace those. That's
the specification's "provisioned service", so anything implementing it
can bind to an offering too.

A connection waits, under `Provisioned`, while its offering isn't
there or hasn't found its Service. Changes to an offering reach its
applications when it's next reconciled, and an offering looks at its
Service again every minute, which is when it notices pods behind it
becoming ready.

### The namespace

Two of Community Cloud's capabilities are labels on a namespace, and
Cirrus checks for them rather than adding them itself:

- `whereWereGoing: "weDontNeedRoads"`, for `hostnames`. The cluster
  Gateway refuses listeners from any other namespace.
- `storage.community-cloud.technology/buckets: "true"`, for `bucket`.
  SeaweedFS refuses buckets from any other namespace.

Without the label, `Provisioned` is False and says which label is
missing.

### What's available

Installs differ, and so do namespaces, so Cirrus writes down what it can
give applications in each one before any of them asks. Every namespace
but Kubernetes's own gets a ConfigMap, `cirrus-capabilities`, with a
report as JSON under `capabilities.json` (`src/capabilities/`):

- `services`: `postgres`, `rabbitmq` and `bucket`, each `available` or
  not, with a `reason`. A service is missing when its operator's CRD
  isn't installed or, for RabbitMQ, its shared cluster isn't there.
  Buckets also need the namespace's label. The first database also
  needs room under the storage quota for the namespace's Postgres
  volume.
- `storage`: each storage type, and whether its StorageClass exists.
  `ram` always does.
- `ingress`: whether applications here can have public hostnames, which
  is the Gateway label.
- `egress`: whether a NetworkPolicy or CiliumNetworkPolicy in the
  namespace limits egress, naming them. Cluster-wide Cilium policies
  that limit egress are listed apart, since whether they select this
  namespace's pods isn't worked out.
- `offerings`: the ServiceOfferings applications here may connect to,
  their own namespace's and those shared with it, and whether each is
  ready.
- `shared`: the namespace's shared values, plain ones with their
  values and secret ones by name alone.

It's looked at again when the namespace or its shared values change,
and every three minutes. `view`, `edit` and `admin` may read it, through the aggregated
roles in `k8s/operators/cirrus/Cirrus.rbac.yaml`, and so may an agent's
token, which has nothing else beyond applications. Meteorologist's MCP
tools use it to say what an application can ask for and to refuse what
it can't. Cirrus's own checks when provisioning are unchanged: the
report is advice ahead of time, not a gate.

## Rollouts

GitLab has no webhook for an image being pushed, so Cirrus listens for
**successful pipelines** on the tracked ref instead. When one arrives:

1. Cirrus checks the hook's token, which is the application's own and
   is kept in `<app>-cirrus-webhook`.
2. It finds the pipeline's image in the project's registry, as below,
   and records it, by digest, as `status.release`.
3. The reconciler sees that the release differs from `deployedImage`
   and runs the migration Job, `<app>-migrate-<hash>`, with the new
   image. The old version keeps serving while the Job runs.
4. Once the Job completes, the Deployment gets the new image, by
   digest.

### Finding the image

GitLab doesn't record which tags a pipeline pushed, so Cirrus matches
the registry's tags back to the pipeline:

1. **By name.** With `imageTag` set, the tag it makes, and only that.
   Without it, each of the usual ways CI tags with the commit, in turn:
   `{commit_sha}` (`$CI_COMMIT_SHA`), `{short_sha}`
   (`$CI_COMMIT_SHORT_SHA`), and either with `{ref}-` in front. Each
   is one lookup, so this costs at most four requests.
2. **By push time**, only with `findImageByPushTime: true`. When
   nothing matched by name, the tag that was pushed between the
   pipeline starting and a minute after it finished, for CI that tags
   with `latest` or a version. Several tags on one image are fine,
   since the digest is what's rolled out. Different images pushed in
   that time aren't guessed between: that's `NoImage`, and `imageTag`
   is the way out. Each tag looked at is a request, so it looks at no
   more than 20, and skips tags that look like another commit's.

Rolling out by digest means a tag pushed again later, like `latest`,
doesn't change what's running until Cirrus finds another pipeline's
image. An image outside the project's own registry can't be looked
through, so it needs `imageTag`, and is rolled out by that tag.

If the migration fails, `RolledOut` is False with the Job's name, and
the old version stays. Each image's migrations run once. To rerun them,
delete the Job. A finished Job is kept, logs and all, until the next
image's migrations start.

Migrations run one at a time. An image that arrives while another's
migration is running waits for it to finish, as `RolledOut` says, and
the running one isn't stopped. The old version keeps serving with the
new schema until the rollout finishes, so a migration has to leave the
schema usable by the code before it.

The Job's pods are labelled `app.kubernetes.io/part-of` and
`app.kubernetes.io/component: migrations` rather than as the
application's own pods, so the application's Service doesn't send them
traffic.

Webhooks can get lost, so Cirrus also checks for the newest successful
pipeline every ten minutes. Until a release arrives, the application
runs `spec.image`.

The GitLab token in `tokenSecret` needs the `api` scope and the
Maintainer role on the project, so Cirrus can manage the project's
webhook and read its registry. GitLab checks both: a token with the
right scope still can't save a webhook if its user, or the bot behind
a group or project token, is only a Developer.

## Deleting

Everything in the application's namespace is owned by the
WebApplication and is removed with it, its Postgres role and
Database resources included. What's in `cc-office` (the vhost, the
user and the permission) and the GitLab webhook are removed by
Cirrus's finalizer. **Data is kept:** CloudNativePG keeps the
database, the namespace's Postgres stays, SeaweedFS keeps the bucket,
and the volumes' claims aren't owned by the application, so they and
what's on them stay; an application made again with the same name and
volumes picks them up. Removing a `postgres`, `bucket` or `rabbitmq` block
from a live WebApplication stops Cirrus maintaining those resources but
doesn't delete them. They're removed when the WebApplication is
deleted.

## Publishing DNS

A `DnsProvider` is one DNS provider account, the domains it holds, and
the namespaces whose hostnames it publishes. It's cluster-scoped, since
which namespace may write which domain is the cluster's decision, not
a namespace's:

```yaml
apiVersion: community-cloud.technology/v1alpha1
kind: DnsProvider
metadata:
  name: acme
spec:
  provider: cloudflare          # any ExternalDNS provider
  domains: [acme.example]
  excludeDomains: []            # parts given to another provider
  namespaces: [acme]            # one ExternalDNS each
  credentialsSecret: cirrus-dns-acme   # the default, in external-dns
  target: 203.0.113.7           # optional: what records point at
  policy: sync                  # or upsert-only, which never deletes
  args: []                      # further ExternalDNS flags
```

For each namespace Cirrus runs an ExternalDNS in `external-dns`
(`cirrus-dns-<provider>-<namespace>`) that reads only that namespace's
routes and writes only the provider's domains, with every key of the
credentials Secret as an environment variable. A route naming a
domain its namespace wasn't given is simply ignored.

This is the same design as the installer's `dns` section
(`installer/src/util/dns.ts`), kept in the cluster instead, so a
team's or a client's domain can be added from Meteorologist without
re-running a bundle. The two can sit side by side: the names and TXT
owner IDs differ (`cirrus-…` against `external-dns-…` and `cc-…`), so
neither touches the other's instances or records. Use the installer
for the cluster's own domains, which change with the cluster, and
DnsProviders for what changes with the people using it.

A DnsProvider runs nothing, and says why in its `Ready` condition,
when:

- **`Invalid`**: it has no provider or domains, or an unknown policy.
- **`DomainConflict`**: another DnsProvider publishing different
  namespaces holds the same domain, or one containing it without
  excluding it, so two sets of namespaces could write the same
  names. Only other DnsProviders are checked; the installer checks
  its own section, but neither sees the other's, so don't give the
  same domain to both.
- **`MissingCredentials`**: the credentials Secret isn't in
  `external-dns`.

Deleting the DnsProvider removes its instances. With the default
`sync` policy, an instance that's removed leaves its records behind,
since nothing is left to delete them.

## Configuration

Cirrus reads its settings from the environment. The defaults are the
names the installer uses.

| Variable | Default |
|---|---|
| `CIRRUS_WEBHOOK_BASE_URL` | unset: no webhooks, polling only. The installer sets `https://{values.domain.cirrus}` |
| `CIRRUS_LISTEN_ADDRESS` | `0.0.0.0:8080` |
| `CIRRUS_SERVICES_NAMESPACE` | `cc-office`, where the shared RabbitMQ is |
| `CIRRUS_POSTGRES_CLUSTER` | `cirrus-postgres`, the name of each namespace's Postgres |
| `CIRRUS_POSTGRES_INSTANCES` | `1` |
| `CIRRUS_POSTGRES_STORAGE_SIZE` | `20Gi` |
| `CIRRUS_POSTGRES_STORAGE_CLASS` | `cc-local-ssd-fast` |
| `CIRRUS_POSTGRES_IMAGE` | unset: CloudNativePG's default |
| `CIRRUS_RABBITMQ_CLUSTER` | `rabbitmq` |
| `CIRRUS_SEAWEED_NAME`, `CIRRUS_SEAWEED_NAMESPACE` | `seaweed`, `seaweedfs` |
| `CIRRUS_S3_ENDPOINT` | `http://seaweed-s3.seaweedfs.svc:8333` |
| `CIRRUS_GATEWAY_NAME`, `CIRRUS_GATEWAY_NAMESPACE` | `cc-letsencrypt-web-gateway`, `community-cloud` |
| `CIRRUS_CLUSTER_ISSUER` | `cc-lets-encrypt` |
| `CIRRUS_DNS_NAMESPACE` | `external-dns`, where DnsProviders' ExternalDNS instances and credentials are |
| `CIRRUS_CLUSTER_DOMAIN` | empty. The installer sets `{values.domain.main}`, hashed into each instance's TXT owner ID |
| `RUST_LOG` | `info` |

## Developing

```bash
cargo test                       # unit tests, plus a check that the CRD is current
cargo clippy --all-targets -- -D warnings
cargo run --bin crdgen > ../../k8s/operators/cirrus/Cirrus.crd.yaml   # after changing src/crd.rs or src/dns/mod.rs
docker build -t cirrus:dev .
```

The toolchain is pinned in `rust-toolchain.toml`. `cargo run` against
a cluster uses your current kubeconfig, so point it at a throwaway
cluster, not a real one.

| Path | What it is |
|---|---|
| `src/crd.rs` | The WebApplication types; the CRD is generated from them |
| `src/dns/` | DnsProvider: its types, the domain conflict check, the ExternalDNS it runs, and its controller |
| `src/reconcile/` | The reconciler. `mod.rs` runs the steps in order, with one module per thing it makes |
| `src/forge/` | GitLab: webhooks, pipelines, registry digests |
| `src/webhook.rs` | The HTTP server: `/hooks/gitlab/<namespace>/<name>`, `/healthz`, `/readyz` |
| `src/resources.rs` | The other operators' kinds, and server-side apply |

## Releasing

`.github/workflows/cirrus.yml` builds the image for amd64 and arm64 on
every pull request. Pushes to `main` publish
`ghcr.io/mellow-technology/cirrus:main` and `:sha-<commit>`. A tag
`cirrus-v<version>` publishes `:<version>` and `:latest`; a version
with a hyphen, like `0.2.0-rc.1`, leaves `:latest` alone.

The version is written in three places that move together: `Cargo.toml`,
`Cargo.lock`, and the image `k8s/operators/cirrus/Cirrus.yaml` pins,
which is what the installer applies. The release script sets them all
and pushes the tag, from the repository's root:

```bash
bun scripts/release/cirrus.ts set minor     # or set 0.2.0; commit and merge it
bun scripts/release/cirrus.ts --dry-run     # the checks alone
bun scripts/release/cirrus.ts               # the checks, then the tag, pushed
```

It tags only what's on `origin/main`, only when every place agrees,
and only a version newer than the last released. The workflow checks
the tag against `Cargo.toml` too. Until the tag's image is published,
`Cirrus.yaml` on main names an image that isn't there yet, so release
Cirrus soon after the version change merges; the installer's release
script won't go out before it.

## Not yet

- Credentials across namespaces. A connection from another namespace
  gets the address alone; copying Secrets between tenants is a decision
  of its own.
- Redis. The shared Redis is divided by database number, and handing
  out numbers safely needs a design of its own.
- Forges other than GitLab. `src/forge/` is where they'd go.
- Leader election. Cirrus runs as one replica.
