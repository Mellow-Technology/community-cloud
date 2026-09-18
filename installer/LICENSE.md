# License

The Community Cloud installer — everything under `installer/` — is
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

This applies to `installer/` only. The rest of the repository — the
Kubernetes manifests under `k8s/`, the documentation, everything else
— stays under the MIT License in [`../LICENSE.md`](../LICENSE.md).

## Why not Affero

There is no Affero LGPL. The AGPL exists only as a variant of the GPL,
not of the Lesser GPL, and its network clause would have little to say
about an installer in any case: the AGPL is triggered by users
interacting with a modified program over a network, and this is a
command line tool somebody runs against machines they administer.
LGPL-3.0-or-later is the newest Lesser GPL there is — it was published
on 29 June 2007 and has not been revised since.
