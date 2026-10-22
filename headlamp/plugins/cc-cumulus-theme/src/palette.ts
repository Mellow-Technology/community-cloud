/**
 * @file
 * The colours Cumulus is built from, taken off the website.
 *
 * Every value here was read from community-cloud.technology rather
 * than picked to look similar, so that the console and the site stay
 * the same shade of the same colour when either one is adjusted.
 *
 * The site paints its surfaces as white at a low alpha over the page
 * black, which is the right way to do it when everything sits on one
 * known background, and it is kept here wherever a value is only ever
 * painted. Two of them cannot be: Headlamp runs the sidebar's colours
 * through `getContrastText` to decide what to write on them, and that
 * reads an alpha colour as the colour underneath the alpha — white at
 * 7% is read as white, and the text comes back black. Those two are
 * written as the solid colour the alpha resolves to over the page,
 * with the alpha they came from noted.
 *
 * One mapping is worth stating outright: red is the brand, blue is the
 * action. On the site the mark, the section eyebrows and the beta pill
 * are red, while every button you are meant to press is blue. Headlamp
 * paints its buttons and selected states with `primary`, so `primary`
 * is the blue and the red is kept for `secondary`.
 */

/** The page itself. The site's `--background`. */
export const INK = '#0a0d10';

/**
 * Menus, dialogs and anything that floats.
 *
 * Solid, and the one surface that is: a menu is drawn over whatever
 * happens to be beneath it, so it has to carry its own background.
 * This is the site's `rgba(255, 255, 255, 0.04)` resolved over ink.
 */
export const PAPER = '#131619';

/**
 * Cards, tiles, table headers and chips.
 *
 * Translucent, so the page's texture carries through the way the
 * site's cards let its background through.
 */
export const RAISED = 'rgba(255, 255, 255, 0.06)';

/**
 * The surface a table sits on, under its header.
 *
 * A little stronger than the site's own card, which sits on a flat
 * background. This one has the page's grid showing through it, and
 * needs to read as a surface in spite of that.
 */
export const SURFACE = 'rgba(255, 255, 255, 0.065)';

/** Body text. The site's `--foreground`. */
export const TEXT = '#e3e9ed';

/** Secondary text, and the sidebar's resting state. */
export const MUTED_TEXT = '#9ea6ab';

/** The colour of a button you are meant to press. */
export const ACTION = '#0568e2';

/**
 * The lighter blue, for links.
 *
 * The button blue is a shade meant to be read against, not read: on
 * this background it comes to about 3:1, which is under what text
 * needs. This one clears it.
 */
export const ACTION_LIGHT = '#3d92ee';

/** The mark, the eyebrows, the highlighted word. */
export const BRAND = '#ff3552';

/**
 * The hairline around a card or a tile.
 *
 * The site draws this at 0.09, against a fill of 0.02. Raised to keep
 * the same separation from the stronger fill above: an edge that comes
 * out the same shade as what it encloses is not an edge.
 */
export const HAIRLINE = 'rgba(255, 255, 255, 0.12)';

/**
 * The selected row in the sidebar.
 *
 * Solid, for the `getContrastText` reason above: this is the site's
 * `rgba(255, 255, 255, 0.07)` resolved over ink, which comes back dark
 * enough that Headlamp writes white on it.
 */
export const SELECTED = '#1b1e21';
