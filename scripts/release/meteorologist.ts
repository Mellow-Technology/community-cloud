/**
 * @file
 * Releases Meteorologist: tags meteorologist-v<version>, from which
 * .github/workflows/meteorologist.yml publishes
 * ghcr.io/mellow-technology/meteorologist:<version>.
 *
 * Its version is written in two places: package.json, and the image
 * Meteorologist.yaml pins, which is what the installer applies. As for
 * Cirrus, the pin names the image before the tag publishes it, and the
 * installer's release refuses to go out until it has (see
 * installer.ts).
 */
import { main, packageJsonPlace, patternPlace } from "./release";

export const METEOROLOGIST_MANIFEST = "k8s/apps/meteorologist/Meteorologist.yaml";

// The pinned image in Meteorologist.yaml
export const METEOROLOGIST_IMAGE = /image:\s*ghcr\.io\/mellow-technology\/meteorologist:(\S+)/;

export const meteorologist = {
  name: "meteorologist",
  title: "Meteorologist",
  workflow: "meteorologist.yml",
  places: [
    packageJsonPlace("ui/meteorologist/package.json"),
    patternPlace(METEOROLOGIST_MANIFEST, "the image Meteorologist.yaml pins", METEOROLOGIST_IMAGE),
  ],
};

if (import.meta.main) {
  await main(meteorologist);
}
