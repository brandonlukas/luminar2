import { FlowSim } from './sim.js';
import { presets, csvField, vortexField } from './fields.js';
import { MATERIALS } from './materials.js';
import { parseCSV, generateSampleCSV } from './csv.js';

const $ = (id) => document.getElementById(id);

// ————————————————————————————————————————————————
// Plates: small sims that lazily boot when scrolled into view
// and pause when they leave it.
// ————————————————————————————————————————————————

const PLATES = {
  hero: { make: () => presets.turbulence(), particles: 2500, material: 'comets' },
  vortex: { make: () => presets.vortex(), particles: 5000, material: 'silk' },
  dipole: { make: () => presets.dipole(), particles: 900, material: 'goo' },
  saddle: { make: () => presets.saddle(), particles: 8000, material: 'ink' },
  lorenz: { make: () => presets.lorenz(), particles: 9000, controls: 'rotate', material: 'plasma' },
  abc: { make: () => presets.abc(), particles: 9000, controls: 'rotate', material: 'stardust' },
};

const plateSims = new Map();

const plateObserver = new IntersectionObserver(
  (entries) => {
    for (const entry of entries) {
      const el = entry.target;
      const key = el.dataset.plate;
      const def = PLATES[key];
      let sim = plateSims.get(key);
      if (entry.isIntersecting) {
        if (!sim) {
          sim = new FlowSim(el, {
            controls: def.controls ?? 'none',
            pixelRatio: 1.75,
            trails: 0.88,
            bloom: 0.8,
          });
          sim.setParticleCount(def.particles);
          sim.setMaterial(MATERIALS[def.material ?? 'stardust']);
          sim.setField(def.make());
          plateSims.set(key, sim);
        }
        sim.running = true;
      } else if (sim) {
        sim.running = false;
      }
    }
  },
  { rootMargin: '160px 0px' }
);

document.querySelectorAll('.plate-canvas[data-plate]').forEach((el) => {
  plateObserver.observe(el);
});

// Hero: click (or the caption button) rerolls the turbulence field.
const stirHero = () => {
  const sim = plateSims.get('hero');
  if (sim) sim.setField(presets.turbulence());
};
$('hero-canvas').addEventListener('click', stirHero);
$('hero-stir').addEventListener('click', stirHero);

// ————————————————————————————————————————————————
// Live benchmark figure: field samples per millisecond, right here.
// ————————————————————————————————————————————————

function runBenchmark() {
  const field = vortexField();
  const out = [0, 0, 0];
  // warm-up, then measure
  for (let i = 0; i < 20000; i++) field.sample(Math.random() * 2 - 1, Math.random() * 2 - 1, 0, out);
  const N = 200000;
  const t0 = performance.now();
  for (let i = 0; i < N; i++) field.sample(Math.random() * 2 - 1, Math.random() * 2 - 1, 0, out);
  const ms = performance.now() - t0;
  const perMs = Math.round(N / ms);
  $('fig-bench').textContent = perMs.toLocaleString('en-US');
}

if ('requestIdleCallback' in window) requestIdleCallback(runBenchmark);
else setTimeout(runBenchmark, 2000);

// ————————————————————————————————————————————————
// The Observatory
// ————————————————————————————————————————————————

const obs = new FlowSim($('viewport'), { controls: 'full' });

// Pause the big sim when it's offscreen too.
new IntersectionObserver(
  ([entry]) => { obs.running = entry.isIntersecting; },
  { rootMargin: '160px 0px' }
).observe($('viewport'));

const statField = $('stat-field');
const statPoints = $('stat-points');
const statParticles = $('stat-particles');
const statFps = $('stat-fps');
const message = $('message');

obs.onStats = (fps) => {
  statFps.textContent = String(fps);
};

let uploadedField = null;

function say(text) {
  message.textContent = text;
}

function fmt(n) {
  return n.toLocaleString('en-US');
}

function activate(name, field) {
  obs.setField(field);
  statField.textContent = field.name;
  statPoints.textContent = field.isData ? fmt(field.count) : 'analytic';
  document.querySelectorAll('.preset[data-preset]').forEach((btn) => {
    btn.setAttribute('aria-pressed', String(btn.dataset.preset === name));
  });
  $('csv-controls').hidden = !field.isData;
  if (field.isData) syncCutoffUI(field);
}

