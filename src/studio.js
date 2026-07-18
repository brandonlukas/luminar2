import { FlowSim } from './sim.js';
import { presets, csvField } from './fields.js';
import { MATERIALS } from './materials.js';
import { parseCSV } from './csv.js';
import { $, fmt, bindSlider, wireCSVIntake } from './ui.js';

const say = (text) => { $('r-msg').textContent = text; };
const trim = (v) => String(Number(v.toPrecision(3)));

// ————— catalogue definitions —————

const FIELDS = [
  { key: 'vortex', name: 'Vortex', sub: 'concentric swirl', glyph: '◎',
    note: 'A single eye; angular speed falls with radius. Pure curl — a paddle wheel would spin anywhere you dropped it.' },
  { key: 'dipole', name: 'Dipole', sub: 'twin counter-rotors', glyph: '∞',
    note: 'Two mirrored vortices pump a fast, narrow jet between them — the engine that keeps a smoke ring together.' },
  { key: 'saddle', name: 'Saddle', sub: 'stagnation point', glyph: '✕',
    note: 'Inflow along one axis, outflow along the other. At the exact centre the velocity is zero, and nothing stays.' },
  { key: 'turbulence', name: 'Turbulence', sub: 'random fourier weave', glyph: '≋',
    note: 'A divergence-free weave of random Fourier modes, generated fresh. Select it again to reroll.' },
  { key: 'calligraphy', name: 'Calligraphy', sub: 'point data, with gaps', glyph: '風',
    note: 'A real character — wind, water, flow, cloud, light, or fire — as point measurements along the brush\'s true stroke order, run through the same machinery as an uploaded CSV. Between strokes the data is genuinely missing. Select again for another character.' },
  { key: 'lorenz', name: 'Lorenz', sub: 'two-lobed attractor', glyph: '∿',
    note: 'σ = 10, ρ = 28, β = 8/3. Weather’s confession: never repeating, never leaving. Drag to orbit.' },
  { key: 'abc', name: 'ABC Flow', sub: 'periodic chaos', glyph: '⌗',
    note: 'A smooth trigonometric weave whose particle paths tangle chaotically. The box wraps like a pattern tile.' },
  { key: 'fluid', name: 'The Fluid', sub: 'navier–stokes, live', glyph: '≈',
    note: 'The equations solved live, every frame. Stir with your pointer — it remembers you after you let go.' },
  { key: 'data', name: 'Your Data', sub: 'csv upload', glyph: '⊕',
    note: 'Your measurements, sampled nearest-neighbour within a cutoff. Drop a CSV anywhere, or click to browse.' },
];

const fieldDef = (key) => FIELDS.find((f) => f.key === key);

// The last parsed CSV survives so either chamber can build its own copy.
let lastCSV = null;

// ————— chambers —————

class Chamber {
  constructor(frameEl, name) {
    this.el = frameEl;
    this.name = name;
    this.sim = new FlowSim(frameEl.querySelector('.s-canvas'), { controls: 'full' });
    this.fieldKey = null;
    this.note = '';
    this.subKey = null;
    this.uploadedField = null;
    this.corners = {
      tl: frameEl.querySelector('.tl'),
      tr: frameEl.querySelector('.tr'),
      bl: frameEl.querySelector('.bl'),
      br: frameEl.querySelector('.br'),
    };
    this.titleEl = frameEl.querySelector('.s-chamber');
    // touching a chamber makes it the one the panels edit
    frameEl.addEventListener('pointerdown', () => setActive(this), { capture: true });
  }

  setField(key, field, note) {
    this.fieldKey = key;
    this.note = note;
    this.sim.setField(field);
    const b = field.bounds;
    const is2D = !field.is3D;
    this.corners.tl.textContent = is2D ? `(${trim(b.min[0])}, ${trim(b.max[1])})` : '';
    this.corners.tr.textContent = is2D ? `(${trim(b.max[0])}, ${trim(b.max[1])})` : '';
    this.corners.bl.textContent = is2D ? `(${trim(b.min[0])}, ${trim(b.min[1])})` : '';
    this.corners.br.textContent = is2D ? `(${trim(b.max[0])}, ${trim(b.min[1])})` : '';
  }

  setSubstance(key) {
    this.subKey = key;
    this.sim.setMaterial(MATERIALS[key]);
  }

  domainText() {
    const b = this.sim.field.bounds;
    const parts = [`x ${trim(b.min[0])}…${trim(b.max[0])}`, `y ${trim(b.min[1])}…${trim(b.max[1])}`];
    if (this.sim.field.is3D) parts.push(`z ${trim(b.min[2])}…${trim(b.max[2])}`);
    return parts.join(' · ');
  }
}

