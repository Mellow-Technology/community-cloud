import { describe, expect, test } from "bun:test";

import type { S3Identity } from "./types";
import {
  emptyUserForm,
  fromUserForm,
  newIdentity,
  toUserForm,
  validateNewUserForm,
  validateUserForm,
} from "./userForm";

const methods: S3Identity = {
  metadata: { name: "methods", namespace: "cc-office", resourceVersion: "4" },
  spec: {
    seaweedRef: { name: "seaweed", namespace: "seaweedfs" },
    name: "methods",
    disabled: false,
    reclaimPolicy: "Delete",
  },
  status: { identityName: "methods", phase: "Ready" },
};

describe("a user's form", () => {
  test("comes back as it was", () => {
    expect(fromUserForm(toUserForm(methods), methods)).toEqual(methods);
  });

  test("sets who it's for, and drops what's blank", () => {
    const form = { ...toUserForm(methods), displayName: " Methods ", email: "ops@example.test", disabled: true };
    const spec = fromUserForm(form, methods).spec;
    expect(spec.account).toEqual({ displayName: "Methods", email: "ops@example.test" });
    expect(spec.disabled).toBe(true);
    const cleared = fromUserForm({ ...form, displayName: "", email: "" }, { ...methods, spec });
    expect(cleared.spec.account).toBeUndefined();
  });

  test("never changes its name in SeaweedFS or which SeaweedFS it's in", () => {
    const form = { ...toUserForm(methods), name: "else", namespace: "else" };
    const saved = fromUserForm(form, methods);
    expect(saved.spec.name).toBe("methods");
    expect(saved.spec.seaweedRef).toEqual(methods.spec.seaweedRef);
    expect(saved.metadata).toEqual(methods.metadata);
  });

  test("is checked", () => {
    expect(validateUserForm(toUserForm(methods))).toEqual({});
    expect(validateUserForm({ ...toUserForm(methods), email: "not an address" }).email).toBeDefined();
    expect(validateUserForm({ ...toUserForm(methods), displayName: "x".repeat(257) }).displayName).toBeDefined();
  });
});

describe("a new user", () => {
  const form = { ...emptyUserForm("cc-office"), name: "reports" };

  test("is named in SeaweedFS for its namespace, unless told otherwise", () => {
    const seaweed = { name: "seaweed", namespace: "seaweedfs" };
    expect(newIdentity(form, seaweed)).toEqual({
      apiVersion: "seaweed.seaweedfs.com/v1",
      kind: "S3Identity",
      metadata: { name: "reports", namespace: "cc-office", labels: {} },
      spec: { seaweedRef: seaweed, name: "cc-office-reports", disabled: false, reclaimPolicy: "Delete" },
    });
    expect(newIdentity({ ...form, userName: " Reports_1 ", displayName: "Reports" }, seaweed).spec).toMatchObject({
      name: "Reports_1",
      account: { displayName: "Reports" },
    });
  });

  test("is checked", () => {
    expect(validateNewUserForm(form)).toEqual({});
    expect(Object.keys(validateNewUserForm(emptyUserForm())).toSorted()).toEqual(["name", "namespace"]);
    expect(validateNewUserForm({ ...form, userName: "has space" }).userName).toBeDefined();
    expect(validateNewUserForm({ ...form, secretName: "Bad" }).secretName).toBeDefined();
    // A key's Secret only matters when there's a key
    expect(validateNewUserForm({ ...form, secretName: "Bad", createKey: false })).toEqual({});
  });
});
