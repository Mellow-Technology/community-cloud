"use client";

/**
 * @file
 * A namespace's DNS: the providers putting its hostnames in DNS, and
 * the means to add one or stop one.
 *
 * Each provider is a DnsProvider, which Cirrus turns into one
 * ExternalDNS per namespace it publishes. A namespace can join a
 * provider that already exists — the office's account publishing a
 * team's routes too — or get one of its own, with a new account's
 * credentials. Either way the domains are checked against every other
 * provider first, since two namespaces sharing a domain could write
 * each other's records.
 */
import { useRouter } from "next/navigation";
import { useMemo, useState, useTransition } from "react";
import { Disclosure } from "gui-mellow/Accordion";
import { Alert } from "gui-mellow/Alert";
import { Button } from "gui-mellow/Button";
import { SelectField, TextField } from "gui-mellow/Field";
import { StatusDot } from "gui-mellow/StatusDot";
import { Table } from "gui-mellow/Table";

import { createDnsProvider, setDnsPublishing } from "@/lib/actions";
import {
  OTHER_PROVIDER,
  PROVIDER_PRESETS,
  credentialsFor,
  dnsState,
  emptyDnsForm,
  presetFor,
  validateDnsForm,
  type DnsProviderForm,
} from "@/lib/dns/providers";
import { DNS_NAMESPACE, DNS_POLICIES, type DnsPolicy, type DnsProvider } from "@/lib/dns/types";
import pageStyles from "./page.module.scss";
import styles from "./WebApplicationForm.module.scss";

/**
 * @param props
 * @param props.namespace
 * @param props.providers every DnsProvider in the cluster
 * @returns
 */
export function NamespaceDns({ namespace, providers }: { namespace: string; providers: DnsProvider[] }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [result, setResult] = useState<{ ok: boolean; message: string }>();
  const publishing = providers.filter((provider) => (provider.spec.namespaces ?? []).includes(namespace));
  const others = providers.filter((provider) => !publishing.includes(provider));

  const toggle = (provider: string, publish: boolean) =>
    startTransition(async () => {
      setResult(undefined);
      const done = await setDnsPublishing(namespace, provider, publish);
      setResult(
        done.ok
          ? {
              ok: true,
              message: publish
                ? `${provider} now publishes ${namespace}'s hostnames.`
                : `${provider} no longer publishes ${namespace}. Records it made are removed unless its policy is upsert-only.`,
            }
          : { ok: false, message: done.error },
      );
      router.refresh();
    });

  return (
    <div className={styles.fields}>
      <p className={pageStyles.empty}>
        Hostnames on this namespace&apos;s applications are put in DNS, pointing at the cluster, by ExternalDNS — one
        instance per provider, run by Cirrus in <code>{DNS_NAMESPACE}</code>, where nobody with access only to this
        namespace can read the credentials. Only names inside a provider&apos;s domains are ever written.
      </p>
      {publishing.length > 0 ? (
        <Table
          columns={["Provider", "Domains", "State", ""]}
          rows={publishing.map((provider) => {
            const state = dnsState(provider, namespace);
            return [
              <span key="name">
                <code>{provider.metadata.name}</code> (
                {presetFor(provider.spec.provider)?.label ?? provider.spec.provider})
              </span>,
              provider.spec.domains.join(", "),
              <span key="state" title={state.message}>
                <StatusDot tone={state.tone}>{state.label}</StatusDot>
                {state.message && state.tone !== "success" && <p className={styles.note}>{state.message}</p>}
              </span>,
              <Button
                key="stop"
                size="sm"
                variant="ghost"
                loading={pending}
                onClick={() => toggle(provider.metadata.name, false)}
              >
                Stop publishing
              </Button>,
            ];
          })}
        />
      ) : (
        <p className={pageStyles.empty}>
          Nothing publishes this namespace yet, so each hostname is pointed at the cluster by hand.
        </p>
      )}

      {others.length > 0 && (
        <Disclosure title="Publish through an existing provider">
          <Table
            columns={["Provider", "Domains", "Publishes", ""]}
            rows={others.map((provider) => [
              <code key="name">{provider.metadata.name}</code>,
              provider.spec.domains.join(", "),
              (provider.spec.namespaces ?? []).join(", ") || "Nothing",
              <Button
                key="add"
                size="sm"
                variant="secondary"
                loading={pending}
                onClick={() => toggle(provider.metadata.name, true)}
              >
                Publish {namespace} too
              </Button>,
            ])}
          />
        </Disclosure>
      )}

      <Disclosure title="Add a DNS provider for this namespace">
        <DnsProviderCreator namespace={namespace} providers={providers} onCreated={() => router.refresh()} />
      </Disclosure>

      {result && (
        <Alert tone={result.ok ? "success" : "danger"} role="status">
          {result.message}
        </Alert>
      )}
    </div>
  );
}

/**
 * The form for a new provider, publishing one namespace.
 *
 * @param props
 * @param props.namespace
 * @param props.providers every DnsProvider, to check the domains against
 * @param props.onCreated
 * @returns
 */