const frames = document.querySelectorAll('.chamber');
const chambers = [new Chamber(frames[0], 'A'), null];
let active = chambers[0];
let dual = false;

function setActive(chamber) {
  if (chamber === active) return;
  active = chamber;
  document.querySelectorAll('.chamber').forEach((el) => el.classList.remove('active'));
  chamber.el.classList.add('active');
  syncPanels();
}

// Reflect the active chamber's actual state into every panel.
function syncPanels() {
  const sim = active.sim;
  const def = MATERIALS[active.subKey];

  document.querySelectorAll('.s-field').forEach((el) => {
    el.setAttribute('aria-selected', String(el.dataset.key === active.fieldKey));
  });
  document.querySelectorAll('.s-substance').forEach((el) => {
    el.setAttribute('aria-selected', String(el.dataset.key === active.subKey));
  });
  $('field-note').textContent = active.note;

  const [cMin, cMax, cStep] = def.countRange ?? [1000, 60000, 1000];
  const count = $('ctl-count');
  count.min = String(cMin);
  count.max = String(cMax);
  count.step = String(cStep);
  count.value = String(sim.count);
  $('val-count').textContent = fmt(sim.count);
  $('ctl-speed').value = String(sim.speed);
  $('val-speed').textContent = `${sim.speed.toFixed(2)}×`;
  $('ctl-size').value = String(sim.sizeParam);
  $('val-size').textContent = `${sim.sizeParam.toFixed(2)}×`;
  $('ctl-trails').value = String(sim.trailDamp ?? 0.88);
  $('val-trails').textContent = (sim.trailDamp ?? 0.88).toFixed(2);
  $('ctl-bloom').value = String(sim.bloomPass.strength);
  $('val-bloom').textContent = sim.bloomPass.strength.toFixed(2);
  $('ctl-gusts').checked = sim.clustered;
  $('ctl-sources').checked = sim.sourceSpawn;
  $('btn-pause').textContent = sim.paused ? 'Resume' : 'Pause';

  const field = sim.field;
  $('csv-controls').hidden = !field?.isData;
  if (field?.isData) {
    $('ctl-cutoff').value = String(field.cutoff / field.spacing);
    $('val-cutoff').textContent = field.cutoff.toPrecision(3);
    $('ctl-idw').checked = field.idw;
  }

  $('r-field').textContent = field?.name ?? '—';
  $('r-sub').textContent = def?.label ?? '—';
  $('r-count').textContent = fmt(sim.count);
  $('r-domain').textContent = field ? active.domainText() : '—';
}

// ————— view toggle —————

function setDual(on) {
  dual = on;
  $('view-single').setAttribute('aria-pressed', String(!on));
  $('view-dual').setAttribute('aria-pressed', String(on));
  $('stage').classList.toggle('dual', on);
  frames[0].querySelector('.s-chamber').textContent = on ? 'Chamber A' : 'Observation Chamber';
  frames[1].hidden = !on;

  if (on && !chambers[1]) {
    // Chamber B is born as a twin of A — then change one side and compare.
    const b = new Chamber(frames[1], 'B');
    chambers[1] = b;
    b.sim.setParticleCount(active.sim.count);
    b.setSubstance(active.subKey);
    b.sim.speed = active.sim.speed;
    b.sim.sizeParam = active.sim.sizeParam;
    if (active.fieldKey === 'data' && lastCSV) {
      b.uploadedField = csvField(lastCSV.data, lastCSV.name);
      b.setField('data', b.uploadedField, dataNote(b.uploadedField));
    } else {
      const key = active.fieldKey === 'data' ? 'vortex' : active.fieldKey;
      b.setField(key, presets[key](), fieldDef(key).note);
    }
    b.sim.onStats = (fps, simMs) => {
      if (active !== b) return;
      $('r-fps').textContent = String(fps);
      $('r-sim').textContent = `${simMs.toFixed(1)} ms`;
    };
  }
  if (chambers[1]) chambers[1].sim.running = on;
  if (on) {
    frames[0].classList.add('active');
    say('click a chamber to edit it');
  } else {
    document.querySelectorAll('.chamber').forEach((el) => el.classList.remove('active'));
    setActive(chambers[0]);
  }
}

$('view-single').addEventListener('click', () => setDual(false));
$('view-dual').addEventListener('click', () => setDual(true));

// ————— catalogue UI —————

