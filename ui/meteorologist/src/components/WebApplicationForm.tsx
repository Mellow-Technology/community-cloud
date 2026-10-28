"use client";

/**
 * @file
 * The guided setup for a WebApplication, for creating one and for
 * editing it.
 *
 * Laid out as numbered steps in the order someone thinks about an
 * application: where it lives, what it runs, how it runs, how it's
 * reached, what it needs, how it's updated, and its settings. Each
 * shared service says what it hands the application, so choosing one
 * doesn't mean reading Cirrus's source to find the variable names.
 *
 * When a choice needs something the namespace doesn't allow, the form
 * says so beside the choice and offers to allow it there and then. The
 * same goes for the GitLab token: the Secret can be made from here
 * rather than with kubectl.
 *
 * The conversion to and from the resource, the validation and the
 * warnings are all in src/lib/webapp, where they're tested; this only
 * draws them.
 */
import { useRouter } from "next/navigation";
import { useMemo, useState, useTransition, type ReactNode } from "react";
import { Disclosure } from "gui-mellow/Accordion";
import { Alert } from "gui-mellow/Alert";
import { Badge } from "gui-mellow/Badge";
import { Button } from "gui-mellow/Button";
import { SelectField, TextField } from "gui-mellow/Field";
import { Steps } from "gui-mellow/Steps";
import { Switch } from "gui-mellow/Switch";

import { createTokenSecret, saveWebApplication, setNamespaceCapability } from "@/lib/actions";
import { enabledCapabilities, type Capability } from "@/lib/capabilities";
import { validateForm, type EnvRow, type WebApplicationForm as FormModel } from "@/lib/webapp/form";
import { DEFAULT_GITLAB_REF, DEFAULT_GITLAB_URL, DEFAULT_IMAGE_TAG, DEFAULT_TOKEN_KEY } from "@/lib/webapp/types";
import { postgresDatabase } from "@/lib/postgres";
import { capabilityWarnings, postgresNote, type CapabilityWarning } from "@/lib/webapp/warnings";
import styles from "./WebApplicationForm.module.scss";

/**
 * A namespace the application could go in, with its labels so the form
 * can tell what it allows.
 */
export interface NamespaceChoice {
  name: string;
  labels: Record<string, string>;
  // Undefined wherever it couldn't be found out
  hasPostgres?: boolean;
  storageQuota?: string;
  storageUsed?: string;
}

export interface WebApplicationFormProps {
  initial: FormModel;
  namespaces: NamespaceChoice[];
  // Present when editing: the version the form was opened at
  resourceVersion?: string;
}

/**
 * @param props
 * @returns
 */
