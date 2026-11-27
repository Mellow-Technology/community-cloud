/**
 * @file
 * The tile behind every page (../components/CloudsBackground.tsx), as
 * SVG: clouds in a range of sizes, a hot-air balloon, and birds in the
 * distance, drawn in black,
 * since it's used as a mask and only its shape counts.
 */

// Every line drawn the same width, however a shape is scaled
const LINE = "vector-effect='non-scaling-stroke'";

// One cloud, 46 by 26: a flat base and three lobes
const CLOUD = `<path ${LINE} d='M6 24H40A7 7 0 0 0 40 10A10 10 0 0 0 21 6A7 7 0 0 0 9 12A6 6 0 0 0 6 24Z'/>`;

// A hot-air balloon, 30 by 41: its envelope with two seams, the ropes
// and the basket
const BALLOON = [
  "M15 2C7 2 2 8 2 15C2 22 9 27 12 31H18C21 27 28 22 28 15C28 8 23 2 15 2Z",
  "M15 2C10 8 10 24 13 31",
  "M15 2C20 8 20 24 17 31",
  "M12 31L13 36",
  "M18 31L17 36",
  "M12.5 36H17.5V41H12.5Z",
]
  .map((d) => `<path ${LINE} d='${d}'/>`)
  .join("");

// A bird in the distance, 10 by 4: a soft "v", wingtips up
const BIRD = `<path ${LINE} d='M0 0Q3 1 5 4Q7 1 10 0'/>`;

/**
 * A few birds flying together, staggered.
 *
 * @param x
 * @param y
 * @param size
 * @param count
 * @returns
 */
function flock(x: number, y: number, size: number, count: number): string {
  return Array.from(
    { length: count },
    (_, at) => `<g transform='translate(${x + at * 15 * size} ${y + (at % 2) * 7 * size}) scale(${size})'>${BIRD}</g>`,
  ).join("");
}

// Where the clouds go on the tile: x, y and size
const CLOUDS: Array<[number, number, number]> = [
  [14, 12, 1],
  [116, 34, 1.35],
  [48, 86, 0.7],
  [150, 108, 0.9],
  [250, 20, 0.8],
  [350, 60, 1.2],
  [300, 120, 0.65],
  [20, 170, 1.1],
  [130, 230, 0.75],
  [190, 160, 0.6],
  [370, 220, 0.95],
];

export const CLOUDS_TILE_WIDTH = 440;
export const CLOUDS_TILE_HEIGHT = 300;

export const CLOUDS_TILE =
  `<svg xmlns='http://www.w3.org/2000/svg' width='${CLOUDS_TILE_WIDTH}' height='${CLOUDS_TILE_HEIGHT}'>` +
  "<g fill='none' stroke='black' stroke-width='1.25' stroke-linejoin='round' stroke-linecap='round'>" +
  CLOUDS.map(([x, y, size]) => `<g transform='translate(${x} ${y}) scale(${size})'>${CLOUD}</g>`).join("") +
  // One balloon to a tile, and a few flocks
  `<g transform='translate(262 196) scale(1.3)'>${BALLOON}</g>` +
  flock(222, 70, 1.2, 3) +
  flock(60, 130, 0.9, 2) +
  flock(330, 170, 1, 2) +
  flock(96, 270, 0.8, 3) +
  "</g></svg>";
