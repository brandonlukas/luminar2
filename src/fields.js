// Field objects share one interface:
//   { name, is3D, bounds: {min:[x,y,z], max:[x,y,z]}, charSpeed, wrap?,
//     sample(x, y, z, out) -> bool   (writes velocity into out[0..2]),
//     spawn(out) -> void             (writes a spawn position into out[0..2]) }

import { HANZI } from './hanzi.js';

const TAU = Math.PI * 2;

function rand(a, b) {
  return a + Math.random() * (b - a);
}

// 90th-percentile speed over spawned samples — used to normalize advection speed.
function measureCharSpeed(field, n = 600) {
  const p = [0, 0, 0];
  const v = [0, 0, 0];
  const speeds = [];
  for (let i = 0; i < n; i++) {
    field.spawn(p);
    if (field.sample(p[0], p[1], p[2], v)) {
      speeds.push(Math.hypot(v[0], v[1], v[2]));
    }
  }
  speeds.sort((a, b) => a - b);
  const s = speeds[Math.floor(speeds.length * 0.9)] || 1;
  return s > 1e-12 ? s : 1;
}

function uniformSpawner(bounds) {
  return (out) => {
    out[0] = rand(bounds.min[0], bounds.max[0]);
    out[1] = rand(bounds.min[1], bounds.max[1]);
    out[2] = rand(bounds.min[2], bounds.max[2]);
  };
}

function finishField(field) {
  field.charSpeed = measureCharSpeed(field);
  return field;
}

// ————— 2D presets (z = 0 plane) —————

export function vortexField() {
  const bounds = { min: [-1, -1, 0], max: [1, 1, 0] };
  return finishField({
    name: 'Vortex',
    is3D: false,
    bounds,
    spawn: uniformSpawner(bounds),
    sample(x, y, _z, out) {
      const r2 = x * x + y * y;
      const w = 1.6 / (r2 + 0.12);
      out[0] = -y * w;
      out[1] = x * w;
      out[2] = 0;
      return true;
    },
  });
}

export function saddleField() {
  const bounds = { min: [-1, -1, 0], max: [1, 1, 0] };
  return finishField({
    name: 'Saddle',
    is3D: false,
    bounds,
    spawn: uniformSpawner(bounds),
    sample(x, y, _z, out) {
      out[0] = x;
      out[1] = -y;
      out[2] = 0;
      return true;
    },
  });
}

export function dipoleField() {
  const bounds = { min: [-1, -1, 0], max: [1, 1, 0] };
  const cores = [
    { x: -0.45, y: 0, s: 1 },
    { x: 0.45, y: 0, s: -1 },
  ];
  return finishField({
    name: 'Dipole',
    is3D: false,
    bounds,
    spawn: uniformSpawner(bounds),
    sample(x, y, _z, out) {
      let vx = 0;
      let vy = 0;
      for (const c of cores) {
        const dx = x - c.x;
        const dy = y - c.y;
        const w = c.s / (dx * dx + dy * dy + 0.045);
        vx += -dy * w;
        vy += dx * w;
      }
      out[0] = vx;
      out[1] = vy;
      out[2] = 0;
      return true;
    },
  });
}

// Divergence-free random field: velocity from a streamfunction built of
// random Fourier modes. Re-created on every call for a fresh field.
export function turbulenceField() {
  const bounds = { min: [-1, -1, 0], max: [1, 1, 0] };
  const modes = [];
  for (let i = 0; i < 8; i++) {
    const cycles = rand(0.5, 3);
    const angle = rand(0, TAU);
    const kx = Math.cos(angle) * cycles * Math.PI;
    const ky = Math.sin(angle) * cycles * Math.PI;
    modes.push({ kx, ky, phase: rand(0, TAU), amp: 1 / cycles });
  }
  return finishField({
    name: 'Turbulence',
    is3D: false,
    bounds,
    spawn: uniformSpawner(bounds),
    sample(x, y, _z, out) {
      let vx = 0;
      let vy = 0;
      for (const m of modes) {
        const c = m.amp * Math.cos(m.kx * x + m.ky * y + m.phase);
        vx += m.ky * c;
        vy += -m.kx * c;
      }
      out[0] = vx;
      out[1] = vy;
      out[2] = 0;
      return true;
    },
  });
}

