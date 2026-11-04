/**
 * @file
 * Releases the installer: tags installer-v<version>, from which
 * .github/workflows/installer.yml builds every executable and publishes
 * them as a GitHub release.
 *
 * Its own version is package.json's. The workflow writes the tag's
 * version into the executables, so package.json is what says which
 * release main is heading for, and this keeps the tag and it the same.
 *
 * The installer carries the manifests under k8s/ inside it, and some
 * of them pin images of ours. A release is a promise those can be
 * pulled, so each pinned image's own release has to be out first:
 * after `cirrus.ts set` reaches main, Cirrus.yaml names an image that
 * only exists once Cirrus is tagged.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { CIRRUS_IMAGE, CIRRUS_MANIFEST } from "./cirrus";
import { METEOROLOGIST_IMAGE, METEOROLOGIST_MANIFEST } from "./meteorologist";
import { type CheckContext, ROOT, main, packageJsonPlace, tagFor } from "./release";

// Images of ours the embedded manifests pin, and the release that
// publishes each
const PINNED_IMAGES = [
  { component: "cirrus", title: "Cirrus", file: CIRRUS_MANIFEST, pattern: CIRRUS_IMAGE },
  { component: "meteorologist", title: "Meteorologist", file: METEOROLOGIST_MANIFEST, pattern: METEOROLOGIST_IMAGE },
];

/**
 * Every pinned image whose release isn't out.
 *
 * @param context
 * @returns
 */
async function pinnedImagesReleased({ remoteTags }: CheckContext): Promise<string[]> {
  const problems: string[] = [];
  for (const pinned of PINNED_IMAGES) {
    const text = await readFile(join(ROOT, pinned.file), "utf8");
    const version = pinned.pattern.exec(text)?.[1];
    if (version === undefined) {
      problems.push(`Couldn't find the image ${pinned.file} pins.`);
      continue;
    }
    const tag = tagFor({ name: pinned.component }, version);
    console.log(`  ${pinned.title} image pinned in ${pinned.file}: ${version}`);
    if (!remoteTags.has(tag)) {
      problems.push(
        `${pinned.file} pins ${pinned.title} ${version}, which isn't released. Release it first: ` +
          `\`bun scripts/release/${pinned.component}.ts\`.`,
      );
    }
  }
  return problems;
}

export const installer = {
  name: "installer",
  title: "the installer",
  workflow: "installer.yml",
  places: [packageJsonPlace("installer/package.json")],
  checks: pinnedImagesReleased,
};

if (import.meta.main) {
  await main(installer);
}
