/**
 * @file
 * What the MCP server tells an agent when it connects: how to work out
 * what an application needs from its project's files, and to write the
 * answer down as image labels so it needn't be worked out again.
 *
 * This is the agent's half of CC-56. Cirrus reads the same labels
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
   - Several images from one repository, such as an application and its API built by a docker buildx bake group: each is an application of its own, with the same gitlab project and its own image. With Meteorologist's bake build, target api is pushed to <project's registry>/api, and a single target, or the main target if one is set, to the project's own repository.
   - Redis has no field yet; say so if the application needs one.
3. After creating or updating, write the returned dockerfileLabels into the project's Dockerfile, in the stage that's run (the last one), replacing any ${LABEL_PREFIX}* labels already there. That's what makes the next look quick, and Cirrus reads them too: once they're in the image, what they ask for is filled in where the spec says nothing (get_application shows it under detected). The spec wins, and detect: false turns them off.

Environment and secrets:
- env is for plain settings, such as LOG_LEVEL. Anyone who can see the application reads them, so never put a secret there, even one you can see in the project.
- Secrets, such as API keys, go in secrets, by name and with a description of what each is and where to get it. You never give or see a value: a person sets it in Meteorologist, and the application waits until each has one. Look for them in .env.example, the config the application reads, and its README, and leave out what Cirrus already provides (DATABASE_URL, PG*, AMQP_URL, S3_*, AWS_*).
- The namespace may already share values its applications use, such as an SMTP host or a common API key: get_capabilities lists them, plain ones with their values and secret ones by name. Use one through shared, with as when the application expects another name, rather than asking for the same secret again.
- get_application says which secrets and shared values have a value (set), never what it is. wait_for_rollout says when the application is waiting for one, and which, for you to pass on.

How migrations run:
- A Job with the new image and the application's environment (DATABASE_URL, PG* and the rest), on the first deploy and on each new image after. The Deployment is given the image only once the Job succeeds, and the old version serves until then.
- command replaces the image's entrypoint and runs without a shell: ["bin/rails", "db:migrate"], not ["bin/rails db:migrate"]. For &&, pipes or $VARIABLES, use ["/bin/sh", "-c", "..."]. The ${LABEL_PREFIX}migrate label takes either form; a plain string there is run with /bin/sh -c.
- Once per image: applying the same image again doesn't rerun it, but going back to an earlier image does, so it must be safe to run twice (the frameworks' own migrate commands are). It must also leave the schema usable by the image still serving.
- One at a time: an image arriving while another's migration runs waits for it to finish.
- It's retried once, and fails after timeoutSeconds (30 minutes unless said).
- A failed migration leaves the old version running and isn't rerun for that image. Fix it and roll out a new image, or have a person delete the Job to run it again. You can't read its logs: give the person the Job's name, which wait_for_rollout and get_application report.

How buckets work:
- bucket gives the application an S3 bucket of its own in the cluster's SeaweedFS, called <namespace>-<application> (S3_BUCKET), with a key that reaches that bucket and no other. Nothing else in it is configurable from here but quota, such as { quota: "10Gi" }.
- Cirrus sets S3_ENDPOINT, S3_BUCKET, S3_REGION, S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY, and AWS_ENDPOINT_URL_S3, AWS_REGION, AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY, which AWS's SDKs read by themselves. Point the application's storage config at them; a framework that wants its own names (Rails' Active Storage, Django's django-storages, Laravel's filesystems) should read them from these.
- Use path-style addressing (forcePathStyle: true, use_path_style_endpoint, addressing_style "path"): SeaweedFS doesn't serve buckets as subdomains. The region is us-east-1, which SeaweedFS ignores but SDKs insist on.
- S3_ENDPOINT is inside the cluster only. Uploads and downloads that go through the application work as they are; links handed to browsers, such as presigned URLs, don't, since a signature covers the host. Where the cluster serves S3 outside, S3_PUBLIC_ENDPOINT is that address: sign browser links with a client pointed at it. Without it, serve files through the application. Objects aren't public: every read needs the keys or a signed link.
- The bucket and its contents are kept when the application is deleted, and it can't be turned off from here.

How volumes work:
- Prefer the services: a database for data, a bucket for uploads and files. A volume is for what has to be a filesystem, such as SQLite, a search index or a cache.
- A disk volume (fast, the default, on NVMe; sata; hdd) is a claim of its own, <application>-<name>, on storage local to one node. It's made on the node the first pod lands on, and every copy of the application shares it and runs on that node, so more replicas don't spread across nodes.
- An application with a disk volume is rolled out by stopping the old copies before starting the new, so there's a moment with nothing serving.
- A storage type needs a node with those disks, not only its StorageClass: one no node has waits forever. get_capabilities says which StorageClasses exist; fast is the safe choice.
- ram is a RAM disk: each pod's own, emptied whenever the pod restarts, and counted against its memory (Cirrus adds its size to the memory request and limit). For caches and scratch space, never for anything to keep.
- Migrations don't mount volumes, since the Job may run on another node while the old version is still up. An application that keeps its database on a volume, such as SQLite, has to migrate when it starts instead.
- A volume is kept when the application is deleted, and picked up again by one made with the same name and volume. It can grow but not shrink, and its type can't change; from here, volumes are only added, and a person changes them in Meteorologist.
- Sizes count against the namespace's storage quota; ask for what's needed, such as 1Gi or 10Gi.

To see a change through, pass wait: true to create_application or update_application, or call wait_for_rollout: it answers once the application is healthy or has failed, saying what Cirrus is doing as it goes. If the time runs out, it's still going; call wait_for_rollout again. A failure's message says why, such as a migration that exited with an error.

Cirrus sets the variables for what it provides: DATABASE_URL and PG*, AMQP_URL and RABBITMQ_*, S3_* and AWS_*. Point the application at those rather than setting them by hand, and never put secrets in env.

What's left to a person in Meteorologist: hostnames (an application made here is only reachable inside the cluster until it has one), deleting, turning a service off, changing a volume, and variables read from Secrets. Say so, with the application's page link, when one of those is needed.`;