// ————— 3D presets —————

export function lorenzField() {
  const sigma = 10;
  const rho = 28;
  const beta = 8 / 3;

  // Spawn pool: points along one trajectory, so new particles start on the
  // attractor instead of raining in from a bounding cube.
  const pool = new Float32Array(3000 * 3);
  let px = 1;
  let py = 1;
  let pz = 20;
  const step = (n) => {
    for (let i = 0; i < n; i++) {
      const dx = sigma * (py - px);
      const dy = px * (rho - pz) - py;
      const dz = px * py - beta * pz;
      px += dx * 0.004;
      py += dy * 0.004;
      pz += dz * 0.004;
    }
  };
  step(2000); // discard transient
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < 3000; i++) {
    step(5);
    pool[i * 3] = px;
    pool[i * 3 + 1] = py;
    pool[i * 3 + 2] = pz;
    min[0] = Math.min(min[0], px); max[0] = Math.max(max[0], px);
    min[1] = Math.min(min[1], py); max[1] = Math.max(max[1], py);
    min[2] = Math.min(min[2], pz); max[2] = Math.max(max[2], pz);
  }
  const pad = 4;
  const bounds = {
    min: [min[0] - pad, min[1] - pad, min[2] - pad],
    max: [max[0] + pad, max[1] + pad, max[2] + pad],
  };
  return finishField({
    name: 'Lorenz',
    is3D: true,
    bounds,
    spawn(out) {
      const i = (Math.random() * 3000) | 0;
      out[0] = pool[i * 3] + rand(-0.6, 0.6);
      out[1] = pool[i * 3 + 1] + rand(-0.6, 0.6);
      out[2] = pool[i * 3 + 2] + rand(-0.6, 0.6);
    },
    sample(x, y, z, out) {
      out[0] = sigma * (y - x);
      out[1] = x * (rho - z) - y;
      out[2] = x * y - beta * z;
      return true;
    },
  });
}

export function abcField() {
  const A = Math.sqrt(3);
  const B = Math.sqrt(2);
  const C = 1;
  const bounds = { min: [0, 0, 0], max: [TAU, TAU, TAU] };
  return finishField({
    name: 'ABC Flow',
    is3D: true,
    wrap: true,
    bounds,
    spawn: uniformSpawner(bounds),
    sample(x, y, z, out) {
      out[0] = A * Math.sin(z) + C * Math.cos(y);
      out[1] = B * Math.sin(x) + A * Math.cos(z);
      out[2] = C * Math.sin(y) + B * Math.cos(x);
      return true;
    },
  });
}

// ————— The Fluid: a live Navier–Stokes solver (Stam stable fluids) —————
// Unlike every other field, this one evolves: sim calls update(dt) each
// frame and stir(x, y, dx, dy) on pointer moves. Particles just sample it.

