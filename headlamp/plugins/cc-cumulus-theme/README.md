# cc-cumulus-theme

Cumulus, the Community Cloud theme for [Headlamp](https://headlamp.dev), plus
the Community Cloud mark in place of Headlamp's own logo.

Pick it in Headlamp under **Settings → General → Theme**.

## What it looks like

The colours, the corner radius and the type are the website's, read off
community-cloud.technology rather than matched by eye, so the two stay in step.
They are in [`src/palette.ts`](src/palette.ts) with the site token each came
from.

| Role | Colour | On the site |
| --- | --- | --- |
| Page | `#0a0d10` | `--background` |
| Menus, dialogs | `#131619` | `rgba(255,255,255,0.04)` over the page |
| Tables | `rgba(255,255,255,0.065)` | the card fill, strengthened for the texture behind it |
| Tiles, table headers, chips | `rgba(255,255,255,0.06)` | the raised card fill |
| Hairlines | `rgba(255,255,255,0.12)` | the card border, strengthened to suit the fill |
| Text | `#e3e9ed` | `--foreground` |
| Buttons, selected state | `#0568e2` | the primary button |
| Links | `#3d92ee` | the lighter blue, which clears 4.5:1 on the page |
| Brand accent | `#ff3552` | the mark, the eyebrows, the beta pill |

Red is the brand and blue is the action: on the site every button you are meant
to press is blue, while the red is the mark and the highlights. Headlamp paints
buttons and selected states with `primary`, so `primary` is the blue and the red
is `secondary`.

## What the theme cannot carry

A Headlamp theme is a list of palette colours. Two things have to be done outside
it, both as `GlobalStyles` rendered alongside the logo and applied only while
Cumulus is the selected theme.

**Gradients.** Every theme colour becomes a Material UI palette value, and the
two places those land both reject one: the sidebar and navbar colours are passed
through `getContrastText`/`getContrastRatio`, which throw on anything that will
not decompose into a colour, and the rest are assigned to `backgroundColor`,
which ignores a gradient and leaves the element with no background at all.

**Surfaces.** The components that most need one do not take it from a palette
colour. A table's header row carries `display: contents`, which paints no
background whatever it is given, and the card a table sits in uses Material UI's
own paper colour plus an elevation gradient. Against a page this dark both come
out as very nearly the page itself.

So the stylesheet sets, over colours the theme has already applied: a honeycomb
texture on the page; a soft light at the top of the sidebar and app bar; the
site's fill and hairline on `.MuiTable-root`; the site's hairline on
`.MuiPaper-outlined`, which is what the overview tiles are; and the left edge of
those tiles, which their own `margin: 0 auto` otherwise centres in a grid cell
that can be much wider than their 300px cap.

The table rule paints the `table` element itself, which is worth knowing if it
ever needs changing. Headlamp lays its tables out as a CSS grid directly on that
element — there is no container and no paper around it — and Material React Table
gives every cell `background-color: inherit`. That inheritance is load-bearing:
it is how a selected row gets its highlight, by setting a background on the `tr`
the cells take their colour from. Body rows set nothing, so their cells are
transparent and the page reads straight through them. Painting the table element
puts one surface behind all of them without touching any of that — the header row
still takes `background.muted` and a selected row still takes its highlight, both
now over the surface instead of over the page.

Every rule is additive. If a selector stops matching, the surface under it is
already the right colour and only the texture is lost.

### One trap worth knowing

`getContrastText` reads an alpha colour as the colour behind the alpha — white at
7% comes back as white, and it returns black text. Headlamp uses it to colour the
selected sidebar item, so `sidebar.selectedBackground` and the other sidebar
colours have to be the solid shade the alpha resolves to, not the alpha itself.
`palette.ts` marks which values are solid for this reason.

## Fonts

The site's type is bundled: IBM Plex Sans for text, Space Grotesk for headings,
in `src/fonts/`. Nothing is fetched at runtime, so the theme looks the same on an
air-gapped network as on a laptop with a connection.

Both are variable fonts, so one file covers every weight — 62 KB for the pair,
against roughly five times that for the static faces. A Headlamp theme takes one
family for everything, so Space Grotesk is applied to the heading elements by the
same stylesheet as the surfaces.

The files are inlined into `main.js` at build time, because a plugin is a single
JavaScript file served from its folder with nothing to serve a second file from.
That needs Vite's asset inline limit raised above its 4 KB default, which
`scripts/build.mjs` does, which is what `npm run build` runs. A build through
`headlamp-plugin build` would emit the fonts as separate files that nothing
requests, and the theme would quietly fall back.

## Building and installing

```bash
npm install && npm run build && npm run deploy:local
```

Then reload Headlamp (Cmd/Ctrl+R).

The scripts call `tsc`, `eslint`, `prettier` and Vite directly rather than going
through the `headlamp-plugin` CLI, which does not run on Node 26 — it fails
inside yargs with `ReferenceError: require is not defined in ES module scope`.
`npm run check` does the type check, lint and formatting check in one go.

That also rules out `headlamp-plugin`'s `start` (watch mode), `package`,
`storybook`, `test` and `i18n`, so there are no scripts for them; on an older
Node they can be run with `npx @kinvolk/headlamp-plugin <command>`. Without watch
mode, a change means `npm run build && npm run deploy:local` and a reload.

See [`../cc-storage-explorer/README.md`](../cc-storage-explorer/README.md) for
the plugin directory each platform installs into.

## The background texture

The page carries a honeycomb, built in [`src/hexagons.ts`](src/hexagons.ts). It
began as the square grid from the site's hero, which turned out to be the wrong
thing to put behind a console: its vertical lines run parallel to a table's
columns at a similar spacing, so they read as column rules and invite you to look
for a relationship between a line and the data either side of it. There is none.

A honeycomb has no long straight line in any direction, so nothing in it aligns
with anything in a table and it reads as surface rather than structure. It is one
SVG tile repeated — 96 x 55.426 px for a 32px side — rather than stacked
repeating gradients, which would need three layers for the three line directions
and three passes over every pixel of a full-window background.

The two knobs are `SIDE` and `STROKE` in that file. Below about 0.03 alpha the
lattice stops registering; above about 0.06 it starts competing with the content.

Tables and tiles sit over it behind a `backdrop-filter: blur(12px)`, with a one
pixel inset highlight along their top edge.

That blur comes with a catch worth understanding before touching any of these
values. A blur spreads a line over its own diameter, so a one pixel lattice line
under a twelve pixel blur keeps roughly a twentieth of its contrast — which of
4.5% white is nothing. The lattice showing through is the only thing that made a
panel read as translucent, so blurring it leaves a panel that looks painted on.
Measured: 3px of blur is already enough to erase it.

What survives a blur is anything broader than it. So the page also carries three
very large, very faint pools of light (`PAGE_WASHES` in `src/index.tsx`) which are
invisible as shapes but mean a panel laid over one is lighter at one edge than the
other, and lighter than a panel sitting elsewhere. That difference is the whole of
the glass effect. Remove the washes and the blur has nothing to reveal.

The blur is layered over a `background-attachment: fixed` page, which is the
expensive combination of the two: if scrolling a long list ever feels heavy, that
`fixed` is the first thing to drop. Nothing visible is lost under the panels,
only in the gutters, where the texture would then scroll with the page.
