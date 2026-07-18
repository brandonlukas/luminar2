import { FlowSim } from './sim.js';
import { presets, csvField } from './fields.js';
import { MATERIALS } from './materials.js';
import { parseCSV } from './csv.js';

const $ = (id) => document.getElementById(id);

// ————— catalogue —————

const FIELDS = [
  { key: 'vortex', name: 'Vortex', sub: 'concentric swirl', glyph: '◎',
    note: 'A single eye; angular speed falls with radius. Pure curl — a paddle wheel would spin anywhere you dropped it.' },
  { key: 'dipole', name: 'Dipole', sub: 'twin counter-rotors', glyph: '∞',
    note: 'Two mirrored vortices pump a fast, narrow jet between them — the engine that keeps a smoke ring together.' },
  { key: 'saddle', name: 'Saddle', sub: 'stagnation point', glyph: '✕',
    note: 'Inflow along one axis, outflow along the other. At the exact centre the velocity is zero, and nothing stays.' },
  { key: 'turbulence', name: 'Turbulence', sub: 'random fourier weave', glyph: '≋',
    note: 'A divergence-free weave of random Fourier modes, generated fresh. Select it again to reroll.' },
  { key: 'lorenz', name: 'Lorenz', sub: 'two-lobed attractor', glyph: '∿',
    note: 'σ = 10, ρ = 28, β = 8/3. Weather’s confession: never repeating, never leaving. Drag to orbit.' },
  { key: 'abc', name: 'ABC Flow', sub: 'periodic chaos', glyph: '⌗',
    note: 'A smooth trigonometric weave whose particle paths tangle chaotically. The box wraps like a pattern tile.' },
  { key: 'fluid', name: 'The Fluid', sub: 'navier–stokes, live', glyph: '≈',
    note: 'The equations solved live, every frame. Stir with your pointer — it remembers you after you let go.' },
  { key: 'data', name: 'Your Data', sub: 'csv upload', glyph: '⊕',
    note: 'Your measurements, sampled nearest-neighbour within a cutoff. Drop a CSV anywhere, or click to browse.' },
];

const sim = new FlowSim($('studio-canvas'), { controls: 'full' });

let uploadedField = null;
let currentFieldKey = null;
let currentSub = null;

const fmt = (n) => n.toLocaleString('en-US');
const say = (text) => { $('r-msg').textContent = text; };

function trim(v) {
  const a = Number(v.toPrecision(3));
  return String(a);
}

function setCorners(field) {
  const b = field.bounds;
  const is2D = !field.is3D;
  $('corner-tl').textContent = is2D ? `(${trim(b.min[0])}, ${trim(b.max[1])})` : '';
  $('corner-tr').textContent = is2D ? `(${trim(b.max[0])}, ${trim(b.max[1])})` : '';
  $('corner-bl').textContent = is2D ? `(${trim(b.min[0])}, ${trim(b.min[1])})` : '';
  $('corner-br').textContent = is2D ? `(${trim(b.max[0])}, ${trim(b.min[1])})` : '';
  const parts = [`x ${trim(b.min[0])}…${trim(b.max[0])}`, `y ${trim(b.min[1])}…${trim(b.max[1])}`];
  if (field.is3D) parts.push(`z ${trim(b.min[2])}…${trim(b.max[2])}`);
  $('r-domain').textContent = parts.join(' · ');
}

function activateField(key, field, note) {
  currentFieldKey = key;
  sim.setField(field);
  $('r-field').textContent = field.name;
  $('field-note').textContent = note;
  setCorners(field);
  document.querySelectorAll('.s-field').forEach((el) => {
    el.setAttribute('aria-selected', String(el.dataset.key === key));
  });
  $('csv-controls').hidden = !field.isData;
  if (field.isData) syncCutoffUI(field);
}

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
      if (uploadedField) activateField('data', uploadedField, dataNote());
      else $('file-input').click();
      return;
    }
    activateField(f.key, presets[f.key](), f.note);
  });
  catalog.appendChild(btn);
}

function dataNote() {
  if (!uploadedField) return FIELDS.find((f) => f.key === 'data').note;
  return `${fmt(uploadedField.count)} measured points, ${uploadedField.is3D ? 'three' : 'two'} dimensions. Nearest-neighbour within a cutoff of ${uploadedField.cutoff.toPrecision(3)}.`;
}

// ————— substance atlas —————

const substances = $('substances');
for (const [key, def] of Object.entries(MATERIALS)) {
  const btn = document.createElement('button');
  btn.className = 's-substance';
  btn.dataset.key = key;
  btn.setAttribute('role', 'option');
  btn.setAttribute('aria-selected', 'false');
  const c0 = def.colors[0].map((v) => Math.round(Math.min(1, v) * 255));
  const c1 = def.colors[1].map((v) => Math.round(Math.min(1, v) * 255));
  const swatch = `linear-gradient(90deg, rgb(${c0}) 0%, rgb(${c1}) 100%)`;
  btn.innerHTML = `<span class="s-swatch" style="background:${swatch}"></span><span class="s-sname">${def.label}</span>`;
  btn.addEventListener('click', () => setSubstance(key));
  substances.appendChild(btn);
}

