/**
 * @file
 * The things that describe the cluster as a whole: who runs it, what
 * it's called on the internet, and how much it should spend on staying
 * up.
 *
 * These are written under "values", because that's where the manifests
 * in k8s/ read them from. A chart asking for ".Values.domain.main"
 * finds it there and nowhere else, so the interactive installer writes
 * the shape those templates were written against.
 */
import { checkbox, confirm, input, select } from "@inquirer/prompts";

import {
  ConfigDraft,
  ConfigSection,
  NOTHING_SET,
  readFirstPath,
  readPath,
  validateEmail,
  validateHostname,
  writePath,
} from "../section.ts";
import { findRegionByName, getRegion, regions as worldRegions } from "../../../topology/regions.ts";

/**
 * How much redundancy the cluster should aim for.
 *
 * Recorded for the components that will read it when they're written;
 * nothing acts on it yet.
 */
const RESILIENCY_CHOICES = [
  {
    name: "YOLO (You Only Live Once)",
    value: "yolo",
    description:
      "Use as few resources as possible. The possibility of data loss and service disruption is high, and very real. For single node installations this is the only option.",
  },
  {
    name: "Balanced (Recommended)",
    value: "balanced",
    description:
      "Reasonable resilience without overly consuming resources: services will try to run across three nodes or more.",
  },
  {
    name: "Paranoid (i.e. I've had one too many 3am debug sessions)",
    value: "paranoid",
    description:
      "Discard any notion of reasonable resource management in the ultimate quest for service resilience and stability.",
  },
];

export const clusterSection: ConfigSection = {
  name: "cluster",
  title: "Cluster basics",

  describe: (draft) => {
    const domain = readFirstPath(draft, "values.domain.main", "domains.main");
    const email = readFirstPath(draft, "values.adminEmail", "config.adminEmail");
    const resiliency = readPath(draft, "resiliency");

    if (domain === undefined && email === undefined) {
      return NOTHING_SET;
    }

    return [
      domain !== undefined ? domain : "no domain",
      email !== undefined ? email : "no admin email",
      resiliency !== undefined ? resiliency : "no resiliency level",
    ].join(", ");
  },

  run: async (draft: ConfigDraft) => {
    const adminEmail = await input({
      message: "Administrator email address",
      default: readFirstPath(draft, "values.adminEmail", "config.adminEmail"),
      validate: validateEmail,
    });
    writePath(draft, "values.adminEmail", adminEmail.trim());

    const letsencryptEmail = await input({
      message: "Email address for Let's Encrypt (leave as-is to reuse the above)",
      default: readFirstPath(
        draft,
        "values.letsencryptEmail",
        "config.letsencryptEmail",
        "values.adminEmail",
        "config.adminEmail",
      ) ?? adminEmail.trim(),
      validate: validateEmail,
    });
    writePath(draft, "values.letsencryptEmail", letsencryptEmail.trim());

    const main = await input({
      message: "Primary domain for the cluster",
      default: readFirstPath(draft, "values.domain.main", "domains.main"),
      validate: validateHostname,
    });
    writePath(draft, "values.domain.main", main.trim());

    // The manifests read a hostname per service. Offering them derived
    // from the primary domain saves typing the same thing five times,
    // while still letting any of them live somewhere else.
    const derived = await confirm({
      message: `Derive service hostnames from ${main.trim()}? (auth.${main.trim()}, agent.${main.trim()}, and so on)`,
      default: readFirstPath(draft, "values.domain.auth", "domains.auth") === undefined,
    });

    const services: { key: string; label: string; prefix: string }[] = [
      { key: "auth", label: "Authentik (single sign on)", prefix: "auth" },
      { key: "agent", label: "Picoclaw agent", prefix: "agent" },
      { key: "crm", label: "Twenty (CRM)", prefix: "crm" },
      { key: "mattermost", label: "Mattermost (chat)", prefix: "chat" },
    ];

    for (const service of services) {
      const suggested = `${service.prefix}.${main.trim()}`;
      const current = readFirstPath(draft, `values.domain.${service.key}`, `domains.${service.key}`);

      if (derived && current === undefined) {
        writePath(draft, `values.domain.${service.key}`, suggested);
        continue;
      }

      const hostname = await input({
        message: `Hostname for ${service.label}`,
        default: current !== undefined ? current : suggested,
        validate: validateHostname,
      });
      writePath(draft, `values.domain.${service.key}`, hostname.trim());
    }

    const secondary = await input({
      message: "Secondary domain, if the cluster serves one (leave blank for none)",
      default: readFirstPath(draft, "values.domain.secondary", "domains.secondary") ?? "",
      validate: (value: string) => (value.trim() === "" ? true : validateHostname(value)),
    });
    writePath(draft, "values.domain.secondary", secondary.trim());

    const resiliency = await select({
      message: "How resilient to failure would you like your Community Cloud instance to be?",
      default: readPath(draft, "resiliency") ?? "balanced",
      choices: RESILIENCY_CHOICES,
    });
    writePath(draft, "resiliency", resiliency);
  },
};

