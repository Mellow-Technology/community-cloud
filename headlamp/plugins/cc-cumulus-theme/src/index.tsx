/**
 * @file
 * Cumulus: Headlamp dressed as Community Cloud.
 *
 * The console and the website should look like one product, so the
 * colours, the corner radius and the type here are the site's own,
 * read off it rather than matched by eye. They live in `palette.ts`
 * and `fonts.ts`.
 *
 * What a Headlamp theme can carry is a list of palette colours, and
 * two kinds of thing have to be done outside it.
 *
 * Gradients, because every theme colour is handed to Material UI as a
 * palette value and the places those end up will not take one: the
 * sidebar's colours are run through `getContrastText`, which throws on
 * anything it cannot decompose into a colour, and the rest are
 * assigned to `backgroundColor`, which ignores a gradient and leaves
 * the element with no background at all.
 *
 * And surfaces, because the components that need one do not take their
 * background from a palette colour. A table's header row carries
 * `display: contents`, which paints nothing at all, and the card a
 * table sits in takes Material UI's own paper colour. Against a page
 * this dark both come out as very nearly the page itself, and a table
 * with no surface under it is a hard thing to read.
 *
 * So both are done as `GlobalStyles`, rendered alongside the logo, and
 * every rule is additive: a colour laid over a colour the theme has
 * already set. A selector that stops matching costs the surface and
 * nothing else.
 */
import { AppLogoProps, registerAppLogo, registerAppTheme } from '@kinvolk/headlamp-plugin/lib';
import GlobalStyles from '@mui/material/GlobalStyles';
import { useTheme } from '@mui/material/styles';
import { BODY_FONT, FONT_FACES, HEADING_FONT } from './fonts';
import { HEXAGONS } from './hexagons';
import { COMMUNITY_CLOUD_LOGO } from './logo';
import {
  ACTION,
  ACTION_LIGHT,
  BRAND,
  HAIRLINE,
  INK,
  MUTED_TEXT,
  PAPER,
  RAISED,
  SELECTED,
  SURFACE,
  TEXT,
} from './palette';

registerAppTheme({
  name: 'Cumulus',
  base: 'dark',
  primary: ACTION,
  secondary: BRAND,
  text: { primary: TEXT },
  link: { color: ACTION_LIGHT },
  background: {
    default: INK,
    surface: PAPER,
    muted: RAISED,
  },
  navbar: {
    background: INK,
    color: TEXT,
  },
  sidebar: {
    background: INK,
    color: MUTED_TEXT,
    selectedBackground: SELECTED,
    selectedColor: '#ffffff',
    actionBackground: ACTION,
  },
  // The site rounds its buttons at 6 and its cards at 10 to 12.
  // Headlamp has the one radius for both.
  radius: 8,
  buttonTextTransform: 'none',
  fontFamily: [BODY_FONT],
});

/**
 * Light across the page, for the panels to show.
 *
 * These exist because of the blur below. A blur takes a thin line and
 * spreads it over its own diameter, so a one pixel lattice line under
 * a twelve pixel blur keeps about a twentieth of its contrast — which
 * of 4.5% white is nothing at all. Everything that made a panel read
 * as translucent is exactly what the blur destroys, and the result is
 * a panel that looks painted on.
 *
 * What survives a blur is anything broader than it. So the page also
 * carries a few very large, very faint pools of light: invisible as
 * shapes, but enough that a panel laid over one is lighter at one edge
 * than the other, and visibly lighter than a panel laid somewhere
 * else. That difference is the whole of the effect. Without them the
 * blur has nothing to reveal and may as well not be there.
 */
const PAGE_WASHES = [
  'radial-gradient(900px 620px at 10% 0%, rgba(255, 255, 255, 0.045), transparent 70%)',
  'radial-gradient(1100px 720px at 90% 45%, rgba(255, 255, 255, 0.038), transparent 70%)',
  'radial-gradient(900px 820px at 40% 105%, rgba(255, 255, 255, 0.03), transparent 70%)',
];

/**
 * Frosted glass, for the surfaces laid over all that.
 *
 * 12px is past the point where the hexagons stop being separately
 * visible, and far short of where the pools of light start to smear
 * into each other. The inset highlight along the top edge is the part
 * that reads as a pane catching the light rather than a patch of fog.
 *
 * The usual recipe pairs the blur with a `saturate()`, which is left
 * out here: the backdrop is white light on near black and there is no
 * colour in it to lift.
 */
const GLASS = {
  backdropFilter: 'blur(8px)',
  WebkitBackdropFilter: 'blur(8px)',
  boxShadow: 'inset 0 1px 0 rgba(255, 255, 255, 0.1)',
};