export function fluidField() {
  const N = 112;
  const S = N + 2;
  const u = new Float32Array(S * S);
  const v = new Float32Array(S * S);
  const u0 = new Float32Array(S * S);
  const v0 = new Float32Array(S * S);
  const IX = (i, j) => i + S * j;
  const bounds = { min: [-1, -1, 0], max: [1, 1, 0] };

  function setBnd(b, x) {
    for (let i = 1; i <= N; i++) {
      x[IX(0, i)] = b === 1 ? -x[IX(1, i)] : x[IX(1, i)];
      x[IX(N + 1, i)] = b === 1 ? -x[IX(N, i)] : x[IX(N, i)];
      x[IX(i, 0)] = b === 2 ? -x[IX(i, 1)] : x[IX(i, 1)];
      x[IX(i, N + 1)] = b === 2 ? -x[IX(i, N)] : x[IX(i, N)];
    }
    x[IX(0, 0)] = 0.5 * (x[IX(1, 0)] + x[IX(0, 1)]);
    x[IX(0, N + 1)] = 0.5 * (x[IX(1, N + 1)] + x[IX(0, N)]);
    x[IX(N + 1, 0)] = 0.5 * (x[IX(N, 0)] + x[IX(N + 1, 1)]);
    x[IX(N + 1, N + 1)] = 0.5 * (x[IX(N, N + 1)] + x[IX(N + 1, N)]);
  }

  function project() {
    const div = u0;
    const p = v0;
    for (let j = 1; j <= N; j++) {
      for (let i = 1; i <= N; i++) {
        div[IX(i, j)] = -0.5 * (u[IX(i + 1, j)] - u[IX(i - 1, j)] + v[IX(i, j + 1)] - v[IX(i, j - 1)]) / N;
        p[IX(i, j)] = 0;
      }
    }
    setBnd(0, div);
    setBnd(0, p);
    for (let k = 0; k < 14; k++) {
      for (let j = 1; j <= N; j++) {
        for (let i = 1; i <= N; i++) {
          p[IX(i, j)] = (div[IX(i, j)] + p[IX(i - 1, j)] + p[IX(i + 1, j)] + p[IX(i, j - 1)] + p[IX(i, j + 1)]) / 4;
        }
      }
      setBnd(0, p);
    }
    for (let j = 1; j <= N; j++) {
      for (let i = 1; i <= N; i++) {
        u[IX(i, j)] -= 0.5 * N * (p[IX(i + 1, j)] - p[IX(i - 1, j)]);
        v[IX(i, j)] -= 0.5 * N * (p[IX(i, j + 1)] - p[IX(i, j - 1)]);
      }
    }
    setBnd(1, u);
    setBnd(2, v);
  }

  function advect(b, d, d0, du, dv, dt) {
    const dt0 = dt * N * 0.5; // world span is 2 units across N cells
    for (let j = 1; j <= N; j++) {
      for (let i = 1; i <= N; i++) {
        let x = i - dt0 * du[IX(i, j)];
        let y = j - dt0 * dv[IX(i, j)];
        x = Math.max(0.5, Math.min(N + 0.5, x));
        y = Math.max(0.5, Math.min(N + 0.5, y));
        const i0 = x | 0;
        const j0 = y | 0;
        const s1 = x - i0;
        const t1 = y - j0;
        d[IX(i, j)] =
          (1 - s1) * ((1 - t1) * d0[IX(i0, j0)] + t1 * d0[IX(i0, j0 + 1)]) +
          s1 * ((1 - t1) * d0[IX(i0 + 1, j0)] + t1 * d0[IX(i0 + 1, j0 + 1)]);
      }
    }
    setBnd(b, d);
  }

  function splat(wx, wy, dx, dy) {
    const ci = Math.max(3, Math.min(N - 2, ((wx + 1) / 2) * N | 0));
    const cj = Math.max(3, Math.min(N - 2, ((wy + 1) / 2) * N | 0));
    for (let j = -2; j <= 2; j++) {
      for (let i = -2; i <= 2; i++) {
        const f = Math.exp(-(i * i + j * j) / 3.5);
        const id = IX(ci + i, cj + j);
        u[id] = Math.max(-2.5, Math.min(2.5, u[id] + dx * f));
        v[id] = Math.max(-2.5, Math.min(2.5, v[id] + dy * f));
      }
    }
  }

  let T = 0;
  let lastUser = -1e9;

  const field = {
    name: 'The Fluid',
    is3D: false,
    bounds,
    charSpeed: 0.45,
    spawn: uniformSpawner(bounds),

    stir(wx, wy, dx, dy) {
      lastUser = T;
      splat(wx, wy, dx * 30, dy * 30);
    },

    update(dt) {
      T += dt;
      const step = Math.min(dt, 0.033);
      // Idle stirrer keeps the plate alive until the visitor takes over.
      if (T - lastUser > 3) {
        const ax = Math.sin(T * 0.5) * Math.sin(T * 0.23 + 1.7) * 0.62;
        const ay = Math.sin(T * 0.37 + 0.4) * 0.55;
        splat(ax, ay, Math.cos(T * 0.9) * 0.5, Math.sin(T * 0.7) * 0.5);
      }
      u0.set(u);
      v0.set(v);
      advect(1, u, u0, u0, v0, step);
      advect(2, v, v0, u0, v0, step);
      project();
      // gentle global decay so a stirred storm eventually settles
      for (let k = 0; k < u.length; k++) {
        u[k] *= 0.999;
        v[k] *= 0.999;
      }
    },

    sample(x, y, _z, out) {
      if (x < -1 || x > 1 || y < -1 || y > 1) return false;
      let fx = ((x + 1) / 2) * N + 0.5;
      let fy = ((y + 1) / 2) * N + 0.5;
      fx = Math.max(1, Math.min(N, fx));
      fy = Math.max(1, Math.min(N, fy));
      const i0 = fx | 0;
      const j0 = fy | 0;
      const s1 = fx - i0;
      const t1 = fy - j0;
      out[0] =
        (1 - s1) * ((1 - t1) * u[IX(i0, j0)] + t1 * u[IX(i0, j0 + 1)]) +
        s1 * ((1 - t1) * u[IX(i0 + 1, j0)] + t1 * u[IX(i0 + 1, j0 + 1)]);
      out[1] =
        (1 - s1) * ((1 - t1) * v[IX(i0, j0)] + t1 * v[IX(i0, j0 + 1)]) +
        s1 * ((1 - t1) * v[IX(i0 + 1, j0)] + t1 * v[IX(i0 + 1, j0 + 1)]);
      out[2] = 0;
      return true;
    },
  };
  return field;
}

