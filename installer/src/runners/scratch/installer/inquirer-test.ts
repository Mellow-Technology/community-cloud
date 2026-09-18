import { input, checkbox, select, Separator } from "@inquirer/prompts";

const resiliencyLevel = await select({
  message:
    "How resilient to failure would you like your Community Cloud instance to be?",
  default: "balanced",
  choices: [
    {
      name: "YOLO (You Only Live Once)",
      value: "yolo",
      description:
        "In YOLO mode, Community Cloud will attempt to use as little resources as possible. However the possibility for data loss and service disruption is high (and very real). For single node installations this is the only option.",
    },
    {
      name: "Balanced (Recommended)",
      value: "balanced",
      description:
        "This mode will attempt to provide reasonable resilience without overly consuming resources (i.e. resources will attempt to run on 3 nodes or mode).",
    },
    {
      name: "Paranoid (i.e. I've had one too many 3am debug sessions)",
      value: "paranoid",
      description:
        "In Paranoid mode, Community Cloud will discard any notion of reasonable resource management in the ultimate quest for service resilience and stability.",
    },
  ],
});

const components = await checkbox({
  message: "Which components would you like to install?",
  choices: [
    {
      name: "cert-manager",
      value: "cert-manager",
      description:
        "Provision and manage TLS certificates with LetsEncrypt or many other certificate issuers (https://cert-manager.io)",
      checked: true,
    },
    {
      name: "vLLM",
      value: "vllm",
      description: "Efficiently run large language models (https://vllm.ai/)",
      checked: true,
    },
    {
      name: "Garage",
      value: "garage",
      description:
        "S3 compatible storage service designed for resiliency and a wide variety of operating environments (https://garagehq.deuxfleurs.fr/)",
    },
    {
      name: "PostgreSql",
      value: "postgres",
      description:
        "The very commonly used open source SQL database (https://cloudnative-pg.io/)",
    },
    {
      name: "MariaDB",
      value: "mariadb",
      description:
        "A powerful MySql comptaible SQL database (https://github.com/mariadb-operator/mariadb-operator)",
    },
    {
      name: "MongoDB",
      value: "mongodb",
      description:
        "The infamously web scale document database (https://github.com/mongodb/mongodb-kubernetes/tree/master)",
    },
    {
      name: "NATS",
      value: "nats",
      description: "A powerful distributed message broker (https://nats.io/)",
    },
    {
      name: "Headlamp",
      value: "headlamp",
      description:
        "Headlamp is a user-friendly UI for Kubernetes (https://headlamp.dev/)",
      checked: true,
    },
    {
      name: "Grafana",
      value: "grafana",
      description:
        "The extremely popular OSS observability and monitoring tool. (https://grafana.com/)",
    },
    {
      name: "Umami",
      value: "umami",
      description:
        "Self-hosted, beautiful, and lightweight analytics for your website. (https://umami.is/)",
    },
    {
      name: "Airflow",
      value: "airflow",
      description:
        "Build, run, and monitor sophisticated workflows (https://airflow.apache.org/)",
    },
  ],
});

/**
 * Should Tailscale be used for networking.
 */
const useTailscale = await select({
  message:
    "Should Tailscale be used for cluster networking? (for more info see https://docs.k3s.io/networking/distributed-multicloud#integration-with-the-tailscale-vpn-provider-experimental)",
  choices: [
    {
      name: "Yes - automatically install and setup Tailscale",
      value: "tailscale-auto",
    },
    {
      name: "Yes - I have already installed Tailscale or will do so manually before setup",
      value: "tailscale-manual",
    },
    {
      name: "No - I do not want to use Tailscale",
      value: "tailscale-no",
    },
  ],
});

/**
 * Setup LVM options. We currently have two choices:
 *
 * 1. In the recommended setup we setup a volume group
 *    for each disk type (i.e. SSD, HDD). This maps onto
 *    LVMd device classes and a StorageClass will be created
 *    for each device class. This is recommended to get
 *    appropriate performance for the use case. For instance,
 *    it likely makes sense to have bulk storage map to HDDs
 *    for high capacity while a database uses SSD based storage.
 * 2. The second option will create a cache pool using SSD
 *    based drives while using HDDs for bulk storage. This is
 *    a good option for situations in which a large portion
 *    of frequently accessed data can fit on the cache device
 *    while high capacity drives can be used for all data.
 *    Community Cloud uses write back mode for higher performance
 *    at the (somewhat) higher risk of data loss in a drive failure.
 *    In the case of nodes with only one storage type option 1
 *    will be used as a fallback.
 * 3. The third option will create a single device class
 *    and storage class that will be used for everything.
 *    If there's there desire to create a dead simple setup
 *    this would be the option to go with. However, it's not
 *    recommended as performance will be bounded by the slowest
 *    drives in a volume group.
 *
 */
const lvmOptions = await select({
  message: "How should Logical Volume Manager be setup?",
  choices: [
    {
      name: "One Volume Group per disk type",
      value: "vg-per-disk-type",
      description:
        "Create a volume group for each type of disk (i.e. SSD, HDD) - recommended",
    },
    {
      name: "Cache Pool",
      value: "cache-pool",
      description:
        "Create an LVM cache pool setup in which SSD based storage is used as a cache and backed by HDD based storage for durability.",
    },
    {
      name: "One Volume Group",
      value: "vg-single",
      description: "Create a single volume group regardless of disk type",
    },
  ],
});

/**
 * Setup regions and zones
 *
 * In general it's highly recommended to setup regions and zones for a
 * cluster. By default, Community Cloud is setup to run workloads across zones
 * for higher resiliency in the face of failures.
 *
 * Even if at first you only have machines in a single location
 * setting them up is suggested so in the event of your cluster growing
 * you will be able to benefit from workloads being spread across mulitple
 * zones which will increase the resiliency of your application.
 *
 * We suggest the following topology for a Community Cloud cluster:
 *
 *
 * Region: Setup by country or overall geographic area
 * Zone: A single physical location
 *
 * This setup must follow the constraints for regions and zones within
 * Kubernetes. More details can be found here:
 * https://kubernetes.io/docs/reference/labels-annotations-taints/#topologykubernetesiozone
 */

/**
 * If not configured in the setup file then we setup regions.
 */
const region = await input({ message: "Enter a name for the region" });

/**
 * If not configured in the setup
 */
const zone = await input({ message: "Enter a name for the zone" });