function DnsProviderCreator({
  namespace,
  providers,
  onCreated,
}: {
  namespace: string;
  providers: DnsProvider[];
  onCreated: () => void;
}) {
  const [form, setForm] = useState<DnsProviderForm>(() => emptyDnsForm(namespace));
  const [attempted, setAttempted] = useState(false);
  const [pending, startTransition] = useTransition();
  const [result, setResult] = useState<{ ok: boolean; message: string }>();
  const errors = useMemo(() => validateDnsForm(form, providers, namespace), [form, providers, namespace]);
  const shown = attempted ? errors : {};
  const preset = presetFor(form.provider);
  const set = <K extends keyof DnsProviderForm>(key: K, value: DnsProviderForm[K]) =>
    setForm((current) => ({ ...current, [key]: value }));

  const submit = () => {
    setAttempted(true);
    setResult(undefined);
    if (Object.keys(errors).length > 0) {
      return;
    }
    startTransition(async () => {
      const created = await createDnsProvider(namespace, form);
      if (created.ok) {
        setResult({ ok: true, message: `Made ${form.name}. Cirrus starts its ExternalDNS for ${namespace} shortly.` });
        setForm(emptyDnsForm(namespace));
        setAttempted(false);
        onCreated();
      } else {
        setResult({ ok: false, message: created.error });
      }
    });
  };

  return (
    <div className={styles.fields}>
      <div className={styles.row}>
        <SelectField
          label="Provider"
          value={form.provider}
          onChange={(event) =>
            setForm((current) => ({
              ...current,
              provider: event.target.value,
              credentials: credentialsFor(current, event.target.value),
            }))
          }
          options={[
            ...PROVIDER_PRESETS.map((each) => ({ value: each.id, label: each.label })),
            { value: OTHER_PROVIDER, label: "Another ExternalDNS provider" },
          ]}
        />
        {form.provider === OTHER_PROVIDER ? (
          <TextField
            label="ExternalDNS provider"
            placeholder="gandi"
            error={shown.customProvider}
            value={form.customProvider}
            onChange={(event) => set("customProvider", event.target.value)}
          />
        ) : (
          <TextField
            label="Name"
            hint="Names the provider, its instances and its Secret."
            error={shown.name}
            value={form.name}
            onChange={(event) => set("name", event.target.value)}
          />
        )}
      </div>
      {form.provider === OTHER_PROVIDER && (
        <TextField
          label="Name"
          hint="Names the provider, its instances and its Secret."
          error={shown.name}
          value={form.name}
          onChange={(event) => set("name", event.target.value)}
        />
      )}
      <TextField
        label="Domains"
        required
        placeholder="example.org"
        hint="The zones it may write in, separated by commas. A name outside them is never touched."
        error={shown.domains}
        value={form.domains}
        onChange={(event) => set("domains", event.target.value)}
      />
      <fieldset className={styles.list}>
        <legend className={styles.legend}>Credentials</legend>
        {preset && <p className={styles.note}>{preset.hint}</p>}
        {form.credentials.map((row, index) => (
          <div className={styles.listRow} key={index}>
            <TextField
              label="Variable"
              className={styles.grow}
              placeholder="API_TOKEN"
              disabled={preset !== undefined}
              value={row.name}
              onChange={(event) =>
                set(
                  "credentials",
                  form.credentials.map((each, at) => (at === index ? { ...each, name: event.target.value } : each)),
                )
              }
            />
            <TextField
              label="Value"
              type="password"
              autoComplete="off"
              className={styles.grow}
              value={row.value}
              onChange={(event) =>
                set(
                  "credentials",
                  form.credentials.map((each, at) => (at === index ? { ...each, value: event.target.value } : each)),
                )
              }
            />
          </div>
        ))}
        {preset === undefined && (
          <div>
            <Button
              size="sm"
              variant="secondary"
              onClick={() => set("credentials", [...form.credentials, { name: "", value: "" }])}
            >
              Add a variable
            </Button>
          </div>
        )}
        {shown.credentials && <p className={styles.error}>{shown.credentials}</p>}
      </fieldset>
      <Disclosure title="More settings">
        <div className={styles.fields}>
          <TextField
            label="Excluded domains"
            placeholder="client.example.org"
            hint="Parts of those domains that belong to someone else, such as a subdomain given to another namespace."
            value={form.excludeDomains}
            onChange={(event) => set("excludeDomains", event.target.value)}
          />
          <div className={styles.row}>
            <TextField
              label="Point records at"
              placeholder="The Gateway's own address"
              hint="An address or hostname. Needed when the cluster is reached through a router forwarding ports."
              value={form.target}
              onChange={(event) => set("target", event.target.value)}
            />
            <SelectField
              label="Policy"
              value={form.policy}
              hint="Sync removes a record when its route goes; upsert-only never removes anything."
              onChange={(event) => set("policy", event.target.value as DnsPolicy)}
              options={DNS_POLICIES.map((policy) => ({ value: policy, label: policy }))}
            />
          </div>
        </div>
      </Disclosure>
      <p className={styles.note}>
        The credentials go into the Secret <code>{`cirrus-dns-${form.name || "<name>"}`}</code> in{" "}
        <code>{DNS_NAMESPACE}</code>, and nowhere else.
      </p>
      <div>
        <Button loading={pending} onClick={submit}>
          Add provider
        </Button>
      </div>
      {result && (
        <Alert tone={result.ok ? "success" : "danger"} role="status">
          {result.message}
        </Alert>
      )}
    </div>
  );
}
