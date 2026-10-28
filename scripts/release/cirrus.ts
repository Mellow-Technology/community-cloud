/**
 * @file
 * Releases Cirrus: tags cirrus-v<version>, from which
 * .github/workflows/cirrus.yml publishes
 * ghcr.io/mellow-technology/cirrus:<version>.
 *
 * Its version is written in three places, and they have to move
 * together. Cargo.lock repeats Cargo.toml's, and `cargo build --locked`
 * refuses a lockfile that's behind. Cirrus.yaml pins the image the
 * installer applies, beside the CRD built from the same source, so a
 * release whose pin is older would install an operator that doesn't
 * match its own CRD.
 *
 * The pin names the image before the tag publishes it; between `set`
 * reaching main and the release, an installer built from main points
 * at an image that isn't there yet. The installer's own release
 * refuses to go out in that state (see installer.ts).
 */
import { main, patternPlace } from "./release";

export const CIRRUS_MANIFEST = "k8s/operators/cirrus/Cirrus.yaml";

// The pinned image in Cirrus.yaml
export const CIRRUS_IMAGE = /image:\s*ghcr\.io\/mellow-technology\/cirrus:(\S+)/;

export const cirrus = {
  name: "cirrus",
  title: "Cirrus",
  workflow: "cirrus.yml",
  places: [
    patternPlace("operators/cirrus/Cargo.toml", "the crate's version", /^\[package\][^[]*?^version\s*=\s*"([^"]+)"/m),
    patternPlace(
      "operators/cirrus/Cargo.lock",
      "the lockfile's version for cirrus",
      /^name = "cirrus"\nversion = "([^"]+)"/m,
    ),
    patternPlace(CIRRUS_MANIFEST, "the image Cirrus.yaml pins", CIRRUS_IMAGE),
  ],
};

if (import.meta.main) {
  await main(cirrus);
}
