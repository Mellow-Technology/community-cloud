/**
 * @file
 * The tile behind every page (../components/CloudsBackground.tsx), as
 * SVG: clouds in a range of sizes and one airliner, drawn in black,
 * since it's used as a mask and only its shape counts.
 */

// Every line drawn the same width, however a shape is scaled
const LINE = "vector-effect='non-scaling-stroke'";

// One cloud, 46 by 26: a flat base and three lobes
const CLOUD = `<path ${LINE} d='M6 24H40A7 7 0 0 0 40 10A10 10 0 0 0 21 6A7 7 0 0 0 9 12A6 6 0 0 0 6 24Z'/>`;

// An airliner from the side, nose to the right, 64 by 26: fuselage,
// tail fin, tailplane, a swept wing with its engine, and the cockpit
const PLANE = [
  "M6 13Q6 10 10 10H52Q60 10 63 13Q60 16 52 16H10Q6 16 6 13Z",
  "M10 10L5 2H10L18 10",
  "M9 14L3 17H9",
  "M30 14L21 24H26L39 15",
  "M24 19.5H31",
  "M53 11.5H57",
]
  .map((d) => `<path ${LINE} d='${d}'/>`)
  .join("");

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
  // One plane to a tile, climbing gently
  `<g transform='translate(252 222) rotate(-9) scale(1.4)'>${PLANE}</g>` +
  "</g></svg>";
