/**
 * @file
 * What the MCP server tells an agent when it connects: how to work out
 * what an application needs from its project's files, and to write the
 * answer down as image labels so it needn't be worked out again.
 *
 * This is the agent's half of CC-56. Cirrus will read the same labels
 * from images (../webapp/labels.ts); the signals below are the ones
 * CC-56 lists for later, which an agent with the files in front of it
 * can use today.
 */
import { LABEL_PREFIX } from "../webapp/labels";

export const INSTRUCTIONS = `Community Cloud web applications in one Kubernetes namespace, the one this token belongs to. Cirrus deploys each one, with what it asks for: a Postgres database, an S3 bucket, a RabbitMQ vhost, volumes, connections to other services, and migrations run before each rollout.

What Cirrus can provide differs between installs and namespaces: call get_capabilities first. Anything it says isn't available is left out of the tools and refused; tell the person what's missing and why, using its reason.

Before creating or updating, work out what the application needs:

1. If the Dockerfile already has ${LABEL_PREFIX}* labels, they're the answer: use them and skip the rest.
   - ${LABEL_PREFIX}postgres="true" → postgres: true
   - ${LABEL_PREFIX}rabbitmq="true" → rabbitmq: true
   - ${LABEL_PREFIX}bucket="true" → bucket: true
   - ${LABEL_PREFIX}migrate, a JSON array such as ["bin/rails","db:migrate"] → migrations.command (a plain string is run with /bin/sh -c)
   - ${LABEL_PREFIX}health="/path" → healthCheckPath
2. Otherwise read the project:
   - Postgres: a pg, psycopg, asyncpg, pgx, Npgsql or postgres driver in its dependencies; adapter: postgresql in config/database.yml; provider = "postgresql" in a Prisma schema; ENGINE django.db.backends.postgresql; a postgres service in docker-compose.yml; DATABASE_URL in .env.example.
   - RabbitMQ: amqplib, pika, aio-pika, bunny, lapin or amqp091-go; an AMQP_URL or a rabbitmq service.
   - Bucket: an S3 client (aws-sdk, @aws-sdk/client-s3, boto3, minio, ActiveStorage with service: S3).
   - Migrations: Procfile release: line; Rails bin/rails db:migrate; Django python manage.py migrate; Prisma npx prisma migrate deploy; Laravel php artisan migrate --force; Phoenix bin/migrate or a release task; Alembic alembic upgrade head.
   - Health check: a route such as /up (Rails 7.1+), /healthz, /health or /api/health.
   - Port: EXPOSE in the Dockerfile is read by Cirrus, so only set port when there isn't one.
   - Redis has no field yet; say so if the application needs one.
3. After creating or updating, write the returned dockerfileLabels into the project's Dockerfile, in the stage that's run (the last one), replacing any ${LABEL_PREFIX}* labels already there. That's what makes the next look quick, and what Cirrus will read.

To see a change through, pass wait: true to create_application or update_application, or call wait_for_rollout: it answers once the application is healthy or has failed, saying what Cirrus is doing as it goes. If the time runs out, it's still going; call wait_for_rollout again. A failure's message says why, such as a migration that exited with an error.

Cirrus sets the variables for what it provides: DATABASE_URL and PG*, AMQP_URL and RABBITMQ_*, S3_* and AWS_*. Point the application at those rather than setting them by hand, and never put secrets in env.

What's left to a person in Meteorologist: hostnames (an application made here is only reachable inside the cluster until it has one), deleting, turning a service off, changing a volume, and variables read from Secrets. Say so, with the application's page link, when one of those is needed.`;
