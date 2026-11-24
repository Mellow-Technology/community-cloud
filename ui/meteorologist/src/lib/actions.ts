"use server";

/**
 * @file
 * Every change the pages make to the cluster, as server actions.
 *
 * Each one is called from a form or a button in the browser and runs
 * here, as the signed-in person, through the same client the pages
 * read with. They report failure in what they return rather than by
 * throwing, since Next hides a thrown error's message in production
 * and "you don't have permission for that" is worth seeing.
 *
 * Nothing the browser sends is trusted to be well formed: the form is
 * validated again here, and a capability has to be one the registry
 * knows.
 */
import { revalidatePath } from "next/cache";
import { unstable_rethrow } from "next/navigation";

import { CAPABILITIES, capabilityLabelPatch, type CapabilityId } from "./capabilities";
import {
  credentialsData,
  domainConflicts,
  fromDnsForm,
  validateDnsForm,
  withNamespace,
  type DnsProviderForm,
} from "./dns/providers";
import { DNS_NAMESPACE } from "./dns/types";
import { gitLabFor } from "./gitlab/api";
import {
  BUILDS_CONFIG_MAP,
  buildSettingsFrom,
  buildsConfigMap,
  buildProblems,
  normaliseBuild,
  withProjectBuild,
  type Build,
  type BuildSettings,
} from "./gitlab/builds";
import { newKey } from "./gitlab/buildKeys";
import {
  CONNECTION_KEY,
  CONNECTION_LABEL,
  URL_ANNOTATION,
  connectionProblem,
  connectionsIn,
  imageFor,
  normaliseUrl,
  type GitLabProject,
} from "./gitlab/connections";
import { getKube } from "./kube";
import { KubeError, describeError, isForbidden, settle, type KubeClient } from "./kube/client";
import {
  CREATED_BY,
  DEFAULT_SERVICE_ACCOUNT,
  PULL_SECRET_TYPE,
  SETTINGS_NAME,
  defaultPullSecrets,
  dockerConfigJson,
  initialLabels,
  placementPatch,
  pullSecretName,
  toLimitRange,
  toResourceQuota,
  validateNamespaceForm,
  type NamespaceForm,
} from "./namespace/settings";
import { findAdminSecret, readPackageRecords } from "./office";
import { fromBucketForm, validateBucketForm, type BucketForm } from "./storage/form";
import { newKeyNames, secretNameProblem } from "./storage/keys";
import { SEAWEED_REF, type ReclaimPolicy, type S3Identity } from "./storage/types";
import {
  fromUserForm,
  newIdentity,
  validateNewUserForm,
  validateUserForm,
  type NewUserForm,
  type UserForm,
} from "./storage/userForm";
import { confirmsDeletion } from "./webapp/deletion";
import { fromForm, validateForm, type WebApplicationForm } from "./webapp/form";
import { REGISTRY_ANNOTATION, normaliseRegistry } from "./webapp/registry";

/**
 * What an action did: done, with anything worth handing back, or not,
 * with why.
 */
export type ActionResult<T = undefined> = { ok: true; value: T } | { ok: false; error: string };

/**
 * Runs an action's work, turning a failure into a result.
 *
 * @param work
 * @returns
 */
async function run<T>(work: () => Promise<T>): Promise<ActionResult<T>> {
  try {
    return { ok: true, value: await work() };
  } catch (error) {
    // redirect() works by throwing, and has to be let through
    unstable_rethrow(error);
    return { ok: false, error: describeError(error) };
  }
}

/**
 * Turns a capability on or off for a namespace.
 *
 * @param namespace
 * @param capabilityId
 * @param enabled
 * @returns
 */
export async function setNamespaceCapability(
  namespace: string,
  capabilityId: CapabilityId,
  enabled: boolean,
): Promise<ActionResult> {
  const capability = CAPABILITIES.find((candidate) => candidate.id === capabilityId);
  if (capability === undefined) {
    return { ok: false, error: `There's no capability called ${capabilityId}.` };
  }
  const result = await run(async () => {
    await (await getKube()).patchNamespaceLabels(namespace, capabilityLabelPatch(capability, enabled));
    return undefined;
  });
  revalidatePath("/", "layout");
  return result;
}

