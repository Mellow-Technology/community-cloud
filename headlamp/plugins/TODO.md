# TODO

Things noticed while building these plugins that are worth doing but were out
of scope at the time.

## Reconcile logical volumes against the real volume group

`cc-storage-explorer` currently reports what the `LogicalVolume` custom
resources *say*, and has no way to tell whether the LVM volumes behind them
still exist. In practice they often do not: a `LogicalVolume` can outlive the
volume it describes, leaving a record that looks like allocated space and
isn't.

The plugin cannot currently tell the difference, but the data to do so is
there. Two signals give it away:

- A volume with no `PersistentVolume` bound to it. On its own that is only
  suspicious — a volume may legitimately be between bindings.
- The sum of what the records claim exceeding the size of the volume group
  they claim it from. That cannot be true, so at least some of the records
  are phantoms.

The second is the strong one, and it is the one the plugin can't ask for yet.

This does **not** need changes to TopoLVM. The missing figure is the volume
group's total size, and TopoLVM already publishes it — just as a Prometheus
metric on the node pods rather than on the API:

```
topolvm_volumegroup_size_bytes{device_class,node}       LVM VG size under lvmd management
topolvm_volumegroup_available_bytes{device_class,node}  LVM VG available bytes
```

The `capacity.topolvm.io/<class>` node annotation the plugin already reads is
the second of those. The first is only on the metrics endpoint.

There is no Service in front of the node pods, so it has to be a per-pod
proxy, which the API server will do:

```
GET /api/v1/namespaces/<namespace>/pods/<topolvm-node-pod>:8080/proxy/metrics
```

That is the same mechanism `useNodeSummaries` already uses for the kubelet
summary, so the shape of the code is known. What it needs beyond that:

- Discovery rather than hard-coded names. The namespace, the pod label and the
  port are all deployment specific; find the pods by label.
- `pods/proxy` in RBAC, where the kubelet summary needs `nodes/proxy`. Degrade
  the same way: show what the CRs say, and say why the reconciliation is
  missing.
- A parser for the Prometheus text format. Two metric names, so a few lines.

What it would buy: a real "allocated of total" gauge per volume group, and a
warning where the CRs claim more than the group holds — which is the signal
that a node has stale records.

## Surface TopoLVM's own health

Related, and possibly the cause of the above. A `topolvm-controller` that
cannot stay up is a controller that is not reconciling deletions, which would
explain `LogicalVolume` objects outliving their volumes — especially where
none of them carries a `deletionTimestamp`, so nothing ever asked for them to
go, while they still hold the `topolvm.io/logicalvolume` finalizer.

Restart counts and last-state reasons for the TopoLVM pods are already in the
API and the plugin doesn't show them. It should: when the storage view is
reporting something that looks impossible, the first question is whether the
controller behind it is running, and that is one `Pod` list away.

Worth showing per device class and node:

- restart counts for the `topolvm-node` and `csi-registrar` containers
- restart count for `topolvm-controller`
- the last termination reason and exit code, which is where a crash loop
  announces itself

This is arguably a cluster problem rather than a plugin one, but the plugin is
where it would be noticed, and noticing it is most of the work.
