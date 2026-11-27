/**
 * @file
 * The environment variables an application is given, for whoever
 * configures it to read them.
 *
 * Cirrus reports them in status.variables, each with where it comes
 * from and, for a plain one, its value; that's what's true of this
 * application on this cluster, such as whether S3_PUBLIC_ENDPOINT is
 * set. Until Cirrus has looked at an application, or with a Cirrus
 * from before it reported them, the names are worked out from the spec
 * the way Cirrus names them (operators/cirrus/src/reconcile), without
 * values, and marked as expected.
 */
import { envPrefix } from "./form";
import type { VariableStatus, WebApplication } from "./types";

// What each service sets, as Cirrus's postgres.rs, rabbitmq.rs and
// bucket.rs do. S3_PUBLIC_ENDPOINT depends on the cluster, so only
// Cirrus's report has it.
const POSTGRES = ["PGHOST", "PGPORT", "PGDATABASE", "PGUSER", "PGPASSWORD", "DATABASE_URL"];
const RABBITMQ = [
  "RABBITMQ_HOST",
  "RABBITMQ_PORT",
  "RABBITMQ_USERNAME",
  "RABBITMQ_PASSWORD",
  "RABBITMQ_VHOST",
  "AMQP_URL",
];
const BUCKET = [
  "S3_ENDPOINT",
  "S3_BUCKET",
  "S3_REGION",
  "S3_ACCESS_KEY_ID",
  "S3_SECRET_ACCESS_KEY",
  "AWS_ENDPOINT_URL_S3",
  "AWS_REGION",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
];
// The ones read from a Secret
const SECRET = new Set([
  ...POSTGRES,
  ...RABBITMQ,
  "S3_ACCESS_KEY_ID",
  "S3_SECRET_ACCESS_KEY",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
]);

/**
 * The variables an application is given: Cirrus's report, or else what
 * its spec leads to.
 *
 * @param app
 * @returns the variables, and whether Cirrus reported them
 */
export function givenVariables(app: WebApplication): { reported: boolean; variables: VariableStatus[] } {
  const reported = app.status?.variables;
  if (reported !== undefined && reported.length > 0) return { reported: true, variables: reported };

  const spec = app.spec;
  const variables: VariableStatus[] = [];
  const add = (names: string[], from: string) =>
    variables.push(...names.map((name) => ({ name, from, ...(SECRET.has(name) ? { secret: true } : {}) })));
  if (spec.postgres !== undefined) add(POSTGRES, "postgres");
  if (spec.bucket !== undefined) add(BUCKET, "bucket");
  if (spec.rabbitmq !== undefined) add(RABBITMQ, "rabbitmq");
  for (const connection of spec.connections ?? []) {
    const prefix = envPrefix(connection.name ?? connection.offering);
    add(
      ["HOST", "PORT", "URL", "TYPE"].map((part) => `${prefix}_${part}`),
      "connections",
    );
  }
  for (const secret of spec.secrets ?? []) variables.push({ name: secret.name, from: "secrets", secret: true });
  for (const shared of spec.shared ?? []) variables.push({ name: shared.as ?? shared.name, from: "shared" });
  for (const variable of spec.env ?? []) {
    variables.push({
      name: variable.name,
      from: "env",
      ...(variable.valueFrom === undefined ? { value: variable.value ?? "" } : {}),
      ...(variable.valueFrom?.secretKeyRef ? { secret: true } : {}),
    });
  }
  return { reported: false, variables };
}