/**
 * Creates or updates a WebApplication from the form.
 *
 * An update starts from the resource as it is now, at the version the
 * form was opened with, so fields the form doesn't show are kept and a
 * change someone else made in the meantime is refused rather than
 * overwritten.
 *
 * @param form
 * @param resourceVersion the version the form was opened with, when
 *   editing
 * @returns where the application can be seen
 */
export async function saveWebApplication(
  form: WebApplicationForm,
  resourceVersion?: string,
): Promise<ActionResult<{ namespace: string; name: string }>> {
  const errors = validateForm(form);
  const first = Object.values(errors)[0];
  if (first !== undefined) {
    return { ok: false, error: first };
  }

  const result = await run(async () => {
    const kube = await getKube();
    if (resourceVersion === undefined) {
      const created = await kube.createWebApplication(fromForm(form));
      return { namespace: created.metadata.namespace ?? form.namespace, name: created.metadata.name };
    }
    const current = await kube.getWebApplication(form.namespace, form.name);
    current.metadata.resourceVersion = resourceVersion;
    const saved = await kube.replaceWebApplication(fromForm(form, current));
    return { namespace: saved.metadata.namespace ?? form.namespace, name: saved.metadata.name };
  });
  revalidatePath("/", "layout");
  return result;
}

/**
 * Deletes a WebApplication, once its name has been typed to confirm.
 *
 * The name is checked here too, so nothing but the confirm dialog can
 * delete through this. Only the WebApplication is deleted; Cirrus and
 * Kubernetes take what it made with it (see lib/webapp/deletion.ts).
 *
 * @param namespace
 * @param name
 * @param typed what was typed to confirm
 * @returns
 */
export async function deleteWebApplication(namespace: string, name: string, typed: string): Promise<ActionResult> {
  if (!confirmsDeletion(typed, name)) {
    return { ok: false, error: `Type ${name} to delete it.` };
  }
  const result = await run(async () => {
    await (await getKube()).deleteWebApplication(namespace, name);
    return undefined;
  });
  revalidatePath("/", "layout");
  return result;
}

/**
 * Makes a Bucket from the form, or saves one being edited, starting
 * from the resource as it is at the version the form was opened with,
 * so what the form doesn't show is kept and a change someone else made
 * in the meantime is refused rather than overwritten.
 *
 * @param form
 * @param resourceVersion the version the form was opened with, when
 *   editing
 * @returns where the bucket can be seen
 */
export async function saveBucket(
  form: BucketForm,
  resourceVersion?: string,
): Promise<ActionResult<{ namespace: string; name: string }>> {
  const result = await run(async () => {
    const kube = await getKube();
    const current =
      resourceVersion === undefined ? undefined : await kube.getBucket(form.namespace.trim(), form.name.trim());
    const first = Object.values(validateBucketForm(form, current))[0];
    if (first !== undefined) {
      throw new Error(first);
    }
    if (current === undefined) {
      const created = await kube.createBucket(fromBucketForm(form));
      return { namespace: created.metadata.namespace ?? form.namespace, name: created.metadata.name };
    }
    current.metadata.resourceVersion = resourceVersion;
    const saved = await kube.replaceBucket(fromBucketForm(form, current));
    return { namespace: saved.metadata.namespace ?? form.namespace, name: saved.metadata.name };
  });
  revalidatePath("/", "layout");
  return result;
}

/**
 * Saves an S3Identity, SeaweedFS's S3 user, from the form, starting
 * from the resource as it is at the version the form was opened with.
 *
 * @param form
 * @param resourceVersion the version the form was opened with
 * @returns
 */
export async function saveS3Identity(form: UserForm, resourceVersion: string): Promise<ActionResult> {
  const first = Object.values(validateUserForm(form))[0];
  if (first !== undefined) {
    return { ok: false, error: first };
  }
  const result = await run(async () => {
    const kube = await getKube();
    const current = await kube.getS3Identity(form.namespace, form.name);
    current.metadata.resourceVersion = resourceVersion;
    await kube.replaceS3Identity(fromUserForm(form, current));
    return undefined;
  });
  revalidatePath("/", "layout");
  return result;
}