export function WebApplicationForm({
  initial,
  namespaces: initialNamespaces,
  resourceVersion,
}: WebApplicationFormProps) {
  const router = useRouter();
  const editing = resourceVersion !== undefined;
  const [form, setForm] = useState(initial);
  const [namespaces, setNamespaces] = useState(initialNamespaces);
  const [attempted, setAttempted] = useState(false);
  const [saveError, setSaveError] = useState<string>();
  const [saving, startSaving] = useTransition();

  const errors = useMemo(() => validateForm(form), [form]);
  const shownErrors = attempted ? errors : {};
  const namespace = namespaces.find((choice) => choice.name === form.namespace);
  const warnings = capabilityWarnings(form, namespace?.labels);
  const postgres = namespace && postgresNote(namespace);

  const set = <K extends keyof FormModel>(key: K, value: FormModel[K]) =>
    setForm((current) => ({ ...current, [key]: value }));

  // Text inputs, wired to a field of the form
  const text = (key: { [K in keyof FormModel]: FormModel[K] extends string ? K : never }[keyof FormModel]) => ({
    value: form[key],
    error: shownErrors[key],
    onChange: (event: { target: { value: string } }) => set(key, event.target.value),
  });

  const warningFor = (field: keyof FormModel) =>
    warnings
      .filter((warning) => warning.field === field)
      .map((warning) => (
        <CapabilityWarningNotice
          key={warning.capability.id}
          warning={warning}
          namespace={form.namespace}
          onEnabled={(capability) =>
            setNamespaces((current) =>
              current.map((choice) =>
                choice.name === form.namespace
                  ? { ...choice, labels: { ...choice.labels, [capability.label]: capability.value } }
                  : choice,
              ),
            )
          }
        />
      ));

  const submit = () => {
    setAttempted(true);
    setSaveError(undefined);
    if (Object.keys(errors).length > 0) {
      return;
    }
    startSaving(async () => {
      const result = await saveWebApplication(form, resourceVersion);
      if (result.ok) {
        router.push(`/apps/${encodeURIComponent(result.value.namespace)}/${encodeURIComponent(result.value.name)}`);
        router.refresh();
      } else {
        setSaveError(result.error);
      }
    });
  };

  const steps: Array<{ title: ReactNode; body: ReactNode }> = [
    {
      title: "Where it lives",
      body: (
        <div className={styles.fields}>
          <SelectField
            label="Namespace"
            required
            disabled={editing}
            value={form.namespace}
            error={shownErrors.namespace}
            hint={editing ? "An application can't move between namespaces." : undefined}
            onChange={(event) => set("namespace", event.target.value)}
            options={[
              { value: "", label: "Choose a namespace", disabled: true },
              ...namespaces.map((choice) => ({ value: choice.name, label: choice.name })),
            ]}
          />
          <TextField
            label="Name"
            required
            disabled={editing}
            placeholder="shop"
            hint={editing ? undefined : "Also the name of its Deployment, Service and connection Secrets."}
            {...text("name")}
          />
          {namespace && (
            <p className={styles.note}>
              {namespace.name} allows:{" "}
              {enabledCapabilities(namespace.labels).length > 0
                ? enabledCapabilities(namespace.labels).map((capability) => (
                    <Badge key={capability.id} tone="success" uppercase={false} className={styles.badge}>
                      {capability.title}
                    </Badge>
                  ))
                : "nothing beyond running containers."}
            </p>
          )}
        </div>
      ),
    },
    {
      title: "What it runs",
      body: (
        <div className={styles.fields}>
          <TextField
            label="Image"
            required
            placeholder="registry.gitlab.com/group/app"
            hint="Without the tag. This is what runs until a release from GitLab replaces it."
            {...text("repository")}
          />
          <TextField label="Tag" required placeholder="latest" {...text("tag")} />
          <TextField
            label="Pull secrets"
            placeholder="registry-credentials"
            hint="Usually empty: the namespace's own registry credentials are used. Name Secrets here, separated by commas, only to use these instead."
            {...text("imagePullSecrets")}
          />
        </div>
      ),
    },
    {
      title: "How it runs",
      body: (
        <div className={styles.fields}>
          <div className={styles.row}>
            <TextField label="Replicas" inputMode="numeric" {...text("replicas")} />
            <TextField label="Port" inputMode="numeric" hint="Where it listens for HTTP." {...text("port")} />
          </div>
          <TextField
            label="Health check path"
            placeholder="/healthz"
            hint="Answers 2xx once the application can serve. Rollouts wait for it."
            {...text("healthCheckPath")}
          />
          <Disclosure title="CPU and memory">
            <p className={styles.note}>Left empty, the application gets 256Mi of memory and no CPU limit.</p>
            <div className={styles.row}>
              <TextField label="CPU request" placeholder="100m" {...text("cpuRequest")} />
              <TextField label="Memory request" placeholder="256Mi" {...text("memoryRequest")} />
            </div>
            <div className={styles.row}>
              <TextField label="CPU limit" placeholder="1" {...text("cpuLimit")} />
              <TextField label="Memory limit" placeholder="512Mi" {...text("memoryLimit")} />
            </div>
          </Disclosure>
        </div>
      ),
    },
    {
      title: "How it's reached",
      body: (
        <div className={styles.fields}>
          <p className={styles.note}>
            Each hostname is served over HTTPS through the cluster Gateway, with a certificate from Let&apos;s Encrypt.
            Point its DNS at the cluster first. Leave this empty for an application only other workloads talk to.
          </p>
          <ListEditor
            label="Hostnames"
            values={form.hostnames}
            placeholder="app.example.org"
            addLabel="Add a hostname"
            error={shownErrors.hostnames}
            onChange={(hostnames) => set("hostnames", hostnames)}
          />
          {warningFor("hostnames")}
        </div>
      ),
    },
    {
      title: "What it needs",
      body: (
        <div className={styles.fields}>
          <Switch
            label="A Postgres database"
            checked={form.postgres}
            onChange={(event) => set("postgres", event.target.checked)}
            description={
              <>
                A database of its own, <code>{form.name ? postgresDatabase(form.name) : "<app>"}</code>, with a login of
                its own, on the Postgres server every application in the namespace shares. The server runs beside it, in
                its region. The connection details arrive as environment variables from the{" "}
                <code>{form.name || "<app>"}-postgres</code> Secret: <code>DATABASE_URL</code>, <code>PGHOST</code>,{" "}
                <code>PGPORT</code>, <code>PGDATABASE</code>, <code>PGUSER</code> and <code>PGPASSWORD</code>.
              </>
            }
          />
          {form.postgres && postgres && (
            <Alert tone={postgres.tone} className={styles.indented}>
              {postgres.message}
            </Alert>
          )}
          <Switch
            label="An S3 bucket"
            checked={form.bucket}
            onChange={(event) => set("bucket", event.target.checked)}
            description={
              <>
                A bucket in SeaweedFS with keys that reach only it. Provides <code>S3_ENDPOINT</code>,{" "}
                <code>S3_BUCKET</code>, <code>S3_REGION</code>, <code>S3_ACCESS_KEY_ID</code> and{" "}
                <code>S3_SECRET_ACCESS_KEY</code>, and the same as <code>AWS_*</code> for SDKs that look for those.
                Deleting the application keeps the bucket and its contents.
              </>
            }
          />
          {form.bucket && (
            <TextField
              label="Bucket quota"
              placeholder="10Gi"
              hint="The most the bucket may hold. Empty for no limit."
              className={styles.indented}
              {...text("bucketQuota")}
            />
          )}
          {warningFor("bucket")}
          <Switch
            label="A RabbitMQ vhost"
            checked={form.rabbitmq}
            onChange={(event) => set("rabbitmq", event.target.checked)}
            description={
              <>
                Its own vhost and user in the cluster&apos;s shared RabbitMQ, from the{" "}
                <code>{form.name || "<app>"}-rabbitmq</code> Secret: <code>AMQP_URL</code>, <code>RABBITMQ_HOST</code>,{" "}
                <code>RABBITMQ_PORT</code>, <code>RABBITMQ_USERNAME</code>, <code>RABBITMQ_PASSWORD</code> and{" "}
                <code>RABBITMQ_VHOST</code>.
              </>
            }
          />
        </div>
      ),
    },
    {
      title: "How it's updated",
      body: (
        <div className={styles.fields}>
          <Switch
            label="Release from GitLab"
            checked={form.gitlab}
            onChange={(event) => set("gitlab", event.target.checked)}
            description="Each successful pipeline on the branch below publishes an image, and Cirrus rolls it out. Cirrus registers a webhook on the project to hear about them."
          />
          {form.gitlab && (
            <div className={styles.indented}>
              <div className={styles.fields}>
                <TextField label="GitLab" placeholder={DEFAULT_GITLAB_URL} {...text("gitlabUrl")} />
                <TextField label="Project" required placeholder="group/app" {...text("gitlabProject")} />
                <div className={styles.row}>
                  <TextField
                    label="Branch or tag"
                    placeholder={DEFAULT_GITLAB_REF}
                    hint="Whose successful pipelines are rolled out."
                    {...text("gitlabRef")}
                  />
                  <TextField
                    label="Image tag"
                    placeholder={DEFAULT_IMAGE_TAG}
                    hint="What the pipeline tags the image as. {commit_sha}, {short_sha} and {ref} are filled in."
                    {...text("gitlabImageTag")}
                  />
                </div>
                <div className={styles.row}>
                  <TextField
                    label="Token Secret"
                    required
                    placeholder={`${form.name || "app"}-gitlab-token`}
                    hint="A Secret in this namespace with a project access token: api scope, Maintainer role."
                    {...text("gitlabTokenSecretName")}
                  />
                  <TextField
                    label="Key in the Secret"
                    placeholder={DEFAULT_TOKEN_KEY}
                    {...text("gitlabTokenSecretKey")}
                  />
                </div>
                <TokenSecretCreator
                  namespace={form.namespace}
                  app={form.name}
                  secretKey={form.gitlabTokenSecretKey || DEFAULT_TOKEN_KEY}
                  onCreated={(name) => set("gitlabTokenSecretName", name)}
                />
              </div>
            </div>
          )}

          <Switch
            label="Run migrations before each rollout"
            checked={form.migrations}
            onChange={(event) => set("migrations", event.target.checked)}
            description="A Job with the new image and the same environment, run to completion before the new version replaces the old. If it fails, the old version keeps running."
          />
          {form.migrations && (
            <div className={styles.indented}>
              <div className={styles.fields}>
                <div className={styles.row}>
                  <TextField
                    label="Command"
                    multiline
                    rows={3}
                    required
                    placeholder={"npm\nrun\nmigrate"}
                    hint="Replaces the image's entrypoint. One part per line."
                    {...text("migrationCommand")}
                  />
                  <TextField label="Arguments" multiline rows={3} hint="One per line." {...text("migrationArgs")} />
                </div>
                <TextField
                  label="Time limit, in seconds"
                  inputMode="numeric"
                  placeholder="No limit"
                  {...text("migrationTimeoutSeconds")}
                />
              </div>
            </div>
          )}
        </div>
      ),
    },
    {
      title: "Settings",
      body: (
        <div className={styles.fields}>
          <p className={styles.note}>
            Environment variables, set after the ones Cirrus provides, so one set here wins. For secrets, put them in a
            Secret and reference it with kubectl; those are kept as they are when you save here.
          </p>
          <EnvEditor rows={form.env} error={shownErrors.env} onChange={(env) => set("env", env)} />
          {form.preservedEnv.length > 0 && (
            <div>
              <p className={styles.note}>Read from elsewhere, and kept as they are:</p>
              <ul className={styles.preserved}>
                {form.preservedEnv.map((variable) => (
                  <li key={variable.name}>
                    <code>{variable.name}</code>{" "}
                    {variable.valueFrom?.secretKeyRef
                      ? `from Secret ${variable.valueFrom.secretKeyRef.name}, key ${variable.valueFrom.secretKeyRef.key}`
                      : variable.valueFrom?.configMapKeyRef
                        ? `from ConfigMap ${variable.valueFrom.configMapKeyRef.name}, key ${variable.valueFrom.configMapKeyRef.key}`
                        : "from the pod's own fields"}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      ),
    },
  ];

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
        {saveError && (
          <Alert tone="danger" title="Not saved" role="alert">
            {saveError}
          </Alert>
        )}
        {warnings.length > 0 && (
          <Alert tone="warning" title="It can be saved, but won't fully work yet">
            {warnings.map((warning) => warning.message).join(" ")}
          </Alert>
        )}
        <div className={styles.buttons}>
          <Button type="submit" loading={saving}>
            {editing ? "Save changes" : "Create application"}
          </Button>
          <Button
            variant="ghost"
            href={editing ? `/apps/${encodeURIComponent(form.namespace)}/${encodeURIComponent(form.name)}` : "/apps"}
          >
            Cancel
          </Button>
        </div>
      </div>
    </form>
  );
}

/**
 * A namespace lacking a capability the form needs, and a button that
 * turns it on.
 *
 * @param props
 * @param props.warning
 * @param props.namespace
 * @param props.onEnabled
 * @returns
 */
function CapabilityWarningNotice({
  warning,
  namespace,
  onEnabled,
}: {
  warning: CapabilityWarning;
  namespace: string;
  onEnabled: (capability: Capability) => void;
}) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string>();
  const capability = warning.capability;

  return (
    <Alert
      tone="warning"
      title={`${namespace} doesn't allow ${capability.title.toLowerCase()}`}
      actions={
        <Button
          size="sm"
          variant="secondary"
          loading={pending}
          onClick={() =>
            startTransition(async () => {
              setError(undefined);
              const result = await setNamespaceCapability(namespace, capability.id, true);
              if (result.ok) {
                onEnabled(capability);
              } else {
                setError(result.error);
              }
            })
          }
        >
          Allow it
        </Button>
      }
    >
      {warning.message} Allowing it labels the namespace <code>{`${capability.label}=${capability.value}`}</code>.
      {error && <p className={styles.error}>{error}</p>}
    </Alert>
  );
}

/**
 * Makes the Secret for a GitLab access token, from a token pasted in.
 *
 * @param props
 * @param props.namespace
 * @param props.app
 * @param props.secretKey the key to store the token under
 * @param props.onCreated given the new Secret's name
 * @returns
 */
function TokenSecretCreator({
  namespace,
  app,
  secretKey,
  onCreated,
}: {
  namespace: string;
  app: string;
  secretKey: string;
  onCreated: (name: string) => void;
}) {
  const [name, setName] = useState("");
  const [token, setToken] = useState("");
  const [pending, startTransition] = useTransition();
  const [result, setResult] = useState<{ ok: boolean; message: string }>();
  const secretName = name.trim() || `${app || "app"}-gitlab-token`;

  return (
    <Disclosure title="Create the token Secret here">
      <div className={styles.fields}>
        <p className={styles.note}>
          In GitLab, under the project&apos;s Settings → Access tokens, make a token with the <code>api</code> scope and
          the Maintainer role, and paste it below. It goes straight into a Secret in {namespace || "the namespace"} and
          isn&apos;t kept anywhere else.
        </p>
        <div className={styles.row}>
          <TextField
            label="Secret name"
            placeholder={secretName}
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
          <TextField
            label="Access token"
            type="password"
            autoComplete="off"
            value={token}
            onChange={(event) => setToken(event.target.value)}
          />
        </div>
        <div>
          <Button
            size="sm"
            variant="secondary"
            loading={pending}
            disabled={namespace === "" || token.trim() === ""}
            onClick={() =>
              startTransition(async () => {
                const created = await createTokenSecret(namespace, secretName, secretKey, token, app);
                if (created.ok) {
                  setToken("");
                  onCreated(secretName);
                  setResult({ ok: true, message: `Made ${secretName}, and set it as the token Secret.` });
                } else {
                  setResult({ ok: false, message: created.error });
                }
              })
            }
          >
            Create Secret
          </Button>
        </div>
        {result && (
          <Alert tone={result.ok ? "success" : "danger"} role="status">
            {result.message}
          </Alert>
        )}
      </div>
    </Disclosure>
  );
}

/**
 * A list of single values, one text box each, that rows can be added
 * to and removed from.
 *
 * GUI Mellow has no repeating field, so this is one, built from its
 * TextField and Button.
 *
 * @param props
 * @returns
 */
function ListEditor({
  label,
  values,
  placeholder,
  addLabel,
  error,
  onChange,
}: {
  label: string;
  values: string[];
  placeholder?: string;
  addLabel: string;
  error?: string;
  onChange: (values: string[]) => void;
}) {
  return (
    <fieldset className={styles.list}>
      <legend className={styles.legend}>{label}</legend>
      {values.map((value, index) => (
        <div className={styles.listRow} key={index}>
          <TextField
            label={`${label} ${index + 1}`}
            className={styles.grow}
            placeholder={placeholder}
            value={value}
            onChange={(event) => onChange(values.map((old, at) => (at === index ? event.target.value : old)))}
          />
          <Button
            variant="ghost"
            size="sm"
            aria-label={`Remove ${value || `row ${index + 1}`}`}
            onClick={() => onChange(values.filter((_, at) => at !== index))}
          >
            Remove
          </Button>
        </div>
      ))}
      {error && <p className={styles.error}>{error}</p>}
      <div>
        <Button variant="secondary" size="sm" onClick={() => onChange([...values, ""])}>
          {addLabel}
        </Button>
      </div>
    </fieldset>
  );
}

/**
 * Environment variables, a name and a value to a row.
 *
 * @param props
 * @returns
 */
function EnvEditor({ rows, error, onChange }: { rows: EnvRow[]; error?: string; onChange: (rows: EnvRow[]) => void }) {
  const update = (index: number, change: Partial<EnvRow>) =>
    onChange(rows.map((row, at) => (at === index ? { ...row, ...change } : row)));

  return (
    <fieldset className={styles.list}>
      <legend className={styles.legend}>Environment variables</legend>
      {rows.map((row, index) => (
        <div className={styles.listRow} key={index}>
          <TextField
            label="Name"
            className={styles.grow}
            placeholder="LOG_LEVEL"
            value={row.name}
            onChange={(event) => update(index, { name: event.target.value })}
          />
          <TextField
            label="Value"
            className={styles.grow}
            placeholder="info"
            value={row.value}
            onChange={(event) => update(index, { value: event.target.value })}
          />
          <Button
            variant="ghost"
            size="sm"
            aria-label={`Remove ${row.name || `row ${index + 1}`}`}
            onClick={() => onChange(rows.filter((_, at) => at !== index))}
          >
            Remove
          </Button>
        </div>
      ))}
      {error && <p className={styles.error}>{error}</p>}
      <div>
        <Button variant="secondary" size="sm" onClick={() => onChange([...rows, { name: "", value: "" }])}>
          Add a variable
        </Button>
      </div>
    </fieldset>
  );
}
