import { describe, expect, test } from "bun:test";

import { keyDeletion, newKeyNames, secretNameProblem } from "./keys";
import type { S3CredentialsSummary } from "./types";

const key = (name: string, secretName: string): S3CredentialsSummary => ({
  namespace: "cc-office",
  name,
  identity: "reporting",
  secretName,
});

describe("a new key's names", () => {
  test("are the user's, then numbered, with -s3 for the Secret", () => {
    expect(newKeyNames("reporting", [])).toEqual({ name: "reporting", secretName: "reporting-s3" });
    expect(newKeyNames("reporting", [key("reporting", "reporting-s3")])).toEqual({
      name: "reporting-2",
      secretName: "reporting-2-s3",
    });
  });

  test("step past a Secret that's already there", () => {
    expect(newKeyNames("reporting", [], ["reporting-s3", "reporting-2-s3"]).name).toBe("reporting-3");
  });
});

describe("a Secret's name", () => {
  test("is checked, and blank means the one suggested", () => {
    expect(secretNameProblem("")).toBeUndefined();
    expect(secretNameProblem("reports-s3")).toBeUndefined();
    expect(secretNameProblem("Reports")).toBeDefined();
    expect(secretNameProblem("taken", ["taken"])).toContain("already");
  });
});

test("deleting a key says whether it keeps working", () => {
  expect(keyDeletion({ ...key("a", "b"), reclaimPolicy: "Retain" })).toContain("keeps working");
  expect(keyDeletion(key("a", "b"))).toContain("taken out of SeaweedFS");
});