/**
 * Asks SeaweedFS's operator for a key pair for a user, into the Secret
 * named or one named for the user, keeping clear of names in use.
 *
 * @param kube
 * @param namespace
 * @param identity the S3Identity's resource name
 * @param secretName blank for the one suggested
 * @param reclaimPolicy
 * @param seaweedRef the SeaweedFS the user is in
 * @returns the S3Credentials' name
 */
async function makeKey(
  kube: KubeClient,
  namespace: string,
  identity: string,
  secretName: string,
  reclaimPolicy: ReclaimPolicy,
  seaweedRef: S3Identity["spec"]["seaweedRef"],
): Promise<string> {
  const [existing, secrets] = await Promise.all([
    kube.listS3Credentials(namespace),
    // Only to keep clear of names in use; someone who can't list
    // Secrets just gets the suggestion, and the API server's refusal if
    // it's taken
    settle(() => kube.listSecrets(namespace)),
  ]);
  const taken = secrets.ok ? secrets.value.map((secret) => secret.name) : [];
  const problem = secretNameProblem(secretName, taken);
  if (problem !== undefined) {
    throw new Error(problem);
  }
  const names = newKeyNames(identity, existing, taken);
  const created = await kube.createS3Credentials({
    namespace,
    name: names.name,
    identity,
    secretName: secretName.trim() || names.secretName,
    reclaimPolicy,
    seaweedRef,
    labels: CREATED_BY,
  });
  return created.name;
}

/**
 * Asks SeaweedFS's operator for a new key pair for a user, written into
 * a Secret in the user's namespace: the one named, or one named for the
 * user.
 *
 * @param namespace
 * @param identity the S3Identity's resource name
 * @param secretName blank for the one suggested
 * @param reclaimPolicy whether deleting it takes the key out of SeaweedFS
 * @returns the S3Credentials' name
 */
export async function createAccessKey(
  namespace: string,
  identity: string,
  secretName: string,
  reclaimPolicy: ReclaimPolicy,
): Promise<ActionResult<{ name: string }>> {
  if (reclaimPolicy !== "Delete" && reclaimPolicy !== "Retain") {
    return { ok: false, error: "Delete the key with it, or keep it." };
  }
  const result = await run(async () => {
    const kube = await getKube();
    const user = await kube.getS3Identity(namespace, identity);
    return { name: await makeKey(kube, namespace, identity, secretName, reclaimPolicy, user.spec.seaweedRef) };
  });
  revalidatePath("/", "layout");
  return result;
}

/**
 * Makes an S3Identity, SeaweedFS's S3 user, from the form, and its
 * first key with it when asked. A key that can't be made doesn't undo
 * the user: it's said, and one can be made from the user's page.
 *
 * @param form
 * @returns where the user can be seen, and why its key wasn't made if
 *   it wasn't
 */
export async function createS3User(
  form: NewUserForm,
): Promise<ActionResult<{ namespace: string; name: string; keyError?: string }>> {
  const first = Object.values(validateNewUserForm(form))[0];
  if (first !== undefined) {
    return { ok: false, error: first };
  }
  const result = await run(async () => {
    const kube = await getKube();
    const created = await kube.createS3Identity(newIdentity(form, SEAWEED_REF, CREATED_BY));
    const namespace = created.metadata.namespace ?? form.namespace.trim();
    const name = created.metadata.name;
    if (!form.createKey) {
      return { namespace, name };
    }
    try {
      await makeKey(kube, namespace, name, form.secretName, form.keyReclaimPolicy, created.spec.seaweedRef);
      return { namespace, name };
    } catch (error) {
      unstable_rethrow(error);
      return { namespace, name, keyError: describeError(error) };
    }
  });
  revalidatePath("/", "layout");
  return result;
}

/**
 * Deletes a key, once its S3Credentials' name has been typed to
 * confirm. Whether the key stops working is its reclaim policy's to
 * say (see lib/storage/keys.ts).
 *
 * @param namespace
 * @param name the S3Credentials'
 * @param typed what was typed to confirm
 * @returns
 */
