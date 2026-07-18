// Plumbing shared by both pages: element lookup, number formatting,
// slider wiring, and CSV intake (file picker + whole-page drag & drop).

export const $ = (id) => document.getElementById(id);

export const fmt = (n) => n.toLocaleString('en-US');

export function bindSlider(id, valueId, apply, format = (v) => v.toFixed(2), init = false) {
  const el = $(id);
  const val = $(valueId);
  const update = () => {
    const v = Number(el.value);
    val.textContent = format(v);
    apply(v);
  };
  el.addEventListener('input', update);
  if (init) update();
}

// Delivers dropped or picked file text to onText(text, filename).
export function wireCSVIntake(onText, onError) {
  const loadFile = (file) => {
    const reader = new FileReader();
    reader.onload = () => onText(reader.result, file.name);
    reader.onerror = onError;
    reader.readAsText(file);
  };
  $('file-input').addEventListener('change', (e) => {
    if (e.target.files[0]) loadFile(e.target.files[0]);
    e.target.value = '';
  });
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
}
