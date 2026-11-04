# Monitoring

Prometheus, Alertmanager and Grafana, from the `monitoring` package,
which installs the `kube-prometheus-stack` chart into `community-cloud`.

Grafana is at `values.domain.grafana`. People sign in through Authentik,
and only members of a `k8s-` group get in: the cluster admin group
(`values.clusterAdminGroup`) are Grafana administrators, and everyone
else may look. If Authentik is what's broken, the account in the
`grafana-admin` Secret signs in at `/login?disableAutoLogin`.

Prometheus and Alertmanager have no route, because neither has a sign
in. Query Prometheus through Grafana's Explore page. For their own
pages, forward a port:

```sh
kubectl -n community-cloud port-forward svc/monitoring-kube-prometheus-prometheus 9090
kubectl -n community-cloud port-forward svc/monitoring-kube-prometheus-alertmanager 9093
```

| File | What it is |
|---|---|
| `Monitoring.values.yaml` | Helm values: storage, retention, Grafana's sign in, Alertmanager's mail. |
| `Monitoring.blueprint.yaml` | Grafana's client in Authentik — a blueprint, not a manifest. |
| `Monitoring.network.yaml` | The ListenerSet and routes for Grafana. |
| `Monitoring.monitors.yaml` | What's scraped beyond the chart's own: Cilium, cert-manager, CloudNativePG and TopoLVM. |
| `Monitoring.rules.yaml` | Alerts of our own, for certificates and node storage. |
| `Monitoring.dashboards.yaml` | Dashboards for what doesn't ship its own. |

## Alerts

Alerts are emailed to `values.adminEmail` through the mail server
configured for `community-cloud`, under `smtp.namespaces`. Without one,
Alertmanager still runs and Grafana still shows what's firing, but
nobody is told.

## Metrics

K3s keeps the controller manager and the scheduler inside its own
process, on localhost, and Cilium replaces kube-proxy, so those are left
out along with their alert rules. So is etcd.

Cilium's metrics are switched on in its own values, which restarts its
agents one node at a time when the `cilium` bundle is next run. Until
then its monitors find nothing to scrape, which does no harm.

Those metrics listen on ports 9962 and 9963 on every interface of every
node. node-exporter is told to use the node's internal address, but
Cilium has no such setting, so block those two ports on any node with a
public address.

## Upgrading the chart

Helm installs a chart's CRDs the first time and never touches them
again, so a new version of this chart needs its CRDs applied first:

```sh
helm pull prometheus-community/kube-prometheus-stack --version <version> --untar
kubectl apply --server-side --force-conflicts -f kube-prometheus-stack/charts/crds/crds/
```

Then change the version in `installer/src/cli/commands/packages.ts`.