export async function deleteAccessKey(namespace: string, name: string, typed: string): Promise<ActionResult> {
  if (!confirmsDeletion(typed, name)) {
    return { ok: false, error: `Type ${name} to delete it.` };
  }
  const result = await run(async () => {
    await (await getKube()).deleteS3Credentials(namespace, name);
    return undefined;
  });
  revalidatePath("/", "layout");
  return result;
}

/**
 * A key's secret half, read from its Secret as the person asking, so
 * only someone who may read Secrets there sees it.
 *
 * @param namespace
 * @param name the S3Credentials'
 * @returns
 */
export async function revealSecretKey(namespace: string, name: string): Promise<ActionResult<string>> {
  try {
    const kube = await getKube();
    const credentials = (await kube.listS3Credentials(namespace)).find((each) => each.name === name);
    if (credentials?.secretName === undefined) {
      return { ok: false, error: "SeaweedFS's operator hasn't said where this key is yet." };
    }
    const field = credentials.secretKeyField ?? "secretKey";
    const value = await kube.readSecretValue(credentials.secretNamespace ?? namespace, credentials.secretName, field);
    if (value === undefined) {
      return { ok: false, error: `There's no "${field}" in the Secret ${credentials.secretName} yet.` };
    }
    return { ok: true, value };
  } catch (error) {
    unstable_rethrow(error);
    if (isForbidden(error)) {
      return { ok: false, error: "Only people who can read Secrets in this namespace can see a secret key." };
    }
    return { ok: false, error: describeError(error) };
  }
}

/**
 * Deletes a Bucket, once its name has been typed to confirm. Its
 * contents go too only when its reclaim policy is Delete.
 *
 * @param namespace
 * @param name
 * @param typed what was typed to confirm
 * @returns
 */
export async function deleteBucket(namespace: string, name: string, typed: string): Promise<ActionResult> {
  if (!confirmsDeletion(typed, name)) {
    return { ok: false, error: `Type ${name} to delete it.` };
  }
  const result = await run(async () => {
    await (await getKube()).deleteBucket(namespace, name);
    return undefined;
  });
  revalidatePath("/", "layout");
  return result;
}

/**
 * A namespace's GitLab connection, with its token, for a call made
 * here and then.
 *
 * @param kube
 * @param namespace
 * @param name
 * @returns
 */
async function connectionWithToken(
  kube: KubeClient,
  namespace: string,
  name: string,
): Promise<{ url: string; token: string }> {
  const connection = connectionsIn(await kube.listSecrets(namespace)).find((each) => each.name === name);
  if (connection === undefined) {
    throw new Error(`${name} isn't a GitLab connection in ${namespace}.`);
  }
  const token = await kube.readSecretValue(namespace, name, CONNECTION_KEY);
  if (token === undefined || token.trim() === "") {
    throw new Error(`${name} has no token in it. Remove it and add it again.`);
  }
  return { url: connection.url, token: token.trim() };
}

/**
 * Adds a GitLab connection to a namespace: a Secret with the token,
 * marked as a connection, once GitLab has said the token works.
 *
 * The token goes straight from the form to GitLab and the API server;
 * nothing here keeps or logs it.
 *
 * @param namespace
 * @param name
 * @param url the GitLab instance
 * @param token
 * @returns how many projects the token can see
 */
export async function createGitLabConnection(
  namespace: string,
  name: string,
  url: string,
  token: string,
): Promise<ActionResult<{ projects: number }>> {
  const problem = connectionProblem(name, url, token);
  if (problem !== undefined) {
    return { ok: false, error: problem };
  }
  const instance = normaliseUrl(url);
  const result = await run(async () => {
    const projects = await gitLabFor(instance, token.trim()).listProjects();
    await (
      await getKube()
    ).createSecret(
      namespace,
      name.trim(),
      { [CONNECTION_KEY]: token.trim() },
      { ...CREATED_BY, [CONNECTION_LABEL]: "true" },
      "Opaque",
      { [URL_ANNOTATION]: instance },
    );
    return { projects: projects.length };
  });
  revalidatePath("/", "layout");
  return result;
}

/**
 * Removes a GitLab connection, unless an application still updates
 * through it.
 *
 * @param namespace
 * @param name
 * @returns
 */