// ————— CSV data field: nearest neighbour within a cutoff radius —————

// Dense CSR grid over the data bounding box: cell lookup is pure index
// arithmetic (no hashing, no Map), so small cells stay cheap.
class DenseGrid {
  constructor(positions, count, is3D, cellSize, bounds, velocities = null) {
    const CAP = 4_000_000;
    const ex = bounds.max[0] - bounds.min[0];
    const ey = bounds.max[1] - bounds.min[1];
    const ez = bounds.max[2] - bounds.min[2];
    let cell = cellSize;
    let nx;
    let ny;
    let nz;
    for (;;) {
      nx = Math.max(1, Math.floor(ex / cell) + 1);
      ny = Math.max(1, Math.floor(ey / cell) + 1);
      nz = is3D ? Math.max(1, Math.floor(ez / cell) + 1) : 1;
      if (nx * ny * nz <= CAP) break;
      cell *= 1.5;
    }
    this.cellSize = cell;
    this.nx = nx;
    this.ny = ny;
    this.nz = nz;
    this.minX = bounds.min[0];
    this.minY = bounds.min[1];
    this.minZ = bounds.min[2];

    const ncells = nx * ny * nz;
    const start = new Uint32Array(ncells + 1);
    const cellOf = (i) => {
      const gx = Math.min(nx - 1, Math.floor((positions[i * 3] - this.minX) / cell));
      const gy = Math.min(ny - 1, Math.floor((positions[i * 3 + 1] - this.minY) / cell));
      const gz = is3D
        ? Math.min(nz - 1, Math.floor((positions[i * 3 + 2] - this.minZ) / cell))
        : 0;
      return (gz * ny + gy) * nx + gx;
    };
    for (let i = 0; i < count; i++) start[cellOf(i) + 1]++;
    for (let c = 0; c < ncells; c++) start[c + 1] += start[c];
    const entries = new Uint32Array(count);
    const cursor = start.slice(0, ncells);
    for (let i = 0; i < count; i++) entries[cursor[cellOf(i)]++] = i;
    this.start = start;
    this.entries = entries;

    // Copies reordered into cell order: bucket scans walk memory
    // sequentially instead of chasing indices.
    this.pos = new Float32Array(count * 3);
    this.vel = velocities ? new Float32Array(count * 3) : null;
    for (let k = 0; k < count; k++) {
      const i = entries[k];
      this.pos[k * 3] = positions[i * 3];
      this.pos[k * 3 + 1] = positions[i * 3 + 1];
      this.pos[k * 3 + 2] = positions[i * 3 + 2];
      if (velocities) {
        this.vel[k * 3] = velocities[i * 3];
        this.vel[k * 3 + 1] = velocities[i * 3 + 1];
        this.vel[k * 3 + 2] = velocities[i * 3 + 2];
      }
    }
  }
}

