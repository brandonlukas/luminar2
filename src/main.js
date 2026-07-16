import { FlowSim } from './sim.js';
import { presets, csvField } from './fields.js';
import { parseCSV, generateSampleCSV } from './csv.js';

const $ = (id) => document.getElementById(id);

const sim = new FlowSim($('viewport'));

const statField = $('stat-field');
const statPoints = $('stat-points');
const statParticles = $('stat-particles');
const statFps = $('stat-fps');
const message = $('message');

sim.onStats = (fps) => {
  statFps.textContent = String(fps);
};

let uploadedField = null;
let activePreset = null;

function say(text) {
  message.textContent = text;
}

function fmt(n) {
  return n.toLocaleString('en-US');
}

function activate(name, field) {
  activePreset = name;
  sim.setField(field);
  statField.textContent = field.name;
  statPoints.textContent = field.isData ? fmt(field.count) : 'analytic';
  document.querySelectorAll('.preset[data-preset]').forEach((btn) => {
    btn.setAttribute('aria-pressed', String(btn.dataset.preset === name));
  });
  $('csv-controls').hidden = !field.isData;
  if (field.isData) syncCutoffUI(field);
}

// ————— presets —————

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
  } catch (err) {
    say(`Error: ${err.message}`);
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
  sim.setParticleCount(v);
  statParticles.textContent = fmt(v);
}, (v) => fmt(v));

bindSlider('ctl-speed', 'val-speed', (v) => (sim.speed = v), (v) => `${v.toFixed(2)}×`);
bindSlider('ctl-size', 'val-size', (v) => (sim.sizeParam = v), (v) => `${v.toFixed(2)}×`);
bindSlider('ctl-trails', 'val-trails', (v) => sim.setTrails(v));
bindSlider('ctl-bloom', 'val-bloom', (v) => sim.setBloom(v));

// ————— actions —————

$('btn-pause').addEventListener('click', (e) => {
  sim.paused = !sim.paused;
  e.target.textContent = sim.paused ? 'Resume' : 'Pause';
});

$('btn-reseed').addEventListener('click', () => sim.reseedAll());

// ————— boot —————

activate('vortex', presets.vortex());