export async function deleteGitLabConnection(namespace: string, name: string): Promise<ActionResult> {
  const result = await run(async () => {
    const kube = await getKube();
    if (!connectionsIn(await kube.listSecrets(namespace)).some((each) => each.name === name)) {
      throw new Error(`${name} isn't a GitLab connection in ${namespace}.`);
    }
    const users = (await kube.listWebApplications(namespace))
      .filter((app) => app.spec.source?.gitlab?.tokenSecret.name === name)
      .map((app) => app.metadata.name);
    if (users.length > 0) {
      throw new Error(`${users.join(", ")} still update through ${name}. Switch them to another connection first.`);
    }
    await kube.deleteSecret(namespace, name);
    return undefined;
  });
  revalidatePath("/", "layout");
  return result;
}

/**
 * The projects a connection's token can see.
 *
 * @param namespace
 * @param connection
 * @param search
 * @returns
 */
export async function findGitLabProjects(
  namespace: string,
  connection: string,
  search: string,
): Promise<ActionResult<GitLabProject[]>> {
  return run(async () => {
    const { url, token } = await connectionWithToken(await getKube(), namespace, connection);
    return gitLabFor(url, token).listProjects(search);
  });
}

/**
 * A project's images, and which of them to run.
 *
 * @param namespace
 * @param connection
 * @param project
 * @returns
 */
export async function findGitLabImages(
  namespace: string,
  connection: string,
  project: GitLabProject,
): Promise<ActionResult<{ images: string[]; suggested?: string }>> {
  return run(async () => {
    const { url, token } = await connectionWithToken(await getKube(), namespace, connection);
    const gitlab = gitLabFor(url, token);
    const repositories = await gitlab.listRepositories(project.id);
    // Before its first image, where one will go is the only suggestion,
    // and listings don't carry it
    const registryPrefix =
      project.registryPrefix ?? (repositories.length !== 1 ? await gitlab.registryPrefix(project.id) : undefined);
    const suggested = imageFor({ ...project, registryPrefix }, repositories);
    // Before the first image there are no repositories, only where one will go
    const images = repositories.length > 0 ? repositories : suggested ? [suggested] : [];
    return { images, suggested };
  });
}

/**
 * Changes a namespace's GitLab build settings, making them, with a new
 * key, when there are none yet. Tried again once if they changed in
 * between reading and writing.
 *
 * @param namespace
 * @param change
 */
async function changeBuildSettings(
  namespace: string,
  change: (settings: BuildSettings) => BuildSettings,
): Promise<void> {
  const kube = await getKube();
  for (let attempt = 1; ; attempt += 1) {
    const existing = await kube.getConfigMap(namespace, BUILDS_CONFIG_MAP);
    const settings = buildSettingsFrom(existing) ?? { key: newKey(), build: {}, projects: {} };
    try {
      await kube.saveConfigMap(buildsConfigMap(namespace, change(settings), CREATED_BY, existing));
      return;
    } catch (error) {
      if (attempt >= 2 || !(error instanceof KubeError && error.status === 409)) {
        throw error;
      }
    }
  }
}

/**
 * A build as the browser sent it, checked: what's wrong with it, or the
 * build as it's kept.
 *
 * @param build
 * @returns
 */
function checkedBuild(build: Build): { ok: true; build: Build } | { ok: false; error: string } {
  const problem = Object.values(buildProblems(build))[0];
  return problem === undefined ? { ok: true, build: normaliseBuild(build) } : { ok: false, error: problem };
}

/**
 * Sets where a namespace's projects keep their Dockerfile, bake file
 * and bake target unless they say otherwise. Blanks are the defaults.
 *
 * @param namespace
 * @param build
 * @returns
 */
export async function saveGitLabBuildDefault(namespace: string, build: Build): Promise<ActionResult> {
  const checked = checkedBuild(build);
  if (!checked.ok) {
    return checked;
  }
  const result = await run(async () => {
    await changeBuildSettings(namespace, (settings) => ({ ...settings, build: checked.build }));
    return undefined;
  });
  revalidatePath("/", "layout");
  return result;
}

/**
 * Gives a namespace's build URLs a new key. Every project including
 * the old one fails to start a pipeline until its include is changed.
 *
 * @param namespace
 * @returns
 */
