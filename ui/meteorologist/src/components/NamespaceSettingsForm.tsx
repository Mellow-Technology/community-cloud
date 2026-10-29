"use client";

/**
 * @file
 * A namespace's settings — region, quota, container defaults and
 * registry credentials — for making a namespace and for changing one.
 *
 * What each setting turns into, and why it's done that way, is in
 * src/lib/namespace/settings.ts; this only draws it. The one thing it
 * works out for itself is whether the storage quota leaves room for
 * the Postgres Cirrus starts with the namespace's first database, since
 * a quota too small for it fails quietly, in a CloudNativePG status
 * nobody's looking at.
 */
import { useRouter } from "next/navigation";
import { useMemo, useState, useTransition, type ReactNode } from "react";
import { Alert } from "gui-mellow/Alert";
import { Button } from "gui-mellow/Button";
import { SelectField, TextField } from "gui-mellow/Field";
import { Steps } from "gui-mellow/Steps";
import { Switch } from "gui-mellow/Switch";

import { createNamespace, saveNamespaceSettings } from "@/lib/actions";
import { CAPABILITIES } from "@/lib/capabilities";
import { pullSecretName, validateNamespaceForm, type NamespaceForm, type RegistryRow } from "@/lib/namespace/settings";
import { POSTGRES_CLUSTER, POSTGRES_STORAGE, postgresStorageProblem } from "@/lib/postgres";
import styles from "./WebApplicationForm.module.scss";

export interface NamespaceSettingsFormProps {
  initial: NamespaceForm;
  // Absent when making a namespace
  existing?: {
    // Pull Secrets in the namespace that could be made defaults
    pullSecrets: string[];
    // Whether the namespace's Postgres is already there, and so
    // already counted in what the quota has used
    hasPostgres: boolean;
    storageUsed?: string;
  };
  // The regions nodes are in; empty when they couldn't be listed
  regions: string[];
}

/**
 * @param props
 * @returns
 */
