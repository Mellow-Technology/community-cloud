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
| `migrations` | a Job, run with each new image before the rollout | Kubernetes |
| `source.gitlab` | a project webhook; each successful pipeline on `ref` rolls out | GitLab's API |

It runs in `community-cloud`, and the installer's `cirrus` package
installs it along with everything above.

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
  port: 3000
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
      imageTag: "{commit_sha}" # or "{short_sha}", "{ref}", combined freely
```

More in [examples/](./examples):

| Example | Shows |
|---|---|
| [`static-site.yaml`](./examples/static-site.yaml) | The least there is: an image on two hostnames, no source |
| [`rails-app.yaml`](./examples/rails-app.yaml) | Everything at once — Postgres, a bucket, RabbitMQ, migrations, GitLab — with the labelled namespace and token Secret it needs |
| [`internal-api.yaml`](./examples/internal-api.yaml) | No hostname, a self-managed GitLab, a release branch and a custom image tag |

`tests/examples.rs` reads every WebApplication in there with the
operator's own types, so a field the operator doesn't know as typed
fails the build — though an unknown field is ignored, as the API
server's pruning would.

`kubectl get webapp` shows the deployed image, readiness and address.
`kubectl describe webapp shop` shows the conditions — `Provisioned`,
`RolledOut`, `WebhookRegistered` and `Ready` — and what each is waiting
on.

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

### The namespace

Two of Community Cloud's capabilities are labels on a namespace, and
Cirrus checks for them rather than adding them itself:

- `whereWereGoing: "weDontNeedRoads"`, for `hostnames`. The cluster
  Gateway refuses listeners from any other namespace.
- `storage.community-cloud.technology/buckets: "true"`, for `bucket`.
  SeaweedFS refuses buckets from any other namespace.

Without the label, `Provisioned` is False and says which label is
missing.

## Rollouts

GitLab has no webhook for an image being pushed, so Cirrus listens for
**successful pipelines** on the tracked ref instead. When one arrives:

1. Cirrus checks the hook's token, which is the application's own and
   is kept in `<app>-cirrus-webhook`.
2. It works out the tag from `imageTag`, asks GitLab's registry API for
   the tag's digest, and records the result as `status.release`. An
   image outside the project's GitLab registry is rolled out by tag.
3. The reconciler sees that the release differs from `deployedImage`
   and runs the migration Job, `<app>-migrate-<hash>`, with the new
   image. The old version keeps serving while the Job runs.
4. Once the Job completes, the Deployment gets the new image, by
   digest.

If the migration fails, `RolledOut` is False with the Job's name, and
the old version stays. Each image's migrations run once. To rerun them,
delete the Job.

Webhooks can get lost, so Cirrus also checks for the newest successful
pipeline every ten minutes. Until a release arrives, the application
runs `spec.image`.

The GitLab token in `tokenSecret` needs the `api` scope and the
Maintainer role on the project, so Cirrus can manage the project's
webhook and read its registry.

## Deleting

Everything in the application's namespace is owned by the
WebApplication and is removed with it, its Postgres role and
Database resources included. What's in `cc-office` (the vhost, the
user and the permission) and the GitLab webhook are removed by
Cirrus's finalizer. **Data is kept:** CloudNativePG keeps the
database, the namespace's Postgres stays, and SeaweedFS keeps the
bucket. Removing a `postgres`, `bucket` or `rabbitmq` block
from a live WebApplication stops Cirrus maintaining those resources but
doesn't delete them. They're removed when the WebApplication is
deleted.

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
| `CIRRUS_POSTGRES_STORAGE_SIZE` | `10Gi` |
| `CIRRUS_POSTGRES_STORAGE_CLASS` | `cc-local-ssd-fast` |
| `CIRRUS_POSTGRES_IMAGE` | unset: CloudNativePG's default |
| `CIRRUS_RABBITMQ_CLUSTER` | `rabbitmq` |
| `CIRRUS_SEAWEED_NAME`, `CIRRUS_SEAWEED_NAMESPACE` | `seaweed`, `seaweedfs` |
| `CIRRUS_S3_ENDPOINT` | `http://seaweed-s3.seaweedfs.svc:8333` |
| `CIRRUS_GATEWAY_NAME`, `CIRRUS_GATEWAY_NAMESPACE` | `cc-letsencrypt-web-gateway`, `community-cloud` |
| `CIRRUS_CLUSTER_ISSUER` | `cc-lets-encrypt` |
| `RUST_LOG` | `info` |

## Developing

```bash
cargo test                       # unit tests, plus a check that the CRD is current
cargo clippy --all-targets -- -D warnings
cargo run --bin crdgen > ../../k8s/operators/cirrus/Cirrus.crd.yaml   # after changing src/crd.rs
docker build -t cirrus:dev .
```

The toolchain is pinned in `rust-toolchain.toml`. `cargo run` against
a cluster uses your current kubeconfig, so point it at a throwaway
cluster, not a real one.

| Path | What it is |
|---|---|
| `src/crd.rs` | The WebApplication types; the CRD is generated from them |
| `src/reconcile/` | The reconciler. `mod.rs` runs the steps in order, with one module per thing it makes |
| `src/forge/` | GitLab: webhooks, pipelines, registry digests |
| `src/webhook.rs` | The HTTP server: `/hooks/gitlab/<namespace>/<name>`, `/healthz`, `/readyz` |
| `src/resources.rs` | The other operators' kinds, and server-side apply |

## Releasing

`.github/workflows/cirrus.yml` builds the image for amd64 and arm64 on
every pull request. Pushes to `main` publish
`ghcr.io/mellow-technology/cirrus:main` and `:sha-<commit>`. A tag
`cirrus-v<version>` publishes `:<version>` and `:latest`. After
releasing, bump the pinned image in
`k8s/operators/cirrus/Cirrus.yaml`.

## Not yet

- Redis. The shared Redis is divided by database number, and handing
  out numbers safely needs a design of its own.
- Forges other than GitLab. `src/forge/` is where they'd go.
- Leader election. Cirrus runs as one replica.