// Median nearest-neighbour spacing, estimated from a sample of the points.
function estimateSpacing(positions, count, is3D, bounds) {
  const diag = Math.hypot(
    bounds.max[0] - bounds.min[0],
    bounds.max[1] - bounds.min[1],
    bounds.max[2] - bounds.min[2]
  );
  const guess = is3D
    ? diag / Math.max(2, Math.cbrt(count))
    : diag / Math.max(2, Math.sqrt(count));
  const grid = new DenseGrid(positions, count, is3D, guess * 2, bounds);
  const { start, entries, nx, ny, nz, cellSize } = grid;
  const sampleN = Math.min(count, 500);
  const stride = Math.max(1, Math.floor(count / sampleN));
  const dists = [];
  for (let i = 0; i < count; i += stride) {
    const x = positions[i * 3];
    const y = positions[i * 3 + 1];
    const z = positions[i * 3 + 2];
    const cx = Math.min(nx - 1, Math.floor((x - grid.minX) / cellSize));
    const cy = Math.min(ny - 1, Math.floor((y - grid.minY) / cellSize));
    const cz = is3D ? Math.min(nz - 1, Math.floor((z - grid.minZ) / cellSize)) : 0;
    let best = Infinity;
    const z0 = Math.max(0, cz - 1);
    const z1 = Math.min(nz - 1, cz + (is3D ? 1 : 0));
    for (let gz = z0; gz <= z1; gz++) {
      for (let gy = Math.max(0, cy - 1); gy <= Math.min(ny - 1, cy + 1); gy++) {
        for (let gx = Math.max(0, cx - 1); gx <= Math.min(nx - 1, cx + 1); gx++) {
          const c = (gz * ny + gy) * nx + gx;
          for (let k = start[c]; k < start[c + 1]; k++) {
            const j = entries[k];
            if (j === i) continue;
            const dx = positions[j * 3] - x;
            const dy = positions[j * 3 + 1] - y;
            const dz = positions[j * 3 + 2] - z;
            const d2 = dx * dx + dy * dy + dz * dz;
            if (d2 < best) best = d2;
          }
        }
      }
    }
    if (best < Infinity) dists.push(Math.sqrt(best));
  }
  dists.sort((a, b) => a - b);
  const median = dists[Math.floor(dists.length / 2)];
  return median && median > 1e-12 ? median : guess;
}