export const topologySection: ConfigSection = {
  name: "topology",
  title: "Regions and zones",

  describe: (draft) => {
    const chosen = readPath(draft, "regions");

    if (!Array.isArray(chosen) || chosen.length === 0) {
      return NOTHING_SET;
    }

    return chosen.map((region: any) => `${region.name} (${region.value})`).join(", ");
  },

  run: async (draft: ConfigDraft) => {
    console.log(`
  Regions and zones are worth setting up even for a cluster that lives
  in one place today. Workloads are spread across zones for resilience,
  so a cluster that later grows into a second location benefits without
  anything being rearranged.

  Regions come from a fixed list, so that two clusters in the same part
  of the world end up calling it the same thing. A zone is a single
  physical location within a region, and is set per node.
`);

    const existing = Array.isArray(readPath(draft, "regions"))
      ? (readPath(draft, "regions") as any[])
      : [];

    // What's already in use, from the regions list and from the nodes
    // themselves. A configuration written before this list existed may
    // name a region without having an entry for it.
    const inUse = new Set<string>();

    for (const region of existing) {
      const byCode = getRegion(String(region.value));
      const byName = region.name !== undefined ? findRegionByName(String(region.name)) : undefined;
      const matched = byCode !== undefined ? byCode : byName;

      if (matched !== undefined) {
        inUse.add(matched.code);
      }
    }

    const nodes = readPath(draft, "nodes");
    for (const node of Array.isArray(nodes) ? nodes : []) {
      if (node !== null && typeof node === "object" && node.region !== undefined) {
        const matched = getRegion(String(node.region));
        if (matched !== undefined) {
          inUse.add(matched.code);
        }
      }
    }

    const chosen = await checkbox({
      message: "Which regions does this cluster have machines in?",
      pageSize: 12,
      choices: worldRegions.map((region) => ({
        name: `${region.name}  (${region.code})`,
        value: region.code,
        description: region.note,
        checked: inUse.has(region.code),
      })),
    });

    // Anything the configuration named that isn't in the list is kept
    // rather than quietly dropped: it may well be deliberate, and a
    // node could be pointing at it.
    const custom = existing.filter((region: any) => {
      const byCode = getRegion(String(region.value));
      const byName = region.name !== undefined ? findRegionByName(String(region.name)) : undefined;
      return byCode === undefined && byName === undefined;
    });

    if (custom.length > 0) {
      console.log(
        `  Keeping ${custom.length === 1 ? "a region" : "regions"} not in the standard list: ${custom
          .map((region: any) => `${region.name} (${region.value})`)
          .join(", ")}`,
      );
    }

    const selected = chosen
      .map((code) => getRegion(code))
      .filter((region): region is NonNullable<typeof region> => region !== undefined)
      .map((region) => ({ name: region.name, value: region.code }));

    writePath(draft, "regions", [...selected, ...custom]);

    // The nodes section offers these when asking where a node lives,
    // so a cluster with none configured has nothing to offer
    if (selected.length === 0 && custom.length === 0) {
      console.log("  No regions selected, so nodes won't be asked which region they're in.");
    }
  },
};
