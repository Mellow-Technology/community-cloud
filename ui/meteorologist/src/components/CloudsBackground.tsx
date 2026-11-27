/**
 * @file
 * Clouds drifting faintly behind every page, for a weather app, with
 * a hot-air balloon among them and birds in the distance.
 *
 * GUI Mellow's Pattern, with a tile of its own that GUI Mellow doesn't
 * have (../lib/cloudsTile.ts): outlines of clouds in a range of sizes,
 * scattered so the repeat doesn't read as a grid, a balloon, and a few
 * small flocks. Like GUI Mellow's patterns,
 * the tile is a mask over --gm-pattern-color, and its lines are the
 * same width whatever a shape's size. The colour is the theme's text
 * colour, thinned, so it suits light and dark alike while showing a
 * little more than the theme's own pattern colour does. It fades out
 * from near the top, and is hidden from screen readers.
 */
import type { CSSProperties } from "react";
import { Pattern } from "gui-mellow/Pattern";

import { CLOUDS_TILE, CLOUDS_TILE_HEIGHT, CLOUDS_TILE_WIDTH } from "@/lib/cloudsTile";

const STYLE = {
  "--gm-pattern": `url("data:image/svg+xml,${encodeURIComponent(CLOUDS_TILE)}")`,
  "--gm-pattern-size": `${CLOUDS_TILE_WIDTH}px ${CLOUDS_TILE_HEIGHT}px`,
  // The theme's text colour, thinned: dark lines on light, light on dark
  "--gm-pattern-color": "color-mix(in oklch, var(--gm-color-text) 15%, transparent)",
} as CSSProperties;

/**
 * Fills its nearest positioned ancestor, behind that ancestor's content.
 *
 * @returns
 */
export function CloudsBackground() {
  return <Pattern fade="radial" style={STYLE} />;
}