/**
 * Whether Cumulus is the theme currently in use.
 *
 * Headlamp gives a plugin no way to ask which theme is selected, so
 * this goes by the one colour Cumulus is sure to have set. Material UI
 * may hand back either the hex it was given or an `rgb()` form of it,
 * so both are accepted.
 *
 * @param background
 * @returns
 */
function isCumulus(background?: string): boolean {
  if (!background) {
    return false;
  }

  const value = background.toLowerCase().replace(/\s/g, '');

  return value === INK || value === 'rgb(10,13,16)';
}

/**
 * Everything the theme itself cannot say.
 *
 * Only rendered while Cumulus is the chosen theme: these are global
 * rules, and someone who has switched to Headlamp's own dark theme
 * should get Headlamp's own dark theme.
 *
 * @returns
 */
function CumulusStyles() {
  const theme = useTheme();

  if (!isCumulus(theme.palette.background.default)) {
    return null;
  }

  return (
    <GlobalStyles
      styles={{
        '@font-face': FONT_FACES,

        // The site sets its headings in Space Grotesk and its text in
        // IBM Plex Sans. A theme takes the one family, so the headings
        // are named here.
        'h1, h2, h3, h4, h5, h6': { fontFamily: HEADING_FONT },
        '.MuiTypography-h1, .MuiTypography-h2, .MuiTypography-h3': {
          fontFamily: HEADING_FONT,
        },
        '.MuiTypography-h4, .MuiTypography-h5, .MuiTypography-h6': {
          fontFamily: HEADING_FONT,
        },

        // The pools of light, and the honeycomb over them: see
        // `hexagons.ts` for why the site's square grid had to go. The
        // sizes are built from the same list as the images so the two
        // cannot fall out of step. Fixed, so the light stays where it
        // is while a long list scrolls over it.
        body: {
          backgroundImage: [...PAGE_WASHES, HEXAGONS.image].join(', '),
          backgroundSize: [...PAGE_WASHES.map(() => 'auto'), HEXAGONS.size].join(', '),
          backgroundAttachment: 'fixed',
        },

        // The table itself is the surface. Headlamp builds its tables
        // as a CSS grid on the `table` element, with no container and
        // no paper around it, and Material React Table gives every
        // cell `background-color: inherit` — which is how a selected
        // row is coloured, by setting the background on the `tr` the
        // cells inherit from. Body rows set nothing, so their cells
        // come out transparent and the page shows straight through.
        //
        // Painting the table element puts a surface behind all of
        // them at once, and leaves that inheritance alone: the header
        // row still takes `background.muted`, and a selected row still
        // takes its highlight, both now over this instead of over the
        // page. Doubled class for specificity, so the fill is not a
        // tie with Material UI's own rule for the same element.
        '.MuiTable-root.MuiTable-root': {
          backgroundColor: SURFACE,
          borderColor: HAIRLINE,
          ...GLASS,
        },

        // The tiles on the cluster overview, and every other outlined
        // card, take the site's hairline rather than Material UI's.
        '.MuiPaper-outlined': {
          borderColor: HAIRLINE,
          ...GLASS,
        },

        // Those tiles are capped at 300px and centred in their cell by
        // a `margin: 0 auto` of their own. Where the cell is wider than
        // the cap — the workloads overview gives each one a twelfth of
        // the page, which on a wide window is a good deal more — they
        // drift inwards and stop lining up with the heading above them
        // and with the table below. Two classes, because the margin
        // being overridden comes from the component's own `sx`.
        '.MuiGrid-item > .MuiPaper-outlined': {
          marginLeft: 0,
          marginRight: 'auto',
        },

        // A light at the top of the sidebar, falling off over roughly
        // the height of the menu, so it reads as lit from the navbar
        // rather than as a second black rectangle.
        '.MuiDrawer-paper': {
          backgroundImage: `linear-gradient(180deg, rgba(255, 255, 255, 0.035) 0%,
            rgba(255, 255, 255, 0) 280px)`,
        },

        // The same idea along the top bar.
        '.MuiAppBar-root': {
          backgroundImage: `linear-gradient(180deg, rgba(255, 255, 255, 0.04) 0%,
            rgba(255, 255, 255, 0) 100%)`,
        },
      }}
    />
  );
}

/**
 * The mark, and with it everything above.
 *
 * They are rendered from here because the logo is the one component
 * this plugin puts on screen that is always mounted, which saves
 * registering an app bar action that would draw nothing.
 *
 * @param props
 * @returns
 */
function CommunityCloudLogo({ logoType }: AppLogoProps) {
  return (
    <>
      <CumulusStyles />
      <img
        src={COMMUNITY_CLOUD_LOGO}
        alt="Community Cloud"
        height={logoType === 'small' ? 24 : 32}
        style={{ display: 'block' }}
      />
    </>
  );
}

registerAppLogo(CommunityCloudLogo);