function setSubstance(key) {
  currentSub = key;
  const def = MATERIALS[key];
  sim.setMaterial(def);
  $('r-sub').textContent = def.label;
  document.querySelectorAll('.s-substance').forEach((el) => {
    el.setAttribute('aria-selected', String(el.dataset.key === key));
  });
  $('ctl-trails').value = String(def.trails);
  $('val-trails').textContent = def.trails.toFixed(2);
  $('ctl-bloom').value = String(def.bloom);
  $('val-bloom').textContent = def.bloom.toFixed(2);
  const [cMin, cMax, cStep] = def.countRange ?? [1000, 60000, 1000];
  const slider = $('ctl-count');
  slider.min = String(cMin);
  slider.max = String(cMax);
  slider.step = String(cStep);
  if (def.count) {
    slider.value = String(def.count);
    slider.dispatchEvent(new Event('input'));
  }
}

// ————— sliders / toggles —————

function bindSlider(id, valueId, apply, format = (v) => v.toFixed(2)) {
  const el = $(id);
  const val = $(valueId);
  const update = () => {
    const v = Number(el.value);
    val.textContent = format(v);
    apply(v);
  };
  el.addEventListener('input', update);
  update();
}

bindSlider('ctl-count', 'val-count', (v) => {
  sim.setParticleCount(v);
  $('r-count').textContent = fmt(v);
}, (v) => fmt(v));
bindSlider('ctl-speed', 'val-speed', (v) => (sim.speed = v), (v) => `${v.toFixed(2)}×`);
bindSlider('ctl-size', 'val-size', (v) => (sim.sizeParam = v), (v) => `${v.toFixed(2)}×`);
bindSlider('ctl-trails', 'val-trails', (v) => sim.setTrails(v));
bindSlider('ctl-bloom', 'val-bloom', (v) => sim.setBloom(v));

$('ctl-gusts').addEventListener('change', (e) => sim.setGusts(e.target.checked));

const cutoffSlider = $('ctl-cutoff');
function syncCutoffUI(field) {
  cutoffSlider.value = String(field.cutoff / field.spacing);
  $('val-cutoff').textContent = field.cutoff.toPrecision(3);
  $('ctl-idw').checked = field.idw;
}
cutoffSlider.addEventListener('input', () => {
  if (!uploadedField) return;
  uploadedField.setCutoff(Number(cutoffSlider.value) * uploadedField.spacing);
  $('val-cutoff').textContent = uploadedField.cutoff.toPrecision(3);
});
$('ctl-idw').addEventListener('change', (e) => {
  if (uploadedField) uploadedField.idw = e.target.checked;
});

// ————— actions —————

function togglePause() {
  sim.paused = !sim.paused;
  $('btn-pause').textContent = sim.paused ? 'Resume' : 'Pause';
}
$('btn-pause').addEventListener('click', togglePause);
$('btn-reseed').addEventListener('click', () => { sim.reseedAll(); sim.clearTrails(); });

window.addEventListener('keydown', (e) => {
  if (e.code === 'Space' && !/INPUT|BUTTON|A/.test(document.activeElement?.tagName ?? '')) {
    e.preventDefault();
    togglePause();
  }
});

// ————— CSV —————

function loadCSVText(text, filename) {
  try {
    const data = parseCSV(text);
    uploadedField = csvField(data, filename || 'Uploaded CSV');
    activateField('data', uploadedField, dataNote());
    const note = data.skipped ? ` (${data.skipped} rows skipped)` : '';
    say(`loaded ${fmt(data.count)} ${data.is3D ? '3d' : '2d'} points${note}`);
  } catch (err) {
    say(`error: ${err.message}`);
  }
}

function loadFile(file) {
  const reader = new FileReader();
  reader.onload = () => loadCSVText(reader.result, file.name);
  reader.onerror = () => say('error: could not read file');
  reader.readAsText(file);
}

$('file-input').addEventListener('change', (e) => {
  if (e.target.files[0]) loadFile(e.target.files[0]);
  e.target.value = '';
});

const dropzone = $('dropzone');
let dragDepth = 0;
window.addEventListener('dragenter', (e) => { e.preventDefault(); dragDepth++; dropzone.hidden = false; });
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('dragleave', (e) => {
  e.preventDefault();
  dragDepth = Math.max(0, dragDepth - 1);
  if (dragDepth === 0) dropzone.hidden = true;
});
window.addEventListener('drop', (e) => {
  e.preventDefault();
  dragDepth = 0;
  dropzone.hidden = true;
  const file = e.dataTransfer?.files?.[0];
  if (file) loadFile(file);
});

// ————— stats —————

sim.onStats = (fps, simMs) => {
  $('r-fps').textContent = String(fps);
  $('r-sim').textContent = `${simMs.toFixed(1)} ms`;
};

// ————— boot: the fluid with comets, ready to stir —————

setSubstance('comets');
activateField('fluid', presets.fluid(), FIELDS.find((f) => f.key === 'fluid').note);
