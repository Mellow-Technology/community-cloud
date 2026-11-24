/**
 * @file
 * SeaweedFS's S3 users, as the Users tab shows them: what each is
 * called in SeaweedFS, where its keys are, and which buckets it may use.
 */
import type { Bucket, BucketAction, S3CredentialsSummary, S3Identity } from "./types";
import { userTabHref } from "./userTabs";

/**
 * A user's name in SeaweedFS: what a Bucket's access names.
 *
 * @param identity
 * @returns
 */
export function identityName(identity: S3Identity): string {
  return identity.status?.identityName ?? identity.spec.name ?? identity.metadata.name;
}

/**
 * The key pairs made for a user, by the S3Credentials naming it in its
 * namespace.
 *
 * @param identity
 * @param credentials
 * @returns
 */
export function keysFor(identity: S3Identity, credentials: S3CredentialsSummary[]): S3CredentialsSummary[] {
  return credentials.filter(
    (each) => each.namespace === identity.metadata.namespace && each.identity === identity.metadata.name,
  );
}

/**
 * The buckets a user may use, and what it may do with each. User names
 * are one list for the whole of SeaweedFS, so this is every bucket that
 * names it, whatever namespace it's in.
 *
 * @param identity
 * @param buckets
 * @returns
 */
export function bucketsFor(
  identity: S3Identity,
  buckets: Bucket[],
): Array<{ bucket: Bucket; actions: BucketAction[] }> {
  const name = identityName(identity);
  return buckets.flatMap((bucket) => {
    const access = bucket.spec.access?.find((each) => each.user === name);
    return access ? [{ bucket, actions: access.actions }] : [];
  });
}

/**
 * A user as the table shows its state: disabled, whatever else it is,
 * comes first.
 *
 * @param identity
 * @returns
 */
export function isDisabled(identity: S3Identity): boolean {
  return identity.spec.disabled === true;
}

/**
 * Where a user is changed.
 *
 * @param identity
 * @returns
 */
export function userEditHref(identity: S3Identity): string {
  return userTabHref(identity.metadata.namespace ?? "", identity.metadata.name, "edit");
}

/**
 * A user as a bucket's access can offer it.
 */
export interface UserChoice {
  user: string;
  namespace: string;
  displayName?: string;
  disabled?: boolean;
}

/**
 * The users the person can see, as choices for a bucket's access.
 *
 * @param identities
 * @returns
 */
export function userChoices(identities: S3Identity[]): UserChoice[] {
  return identities.map((identity) => ({
    user: identityName(identity),
    namespace: identity.metadata.namespace ?? "",
    displayName: identity.spec.account?.displayName,
    disabled: identity.spec.disabled,
  }));
}

/**
 * The options for one row of a bucket's access: the bucket's own
 * namespace's users first, then everyone else's, since user names are
 * one list across SeaweedFS. Users another row already has can't be
 * chosen twice. The row's own user stays an option even when it isn't
 * among the users the person can see, so editing never quietly drops
 * one.
 *
 * @param users
 * @param namespace the bucket's
 * @param current the row's user, if it has one
 * @param taken users the other rows have
 * @returns
 */
export function accessOptions(
  users: UserChoice[],
  namespace: string,
  current: string,
  taken: string[],
): Array<{ value: string; label: string; description?: string; disabled?: boolean }> {
  const sorted = users.toSorted(
    (a, b) =>
      Number(b.namespace === namespace) - Number(a.namespace === namespace) ||
      a.namespace.localeCompare(b.namespace) ||
      a.user.localeCompare(b.user),
  );
  const options = sorted.map((each) => {
    const already = each.user !== current && taken.includes(each.user);
    return {
      value: each.user,
      label: each.user,
      description: [
        each.namespace,
        each.displayName,
        each.disabled ? "disabled" : undefined,
        already ? "already given access" : undefined,
      ]
        .filter(Boolean)
        .join(" · "),
      disabled: already,
    };
  });
  if (current !== "" && !users.some((each) => each.user === current)) {
    options.unshift({
      value: current,
      label: current,
      description: "Not among the users you can see",
      disabled: false,
    });
  }
  return options;
}