export async function changeGitLabBuildKey(namespace: string): Promise<ActionResult> {
  const result = await run(async () => {
    await changeBuildSettings(namespace, (settings) => ({ ...settings, key: newKey() }));
    return undefined;
  });
  revalidatePath("/", "layout");
  return result;
}

/**
 * Sets where one project keeps its Dockerfile, bake file and bake
 * target. Blanks, and anything the same as the namespace's, are the
 * namespace's.
 *
 * @param namespace
 * @param project its path, as group/name
 * @param build
 * @returns
 */
export async function saveProjectBuild(namespace: string, project: string, build: Build): Promise<ActionResult> {
  const checked = checkedBuild(build);
  if (!checked.ok) {
    return checked;
  }
  if (project.trim() === "") {
    return { ok: false, error: "Choose the application's GitLab project first." };
  }
  const result = await run(async () => {
    await changeBuildSettings(namespace, (settings) => withProjectBuild(settings, project.trim(), checked.build));
    return undefined;
  });
  revalidatePath("/", "layout");
  return result;
}

/**
 * Gives a namespace a DNS provider of its own: its credentials, in a
 * Secret beside where Cirrus runs ExternalDNS, then the DnsProvider
 * that publishes the namespace with them.
 *
 * @param namespace
 * @param form
 * @returns
 */
export async function createDnsProvider(namespace: string, form: DnsProviderForm): Promise<ActionResult> {
  const result = await run(async () => {
    const kube = await getKube();
    const existing = await kube.listDnsProviders();
    const first = Object.values(validateDnsForm(form, existing, namespace))[0];
    if (first !== undefined) {
      throw new Error(first);
    }
    const provider = fromDnsForm(form, namespace);
    // Credentials go straight from the form to the API server; nothing
    // here keeps or logs them
    await kube.applySecret(DNS_NAMESPACE, provider.spec.credentialsSecret ?? "", credentialsData(form), {
      ...CREATED_BY,
      "cirrus.community-cloud.technology/dns-provider": provider.metadata.name,
    });
    await kube.applyDnsProvider(provider);
    return undefined;
  });
  revalidatePath("/", "layout");
  return result;
}

/**
 * Has an existing DNS provider publish a namespace's routes, or stop.
 *
 * @param namespace
 * @param provider the DnsProvider's name
 * @param publish
 * @returns
 */
export async function setDnsPublishing(namespace: string, provider: string, publish: boolean): Promise<ActionResult> {
  const result = await run(async () => {
    const kube = await getKube();
    const providers = await kube.listDnsProviders();
    const current = providers.find((each) => each.metadata.name === provider);
    if (current === undefined) {
      throw new Error(`There's no DNS provider called ${provider}.`);
    }
    const changed = withNamespace(current, namespace, publish);
    const conflict = domainConflicts(
      providers.map((each) => (each === current ? changed : each)),
      provider,
    )[0];
    if (publish && conflict !== undefined) {
      throw new Error(conflict);
    }
    await kube.applyDnsProvider({
      apiVersion: changed.apiVersion,
      kind: changed.kind,
      metadata: { name: changed.metadata.name },
      spec: changed.spec,
    });
    return undefined;
  });
  revalidatePath("/", "layout");
  return result;
}

/**
 * Puts a namespace's quota, container defaults and pull Secrets in
 * place. Each is made, replaced or removed to match the form, so
 * clearing a section removes what it made.
 *
 * The defaults go in before the quota: a quota with nothing to state
 * requests for pods that don't would refuse them in the moment
 * between.
 *
 * @param kube
 * @param form
 */
async function applyNamespaceSettings(kube: KubeClient, form: NamespaceForm): Promise<void> {
  const namespace = form.name.trim();

  const limitRange = toLimitRange(form);
  if (limitRange !== undefined) {
    await kube.applyLimitRange(limitRange);
  }
  const quota = toResourceQuota(form);
  if (quota !== undefined) {
    await kube.applyResourceQuota(quota);
  } else {
    await kube.deleteResourceQuota(namespace, SETTINGS_NAME);
  }
  if (limitRange === undefined) {
    await kube.deleteLimitRange(namespace, SETTINGS_NAME);
  }

  // Credentials go straight from the form to the API server; nothing
  // here keeps or logs them
  for (const registry of form.registries) {
    await kube.createSecret(
      namespace,
      pullSecretName(registry.server),
      { ".dockerconfigjson": dockerConfigJson(registry) },
      CREATED_BY,
      PULL_SECRET_TYPE,
      // So the application form can tell which images it's for
      { [REGISTRY_ANNOTATION]: normaliseRegistry(registry.server) },
    );
  }
  await kube.setImagePullSecrets(namespace, DEFAULT_SERVICE_ACCOUNT, defaultPullSecrets(form));
}

