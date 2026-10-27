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
 * Makes the Secret holding a GitLab access token, for an
 * application's source.
 *
 * The token goes straight from the form to the API server; nothing
 * here keeps or logs it.
 *
 * @param namespace
 * @param name
 * @param key
 * @param token
 * @param app the application it's for, recorded on the Secret
 * @returns
 */
export async function createTokenSecret(
  namespace: string,
  name: string,
  key: string,
  token: string,
  app: string,
): Promise<ActionResult> {
  if (token.trim() === "") {
    return { ok: false, error: "Paste the access token first." };
  }
  if (!/^[-._a-zA-Z0-9]+$/.test(key)) {
    return { ok: false, error: "A Secret's key is letters, digits, '-', '_' and '.'." };
  }
  return run(async () => {
    await (
      await getKube()
    ).createSecret(
      namespace,
      name,
      { [key]: token.trim() },
      {
        "app.kubernetes.io/created-by": "meteorologist",
        ...(app !== "" ? { "app.kubernetes.io/part-of": app } : {}),
      },
    );
    return undefined;
  });
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
