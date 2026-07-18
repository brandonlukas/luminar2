import { FlowSim } from './sim.js';
import { presets, csvField, vortexField } from './fields.js';
import { MATERIALS } from './materials.js';
import { parseCSV, generateSampleCSV } from './csv.js';
import { $, fmt, bindSlider, wireCSVIntake } from './ui.js';

// ————————————————————————————————————————————————
// Plates: small sims that lazily boot when scrolled into view
// and pause when they leave it.
// ————————————————————————————————————————————————

const PLATES = {
  hero: { make: () => presets.turbulence(), particles: 2500, material: 'comets', gusts: true },
  vortex: { make: () => presets.vortex(), particles: 5000, material: 'silk' },
  dipole: { make: () => presets.dipole(), particles: 4000, material: 'comets' },
  saddle: { make: () => presets.saddle(), particles: 8000, material: 'ink' },
  lorenz: { make: () => presets.lorenz(), particles: 9000, controls: 'rotate', material: 'plasma' },
  abc: { make: () => presets.abc(), particles: 9000, controls: 'rotate', material: 'stardust' },
  fluid: { make: () => presets.fluid(), particles: 220, material: 'shoal', gusts: true },
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
          if (def.gusts) sim.setGusts(true);
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

const statSim = $('stat-sim');
obs.onStats = (fps, simMs) => {
  statFps.textContent = String(fps);
  statSim.textContent = `${simMs.toFixed(1)} ms`;
};

let uploadedField = null;
let activeDataField = null; // whichever data field is on stage (upload or preset)

function say(text) {
  message.textContent = text;
}

function activate(name, field) {
  obs.setField(field);
  activeDataField = field.isData ? field : null;
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
  if (!activeDataField) return;
  activeDataField.setCutoff(Number(cutoffSlider.value) * activeDataField.spacing);
  $('val-cutoff').textContent = activeDataField.cutoff.toPrecision(3);
});

$('ctl-idw').addEventListener('change', (e) => {
  if (activeDataField) activeDataField.idw = e.target.checked;
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

wireCSVIntake(loadCSVText, () => say('Error: could not read file.'));

$('btn-upload').addEventListener('click', () => $('file-input').click());

$('btn-load-sample').addEventListener('click', () => {
  loadCSVText(generateSampleCSV(), 'sample scatter');
});

$('load-sample-link').addEventListener('click', () => {
  // Anchor scrolls to the observatory; we also load the data.
  loadCSVText(generateSampleCSV(), 'sample scatter');
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

// ————— sliders (init: true applies each slider's starting value) —————

bindSlider('ctl-count', 'val-count', (v) => {
  obs.setParticleCount(v);
  statParticles.textContent = fmt(v);
}, fmt, true);

bindSlider('ctl-speed', 'val-speed', (v) => (obs.speed = v), (v) => `${v.toFixed(2)}×`, true);
bindSlider('ctl-size', 'val-size', (v) => (obs.sizeParam = v), (v) => `${v.toFixed(2)}×`, true);
bindSlider('ctl-trails', 'val-trails', (v) => obs.setTrails(v), undefined, true);
bindSlider('ctl-bloom', 'val-bloom', (v) => obs.setBloom(v), undefined, true);

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
  // Each substance gets a count range that makes sense for it.
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

document.querySelectorAll('.substance[data-substance]').forEach((btn) => {
  btn.addEventListener('click', () => setSubstance(btn.dataset.substance));
});

// ————— actions —————

$('btn-pause').addEventListener('click', (e) => {
  obs.paused = !obs.paused;
  e.target.textContent = obs.paused ? 'Resume' : 'Pause';
});

$('btn-reseed').addEventListener('click', () => { obs.reseedAll(); obs.clearTrails(); });

$('ctl-gusts').addEventListener('change', (e) => obs.setGusts(e.target.checked));

$('ctl-sources').addEventListener('change', (e) => obs.setSources(e.target.checked));

// ————— boot —————

setSubstance('stardust');
activate('vortex', presets.vortex());
