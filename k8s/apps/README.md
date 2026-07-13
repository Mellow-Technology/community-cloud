# Community Cloud Applications

This directory contains Kubernetes configurations for the back-office applications that form the core of a Community Cloud instance. All applications are deployed in the `cc-office` namespace.

## Directory Structure

```
apps/
├── office/                    # Office namespace (cc-office)
├── twenty/                    # Twenty CRM application
├── umami/                     # Umami analytics (template)
└── README.md
```

## Applications

### Twenty CRM (`twenty/`)

[Twenty](https://twenty.com) is an open-source CRM deployed as a full-stack application with server and worker deployments.

| File | Purpose |
|---|---|
| `Twenty.yaml` | Server deployment (1 replica) + worker deployment (1 replica), both on `worker` nodes |
| `TwentyDatabase.yaml` | CloudNative-PG `Database` CRD — creates `twenty_crm` database with `twenty_crm` owner |
| `Twenty.secret.yaml` | Base64-encoded encryption key, DB credentials, and database password |
| `Twenty.storage.yaml` | `ObjectBucketClaim` for Garage S3 storage (20 Gi limit, `cc-s3-storage` class) |
| `Twenty.config.yaml` | ConfigMap with server URL |
| `Twenty.install.yaml` | One-time init Job — runs `yarn database:init:prod` to bootstrap the database |
| `Twenty.route.yaml` | Gateway API `HTTPRoute` — routes  to the `twenty-crm` service |

**Architecture:**

- **Server** (port 3000): Frontend + API, session affinity (ClientIP, 3h timeout)
- **Worker** (background jobs): Runs `yarn worker:prod` for async task processing
- **Database**: CloudNative-PG cluster (`cc-postgres`) with PostGIS support, 30Gi SSD
- **Cache**: Redis (Opstree) in the `cc-office` namespace
- **Storage**: Garage S3-compatible object storage via `ObjectBucketClaim`

### Office (`office/`)

| File | Purpose |
|---|---|
| `OfficeNamespace.yaml` | Creates the `cc-office` namespace with managed-by labels |

### Umami (`umami/`)

Template directory prepared for [Umami](https://umami.is) analytics. No manifests yet.

## Namespace: `cc-office`

The `cc-office` namespace provides a policy boundary for all back-office resources:

- **Managed by**: Community Cloud (`app.kubernetes.io/managed-by: community-cloud`)
- **Purpose**: Isolated namespace for business/team applications with dedicated network policies

## Deployment Order

1. Create namespace (`office/OfficeNamespace.yaml`)
2. Deploy database (`database/Postgres/PostgresCCDefault.yaml` — `cc-postgres` cluster)
3. Deploy Redis (`database/Redis/RedisStandalone.yaml`)
4. Deploy Twenty server + workers (`twenty/Twenty.yaml`)
5. Run init job (`twenty/Twenty.install.yaml`)
6. Apply route (`twenty/Twenty.route.yaml`)
