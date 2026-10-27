import { describe, expect, test } from "bun:test";

import { emptyForm, type WebApplicationForm } from "./form";
import { capabilityWarnings, requiredCapabilities } from "./warnings";

const GATEWAY = { whereWereGoing: "weDontNeedRoads" };
const BUCKETS = { "storage.community-cloud.technology/buckets": "true" };

/**
 * @param changes
 * @returns
 */
function form(changes: Partial<WebApplicationForm> = {}): WebApplicationForm {
  return { ...emptyForm("team"), name: "shop", repository: "nginx", ...changes };
}

/**
 * The capabilities warned about, by name.
 *
 * @param changes
 * @param labels
 * @returns
 */
function warned(changes: Partial<WebApplicationForm>, labels: Record<string, string> | undefined): string[] {
  return capabilityWarnings(form(changes), labels).map((warning) => warning.capability.id);
}

describe("capability warnings", () => {
  test("say nothing for an application that needs nothing", () => {
    expect(requiredCapabilities(form())).toEqual([]);
    expect(warned({}, {})).toEqual([]);
  });

  test("want the gateway label for hostnames", () => {
    expect(warned({ hostnames: ["shop.example.org"] }, {})).toEqual(["gateway"]);
    expect(warned({ hostnames: ["shop.example.org"] }, GATEWAY)).toEqual([]);
  });

  test("ignore empty hostname rows", () => {
    expect(warned({ hostnames: ["", "  "] }, {})).toEqual([]);
  });

  test("want the buckets label for a bucket", () => {
    expect(warned({ bucket: true }, GATEWAY)).toEqual(["buckets"]);
    expect(warned({ bucket: true }, BUCKETS)).toEqual([]);
  });

  test("list everything missing, next to the field that needs it", () => {
    const warnings = capabilityWarnings(form({ bucket: true, hostnames: ["a.example.org"] }), {});
    expect(warnings.map((warning) => [warning.capability.id, warning.field])).toEqual([
      ["gateway", "hostnames"],
      ["buckets", "bucket"],
    ]);
  });

  test("don't guess when the namespace couldn't be read", () => {
    expect(warned({ bucket: true, hostnames: ["a.example.org"] }, undefined)).toEqual([]);
  });

  test("don't care about Postgres or RabbitMQ", () => {
    expect(warned({ postgres: true, rabbitmq: true }, {})).toEqual([]);
  });
});