export function csvField(data, label = 'Uploaded CSV') {
  const { positions, velocities, count, is3D } = data;
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < count; i++) {
    for (let a = 0; a < 3; a++) {
      const v = positions[i * 3 + a];
      if (v < min[a]) min[a] = v;
      if (v > max[a]) max[a] = v;
    }
  }
  if (!is3D) {
    min[2] = 0;
    max[2] = 0;
  }
  const bounds = { min, max };
  const spacing = estimateSpacing(positions, count, is3D, bounds);

  const field = {
    name: label,
    is3D,
    bounds,
    isData: true,
    count,
    spacing,
    cutoff: spacing * 2.5,
    idw: false,
    grid: null,

    setCutoff(r) {
      this.cutoff = Math.max(r, spacing * 0.1);
      // Cells stay near the point spacing so wide cutoffs don't create
      // huge buckets; sample() walks shells outward instead.
      // Smoothing blends over a few point-spacings — the sensible smoothing
      // scale — independent of how far the validity cutoff reaches. Cells
      // match the blend radius so blending never walks past shell 1.
      const blendRadius = Math.min(this.cutoff, spacing * 2);
      this.grid = new DenseGrid(positions, count, is3D, blendRadius, bounds, velocities);
      this.gridR = Math.max(1, Math.ceil(this.cutoff / this.grid.cellSize));
      this.blendR2 = blendRadius * blendRadius;
      this.blendShells = 1;
    },

    spawn(out) {
      const i = (Math.random() * count) | 0;
      const j = this.cutoff * 0.5;
      out[0] = positions[i * 3] + rand(-j, j);
      out[1] = positions[i * 3 + 1] + rand(-j, j);
      out[2] = is3D ? positions[i * 3 + 2] + rand(-j, j) : 0;
    },

    // Hot path: runs ~2x per particle per frame. Cells are walked in
    // Chebyshev shells with inline loops — no callbacks, no hashing.
    sample(x, y, z, out) {
      const r2max = this.cutoff * this.cutoff;
      const g = this.grid;
      const { start, pos, vel, nx, ny, nz } = g;
      const s = g.cellSize;
      const R = this.gridR;
      const idw = this.idw;
      const ix = Math.floor((x - g.minX) / s);
      const iy = Math.floor((y - g.minY) / s);
      const iz = is3D ? Math.floor((z - g.minZ) / s) : 0;
      // Entirely outside the padded data box → no data in reach.
      if (
        ix < -R || ix >= nx + R ||
        iy < -R || iy >= ny + R ||
        iz < -R || iz >= nz + R
      ) {
        return false;
      }

      const r2blend = this.blendR2;
      const invR2blend = 1 / r2blend;
      const rBlend = this.blendShells;
      let wx = 0, wy = 0, wz = 0, wsum = 0;
      let best = r2max;
      let bi = -1;

      // One outward walk serves both modes. NN always runs (it doubles as
      // the fallback when nothing lies within the blend radius); IDW
      // additionally accumulates over shells within the blend radius.
      for (let r = 0; r <= R; r++) {
        // A point in shell r can be as close as (r-1)*s to the query
        // (the query may sit at its cell's edge), so only stop once best
        // beats that bound.
        const rm = (r - 1) * s;
        const nnDone = bi >= 0 && best <= rm * rm && r > 0;
        if (!idw) {
          if (nnDone) break;
        } else if (wsum > 0) {
          if (r > rBlend) break;
        } else if (nnDone && (r > rBlend || best > r2blend)) {
          break;
        }
        const blendThisShell = idw && r <= rBlend;
        const zr = is3D ? r : 0;
        for (let dz = -zr; dz <= zr; dz++) {
          const gz = iz + dz;
          if (gz < 0 || gz >= nz) continue;
          for (let dy = -r; dy <= r; dy++) {
            const gy = iy + dy;
            if (gy < 0 || gy >= ny) continue;
            const onFaceYZ = Math.abs(dy) === r || Math.abs(dz) === r;
            const rowBase = (gz * ny + gy) * nx;
            // Cells of one row are contiguous in the CSR layout, so a face
            // row scans as one run; edge rows touch only the two end cells.
            let k0;
            let k1;
            let k0b = 0;
            let k1b = 0;
            if (onFaceYZ) {
              const gx0 = Math.max(0, ix - r);
              const gx1 = Math.min(nx - 1, ix + r);
              if (gx0 > gx1) continue;
              k0 = start[rowBase + gx0];
              k1 = start[rowBase + gx1 + 1];
            } else {
              const gxa = ix - r;
              const gxb = ix + r;
              k0 = k1 = 0;
              if (gxa >= 0 && gxa < nx) {
                k0 = start[rowBase + gxa];
                k1 = start[rowBase + gxa + 1];
              }
              if (gxb >= 0 && gxb < nx) {
                k0b = start[rowBase + gxb];
                k1b = start[rowBase + gxb + 1];
              }
            }
            for (let pass = 0; pass < 2; pass++) {
              const ks = pass === 0 ? k0 : k0b;
              const ke = pass === 0 ? k1 : k1b;
              for (let k = ks; k < ke; k++) {
                const k3 = k * 3;
                const px = pos[k3] - x;
                const py = pos[k3 + 1] - y;
                const pz = pos[k3 + 2] - z;
                const d2 = px * px + py * py + pz * pz;
                if (blendThisShell && d2 < r2blend) {
                  // Polynomial falloff: no per-point division, smooth blend.
                  const t = 1 - d2 * invR2blend;
                  const w = t * t;
                  wx += vel[k3] * w;
                  wy += vel[k3 + 1] * w;
                  wz += vel[k3 + 2] * w;
                  wsum += w;
                }
                if (d2 < best) {
                  best = d2;
                  bi = k;
                }
              }
            }
          }
        }
      }

      if (idw && wsum > 0) {
        out[0] = wx / wsum;
        out[1] = wy / wsum;
        out[2] = wz / wsum;
        return true;
      }
      if (bi < 0) return false;
      out[0] = vel[bi * 3];
      out[1] = vel[bi * 3 + 1];
      out[2] = vel[bi * 3 + 2];
      return true;
    },
  };

  field.setCutoff(field.cutoff);
  return finishField(field);
}

