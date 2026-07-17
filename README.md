# Luminar — a study in vector fields

A scrolling atlas of vector fields — five annotated "plates" (vortex, dipole,
saddle, Lorenz, ABC flow) with live particle advection, an essay on how fields
work, and an observatory bench where you can drag in a CSV of scattered
point-velocity samples and watch particles flow through your own data.
Twelve render substances skin the same flow: stardust, silk, comets, shoal
(shaded 3D-look koi with swimming tails, trailed by bubbles), plasma, embers (cooling sparks), vapor (noise-carved wisps), fireflies, constellation (a living neighbour graph), glyphs
(symbols oriented along the flow), filings (the field's own portrait as
oriented dashes), and ink. An orthogonal Gusts toggle respawns particles in short-lived
bursts around drifting seeds, so any substance blows through in transient
swarms.

The sixth atlas plate, The Fluid, is a live CPU Navier–Stokes solver (Stam
stable fluids) — the only plate you can touch: stirring with the pointer adds
momentum, pressure balances it, and particles of any substance ride the
solved field.
Warm editorial paper (Fraunces + IBM Plex Mono) around dark glowing plates;
the visual language owes a debt to David Aerne's playful documentation sites.

## Run

```sh
npm install
npm run dev      # dev server
npm run build    # production build to dist/
```

## CSV format

One row per sample point. Headers are case-insensitive and flexible:

| Kind | Columns |
| --- | --- |
| 2D | `x, y, dx, dy` (velocity also as `u, v` or `vx, vy`) |
| 3D | `x, y, z, dx, dy, dz` (also `u, v, w` or `vx, vy, vz`) |

Headerless files work too (4 columns → 2D, 6 → 3D). Comma, semicolon, tab, or
whitespace delimited. Bad rows are skipped and reported. A sample file is
downloadable from the panel.

## How sampling works

- Points can be scattered arbitrarily — no grid required.
- The field is sampled by **nearest neighbour within a cutoff radius**, so flow
  only appears where you actually have data; particles that drift out of reach
  of any sample die and respawn near the data.
- The cutoff defaults to 2.5× the estimated median point spacing and is
  adjustable in the panel (shown in your data's units).
- Optional **Smooth** mode blends nearby samples with a polynomial falloff
  kernel over a couple of point-spacings instead of snapping to the nearest.
- Lookups use a dense CSR spatial grid walked in Chebyshev shells with an
  early-exit bound — exact nearest-neighbour results at 60 fps for tens of
  thousands of particles.

## Presets

2D: Vortex, Dipole, Saddle, Turbulence (random divergence-free Fourier field —
click again to reroll). 3D: Lorenz attractor, ABC flow (periodic, wrapping).

## Rendering

three.js. Particles are drawn as additive soft points colored by local speed
(slow → indigo, fast → warm white), integrated with RK2. Post chain:
render → afterimage (trails) → UnrealBloom → tone-mapped output. 2D fields use
an orthographic camera (scroll to zoom, drag to pan); 3D fields orbit slowly
until you grab them.
