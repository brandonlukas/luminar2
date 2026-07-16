// CSV parser for point-velocity data.
// Accepts headers (case-insensitive, flexible names) or headerless files:
//   2D: x, y, dx, dy      (dx/dy also accepted as u/v or vx/vy)
//   3D: x, y, z, dx, dy, dz  (also u/v/w or vx/vy/vz)

const POSITION_NAMES = { x: 0, y: 1, z: 2 };
const VELOCITY_NAMES = {
  dx: 0, u: 0, vx: 0,
  dy: 1, v: 1, vy: 1,
  dz: 2, w: 2, vz: 2,
};

function detectDelimiter(line) {
  if (line.includes('\t')) return '\t';
  if (line.includes(';')) return ';';
  if (line.includes(',')) return ',';
  return /\s+/;
}

export function parseCSV(text) {
  const lines = text.split(/\r\n|\r|\n/).filter((l) => l.trim().length > 0);
  if (lines.length < 2) throw new Error('File has no data rows.');

  const delim = detectDelimiter(lines[0]);
  const split = (line) =>
    line.split(delim).map((t) => t.trim()).filter((t) => t.length > 0);

  // Header row: any token that isn't a number.
  const first = split(lines[0]);
  const hasHeader = first.some((t) => Number.isNaN(Number(t)));

  let posCols;
  let velCols;
  let is3D;

  if (hasHeader) {
    const names = first.map((t) => t.toLowerCase().replace(/["']/g, ''));
    posCols = [-1, -1, -1];
    velCols = [-1, -1, -1];
    names.forEach((n, i) => {
      if (n in POSITION_NAMES && posCols[POSITION_NAMES[n]] === -1) {
        posCols[POSITION_NAMES[n]] = i;
      } else if (n in VELOCITY_NAMES && velCols[VELOCITY_NAMES[n]] === -1) {
        velCols[VELOCITY_NAMES[n]] = i;
      }
    });
    is3D = posCols[2] !== -1 && velCols[2] !== -1;
    const need = is3D ? 3 : 2;
    for (let a = 0; a < need; a++) {
      if (posCols[a] === -1 || velCols[a] === -1) {
        throw new Error(
          'Could not match columns. Use headers like x,y,dx,dy (or u/v, vx/vy; add z,dz for 3D).'
        );
      }
    }
  } else {
    const n = first.length;
    if (n >= 6) {
      is3D = true;
      posCols = [0, 1, 2];
      velCols = [3, 4, 5];
    } else if (n >= 4) {
      is3D = false;
      posCols = [0, 1, -1];
      velCols = [2, 3, -1];
    } else {
      throw new Error(
        `Expected 4 columns (x,y,dx,dy) or 6 (x,y,z,dx,dy,dz); got ${n}.`
      );
    }
  }

  const start = hasHeader ? 1 : 0;
  const maxRows = lines.length - start;
  const positions = new Float32Array(maxRows * 3);
  const velocities = new Float32Array(maxRows * 3);
  let count = 0;
  let skipped = 0;

  for (let li = start; li < lines.length; li++) {
    const toks = split(lines[li]);
    let ok = true;
    for (let a = 0; a < 3 && ok; a++) {
      const p = posCols[a] === -1 ? 0 : Number(toks[posCols[a]]);
      const v = velCols[a] === -1 ? 0 : Number(toks[velCols[a]]);
      if (Number.isNaN(p) || Number.isNaN(v)) {
        ok = false;
        break;
      }
      positions[count * 3 + a] = p;
      velocities[count * 3 + a] = v;
    }
    if (ok) count++;
    else skipped++;
  }

  if (count < 2) throw new Error('No valid numeric rows found.');
  return { positions, velocities, count, is3D, skipped };
}

// Demo file: a noisy vortex sampled on scattered points, so users can see the format.
export function generateSampleCSV(n = 3000) {
  const rows = ['x,y,dx,dy'];
  while (rows.length <= n) {
    const x = (Math.random() * 2 - 1) * 1.2;
    const y = (Math.random() * 2 - 1) * 1.2;
    const r2 = x * x + y * y;
    if (r2 > 1.44) continue; // scattered points on a disc
    const w = 1.5 / (r2 + 0.15);
    const dx = -y * w + (Math.random() - 0.5) * 0.4;
    const dy = x * w + (Math.random() - 0.5) * 0.4;
    rows.push(`${x.toFixed(4)},${y.toFixed(4)},${dx.toFixed(4)},${dy.toFixed(4)}`);
  }
  return rows.join('\n');
}