// Synthetic point measurements laid along a real character — the path a
// calligrapher's brush travels, in true stroke order (data: src/hanzi.js).
// Goes through the same machinery as an uploaded CSV, including genuinely
// missing data: between the strokes there are no points at all, so sample()
// fails there exactly as it does in the gaps of real-world data.
export function calligraphyField() {
  const g = HANZI[(Math.random() * HANZI.length) | 0];

  // Fit the character into a 16-unit box centred on the origin.
  const all = g.strokes.flat();
  const xs = all.map((p) => p[0]);
  const ys = all.map((p) => p[1]);
  const mnx = Math.min(...xs);
  const mxx = Math.max(...xs);
  const mny = Math.min(...ys);
  const mxy = Math.max(...ys);
  const k = 16 / Math.max(mxx - mnx, mxy - mny);
  const cx = (mnx + mxx) / 2;
  const cy = (mny + mxy) / 2;

  const positions = [];
  const velocities = [];
  const ds = 0.22; // deposit spacing along the brush path
  const width = 0.32; // half-width of each stroke's band of points
  for (const s of g.strokes) {
    // scale the median polyline, dropping coincident points
    const pts = s
      .map(([x, y]) => [(x - cx) * k, (y - cy) * k])
      .filter((p, i, a) => !i || Math.hypot(p[0] - a[i - 1][0], p[1] - a[i - 1][1]) > 1e-6);
    if (pts.length < 2) continue;
    const cum = [0];
    for (let i = 1; i < pts.length; i++) {
      cum.push(cum[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
    }
    const total = cum[cum.length - 1];
    const speed0 = rand(0.9, 1.3);
    let seg = 1;
    for (let d = 0; d <= total; d += ds) {
      while (seg < pts.length - 1 && cum[seg] < d) seg++;
      const l = cum[seg] - cum[seg - 1];
      const f = (d - cum[seg - 1]) / l;
      const [ax, ay] = pts[seg - 1];
      const [bx, by] = pts[seg];
      const px = ax + (bx - ax) * f;
      const py = ay + (by - ay) * f;
      const tx = (bx - ax) / l;
      const ty = (by - ay) / l;
      // ink moves fastest mid-stroke; the tips are where flow is born and dies
      const u = d / total;
      const spd = speed0 * (0.25 + 0.75 * Math.sin(Math.PI * u));
      for (let q = 0; q < 3; q++) {
        const off = rand(-width, width);
        const edge = 1 - (0.5 * Math.abs(off)) / width;
        positions.push(px - ty * off + rand(-0.05, 0.05), py + tx * off + rand(-0.05, 0.05), 0);
        velocities.push(tx * spd * edge + rand(-0.06, 0.06), ty * spd * edge + rand(-0.06, 0.06), 0);
      }
    }
  }
  const count = positions.length / 3;
  return csvField(
    {
      positions: new Float32Array(positions),
      velocities: new Float32Array(velocities),
      count,
      is3D: false,
    },
    `Calligraphy · ${g.char} ${g.pinyin} (${g.meaning})`
  );
}

export const presets = {
  vortex: vortexField,
  saddle: saddleField,
  dipole: dipoleField,
  turbulence: turbulenceField,
  calligraphy: calligraphyField,
  lorenz: lorenzField,
  abc: abcField,
  fluid: fluidField,
};
