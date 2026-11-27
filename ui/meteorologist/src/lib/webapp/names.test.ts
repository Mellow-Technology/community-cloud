import { createHash } from "node:crypto";
import { expect, test } from "bun:test";

import { sharedName } from "./names";

test("a short name is the namespace and the application", () => {
  expect(sharedName("shop", "web")).toBe("shop-web");
});

test("a long one is cut to 63 characters with a hash of the whole, as Cirrus cuts it", () => {
  const namespace = "a".repeat(40);
  const app = `${"b".repeat(30)}1`;
  const name = sharedName(namespace, app);
  const whole = `${namespace}-${app}`;
  expect(name).toHaveLength(63);
  expect(name).toBe(`${whole.slice(0, 54)}-${createHash("sha256").update(whole).digest("hex").slice(0, 8)}`);
  expect(sharedName(namespace, `${"b".repeat(30)}2`)).not.toBe(name);
});
