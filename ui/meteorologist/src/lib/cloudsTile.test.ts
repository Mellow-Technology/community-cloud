import { expect, test } from "bun:test";

import { CLOUDS_TILE, CLOUDS_TILE_HEIGHT, CLOUDS_TILE_WIDTH } from "./cloudsTile";

test("the tile is SVG of the size it says, with clouds and a plane", () => {
  expect(
    CLOUDS_TILE.startsWith(
      `<svg xmlns='http://www.w3.org/2000/svg' width='${CLOUDS_TILE_WIDTH}' height='${CLOUDS_TILE_HEIGHT}'>`,
    ),
  ).toBe(true);
  expect(CLOUDS_TILE.endsWith("</svg>")).toBe(true);
  // Eleven clouds and the plane's six lines
  expect(CLOUDS_TILE.match(/<path /g)).toHaveLength(17);
  // Balanced: every group opened is closed
  expect(CLOUDS_TILE.match(/<g[ >]/g)?.length).toBe(CLOUDS_TILE.match(/<\/g>/g)?.length);
});
