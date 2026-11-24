/**
 * @file
 * An S3Identity, SeaweedFS's S3 user, as the form edits it, and back.
 *
 * Its name in SeaweedFS can't change once set, and which SeaweedFS it's
 * in never can, so the form only has what can: who it's for, whether
 * it's disabled, and whether deleting it takes the user out of
 * SeaweedFS. Turning a form back into a spec starts from the resource
 * as it is, so the rest is kept.
 */
import type { ReclaimPolicy, S3Identity } from "./types";

export interface UserForm {
  namespace: string;
  name: string;
  displayName: string;
  email: string;
  disabled: boolean;
  reclaimPolicy: ReclaimPolicy;
}

export type UserFormErrors = Partial<Record<keyof UserForm, string>>;

/**
 * An S3Identity as the form shows it.
 *
 * @param identity
 * @returns
 */
export function toUserForm(identity: S3Identity): UserForm {
  return {
    namespace: identity.metadata.namespace ?? "",
    name: identity.metadata.name,
    displayName: identity.spec.account?.displayName ?? "",
    email: identity.spec.account?.email ?? "",
    disabled: identity.spec.disabled ?? false,
    // SeaweedFS's operator's default
    reclaimPolicy: identity.spec.reclaimPolicy ?? "Delete",
  };
}

/**
 * The S3Identity the form describes, from the one it edits.
 *
 * @param form already checked with validateUserForm
 * @param existing
 * @returns
 */
export function fromUserForm(form: UserForm, existing: S3Identity): S3Identity {
  const spec = structuredClone(existing.spec);
  const account = { ...spec.account };
  for (const [key, value] of [
    ["displayName", form.displayName],
    ["email", form.email],
  ] as const) {
    const trimmed = value.trim();
    if (trimmed === "") {
      delete account[key];
    } else {
      account[key] = trimmed;
    }
  }
  if (Object.keys(account).length === 0) {
    delete spec.account;
  } else {
    spec.account = account;
  }
  spec.disabled = form.disabled;
  spec.reclaimPolicy = form.reclaimPolicy;
  return { ...existing, metadata: { ...existing.metadata }, spec };
}

// Enough to catch a slip, not to second-guess a real address
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * What's wrong with the form, by field. Empty when nothing is.
 *
 * @param form
 * @returns
 */
export function validateUserForm(form: UserForm): UserFormErrors {
  const errors: UserFormErrors = {};
  if (form.email.trim() !== "" && !EMAIL.test(form.email.trim())) {
    errors.email = "An email address, such as ops@example.com.";
  }
  if (form.displayName.trim().length > 256) {
    errors.displayName = "At most 256 characters.";
  }
  if (form.reclaimPolicy !== "Retain" && form.reclaimPolicy !== "Delete") {
    errors.reclaimPolicy = "Keep the user or delete it.";
  }
  return errors;
}

/**
 * A new user's form: a user's, with what can only be chosen when it's
 * made (its namespace, its names), and whether to make its first key
 * with it.
 */
export interface NewUserForm extends UserForm {
  // Its name in SeaweedFS; blank is namespace-name
  userName: string;
  createKey: boolean;
  // The first key's Secret; blank is named for the user
  secretName: string;
  keyReclaimPolicy: ReclaimPolicy;
}

export type NewUserFormErrors = Partial<Record<keyof NewUserForm, string>>;

/**
 * A new user's form, with a key to be made with it.
 *
 * @param namespace
 * @returns
 */
export function emptyUserForm(namespace = ""): NewUserForm {
  return {
    namespace,
    name: "",
    userName: "",
    displayName: "",
    email: "",
    disabled: false,
    reclaimPolicy: "Delete",
    createKey: true,
    secretName: "",
    keyReclaimPolicy: "Delete",
  };
}

/**
 * A user's name in SeaweedFS when none is typed: the namespace's name
 * before its own, as for buckets, since every namespace's users share
 * one list.
 *
 * @param namespace
 * @param name
 * @returns
 */
export function defaultUserName(namespace: string, name: string): string {
  return `${namespace}-${name}`;
}

// Kubernetes names: a DNS label
const RESOURCE_NAME = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/;

// A name in SeaweedFS: what S3 tools accept for a user without quoting
const USER_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

// Secret names are DNS subdomains
const SECRET_NAME = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?(\.[a-z0-9]([-a-z0-9]*[a-z0-9])?)*$/;

/**
 * What's wrong with a new user's form, by field. Empty when nothing is.
 *
 * @param form
 * @returns
 */
export function validateNewUserForm(form: NewUserForm): NewUserFormErrors {
  const errors: NewUserFormErrors = { ...validateUserForm(form) };
  if (form.namespace.trim() === "") {
    errors.namespace = "Choose the namespace it's in.";
  }
  const name = form.name.trim();
  if (name === "" || name.length > 63 || !RESOURCE_NAME.test(name)) {
    errors.name = "Name it with lower-case letters, digits and hyphens, starting and ending with a letter or digit.";
  }
  const typed = form.userName.trim();
  if (typed !== "" && !USER_NAME.test(typed)) {
    errors.userName = "Up to 128 letters, digits, dots, hyphens and underscores, starting with a letter or digit.";
  }
  const secret = form.secretName.trim();
  if (form.createKey && secret !== "" && (secret.length > 253 || !SECRET_NAME.test(secret))) {
    errors.secretName = "Lower-case letters, digits, hyphens and dots, starting and ending with a letter or digit.";
  }
  return errors;
}

/**
 * The S3Identity a new user's form describes.
 *
 * @param form already checked with validateNewUserForm
 * @param seaweedRef the SeaweedFS it's in
 * @param labels
 * @returns
 */
export function newIdentity(
  form: NewUserForm,
  seaweedRef: S3Identity["spec"]["seaweedRef"],
  labels: Record<string, string> = {},
): S3Identity {
  const namespace = form.namespace.trim();
  const name = form.name.trim();
  const blank: S3Identity = {
    apiVersion: "seaweed.seaweedfs.com/v1",
    kind: "S3Identity",
    metadata: { name, namespace, labels },
    spec: { seaweedRef, name: form.userName.trim() || defaultUserName(namespace, name) },
  };
  return fromUserForm(form, blank);
}