const catalog = $('catalog');
for (const f of FIELDS) {
  const btn = document.createElement('button');
  btn.className = 's-field';
  btn.dataset.key = f.key;
  btn.setAttribute('role', 'option');
  btn.setAttribute('aria-selected', 'false');
  btn.innerHTML = `<span class="s-glyph">${f.glyph}</span><span class="s-fname">${f.name}</span><span class="s-fsub">${f.sub}</span>`;
  btn.addEventListener('click', () => {
    if (f.key === 'data') {
      if (active.uploadedField) {
        active.setField('data', active.uploadedField, dataNote(active.uploadedField));
      } else if (lastCSV) {
        active.uploadedField = csvField(lastCSV.data, lastCSV.name);
        active.setField('data', active.uploadedField, dataNote(active.uploadedField));
      } else {
        $('file-input').click();
        return;
      }
    } else {
      active.setField(f.key, presets[f.key](), f.note);
    }
    syncPanels();
  });
  catalog.appendChild(btn);
}

function dataNote(field) {
  return `${fmt(field.count)} measured points, ${field.is3D ? 'three' : 'two'} dimensions. Nearest-neighbour within a cutoff of ${field.cutoff.toPrecision(3)}.`;
}

// ————— substance atlas UI —————

const substances = $('substances');
for (const [key, def] of Object.entries(MATERIALS)) {
  const btn = document.createElement('button');
  btn.className = 's-substance';
  btn.dataset.key = key;
  btn.setAttribute('role', 'option');
  btn.setAttribute('aria-selected', 'false');
  const c0 = def.colors[0].map((v) => Math.round(Math.min(1, v) * 255));
  const c1 = def.colors[1].map((v) => Math.round(Math.min(1, v) * 255));
  btn.innerHTML = `<span class="s-swatch" style="background:linear-gradient(90deg, rgb(${c0}), rgb(${c1}))"></span><span class="s-sname">${def.label}</span>`;
  btn.addEventListener('click', () => {
    active.setSubstance(key);
    syncPanels();
  });
  substances.appendChild(btn);
}

// ————— sliders / toggles (always act on the active chamber) —————

bindSlider('ctl-count', 'val-count', (v) => {
  active.sim.setParticleCount(v);
  $('r-count').textContent = fmt(v);
}, fmt);
bindSlider('ctl-speed', 'val-speed', (v) => (active.sim.speed = v), (v) => `${v.toFixed(2)}×`);
bindSlider('ctl-size', 'val-size', (v) => (active.sim.sizeParam = v), (v) => `${v.toFixed(2)}×`);
bindSlider('ctl-trails', 'val-trails', (v) => active.sim.setTrails(v));
bindSlider('ctl-bloom', 'val-bloom', (v) => active.sim.setBloom(v));

$('ctl-gusts').addEventListener('change', (e) => active.sim.setGusts(e.target.checked));

$('ctl-sources').addEventListener('change', (e) => active.sim.setSources(e.target.checked));

$('ctl-cutoff').addEventListener('input', () => {
  const f = active.sim.field;
  if (!f?.isData) return;
  f.setCutoff(Number($('ctl-cutoff').value) * f.spacing);
  $('val-cutoff').textContent = f.cutoff.toPrecision(3);
});
$('ctl-idw').addEventListener('change', (e) => {
  const f = active.sim.field;
  if (f?.isData) f.idw = e.target.checked;
});

// ————— actions —————

function togglePause() {
  active.sim.paused = !active.sim.paused;
  $('btn-pause').textContent = active.sim.paused ? 'Resume' : 'Pause';
}
$('btn-pause').addEventListener('click', togglePause);
$('btn-reseed').addEventListener('click', () => {
  active.sim.reseedAll();
  active.sim.clearTrails();
});

window.addEventListener('keydown', (e) => {
  if (e.code === 'Space' && !/INPUT|BUTTON|A/.test(document.activeElement?.tagName ?? '')) {
    e.preventDefault();
    togglePause();
  }
});

// ————— CSV (loads into the active chamber) —————

function loadCSVText(text, filename) {
  try {
    const data = parseCSV(text);
    lastCSV = { data, name: filename || 'Uploaded CSV' };
    active.uploadedField = csvField(data, lastCSV.name);
    active.setField('data', active.uploadedField, dataNote(active.uploadedField));
    const note = data.skipped ? ` (${data.skipped} rows skipped)` : '';
    say(`loaded ${fmt(data.count)} ${data.is3D ? '3d' : '2d'} points into chamber ${active.name}${note}`);
    syncPanels();
  } catch (err) {
    say(`error: ${err.message}`);
  }
}

wireCSVIntake(loadCSVText, () => say('error: could not read file'));

// ————— stats (the active chamber narrates) —————

chambers[0].sim.onStats = (fps, simMs) => {
  if (active !== chambers[0]) return;
  $('r-fps').textContent = String(fps);
  $('r-sim').textContent = `${simMs.toFixed(1)} ms`;
};

// ————— boot: the fluid with comets, ready to stir —————

chambers[0].sim.setParticleCount(MATERIALS.comets.count);
chambers[0].setSubstance('comets');
chambers[0].setField('fluid', presets.fluid(), fieldDef('fluid').note);
syncPanels();