export function NamespaceSettingsForm({ initial, existing, regions }: NamespaceSettingsFormProps) {
  const router = useRouter();
  const creating = existing === undefined;
  const [form, setForm] = useState(initial);
  const [attempted, setAttempted] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; message: string }>();
  const [saving, startSaving] = useTransition();

  const errors = useMemo(() => validateNamespaceForm(form, creating), [form, creating]);
  const shownErrors = attempted ? errors : {};
  const storageProblem = existing?.hasPostgres
    ? undefined
    : postgresStorageProblem(form.quotaStorage, existing?.storageUsed);

  const set = <K extends keyof NamespaceForm>(key: K, value: NamespaceForm[K]) =>
    setForm((current) => ({ ...current, [key]: value }));

  type TextKey = { [K in keyof NamespaceForm]: NamespaceForm[K] extends string ? K : never }[keyof NamespaceForm];
  const text = (key: TextKey) => ({
    value: form[key],
    error: shownErrors[key],
    onChange: (event: { target: { value: string } }) => set(key, event.target.value),
  });

  const submit = () => {
    setAttempted(true);
    setResult(undefined);
    if (Object.keys(errors).length > 0) {
      return;
    }
    startSaving(async () => {
      if (creating) {
        const created = await createNamespace(form);
        if (created.ok) {
          router.push(`/namespaces/${encodeURIComponent(created.value.name)}`);
          router.refresh();
        } else {
          setResult({ ok: false, message: created.error });
        }
        return;
      }
      const saved = await saveNamespaceSettings(form);
      if (saved.ok) {
        // The new pull Secrets now exist, and are kept from here on
        setForm((current) => ({
          ...current,
          pullSecrets: [...current.pullSecrets, ...current.registries.map((row) => pullSecretName(row.server))],
          registries: [],
        }));
        setAttempted(false);
        setResult({ ok: true, message: "Saved." });
        router.refresh();
      } else {
        setResult({ ok: false, message: saved.error });
      }
    });
  };

  const steps: Array<{ title: ReactNode; body: ReactNode }> = [];

  if (creating) {
    steps.push({
      title: "Name and capabilities",
      body: (
        <div className={styles.fields}>
          <TextField label="Name" required placeholder="team-shop" {...text("name")} />
          {CAPABILITIES.map((capability) => (
            <Switch
              key={capability.id}
              label={capability.title}
              description={capability.summary}
              checked={form.capabilities[capability.id] ?? false}
              onChange={(event) => set("capabilities", { ...form.capabilities, [capability.id]: event.target.checked })}
            />
          ))}
        </div>
      ),
    });
  }

  steps.push(
    {
      title: "Where it runs",
      body: (
        <div className={styles.fields}>
          {regions.length > 0 ? (
            <SelectField
              label="Region"
              value={form.region}
              error={shownErrors.region}
              onChange={(event) => set("region", event.target.value)}
              options={[
                { value: "", label: "Anywhere" },
                ...regions.map((region) => ({ value: region, label: region })),
                // A region set by hand that no node is in now
                ...(form.region !== "" && !regions.includes(form.region)
                  ? [{ value: form.region, label: `${form.region} (no nodes)` }]
                  : []),
              ]}
            />
          ) : (
            <TextField label="Region" placeholder="sea" {...text("region")} />
          )}
          <p className={styles.note}>
            Every pod in the namespace runs on a node in this region — applications, and the Postgres and anything else
            made for them, so they&apos;re never a region apart. It&apos;s strict: with no node in the region up, pods
            wait. It needs the API server&apos;s PodNodeSelector plugin, which the installer turns on once anything is
            placed. Pods already running stay where they are until they restart.
          </p>
        </div>
      ),
    },
    {
      title: "How much it may use",
      body: (
        <div className={styles.fields}>
          <p className={styles.note}>Totals for everything in the namespace together. Empty means no limit.</p>
          <div className={styles.row}>
            <TextField
              label="CPU"
              placeholder="4"
              hint="Reserved, in cores. Containers can burst above what they reserve."
              {...text("quotaCpu")}
            />
            <TextField
              label="Memory"
              placeholder="8Gi"
              hint="The most, across every container."
              {...text("quotaMemory")}
            />
            <TextField
              label="Storage"
              placeholder="100Gi"
              hint={`Every volume, the namespace's Postgres (${POSTGRES_STORAGE}) included.`}
              {...text("quotaStorage")}
            />
          </div>
          {storageProblem && (
            <Alert tone="warning" title="Not enough for Postgres">
              {storageProblem}
            </Alert>
          )}
        </div>
      ),
    },
    {
      title: "Default container resource limits",
      body: (
        <div className={styles.fields}>
          <p className={styles.note}>
            What a container is given when it doesn&apos;t state its own. A quota makes Kubernetes refuse pods that
            don&apos;t state what it limits, so these are what keep those running — including the namespace&apos;s
            Postgres server, <code>{POSTGRES_CLUSTER}</code>, which states nothing. Applications that set their own
            resources keep them.
          </p>
          <div className={styles.row}>
            <TextField label="CPU request" placeholder="100m" {...text("defaultCpuRequest")} />
            <TextField
              label="CPU limit"
              placeholder="none"
              hint="Empty lets containers use spare CPU."
              {...text("defaultCpuLimit")}
            />
          </div>
          <div className={styles.row}>
            <TextField label="Memory request" placeholder="128Mi" {...text("defaultMemoryRequest")} />
            <TextField label="Memory limit" placeholder="512Mi" {...text("defaultMemoryLimit")} />
          </div>
        </div>
      ),
    },
    {
      title: "Private registries",
      body: (
        <div className={styles.fields}>
          <p className={styles.note}>
            Credentials every pod in the namespace pulls images with, set on its <code>default</code> ServiceAccount. An
            application that names its own image pull Secrets uses those instead.
          </p>
          {existing && (
            <PullSecretPicker
              chosen={form.pullSecrets}
              available={existing.pullSecrets}
              onChange={(pullSecrets) => set("pullSecrets", pullSecrets)}
            />
          )}
          <RegistryEditor
            rows={form.registries}
            error={shownErrors.registries}
            onChange={(registries) => set("registries", registries)}
          />
        </div>
      ),
    },
  );

  return (
    <form
      className={styles.form}
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <Steps steps={steps} level={2} />

      <div className={styles.footer}>
        {attempted && Object.keys(errors).length > 0 && (
          <Alert tone="danger" title="Some fields need another look" role="alert">
            {Object.values(errors)[0]}
          </Alert>
        )}
        {result && (
          <Alert tone={result.ok ? "success" : "danger"} title={result.ok ? undefined : "Not saved"} role="status">
            {result.message}
          </Alert>
        )}
        <div className={styles.buttons}>
          <Button type="submit" loading={saving}>
            {creating ? "Create namespace" : "Save settings"}
          </Button>
          {creating && (
            <Button variant="ghost" href="/namespaces">
              Cancel
            </Button>
          )}
        </div>
      </div>
    </form>
  );
}

