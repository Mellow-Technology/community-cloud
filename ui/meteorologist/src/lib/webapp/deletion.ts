/**
 * @file
 * What deleting an application does, said before it's done.
 *
 * Deleting the WebApplication is all Meteorologist does. The rest
 * follows from Cirrus (operators/cirrus/src/reconcile/cleanup.rs):
 *
 * - What it made in the namespace — the Deployment, Service, routes,
 *   connection Secrets, and the Postgres, bucket and RabbitMQ
 *   resources — is owned by the application, so Kubernetes removes it
 *   once the application is gone.
 * - What it made elsewhere, it removes itself before letting the
 *   application go: the RabbitMQ vhost and user, which live in
 *   cc-office, and the GitLab webhook.
 *
 * The data is kept on purpose. CloudNativePG leaves the database when
 * its Database resource goes, and SeaweedFS leaves the bucket and its
 * contents, so a slip of the hand costs an application, not what it
 * stored. RabbitMQ is the exception: deleting the vhost deletes its
 * queues, and so whatever messages were waiting in them.
 *
 * Confirming takes the application's name, typed, which is checked
 * here and again by the server action.
 */
import { POSTGRES_CLUSTER, postgresDatabase } from "../postgres";
import type { WebApplication } from "./types";

export interface DeletionSummary {
  // What goes, as sentences
  removed: string[];
  // What stays, as sentences
  kept: string[];
}

/**
 * What deleting this application removes and what it leaves.
 *
 * @param app
 * @returns
 */
export function deletionSummary(app: WebApplication): DeletionSummary {
  const { name, namespace } = app.metadata;
  const { spec } = app;
  const removed = ["Its Deployment and Service, so it stops running."];
  const kept: string[] = [];

  if (spec.hostnames?.length) {
    const verb = spec.hostnames.length === 1 ? "stops" : "stop";
    removed.push(`Its routes, so ${spec.hostnames.join(", ")} ${verb} answering.`);
  }
  if (spec.postgres !== undefined) {
    removed.push("Its Postgres role and connection Secret.");
    kept.push(`Its database, ${postgresDatabase(name)}, and everything in it, on ${namespace}'s ${POSTGRES_CLUSTER}.`);
  }
  if (spec.bucket !== undefined) {
    removed.push("Its bucket's access keys.");
    kept.push("Its bucket, and everything in it.");
  }
  if (spec.rabbitmq !== undefined) {
    removed.push("Its RabbitMQ vhost and user, with any messages still waiting in its queues.");
  }
  if (spec.source?.gitlab !== undefined) {
    removed.push(`The webhook on ${spec.source.gitlab.project} that tells it about new releases.`);
  }

  return { removed, kept };
}

/**
 * Whether what was typed confirms deleting the application.
 *
 * Exactly its name, give or take spaces around it: near enough isn't
 * enough when it's the wrong application.
 *
 * @param typed
 * @param name
 * @returns
 */
export function confirmsDeletion(typed: string, name: string): boolean {
  return typed.trim() === name;
}
