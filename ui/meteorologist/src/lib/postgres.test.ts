import { expect, test } from "bun:test";

import { postgresDatabase, postgresStorageProblem } from "./postgres";
import { formatBytes, parseQuantity } from "./quantity";
import { postgresNote } from "./webapp/warnings";

test("quantities", () => {
  expect(parseQuantity("20Gi")).toBe(20 * 2 ** 30);
  expect(parseQuantity("250m")).toBe(0.25);
  expect(parseQuantity("1G")).toBe(1e9);
  expect(parseQuantity("lots")).toBeUndefined();
  expect(parseQuantity("5Xi")).toBeUndefined();
  expect(formatBytes(15 * 2 ** 30)).toBe("15Gi");
});

test("a storage quota too small for the namespace's Postgres", () => {
  expect(postgresStorageProblem(undefined, undefined)).toBeUndefined();
  expect(postgresStorageProblem("100Gi", "50Gi")).toBeUndefined();
  expect(postgresStorageProblem("10Gi", "0")).toContain("10Gi left");
  expect(postgresStorageProblem("30Gi", "15Gi")).toContain("15Gi left");
});

test("what asking for a database means", () => {
  expect(postgresNote({ name: "team" })).toBeUndefined();
  expect(postgresNote({ name: "team", hasPostgres: true })?.message).toContain("already has its Postgres server");
  expect(postgresNote({ name: "team", hasPostgres: false })?.message).toContain("starts one");
  expect(postgresNote({ name: "team", hasPostgres: false, storageQuota: "10Gi" })?.tone).toBe("warning");
});

// As operators/cirrus/src/naming.rs names it
test("an application's database is named after it", () => {
  expect(postgresDatabase("shop")).toBe("shop");
  expect(postgresDatabase("web-app-2")).toBe("web_app_2");
});
