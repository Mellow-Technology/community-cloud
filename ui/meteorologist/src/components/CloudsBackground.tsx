/**
 * @file
 * Clouds drifting faintly behind every page, for a weather app.
 *
 * GUI Mellow's Pattern, with a tile of its own that GUI Mellow doesn't
 * have: outlines of clouds, three sizes, scattered so the repeat
 * doesn't read as a grid. Like GUI Mellow's patterns, the tile is a
 * mask over the theme's --gm-pattern-color, so it suits light and dark
 * alike, and its lines are the same width whatever a cloud's size. It
 * fades out from near the top, and is hidden from screen readers.
 */
import type { CSSProperties } from "react";
import { Pattern } from "gui-mellow/Pattern";

// One cloud, 46 by 26: a flat base and three lobes
const CLOUD =
  "<path vector-effect='non-scaling-stroke' d='M6 24H40A7 7 0 0 0 40 10A10 10 0 0 0 21 6A7 7 0 0 0 9 12A6 6 0 0 0 6 24Z'/>";

// Four to a tile, at different sizes and uneven places
const TILE =
  "<svg xmlns='http://www.w3.org/2000/svg' width='220' height='150'>" +
  "<g fill='none' stroke='black' stroke-width='1.25' stroke-linejoin='round'>" +
  `<g transform='translate(14 12)'>${CLOUD}</g>` +
  `<g transform='translate(116 34) scale(1.35)'>${CLOUD}</g>` +
  `<g transform='translate(48 86) scale(0.7)'>${CLOUD}</g>` +
  `<g transform='translate(150 108) scale(0.9)'>${CLOUD}</g>` +
  "</g></svg>";

const STYLE = {
  "--gm-pattern": `url("data:image/svg+xml,${encodeURIComponent(TILE)}")`,
  "--gm-pattern-size": "220px 150px",
} as CSSProperties;

/**
 * Fills its nearest positioned ancestor, behind that ancestor's content.
 *
 * @returns
 */
export function CloudsBackground() {
  return <Pattern fade="radial" style={STYLE} />;
}
