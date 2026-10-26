# License

The Community Cloud Headlamp plugins — everything under `headlamp/` — are
free software licensed under the **GNU Lesser General Public License,
version 3 or later** (LGPL-3.0-or-later).

Copyright (C) 2026 Code Incarnate Technologies, LLC.

This program is free software: you can redistribute it and/or modify
it under the terms of the GNU Lesser General Public License as
published by the Free Software Foundation, either version 3 of the
License, or (at your option) any later version.

This program is distributed in the hope that it will be useful, but
WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the GNU
Lesser General Public License for more details.

You should have received a copy of the GNU Lesser General Public
License along with this program. If not, see
<https://www.gnu.org/licenses/>.

## The files

The LGPL version 3 is written as a set of additional permissions on
top of the GPL version 3, so it only means anything alongside it. Both
texts are here, under the names the FSF asks for:

| File | What it is |
|---|---|
| [`COPYING.LESSER`](./COPYING.LESSER) | GNU Lesser General Public License v3 |
| [`COPYING`](./COPYING) | GNU General Public License v3, which the above extends |

## What this covers, and what it doesn't

This applies to `headlamp/` only — both plugins and anything else added
beside them. The installer under `installer/` is separately
LGPL-3.0-or-later and carries its own copies of these texts; the rest of
the repository — the Kubernetes manifests under `k8s/`, the documentation,
everything else — stays under the MIT License in
[`../LICENSE.md`](../LICENSE.md).

## Running inside Headlamp

A plugin is loaded by Headlamp, which is Apache-2.0. That combination is
fine in the direction it happens: GPLv3 and LGPLv3 name Apache-2.0 as a
compatible licence, so Apache-2.0 code may be combined with this and the
result distributed. Nothing here asks Headlamp to change its licence, and
the LGPL's own point is that a program may use a library under it without
taking the licence on.

## Third-party files

Some files here are not ours and keep their own licences.

### Fonts

`cc-cumulus-theme` bundles two typefaces, both under the **SIL Open Font
License 1.1**, whose texts are in
[`plugins/cc-cumulus-theme/licenses/`](./plugins/cc-cumulus-theme/licenses).
The OFL asks that its text travel with the font, so the notices below are
also emitted into the built `main.js`, which is the form the fonts are
actually distributed in.

| File | Typeface | Notice |
|---|---|---|
| `src/fonts/ibm-plex-sans.woff2` | IBM Plex Sans | Copyright © 2017 IBM Corp. with Reserved Font Name "Plex" |
| `src/fonts/space-grotesk.woff2` | Space Grotesk | Copyright 2020 The Space Grotesk Project Authors |

Both are the latin subsets as served by Google Fonts, which the OFL
permits — a subset is a modified version, and it stays under the same
licence. Neither is renamed, so the Reserved Font Name on IBM Plex is not
engaged.

### Scaffolding

`src/headlamp-plugin.d.ts` in each plugin came from
`headlamp-plugin create` and carries its own Apache-2.0 header,
Copyright 2025 The Kubernetes Authors. It is left as it is: relicensing
somebody else's file is not ours to do. The same applies to any other
generated file that still carries that header.

### Brand

`cc-cumulus-theme/src/cloud-logo-color.png` and the Community Cloud name
and mark are Code Incarnate Technologies, LLC. The LGPL covers the code,
not the trademark: a fork is free to use the code and is expected to use
its own name and mark.