/**
 * Which of the namespace's registry Secrets are defaults.
 *
 * @param props
 * @param props.chosen
 * @param props.available every pull Secret in the namespace
 * @param props.onChange
 * @returns
 */
function PullSecretPicker({
  chosen,
  available,
  onChange,
}: {
  chosen: string[];
  available: string[];
  onChange: (chosen: string[]) => void;
}) {
  // A default whose Secret has gone is still shown, so it can be taken off
  const names = [...new Set([...chosen, ...available])].toSorted();
  if (names.length === 0) {
    return <p className={styles.note}>There are no registry Secrets in this namespace yet.</p>;
  }
  return (
    <fieldset className={styles.list}>
      <legend className={styles.legend}>Registry Secrets in this namespace</legend>
      {names.map((name) => (
        <Switch
          key={name}
          label={name}
          description={available.includes(name) ? undefined : "This Secret no longer exists."}
          checked={chosen.includes(name)}
          onChange={(event) =>
            onChange(event.target.checked ? [...chosen, name] : chosen.filter((secret) => secret !== name))
          }
        />
      ))}
    </fieldset>
  );
}

/**
 * New registries to make pull Secrets for, a row each.
 *
 * @param props
 * @param props.rows
 * @param props.error
 * @param props.onChange
 * @returns
 */
function RegistryEditor({
  rows,
  error,
  onChange,
}: {
  rows: RegistryRow[];
  error?: string;
  onChange: (rows: RegistryRow[]) => void;
}) {
  const update = (index: number, change: Partial<RegistryRow>) =>
    onChange(rows.map((row, at) => (at === index ? { ...row, ...change } : row)));

  return (
    <fieldset className={styles.list}>
      <legend className={styles.legend}>Add a registry</legend>
      {rows.map((row, index) => (
        <div className={styles.listRow} key={index}>
          <TextField
            className={styles.grow}
            label="Registry"
            placeholder="registry.gitlab.com"
            hint={row.server.trim() ? `Saved as the Secret ${pullSecretName(row.server)}` : undefined}
            value={row.server}
            onChange={(event) => update(index, { server: event.target.value })}
          />
          <TextField
            className={styles.grow}
            label="Username"
            autoComplete="off"
            value={row.username}
            onChange={(event) => update(index, { username: event.target.value })}
          />
          <TextField
            className={styles.grow}
            label="Password or token"
            type="password"
            autoComplete="off"
            value={row.password}
            onChange={(event) => update(index, { password: event.target.value })}
          />
          <Button variant="ghost" size="sm" onClick={() => onChange(rows.filter((_, at) => at !== index))}>
            Remove
          </Button>
        </div>
      ))}
      {error && <p className={styles.error}>{error}</p>}
      <div>
        <Button
          variant="secondary"
          size="sm"
          onClick={() => onChange([...rows, { server: "", username: "", password: "" }])}
        >
          Add a registry
        </Button>
      </div>
      <p className={styles.note}>
        For GitLab, a deploy token with <code>read_registry</code> does. The credentials go straight into a Secret in
        the namespace and aren&apos;t kept anywhere else.
      </p>
    </fieldset>
  );
}
