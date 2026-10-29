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
import { describeError, type KubeClient } from "./kube/client";
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
import { fromForm, validateForm, type WebApplicationForm } from "./webapp/form";

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
    const repositories = await gitLabFor(url, token).listRepositories(project.id);
    const suggested = imageFor(project, repositories);
    const images = [...new Set([...repositories, ...(suggested ? [suggested] : [])])];
    return { images, suggested };
  });
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
    kube.createNamespace(name, initialLabels(form), placementPatch(form, undefined) as Record<string, string>),
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
    const placement = placementPatch(form, namespace.metadata.annotations);
    if (Object.keys(placement).length > 0) {
      await kube.patchNamespaceAnnotations(namespace.metadata.name, placement);
    }
    await applyNamespaceSettings(kube, form);
    return undefined;
  });
  revalidatePath("/", "layout");
  return result;
}
