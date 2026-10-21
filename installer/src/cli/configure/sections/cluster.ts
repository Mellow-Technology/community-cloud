/**
 * @file
 * The things that describe the cluster as a whole: who runs it, and
 * what it's called on the internet.
 *
 * These are written under "values", because that's where the manifests
 * in k8s/ read them from. A chart asking for ".Values.domain.main"
 * finds it there and nowhere else, so the interactive installer writes
 * the shape those templates were written against.
 */
import { confirm, input } from "@inquirer/prompts";

import {
  ConfigDraft,
  ConfigSection,
  NOTHING_SET,
  readFirstPath,
  validateEmail,
  validateHostname,
  writePath,
} from "../section.ts";

export const clusterSection: ConfigSection = {
  name: "cluster",
  title: "Cluster basics",

  describe: (draft) => {
    const domain = readFirstPath(draft, "values.domain.main", "domains.main");
    const email = readFirstPath(draft, "values.adminEmail", "config.adminEmail");

    if (domain === undefined && email === undefined) {
      return NOTHING_SET;
    }

    return [
      domain !== undefined ? domain : "no domain",
      email !== undefined ? email : "no admin email",
    ].join(", ");
  },

  run: async (draft: ConfigDraft) => {
    const adminEmail = await input({
      message: "Administrator email address",
      default: readFirstPath(draft, "values.adminEmail", "config.adminEmail"),
      validate: validateEmail,
    });
    writePath(draft, "values.adminEmail", adminEmail.trim());

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
      { key: "invoicing", label: "Invoice Ninja (invoicing)", prefix: "invoice" },
      { key: "signing", label: "Documenso (document signing)", prefix: "sign" },
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
  },
};