/**
 * Makes a namespace, with its capabilities, region and settings.
 *
 * The namespace comes first and the rest after, so a failure part way
 * leaves a namespace that exists; that's said, so the rest can be
 * finished from its page rather than tried again from scratch.
 *
 * @param form
 * @returns the new namespace's name
 */
export async function createNamespace(form: NamespaceForm): Promise<ActionResult<{ name: string }>> {
  const first = Object.values(validateNamespaceForm(form, true))[0];
  if (first !== undefined) {
    return { ok: false, error: first };
  }
  const name = form.name.trim();
  const kube = await getKube();

  const created = await run(() =>
    kube.createNamespace(
      name,
      {
        ...initialLabels(form),
        // A new namespace has nothing to take off, so nothing's null
        ...(placementPatch(form, undefined).labels as Record<string, string>),
      },
      {},
    ),
  );
  if (!created.ok) {
    return created;
  }
  const settled = await run(() => applyNamespaceSettings(kube, form));
  revalidatePath("/", "layout");
  return settled.ok
    ? { ok: true, value: { name } }
    : {
        ok: false,
        error: `${name} was made, but its settings weren't all saved: ${settled.error} Finish them on its page.`,
      };
}

/**
 * Saves an existing namespace's region and settings.
 *
 * @param form
 * @returns
 */
export async function saveNamespaceSettings(form: NamespaceForm): Promise<ActionResult> {
  const first = Object.values(validateNamespaceForm(form, false))[0];
  if (first !== undefined) {
    return { ok: false, error: first };
  }
  const result = await run(async () => {
    const kube = await getKube();
    const namespace = await kube.getNamespace(form.name.trim());
    const placement = placementPatch(form, namespace.metadata);
    if (Object.keys(placement.labels).length > 0) {
      await kube.patchNamespaceLabels(namespace.metadata.name, placement.labels);
    }
    if (Object.keys(placement.annotations).length > 0) {
      await kube.patchNamespaceAnnotations(namespace.metadata.name, placement.annotations);
    }
    await applyNamespaceSettings(kube, form);
    return undefined;
  });
  revalidatePath("/", "layout");
  return result;
}

/**
 * An office application's administrator password, or console token,
 * for someone allowed to read it.
 *
 * Only ever the Secret the package's record names, so the browser
 * can't ask for any other. Read as the person asking: whether they
 * see it is their RBAC's to decide, which for a Secret in cc-office
 * means cluster admins. Read-only, and not logged.
 *
 * @param packageName
 * @returns
 */
export async function revealAdminCredential(packageName: string): Promise<ActionResult<string>> {
  if (typeof packageName !== "string" || !/^[a-z0-9-]+$/.test(packageName)) {
    return { ok: false, error: "That isn't a package name." };
  }

  try {
    const kube = await getKube();
    const secret = findAdminSecret(await readPackageRecords(kube), packageName);
    if (secret === undefined) {
      return { ok: false, error: `${packageName} has no administrator's password on record.` };
    }

    const value = await kube.readSecretValue(secret.namespace, secret.name, secret.key);
    if (value === undefined) {
      return {
        ok: false,
        error: `There's no "${secret.key}" in the Secret ${secret.name} in ${secret.namespace}. Re-running ${packageName}'s install makes it.`,
      };
    }
    return { ok: true, value };
  } catch (error) {
    unstable_rethrow(error);
    if (isForbidden(error)) {
      return {
        ok: false,
        error: "Only people who can read Secrets in this application's namespace, cluster admins, can see this.",
      };
    }
    return { ok: false, error: describeError(error) };
  }
}
