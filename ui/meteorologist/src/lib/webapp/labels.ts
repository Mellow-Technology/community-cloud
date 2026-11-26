/**
 * @file
 * The image labels an application can say what it needs with, and the
 * Dockerfile lines that set them.
 *
 * They're CC-56's first step: an image saying "I use Postgres" or "run
 * this to migrate" so its WebApplication needn't. Cirrus reads them
 * from the image it rolls out and fills in what the spec leaves out
 * (operators/cirrus/src/reconcile/labels.rs), recording what it filled
 * in under status.detected. An agent working over MCP (see ../mcp/)
 * writes them into the Dockerfile once it has read the project's
 * files, so the next time anything looks, the answer is already
 * written down rather than worked out again.
 *
 * The names and what each means are the contract with Cirrus's
 * labels.rs, so they're kept here once and changed only together with
 * it:
 *
 * - postgres, rabbitmq, bucket: "true" is the same as the field being
 *   in the spec, asking for one with the defaults
 * - migrate: migrations.command, as a JSON array (exec form), or a
 *   string run with /bin/sh -c
 * - health: healthCheck.path
 *
 * Nothing else is a label yet: there's no redis field to set, and
 * hostnames, resources and connections belong to where it's deployed,
 * not to the image.
 */
import type { WebApplicationSpec } from "./types";

export const LABEL_PREFIX = "technology.community-cloud.";

/**
 * What an application needs, as far as an image can say it.
 */
export interface ImageNeeds {
  postgres?: boolean;
  rabbitmq?: boolean;
  bucket?: boolean;
  migrate?: string[];
  health?: string;
}

/**
 * What a spec says the application needs.
 *
 * @param spec
 * @returns
 */
export function needsOf(spec: WebApplicationSpec): ImageNeeds {
  const needs: ImageNeeds = {};
  if (spec.postgres !== undefined) needs.postgres = true;
  if (spec.rabbitmq !== undefined) needs.rabbitmq = true;
  if (spec.bucket !== undefined) needs.bucket = true;
  if (spec.migrations !== undefined && spec.migrations.command.length > 0) {
    needs.migrate = [...spec.migrations.command, ...(spec.migrations.args ?? [])];
  }
  if (spec.healthCheck?.path !== undefined) needs.health = spec.healthCheck.path;
  return needs;
}

/**
 * The labels for those needs, by name. A need that isn't there has no
 * label rather than a "false" one: leaving the label out is how an
 * image says it doesn't need something.
 *
 * @param needs
 * @returns
 */
export function labelsFor(needs: ImageNeeds): Record<string, string> {
  const labels: Record<string, string> = {};
  for (const service of ["postgres", "rabbitmq", "bucket"] as const) {
    if (needs[service]) labels[`${LABEL_PREFIX}${service}`] = "true";
  }
  if (needs.migrate !== undefined && needs.migrate.length > 0) {
    labels[`${LABEL_PREFIX}migrate`] = JSON.stringify(needs.migrate);
  }
  if (needs.health !== undefined) labels[`${LABEL_PREFIX}health`] = needs.health;
  return labels;
}

/**
 * A value as a Dockerfile writes it: in double quotes, with the
 * characters that are special inside them escaped.
 *
 * @param value
 * @returns
 */
function quoted(value: string): string {
  return `"${value.replace(/[\\"$]/g, (character) => `\\${character}`)}"`;
}

/**
 * The Dockerfile LABEL instruction that sets them, or nothing when
 * there's nothing to say.
 *
 * @param needs
 * @returns
 */
export function dockerfileLabels(needs: ImageNeeds): string | undefined {
  const entries = Object.entries(labelsFor(needs));
  if (entries.length === 0) {
    return undefined;
  }
  return `LABEL ${entries.map(([name, value]) => `${name}=${quoted(value)}`).join(" \\\n      ")}`;
}
