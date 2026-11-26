import { describe, expect, test } from "bun:test";

import { dockerfileLabels, labelsFor, needsOf } from "./labels";

describe("an application's needs", () => {
  test("are read from the fields that ask for something", () => {
    expect(
      needsOf({
        image: { repository: "app" },
        postgres: {},
        bucket: { quota: "5Gi" },
        migrations: { command: ["bin/rails"], args: ["db:migrate"] },
        healthCheck: { path: "/up" },
      }),
    ).toEqual({ postgres: true, bucket: true, migrate: ["bin/rails", "db:migrate"], health: "/up" });
  });

  test("are nothing for an application that asks for nothing", () => {
    expect(needsOf({ image: { repository: "app" } })).toEqual({});
  });
});

describe("the labels", () => {
  test("leave out what isn't needed rather than saying false", () => {
    expect(labelsFor({ postgres: true, rabbitmq: false })).toEqual({ "technology.community-cloud.postgres": "true" });
  });

  test("keep the migration command in exec form", () => {
    expect(labelsFor({ migrate: ["npx", "prisma", "migrate", "deploy"] })).toEqual({
      "technology.community-cloud.migrate": '["npx","prisma","migrate","deploy"]',
    });
  });
});

describe("the Dockerfile's LABEL", () => {
  test("has one label a line, quoted so the JSON survives", () => {
    expect(dockerfileLabels({ postgres: true, migrate: ["bin/rails", "db:migrate"], health: "/up" })).toBe(
      [
        'LABEL technology.community-cloud.postgres="true" \\',
        '      technology.community-cloud.migrate="[\\"bin/rails\\",\\"db:migrate\\"]" \\',
        '      technology.community-cloud.health="/up"',
      ].join("\n"),
    );
  });

  test("escapes what the shell-like quoting would otherwise expand", () => {
    expect(dockerfileLabels({ migrate: ["sh", "-c", "echo $HOME"] })).toContain("\\$HOME");
  });

  test("is nothing when there's nothing to say", () => {
    expect(dockerfileLabels({})).toBeUndefined();
  });
});
