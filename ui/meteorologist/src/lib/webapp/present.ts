/**
 * @file
 * Small facts about an application, worded for the pages.
 */
import type { WebApplication } from "./types";
import { DEFAULT_TAG } from "./types";

/**
 * What the application asks Cirrus for, as short names.
 *
 * @param app
 * @returns
 */
export function requestedServices(app: WebApplication): string[] {
  const spec = app.spec;
  return [
    spec.postgres !== undefined && "Postgres",
    spec.bucket !== undefined && "Bucket",
    spec.rabbitmq !== undefined && "RabbitMQ",
    spec.source?.gitlab !== undefined && "GitLab",
    spec.migrations !== undefined && "Migrations",
  ].filter((name): name is string => name !== false);
}

/**
 * The image the spec names, with its tag.
 *
 * @param app
 * @returns
 */
export function specImage(app: WebApplication): string {
  return `${app.spec.image.repository}:${app.spec.image.tag ?? DEFAULT_TAG}`;
}

/**
 * The image actually running, or else the one the spec names.
 *
 * @param app
 * @returns
 */
export function shownImage(app: WebApplication): string {
  return app.status?.deployedImage ?? specImage(app);
}

/**
 * The page for one application.
 *
 * @param app
 * @returns
 */
export function appHref(app: WebApplication): string {
  return `/apps/${encodeURIComponent(app.metadata.namespace ?? "")}/${encodeURIComponent(app.metadata.name)}`;
}
