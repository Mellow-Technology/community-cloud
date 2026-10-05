/**
 * @file
 * The site's type, carried inside the plugin.
 *
 * Bundled rather than linked. A console that watches a cluster should
 * not be fetching files from the public internet to draw itself, and a
 * machine that cannot reach Google Fonts — an air-gapped network, a
 * laptop on a plane — would get the fallback stack instead of the
 * thing the theme is for.
 *
 * Both families are variable fonts, so one file covers every weight
 * rather than one file per weight: 62 KB for the two of them, against
 * roughly five times that for the static faces they replace. The
 * `font-weight` range in each face is what tells the browser it may
 * interpolate; without it only the single declared weight is used and
 * everything else is synthesised.
 *
 * The files are the latin subsets Google Fonts serves, and the build
 * inlines them into the bundle — see `scripts/build.mjs`, which raises
 * Vite's inline limit so they do not become separate files the plugin
 * has no way to serve.
 */
import ibmPlexSans from './fonts/ibm-plex-sans.woff2';
import spaceGrotesk from './fonts/space-grotesk.woff2';

/** Body text, as the site sets it. */
export const BODY_FONT = '"IBM Plex Sans", "Helvetica Neue", Helvetica, Arial, sans-serif';

/**
 * Headings, as the site sets them.
 *
 * A Headlamp theme takes one family for everything, so this one is
 * applied to the heading elements separately.
 */
export const HEADING_FONT = '"Space Grotesk", "IBM Plex Sans", Helvetica, Arial, sans-serif';

/**
 * The faces, in the form `GlobalStyles` wants them.
 *
 * `swap` so that text is readable in the fallback while the face
 * decodes, which on a bundled font is a single frame but costs
 * nothing to ask for.
 */
export const FONT_FACES = [
  {
    fontFamily: 'IBM Plex Sans',
    fontStyle: 'normal',
    fontDisplay: 'swap',
    fontWeight: '100 700',
    src: `url(${ibmPlexSans}) format('woff2')`,
  },
  {
    fontFamily: 'Space Grotesk',
    fontStyle: 'normal',
    fontDisplay: 'swap',
    fontWeight: '300 700',
    src: `url(${spaceGrotesk}) format('woff2')`,
  },
];
