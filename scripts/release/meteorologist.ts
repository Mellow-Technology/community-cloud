/**
 * @file
 * Releases Meteorologist: tags meteorologist-v<version>, from which
 * .github/workflows/meteorologist.yml publishes
 * ghcr.io/mellow-technology/meteorologist:<version>.
 *
 * For now package.json is the only place its version is written. Once
 * the installer applies Meteorologist, its manifest's pinned image
 * joins it here, as Cirrus.yaml's does in cirrus.ts, and installer.ts
 * checks that pin has been released.
 */
import { main, packageJsonPlace } from "./release";

export const meteorologist = {
  name: "meteorologist",
  title: "Meteorologist",
  workflow: "meteorologist.yml",
  places: [packageJsonPlace("ui/meteorologist/package.json")],
};

if (import.meta.main) {
  await main(meteorologist);
}