document.querySelectorAll('.preset[data-preset]').forEach((btn) => {
  btn.addEventListener('click', () => {
    const name = btn.dataset.preset;
    if (name === 'upload') {
      if (uploadedField) activate('upload', uploadedField);
      return;
    }
    // Re-clicking Turbulence rolls a fresh random field.
    activate(name, presets[name]());
    say('');
  });
});

// ————— CSV upload —————

const cutoffSlider = $('ctl-cutoff');

function syncCutoffUI(field) {
  // Slider is in units of estimated point spacing.
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

function loadCSVText(text, filename) {
  try {
    const data = parseCSV(text);
    uploadedField = csvField(data, filename || 'Uploaded CSV');
    $('btn-uploaded').hidden = false;
    activate('upload', uploadedField);
    const note = data.skipped ? ` (${data.skipped} rows skipped)` : '';
    say(`Loaded ${fmt(data.count)} ${data.is3D ? '3D' : '2D'} points${note}.`);
    $('observatory').scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (err) {
    say(`Error: ${err.message}`);
    $('observatory').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
}

function loadFile(file) {
  const reader = new FileReader();
  reader.onload = () => loadCSVText(reader.result, file.name);
  reader.onerror = () => say('Error: could not read file.');
  reader.readAsText(file);
}

$('btn-upload').addEventListener('click', () => $('file-input').click());
$('file-input').addEventListener('change', (e) => {
  if (e.target.files[0]) loadFile(e.target.files[0]);
  e.target.value = '';
});

$('btn-load-sample').addEventListener('click', () => {
  loadCSVText(generateSampleCSV(), 'sample scatter');
});

$('load-sample-link').addEventListener('click', () => {
  // Anchor scrolls to the observatory; we also load the data.
  loadCSVText(generateSampleCSV(), 'sample scatter');
});

// Drag & drop anywhere on the page
const dropzone = $('dropzone');
let dragDepth = 0;

window.addEventListener('dragenter', (e) => {
  e.preventDefault();
  dragDepth++;
  dropzone.hidden = false;
});
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

// Sample CSV download
$('sample-link').addEventListener('click', (e) => {
  e.preventDefault();
  const blob = new Blob([generateSampleCSV()], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'luminar-sample.csv';
  a.click();
  URL.revokeObjectURL(url);
});

// ————— sliders —————

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
  obs.setParticleCount(v);
  statParticles.textContent = fmt(v);
}, (v) => fmt(v));

bindSlider('ctl-speed', 'val-speed', (v) => (obs.speed = v), (v) => `${v.toFixed(2)}×`);
bindSlider('ctl-size', 'val-size', (v) => (obs.sizeParam = v), (v) => `${v.toFixed(2)}×`);
bindSlider('ctl-trails', 'val-trails', (v) => obs.setTrails(v));
bindSlider('ctl-bloom', 'val-bloom', (v) => obs.setBloom(v));

// ————— substance —————

function setSubstance(name) {
  const def = MATERIALS[name];
  obs.setMaterial(def);
  document.querySelectorAll('.substance[data-substance]').forEach((btn) => {
    btn.setAttribute('aria-pressed', String(btn.dataset.substance === name));
  });
  // Push the substance's defaults into the sliders.
  $('ctl-trails').value = String(def.trails);
  $('val-trails').textContent = def.trails.toFixed(2);
  $('ctl-bloom').value = String(def.bloom);
  $('val-bloom').textContent = def.bloom.toFixed(2);
  if (def.count) {
    $('ctl-count').value = String(def.count);
    $('ctl-count').dispatchEvent(new Event('input'));
  }
}

document.querySelectorAll('.substance[data-substance]').forEach((btn) => {
  btn.addEventListener('click', () => setSubstance(btn.dataset.substance));
});

// ————— actions —————

$('btn-pause').addEventListener('click', (e) => {
  obs.paused = !obs.paused;
  e.target.textContent = obs.paused ? 'Resume' : 'Pause';
});

$('btn-reseed').addEventListener('click', () => obs.reseedAll());

// ————— boot —————

setSubstance('stardust');
activate('vortex', presets.vortex());
