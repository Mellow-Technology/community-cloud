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
 * says so beside the choice and offers to allow it there and then.
 *
 * An image from GitLab is chosen, not typed: through one of the
 * namespace's GitLab connections (made on the namespace's GitLab page,
 * apart from any one application), from the projects its token can
 * see. That also tells Cirrus everything it needs to roll out new
 * images as pipelines build them.
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
import { SegmentedControl } from "gui-mellow/SegmentedControl";
import { Steps } from "gui-mellow/Steps";
import { Switch } from "gui-mellow/Switch";

import { saveWebApplication, setNamespaceCapability } from "@/lib/actions";
import { enabledCapabilities, type Capability } from "@/lib/capabilities";
import { publisherOf } from "@/lib/dns/providers";
import type { DnsProvider } from "@/lib/dns/types";
import { CONNECTION_KEY, type GitLabConnection } from "@/lib/gitlab/connections";
import {
  soleConnection,
  splitList,
  validateForm,
  type EnvRow,
  type ImageSource,
  type WebApplicationForm as FormModel,
} from "@/lib/webapp/form";
import { pullSecretsFor, registryOf, type PullSecret } from "@/lib/webapp/registry";
import { DEFAULT_GITLAB_REF, DEFAULT_IMAGE_TAG } from "@/lib/webapp/types";
import { GitLabImagePicker } from "./GitLabImagePicker";
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
  gitlabConnections?: GitLabConnection[];
  // Its registry credentials, and which registries each is for
  pullSecrets?: PullSecret[];
  // The DNS providers publishing its routes
  dnsProviders?: DnsProvider[];
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
  // An application that already names its credentials keeps them
  const [pullAuto, setPullAuto] = useState(initial.imagePullSecrets.trim() === "");
  const [namespaces, setNamespaces] = useState(initialNamespaces);
  const [attempted, setAttempted] = useState(false);
  const [saveError, setSaveError] = useState<string>();
  const [saving, startSaving] = useTransition();

  const errors = useMemo(() => validateForm(form), [form]);
  const shownErrors = attempted ? errors : {};
  const namespace = namespaces.find((choice) => choice.name === form.namespace);
  const warnings = capabilityWarnings(form, namespace?.labels);
  const postgres = namespace && postgresNote(namespace);
  const connections = namespace?.gitlabConnections ?? [];
  // An application's connection that's an unmarked Secret, from
  // before connections, is still offered
  const connectionChoices =
    form.gitlabTokenSecretName !== "" && !connections.some((each) => each.name === form.gitlabTokenSecretName)
      ? [...connections, { name: form.gitlabTokenSecretName, url: form.gitlabUrl }]
      : connections;
  const fromGitLab = form.imageSource === "gitlab";

  // Registry credentials follow the image, until someone chooses them:
  // the namespace's Secrets for the image's registry. Worked out here
  // rather than kept in step, so whatever changes the image changes them.
  const imageRegistry = registryOf(form.repository);
  const pullSelected = pullAuto
    ? pullSecretsFor(form.repository, namespace?.pullSecrets ?? [])
    : splitList(form.imagePullSecrets);
  const effective =
    pullAuto && namespace?.pullSecrets !== undefined ? { ...form, imagePullSecrets: pullSelected.join(", ") } : form;
  // Every Secret the namespace has, and any named that it doesn't
  const pullChoices = [
    ...(namespace?.pullSecrets ?? []),
    ...pullSelected
      .filter((name) => !(namespace?.pullSecrets ?? []).some((secret) => secret.name === name))
      .map((name) => ({ name, registries: [] })),
  ];

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
      const result = await saveWebApplication(effective, resourceVersion);
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
            onChange={(event) => {
              const chosen = namespaces.find((choice) => choice.name === event.target.value);
              setForm((current) => ({ ...current, namespace: event.target.value, ...soleConnection(chosen) }));
            }}
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
          <SegmentedControl<ImageSource>
            label="Where the image comes from"
            value={form.imageSource}
            onChange={(value) => set("imageSource", value)}
            options={[
              { value: "gitlab", label: "A GitLab project" },
              { value: "other", label: "Any registry" },
            ]}
          />
          {fromGitLab &&
            (form.namespace === "" ? (
              <p className={styles.note}>Choose a namespace first: its GitLab connections are what reach GitLab.</p>
            ) : connectionChoices.length === 0 ? (
              <Alert
                tone="primary"
                title={`${form.namespace} has no GitLab connections yet`}
                actions={
                  <Button
                    size="sm"
                    variant="secondary"
                    href={`/namespaces/${encodeURIComponent(form.namespace)}?tab=integration`}
                  >
                    Add one
                  </Button>
                }
              >
                A connection is a GitLab token kept in the namespace, shared by its applications. With one, the project
                and its image are chosen from a list, and new images can be rolled out as they&apos;re built.
              </Alert>
            ) : (
              <GitLabImagePicker
                key={`${form.namespace}/${form.gitlabTokenSecretName}`}
                namespace={form.namespace}
                connections={connectionChoices}
                connection={form.gitlabTokenSecretName}
                project={form.gitlabProject}
                image={form.repository}
                error={shownErrors.gitlabTokenSecretName ?? shownErrors.gitlabProject}
                onConnection={(connection) =>
                  setForm((current) => ({
                    ...current,
                    gitlabTokenSecretName: connection.name,
                    gitlabTokenSecretKey: CONNECTION_KEY,
                    gitlabUrl: connection.url,
                    gitlabProject: "",
                  }))
                }
                onChoose={({ connection, url, project, image }) =>
                  setForm((current) => ({
                    ...current,
                    gitlabTokenSecretName: connection,
                    gitlabUrl: url,
                    gitlabProject: project.path,
                    gitlabRef:
                      current.gitlabRef === DEFAULT_GITLAB_REF && project.defaultBranch
                        ? project.defaultBranch
                        : current.gitlabRef,
                    repository: image ?? current.repository,
                    // A first choice of project is one to keep up to date
                    gitlab: current.gitlabProject === "" && !editing ? true : current.gitlab,
                  }))
                }
                onImage={(image) => set("repository", image)}
              />
            ))}
          <TextField
            label="Image"
            required
            placeholder="registry.gitlab.com/group/app"
            hint={
              fromGitLab
                ? "Filled in from the project's container registry. Without the tag."
                : "Without the tag, such as ghcr.io/owner/app."
            }
            {...text("repository")}
          />
          <TextField
            label="Tag"
            required
            placeholder="latest"
            hint={form.gitlab && fromGitLab ? "What runs until the first pipeline Cirrus hears about." : undefined}
            {...text("tag")}
          />
          {namespace?.pullSecrets === undefined ? (
            <TextField
              label="Pull secrets"
              placeholder="registry-credentials"
              hint="Usually empty: the namespace's own registry credentials are used. Name Secrets here, separated by commas, only to use these instead."
              {...text("imagePullSecrets")}
            />
          ) : (
            <fieldset className={styles.list}>
              <legend className={styles.legend}>Registry credentials</legend>
              {pullChoices.length === 0 ? (
                <p className={styles.note}>
                  {form.namespace} has no registry credentials. A public image needs none; for a private one, add them
                  under{" "}
                  <a href={`/namespaces/${encodeURIComponent(form.namespace)}`}>
                    the namespace&apos;s private registries
                  </a>
                  .
                </p>
              ) : (
                pullChoices.map((secret) => (
                  <Switch
                    key={secret.name}
                    label={secret.name}
                    checked={pullSelected.includes(secret.name)}
                    description={
                      secret.registries.length > 0
                        ? `For ${secret.registries.join(", ")}`
                        : "For a registry it doesn't name"
                    }
                    onChange={(event) => {
                      setPullAuto(false);
                      set(
                        "imagePullSecrets",
                        (event.target.checked
                          ? [...pullSelected, secret.name]
                          : pullSelected.filter((name) => name !== secret.name)
                        ).join(", "),
                      );
                    }}
                  />
                ))
              )}
              {pullChoices.length > 0 && (
                <p className={styles.note}>
                  {pullAuto
                    ? imageRegistry === undefined
                      ? "Chosen for you once there's an image: the credentials for its registry."
                      : pullSelected.length > 0
                        ? `Chosen for you: the credentials for ${imageRegistry}.`
                        : `None of these are for ${imageRegistry}, so none are named; a public image needs none.`
                    : "Chosen by hand."}{" "}
                  {!pullAuto && (
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => {
                        setPullAuto(true);
                        set("imagePullSecrets", "");
                      }}
                    >
                      Choose for me
                    </Button>
                  )}
                </p>
              )}
            </fieldset>
          )}
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
            Each hostname is served over HTTPS through the cluster Gateway, with a certificate from Let&apos;s Encrypt.{" "}
            {(namespace?.dnsProviders ?? []).length > 0
              ? `Names in ${namespace?.dnsProviders?.flatMap((provider) => provider.spec.domains).join(", ")} are put in DNS for you; point any other name at the cluster yourself.`
              : "Point its DNS at the cluster first."}{" "}
            Leave this empty for an application only other workloads talk to.
          </p>
          <ListEditor
            label="Hostnames"
            values={form.hostnames}
            placeholder="app.example.org"
            addLabel="Add a hostname"
            error={shownErrors.hostnames}
            onChange={(hostnames) => set("hostnames", hostnames)}
          />
          {namespace?.dnsProviders !== undefined &&
            form.hostnames.some((hostname) => hostname.trim() !== "") &&
            namespace.dnsProviders.length > 0 && (
              <ul className={styles.preserved}>
                {form.hostnames
                  .map((hostname) => hostname.trim().toLowerCase())
                  .filter((hostname) => hostname !== "")
                  .map((hostname) => {
                    const publisher = publisherOf(namespace.dnsProviders ?? [], hostname);
                    return (
                      <li key={hostname}>
                        <code>{hostname}</code>{" "}
                        {publisher
                          ? `is published by ${publisher.metadata.name} (${publisher.spec.provider}).`
                          : "isn't in any domain published for this namespace; point it at the cluster by hand."}
                      </li>
                    );
                  })}
              </ul>
            )}
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
            label="Update automatically on image builds"
            checked={form.gitlab && fromGitLab}
            disabled={!fromGitLab}
            onChange={(event) => set("gitlab", event.target.checked)}
            description={
              fromGitLab ? (
                <>
                  When a pipeline on the branch below succeeds, Cirrus rolls out the image it built
                  {form.gitlabProject ? (
                    <>
                      {" "}
                      for <code>{form.gitlabProject}</code>
                    </>
                  ) : null}
                  . It registers a webhook on the project to hear about them, and checks every few minutes in case one
                  is missed.
                </>
              ) : (
                "Only for an image from a GitLab project, chosen under What it runs. Otherwise, change the tag here to roll out a new one."
              )
            }
          />
          {form.gitlab && fromGitLab && (
            <div className={styles.indented}>
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
