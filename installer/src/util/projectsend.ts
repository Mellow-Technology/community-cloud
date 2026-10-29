/**
 * @file
 * Where ProjectSend keeps the files people share.
 *
 * Two places, chosen under "values.projectsend.storage": a volume on a
 * node's disks, through TopoLVM, or a bucket in SeaweedFS. The local
 * volume needs nothing else and keeps the file on the node its pod is
 * on; the bucket survives a node and is shared with nothing, at the
 * cost of needing SeaweedFS, and its public hostname, since ProjectSend
 * hands a download over as a link signed for the bucket.
 *
 * The manifests can only ask whether a value is set — the templates
 * have no "eq" — so the choice reaches them as "projectsend.s3", true
 * or false, and preflight refuses anything but the two names rather
 * than have a typo quietly mean the volume.
 */

export enum ProjectSendStorage {
  Local = "local",
  S3 = "s3",
}

// The volume, unless the configuration says otherwise: it's the one
// that needs nothing else installed
const DEFAULT_STORAGE = ProjectSendStorage.Local;

/**
 * The storage the configuration asks for.
 *
 * @param rawConfig
 * @returns
 */
export function getProjectSendStorage(rawConfig: any): ProjectSendStorage {
  const storage = rawConfig?.values?.projectsend?.storage ?? rawConfig?.projectsend?.storage;

  if (storage === undefined || storage === null) {
    return DEFAULT_STORAGE;
  }

  if (!Object.values(ProjectSendStorage).includes(storage)) {
    throw new Error(
      `"values.projectsend.storage" is ${JSON.stringify(storage)}, and has to be "${ProjectSendStorage.Local}" or "${ProjectSendStorage.S3}".`,
    );
  }

  return storage;
}

/**
 * The template values ProjectSend's manifests read: what the
 * configuration says under "projectsend", with the choice of storage
 * as something an "if" can test.
 *
 * @param rawConfig
 * @returns
 */
export function buildProjectSendValues(rawConfig: any): Record<string, any> {
  const configured = rawConfig?.values?.projectsend ?? rawConfig?.projectsend ?? {};
  const storage = getProjectSendStorage(rawConfig);

  return { ...configured, storage, s3: storage === ProjectSendStorage.S3 };
}

/**
 * What stops ProjectSend's storage working, when it's enabled.
 *
 * A bucket needs SeaweedFS to be in it, and its public hostname for the
 * links downloads are. Without either, the install would apply and the
 * first download fail.
 *
 * @param rawConfig
 * @param enabled the packages the configuration installs
 * @returns
 */
export function checkProjectSendConfig(rawConfig: any, enabled: string[]): string[] {
  let storage: ProjectSendStorage;
  try {
    storage = getProjectSendStorage(rawConfig);
  } catch (error: any) {
    return [error.message];
  }

  if (storage !== ProjectSendStorage.S3) {
    return [];
  }

  const problems: string[] = [];

  if (!enabled.includes("seaweedfs")) {
    problems.push('"values.projectsend.storage" is "s3", which keeps ProjectSend\'s files in SeaweedFS, and the seaweedfs package isn\'t enabled.');
  }

  const values = { ...rawConfig, ...(rawConfig?.values ?? {}) };
  if (typeof values.domain?.storage !== "string" || values.domain.storage === "") {
    problems.push('"values.projectsend.storage" is "s3", and "values.domain.storage" isn\'t set. ProjectSend\'s downloads are links to the bucket, so browsers have to be able to reach it.');
  }

  return problems;
}
