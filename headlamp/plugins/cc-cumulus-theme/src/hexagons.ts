/**
 * @file
 * The honeycomb the page is textured with.
 *
 * This started as the square grid from the site's hero, and a square
 * grid turns out to be the wrong thing to put behind a console. Its
 * vertical lines run parallel to a table's columns at a similar
 * spacing, so the eye reads them as column rules — lines that mean
 * something — and goes looking for the relationship between a line and
 * the data either side of it. There is none, and that is tiring in a
 * way that a texture should never be.
 *
 * A honeycomb has no long straight line in any direction, so nothing
 * in it lines up with anything in a table. It reads as surface rather
 * than structure, which is the whole job.
 *
 * Drawn as an SVG rather than with repeating gradients because the
 * lattice needs three line directions and gradients would want three
 * stacked layers of it, each one costing another pass over every pixel
 * of a full-window background.
 */

/** The side length of one hexagon, in pixels. */
const SIDE = 32;

/**
 * The lattice colour.
 *
 * Faint enough to disappear under a table's surface and still carry on
 * the open page. Below about 0.03 it stops registering as anything;
 * above about 0.06 it starts competing with the content.
 */
const STROKE = 'rgba(255, 255, 255, 0.045)';

/**
 * To three decimal places, which is finer than a device pixel.
 *
 * @param value
 * @returns
 */
function round(value: number): number {
  return Number(value.toFixed(3));
}

/**
 * One hexagon's outline, as SVG path data.
 *
 * Flat-topped, which is what puts a vertex rather than an edge at the
 * left and right of each cell and keeps the lattice from forming
 * continuous vertical runs.
 *
 * @param cx
 * @param cy
 * @returns
 */
function hexagonPath(cx: number, cy: number): string {
  const points = [];

  for (let corner = 0; corner < 6; corner += 1) {
    const angle = (Math.PI / 180) * 60 * corner;
    const x = round(cx + SIDE * Math.cos(angle));
    const y = round(cy + SIDE * Math.sin(angle));
    points.push(`${x} ${y}`);
  }

  return `M${points.join(' L')} Z`;
}

/**
 * The repeating tile.
 *
 * A honeycomb repeats over a rectangle three sides wide and one
 * hexagon tall, with the middle column offset by half a cell. Four
 * centres cover it: one on each vertical edge and one on each
 * horizontal edge. Each is drawn whole and clipped to the part inside
 * the tile, and the part that was clipped is exactly what the next
 * tile along draws from its own opposite edge, so the seam closes.
 *
 * @returns
 */
function buildTile() {
  // Rounded, because the tile's height is irrational and the figure
  // ends up in three places — the viewBox, the SVG's own height and
  // the CSS background size. They have to agree exactly or the lattice
  // drifts a fraction of a pixel per tile and the seams show.
  const halfHeight = round((SIDE * Math.sqrt(3)) / 2);
  const width = 3 * SIDE;
  const height = 2 * halfHeight;

  const centres: [number, number][] = [
    [0, halfHeight],
    [width, halfHeight],
    [width / 2, 0],
    [width / 2, height],
  ];

  const path = centres.map(([cx, cy]) => hexagonPath(cx, cy)).join(' ');
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" ` +
    `viewBox="0 0 ${width} ${height}">` +
    `<path d="${path}" fill="none" stroke="${STROKE}" stroke-width="1"/></svg>`;

  return {
    image: `url("data:image/svg+xml,${encodeURIComponent(svg)}")`,
    size: `${width}px ${height}px`,
  };
}

export const HEXAGONS = buildTile();
