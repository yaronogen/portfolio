/* Sentinel-2 spectral visualization — no dependencies.
 *
 * Data: assets/s2/ (prepared by tools/sentinel2/prepare_scene.py).
 * All reflectance values shown are read from the Level-2A product:
 *   reflectance = (DN + BOA_ADD_OFFSET) / QUANTIFICATION_VALUE
 * Each band is read at its native resolution (10, 20 or 60 m).
 *
 * Stage D adds Dynamic World land-cover predictions for the same acquisition
 * (assets/s2/dw.bin.gz, prepared by tools/sentinel2/prepare_dynamicworld.py).
 * They are model outputs and are always labelled as predictions, separate
 * from the measured reflectance.
 *
 * The intro is a single deterministic timeline: drawIntro(t) renders any
 * moment, so pause, replay, stage jumps and reduced motion all reuse it.
 */
(() => {
  const EXAMPLE_LABELS = { vegetation: 'Vegetation', bare_soil: 'Bare soil', water: 'Water', built_up: 'Built-up' };
  const BAND_ORDER = ['B01', 'B02', 'B03', 'B04', 'B05', 'B06', 'B07', 'B08', 'B8A', 'B09', 'B11', 'B12'];
  const SCL_NAMES = ['No data', 'Saturated or defective', 'Dark area', 'Cloud shadow', 'Vegetation', 'Not vegetated',
    'Water', 'Unclassified', 'Cloud (medium probability)', 'Cloud (high probability)', 'Thin cirrus', 'Snow or ice'];
  const STAGES = [
    { name: 'Observation', start: 0, end: 7000, still: 6200,
      caption: 'Sentinel-2 is a passive optical satellite. Sunlight reaches the ground, each surface reflects part of it, and the MultiSpectral Instrument (MSI) records the reflected light in discrete bands. Line widths show the measured near-infrared (B8) reflectance of four pixels from this scene.' },
    { name: 'Acquisition', start: 7000, end: 15000, still: 10600,
      caption: 'The MSI is a push-broom scanner: the image is built line by line as the satellite moves along its orbit. The view zooms into a 4.3 × 2.2 km window and switches to Level-2A surface reflectance, which is corrected for the atmosphere.' },
    { name: 'Spectra', start: 15000, end: 19000, still: 16600,
      caption: 'Select any pixel, or one of the examples, to see its measured surface reflectance in the 12 Level-2A bands.' },
    { name: 'Land cover', start: 19000, end: 22000, still: 22000,
      caption: 'Dynamic World, a neural-network model by Google and the World Resources Institute, predicts land cover for every 10 m pixel of this acquisition. The map is a prediction, not a measurement: each pixel has a probability for nine classes, and the Confidence view shows where the model is less certain.' },
  ];
  const WIPE = [19400, 21400];
  const VIEWS = { image: 'Image', classes: 'Land cover', confidence: 'Confidence' };
  // Confidence ramp (top-class probability): light = less certain, dark = more certain.
  const CONF_LO = 0.3, CONF_HI = 0.9, CONF_A = [241, 233, 220], CONF_B = [31, 45, 56];
  const T_END = STAGES[STAGES.length - 1].end;

  const clamp = (v, a = 0, b = 1) => Math.min(b, Math.max(a, v));
  const seg = (t, a, b) => clamp((t - a) / (b - a));
  const ease = (p) => (p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2);
  const lerp = (a, b, p) => a + (b - a) * p;
  const el = (tag, attrs = {}, text) => {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
    if (text != null) node.textContent = text;
    return node;
  };
  const svgEl = (tag, attrs = {}) => {
    const node = document.createElementNS('http://www.w3.org/2000/svg', tag);
    for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
    return node;
  };
  const fmt = (v) => v.toFixed(3);
  const nf = new Intl.NumberFormat('en-GB');

  function loadImage(src) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = reject;
      img.src = src;
    });
  }

  function init(figure) {
    const base = figure.dataset.src || 'assets/s2/';
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
    const css = getComputedStyle(document.documentElement);
    const color = (name, fallback) => css.getPropertyValue(name).trim() || fallback;
    const C = {
      paper: color('--paper', '#F5F3EE'), surface: color('--surface', '#FBFAF7'), ink: color('--ink', '#15181A'),
      ink2: color('--ink-2', '#3E4447'), muted: color('--muted', '#646A6D'), rule: color('--rule', '#D8D4CB'),
      accent: color('--accent', '#9A3B22'),
    };
    const MONO = '"IBM Plex Mono", ui-monospace, monospace';
    const SANS = '"IBM Plex Sans", system-ui, sans-serif';

    /* ---------- DOM ---------- */
    const fallback = figure.querySelector('.s2viz-fallback');
    const caption = figure.querySelector('.s2viz-caption');
    const body = el('div', { class: 's2viz-body' });
    const stageBox = el('div', { class: 's2viz-stage' });
    const canvas = el('canvas', { class: 's2viz-canvas', tabindex: '0', role: 'img',
      'aria-label': 'Sentinel-2 true-colour image of the south shore of the Geiseltalsee at Braunsbedra, Germany. Use the arrow keys to move the pixel cursor and Enter to show that pixel’s spectrum.' });
    const loupe = el('canvas', { class: 's2viz-loupe', 'aria-hidden': 'true' });
    const loupeKey = el('p', { class: 's2viz-loupe-key', 'aria-hidden': 'true' });
    loupeKey.innerHTML = '<span class="k10"></span>10 m pixel <span class="k20"></span>20 m <span class="k60"></span>60 m';
    const stageCol = el('div', { class: 's2viz-stagecol' });
    stageBox.append(canvas, loupe, loupeKey);

    const panel = el('div', { class: 's2viz-panel' });
    const pixelInfo = el('div', { class: 's2viz-pixel' });
    const live = el('p', { class: 'screen-reader-only', 'aria-live': 'polite' });
    const chartId = `s2viz-chart-${Math.random().toString(36).slice(2, 8)}`;
    const chart = svgEl('svg', { class: 's2viz-chart', viewBox: '0 0 440 290', role: 'img', 'aria-labelledby': `${chartId}-t` });
    const chartTitle = svgEl('title', { id: `${chartId}-t` });
    chart.append(chartTitle);
    const legend = el('p', { class: 's2viz-legend' });
    legend.innerHTML = '<span><i class="m10"></i>10 m band</span><span><i class="m20"></i>20 m band</span><span><i class="m60"></i>60 m band (atmospheric)</span><span class="guide">Lines only connect the discrete bands as a visual guide.</span>';
    const tableWrap = el('details', { class: 's2viz-table' });
    tableWrap.append(el('summary', {}, 'Show values as a table'));
    const table = el('table');
    tableWrap.append(table);
    const kicker = el('p', { class: 's2viz-kicker' });
    kicker.innerHTML = '<b>Measured</b> · Level-2A surface reflectance';
    panel.append(kicker, chart, legend, tableWrap, live);
    const classKey = el('div', { class: 's2viz-classkey', hidden: '' });
    stageCol.append(stageBox, classKey, pixelInfo);
    body.append(stageCol, panel);

    const controls = el('div', { class: 's2viz-controls' });
    const steps = el('div', { class: 's2viz-steps', role: 'group', 'aria-label': 'Animation stages' });
    const stepButtons = STAGES.map((s, i) => {
      const b = el('button', { type: 'button', 'data-step': String(i) });
      b.innerHTML = `<span>${i + 1}</span> ${s.name}`;
      steps.append(b);
      return b;
    });
    const playBtn = el('button', { type: 'button', class: 's2viz-play' }, 'Pause');
    const replayBtn = el('button', { type: 'button', class: 's2viz-replay' }, 'Replay');
    const examples = el('div', { class: 's2viz-examples', role: 'group', 'aria-label': 'Example pixels' });
    const exampleButtons = {};
    for (const [key, label] of Object.entries(EXAMPLE_LABELS)) {
      const b = el('button', { type: 'button', 'data-example': key, 'aria-pressed': 'false' }, label);
      exampleButtons[key] = b;
      examples.append(b);
    }
    const pinBtn = el('button', { type: 'button', class: 's2viz-pin', 'aria-pressed': 'false' }, 'Compare');
    const transport = el('div', { class: 's2viz-transport' });
    transport.append(playBtn, replayBtn);
    const views = el('div', { class: 's2viz-views', role: 'group', 'aria-label': 'Map view' });
    const viewButtons = {};
    for (const [key, label] of Object.entries(VIEWS)) {
      const b = el('button', { type: 'button', 'data-view': key, 'aria-pressed': String(key === 'image') }, label);
      viewButtons[key] = b;
      views.append(b);
    }
    controls.append(steps, transport, views, examples, pinBtn);

    fallback?.replaceWith(body);
    figure.insertBefore(controls, figure.querySelector('figcaption'));
    figure.classList.add('is-ready');

    /* ---------- State ---------- */
    let meta, imgTrue, imgCtx, bins = null;
    let dw = null, dwLayers = null; // Dynamic World planes and rendered class / confidence canvases
    let view = 'image', keyShown = null, autoPaused = false;
    let t = 0, playing = false, lastFrame = 0, raf = 0;
    let selected = null, pinned = null, cursor = null;
    let shown = null; // currently drawn spectrum values (for tweening)
    let tween = null;
    const ctx = canvas.getContext('2d');
    const lctx = loupe.getContext('2d');

    /* ---------- Data ---------- */
    const W = () => meta.size['10'][0];
    const H = () => meta.size['10'][1];

    function reflectanceAt(x, y) {
      const out = {};
      for (const b of BAND_ORDER) {
        const info = meta.bands[b];
        const res = info.res_m;
        const f = res / 10;
        const [w, h] = meta.size[String(res)];
        const bi = meta.band_order[String(res)].indexOf(b);
        const bx = Math.floor(x / f), by = Math.floor(y / f);
        const dn = bins[res][bi * w * h + by * w + bx];
        out[b] = dn === 0 ? null : (dn + info.boa_add_offset) / meta.quantification_value;
      }
      return out;
    }
    function sclAt(x, y) {
      const w = meta.size['20'][0];
      return bins.scl[Math.floor(y / 2) * w + Math.floor(x / 2)];
    }
    function mixedness(x, y) {
      // Spread of B8 among the 10 m pixels inside this pixel's 20 m footprint.
      const x0 = x - (x % 2), y0 = y - (y % 2);
      const [w, h] = meta.size['10'];
      const bi = meta.band_order['10'].indexOf('B08');
      const vals = [];
      for (let yy = y0; yy < y0 + 2; yy++) for (let xx = x0; xx < x0 + 2; xx++) {
        vals.push((bins[10][bi * w * h + yy * w + xx] + meta.bands.B08.boa_add_offset) / meta.quantification_value);
      }
      const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
      return (Math.max(...vals) - Math.min(...vals)) / Math.max(mean, 0.02);
    }
    function exampleSpectrum(key) {
      return meta.examples[key].reflectance;
    }
    function predictionAt(x, y) {
      if (!dw) return null;
      const n = W() * H(), i = y * W() + x;
      if (dw[i] === meta.dynamic_world.empty_value) return null;
      const s = meta.dynamic_world.probability_scale;
      const probs = meta.dynamic_world.classes.map((c) => ({ ...c, p: dw[(c.id + 1) * n + i] / s }));
      return { label: dw[i], probs, ranked: [...probs].sort((a, b) => b.p - a.p) };
    }
    function buildLayers() {
      const w = W(), h = H(), n = w * h;
      const make = () => { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; };
      const cls = make(), conf = make();
      const ci = cls.getContext('2d').createImageData(w, h), fi = conf.getContext('2d').createImageData(w, h);
      const rgb = meta.dynamic_world.classes.map((c) => [1, 3, 5].map((k) => parseInt(c.color.slice(k, k + 2), 16)));
      const s = meta.dynamic_world.probability_scale, empty = meta.dynamic_world.empty_value;
      for (let i = 0; i < n; i++) {
        const o = i * 4, lab = dw[i];
        if (lab === empty) continue; // stays transparent: the image shows through
        const [r, g, b] = rgb[lab];
        ci.data[o] = r; ci.data[o + 1] = g; ci.data[o + 2] = b; ci.data[o + 3] = 255;
        const q = clamp((dw[(lab + 1) * n + i] / s - CONF_LO) / (CONF_HI - CONF_LO));
        for (let k = 0; k < 3; k++) fi.data[o + k] = Math.round(lerp(CONF_A[k], CONF_B[k], q));
        fi.data[o + 3] = 255;
      }
      cls.getContext('2d').putImageData(ci, 0, 0);
      conf.getContext('2d').putImageData(fi, 0, 0);
      return { classes: cls, confidence: conf };
    }
    async function loadDynamicWorld() {
      const info = meta.dynamic_world;
      if (!info) throw new Error('no Dynamic World data in scene.json');
      const res = await fetch(base + info.file);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      let bytes = new Uint8Array(await res.arrayBuffer());
      if (bytes[0] === 0x1f && bytes[1] === 0x8b) { // gzip (unless the server already decoded it)
        if (!('DecompressionStream' in window)) throw new Error('DecompressionStream not supported');
        const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
        bytes = new Uint8Array(await new Response(stream).arrayBuffer());
      }
      if (bytes.length !== (info.classes.length + 1) * W() * H()) throw new Error('unexpected Dynamic World size');
      return bytes;
    }
    function utm(x, y) {
      return [meta.bounds[0] + (x + 0.5) * 10, meta.bounds[3] - (y + 0.5) * 10];
    }

    /* ---------- Canvas sizing ---------- */
    let cw = 0, ch = 0, dpr = 1;
    function resize() {
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      cw = stageBox.clientWidth;
      ch = Math.round(cw / 2);
      canvas.width = Math.round(cw * dpr);
      canvas.height = Math.round(ch * dpr);
      canvas.style.height = `${ch}px`;
      const ls = Math.round(Math.min(150, Math.max(96, cw * 0.2)));
      loupe.width = ls * dpr; loupe.height = ls * dpr;
      loupe.style.width = `${ls}px`; loupe.style.height = `${ls}px`;
      stageBox.style.setProperty('--loupe', `${ls}px`);
      render();
    }

    /* ---------- Intro: stage A (observation) ---------- */
    const SURFACES = ['vegetation', 'bare_soil', 'water', 'built_up'];
    function surfaceColour(key) {
      // Mean true-colour of the example pixel, so the diagram uses the scene's own colours.
      const r = meta.examples[key].reflectance;
      const s = (v) => Math.round(255 * Math.pow(clamp(v / 0.28), 1 / 1.6));
      return `rgb(${s(r.B04)},${s(r.B03)},${s(r.B02)})`;
    }

    function satellite(x, y, scale, angle) {
      ctx.save();
      ctx.translate(x, y);
      ctx.rotate(angle);
      ctx.scale(scale, scale);
      ctx.lineWidth = 1 / scale;
      ctx.strokeStyle = C.ink;
      // Solar array: one wing of three panels (Sentinel-2 has a single deployable wing).
      ctx.fillStyle = C.surface;
      ctx.beginPath(); ctx.moveTo(14, -1); ctx.lineTo(22, -1); ctx.stroke();
      for (let i = 0; i < 3; i++) {
        const px = 22 + i * 17;
        ctx.fillRect(px, -9, 16, 18); ctx.strokeRect(px, -9, 16, 18);
        ctx.beginPath(); ctx.moveTo(px + 8, -9); ctx.lineTo(px + 8, 9); ctx.moveTo(px, 0); ctx.lineTo(px + 16, 0); ctx.stroke();
      }
      // Hexagonal platform body.
      ctx.fillStyle = C.paper;
      ctx.beginPath();
      ctx.moveTo(-14, -8); ctx.lineTo(-6, -14); ctx.lineTo(6, -14); ctx.lineTo(14, -8);
      ctx.lineTo(14, 8); ctx.lineTo(-14, 8); ctx.closePath(); ctx.fill(); ctx.stroke();
      // MSI instrument on the Earth-facing side, with its sun shade.
      ctx.fillStyle = C.surface;
      ctx.beginPath(); ctx.rect(-9, 8, 14, 9); ctx.fill(); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(-7, 17); ctx.lineTo(-9, 21); ctx.lineTo(5, 21); ctx.lineTo(3, 17); ctx.stroke();
      ctx.restore();
    }

    function drawObservation(tt, alpha) {
      const w = cw, h = ch;
      ctx.save();
      ctx.globalAlpha = alpha;
      const groundY = h * 0.78;
      const fadeIn = ease(seg(tt, 0, 800));
      ctx.globalAlpha = alpha * fadeIn;

      // Orbit arc.
      const cx = w * 0.5, R = w * 1.25, cy = h * 0.2 + R;
      ctx.strokeStyle = C.rule; ctx.lineWidth = 1; ctx.setLineDash([3, 4]);
      ctx.beginPath(); ctx.arc(cx, cy, R, Math.PI * 1.36, Math.PI * 1.64); ctx.stroke(); ctx.setLineDash([]);
      ctx.fillStyle = C.muted; ctx.font = `500 10px ${MONO}`; ctx.textAlign = 'right';
      ctx.fillText('SUN-SYNCHRONOUS ORBIT · 786 KM', w * 0.97, h * 0.1);

      // Ground cross-section: four surfaces from the scene.
      const segW = w * 0.68 / 4, gx0 = w * 0.3;
      SURFACES.forEach((key, i) => {
        const x = gx0 + i * segW;
        ctx.fillStyle = surfaceColour(key);
        ctx.fillRect(x, groundY, segW - 6, h * 0.07);
        ctx.fillStyle = C.ink2; ctx.font = `500 10px ${MONO}`; ctx.textAlign = 'center';
        ctx.fillText(EXAMPLE_LABELS[key].toUpperCase(), x + (segW - 6) / 2, groundY + h * 0.07 + 15);
      });
      ctx.strokeStyle = C.ink; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(w * 0.02, groundY); ctx.lineTo(w * 0.98, groundY); ctx.stroke();

      // Sun.
      const sx = w * 0.07, sy = h * 0.17;
      ctx.strokeStyle = C.ink; ctx.fillStyle = C.surface;
      ctx.beginPath(); ctx.arc(sx, sy, 13, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
      for (let k = 0; k < 8; k++) {
        const a = (k / 8) * Math.PI * 2;
        ctx.beginPath(); ctx.moveTo(sx + Math.cos(a) * 17, sy + Math.sin(a) * 17); ctx.lineTo(sx + Math.cos(a) * 23, sy + Math.sin(a) * 23); ctx.stroke();
      }
      ctx.fillStyle = C.muted; ctx.textAlign = 'center'; ctx.fillText('SUNLIGHT', sx, sy + 40);

      // Satellite position along the orbit.
      const pSat = ease(seg(tt, 300, 6800));
      const ang = lerp(Math.PI * 1.44, Math.PI * 1.60, pSat);
      const satX = cx + Math.cos(ang) * R, satY = cy + Math.sin(ang) * R;
      satellite(satX, satY, Math.max(0.8, w / 700), ang + Math.PI / 2);
      ctx.fillStyle = C.ink2; ctx.textAlign = 'left'; ctx.font = `500 10px ${MONO}`;
      ctx.fillText('SENTINEL-2 · MSI', satX + 18, satY - 22);

      // Incoming sunlight (thin, identical for all surfaces).
      const pIn = ease(seg(tt, 1000, 2600));
      ctx.strokeStyle = C.muted; ctx.lineWidth = 1;
      SURFACES.forEach((key, i) => {
        const tx = gx0 + i * segW + (segW - 6) / 2, ty = groundY;
        ctx.beginPath(); ctx.moveTo(sx + 16, sy + 8); ctx.lineTo(lerp(sx + 16, tx, pIn), lerp(sy + 8, ty, pIn)); ctx.stroke();
      });

      // Reflected light: width proportional to measured B8 reflectance.
      const pOut = ease(seg(tt, 2600, 4400));
      if (pOut > 0) {
        SURFACES.forEach((key, i) => {
          const b8 = meta.examples[key].reflectance.B08;
          const tx = gx0 + i * segW + (segW - 6) / 2, ty = groundY;
          ctx.strokeStyle = C.accent; ctx.globalAlpha = alpha * 0.85;
          ctx.lineWidth = Math.max(0.6, b8 * 22);
          ctx.beginPath(); ctx.moveTo(tx, ty); ctx.lineTo(lerp(tx, satX, pOut), lerp(ty, satY + 16, pOut)); ctx.stroke();
          if (pOut > 0.98) {
            ctx.globalAlpha = alpha;
            ctx.fillStyle = C.accent; ctx.font = `500 10px ${MONO}`; ctx.textAlign = 'center';
            ctx.fillText(`B8 ${b8.toFixed(2)}`, tx, ty - 8);
          }
        });
        ctx.globalAlpha = alpha;
      }

      // Spectral comb: the 12 Level-2A bands at their true centre and width.
      const pComb = ease(seg(tt, 4400, 6200));
      if (pComb > 0) {
        const bx = w * 0.02, by = h * 0.5, bw = w * 0.2, bh = h * 0.12;
        const xs = (nm) => bx + ((nm - 400) / (2300 - 400)) * bw;
        ctx.strokeStyle = C.ink; ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(bx, by + bh); ctx.lineTo(bx + bw, by + bh); ctx.stroke();
        BAND_ORDER.forEach((b, i) => {
          const info = meta.bands[b];
          const p = clamp(pComb * 1.4 - i * 0.03);
          ctx.fillStyle = info.res_m === 60 ? C.rule : C.ink2;
          const x0 = xs(info.center_nm - info.width_nm / 2), x1 = xs(info.center_nm + info.width_nm / 2);
          ctx.fillRect(x0, by + bh - bh * p, Math.max(1.5, x1 - x0), bh * p);
        });
        ctx.fillStyle = C.muted; ctx.font = `500 9px ${MONO}`; ctx.textAlign = 'left';
        ctx.fillText('400', bx, by + bh + 12); ctx.textAlign = 'right'; ctx.fillText('2300 nm', bx + bw, by + bh + 12);
        ctx.textAlign = 'left'; ctx.fillStyle = C.ink2;
        ctx.fillText('12 LEVEL-2A BANDS', bx, by - 6);
      }
      ctx.restore();
    }

    /* ---------- Intro: stage B (acquisition) ---------- */
    function chipRectInContext() {
      const cb = meta.context_bounds, b = meta.bounds;
      const cwM = cb[2] - cb[0], chM = cb[3] - cb[1];
      return [(b[0] - cb[0]) / cwM, (cb[3] - b[3]) / chM, (b[2] - b[0]) / cwM, (b[3] - b[1]) / chM];
    }
    function drawContextView(sxF, syF, swF, shF, revealP) {
      const iw = imgCtx.naturalWidth, ih = imgCtx.naturalHeight;
      // Fit the source rect into the 2:1 canvas.
      const sx = sxF * iw, sy = syF * ih, sw = swF * iw, sh = shF * ih;
      const visH = ch * revealP;
      ctx.save();
      ctx.beginPath(); ctx.rect(0, 0, cw, visH); ctx.clip();
      ctx.imageSmoothingEnabled = true;
      ctx.drawImage(imgCtx, sx, sy, sw, sh, 0, 0, cw, ch);
      ctx.restore();
    }
    function drawAcquisition(tt, alpha) {
      const local = tt - 7000;
      const [rx, ry, rw, rh] = chipRectInContext();
      // Context is 2:1 too; show a 2:1 window that starts as the full context.
      const fullH = 1;
      const zoomP = ease(seg(local, 4000, 6200));
      const sxF = lerp(0, rx, zoomP), syF = lerp(0, ry, zoomP);
      const swF = lerp(1, rw, zoomP), shF = lerp(fullH, rh, zoomP);
      const reveal = ease(seg(local, 400, 3400));
      ctx.save();
      ctx.globalAlpha = alpha * ease(seg(local, 0, 500));
      drawContextView(sxF, syF, swF, shF, reveal);
      // Push-broom line.
      if (reveal > 0 && reveal < 1) {
        const y = ch * reveal;
        ctx.strokeStyle = C.accent; ctx.lineWidth = 2;
        ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(cw, y); ctx.stroke();
        label(`PUSH-BROOM · ONE LINE OF PIXELS PER INSTANT`, 12, Math.min(ch - 10, y + 18));
      }
      // Study window outline.
      const outP = seg(local, 3400, 4000) * (1 - seg(local, 5600, 6200));
      if (outP > 0) {
        const x = (rx - sxF) / swF * cw, y = (ry - syF) / shF * ch, w = rw / swF * cw, h = rh / shF * ch;
        ctx.globalAlpha = alpha * outP;
        ctx.strokeStyle = C.paper; ctx.lineWidth = 3; ctx.strokeRect(x, y, w, h);
        ctx.strokeStyle = C.accent; ctx.lineWidth = 1.5; ctx.strokeRect(x, y, w, h);
        label('4.3 × 2.2 KM WINDOW', x, y - 8);
      }
      ctx.restore();
      // Cross-fade to Level-2A true colour (B4/B3/B2).
      const fadeP = ease(seg(local, 6200, 7000));
      if (fadeP > 0) {
        ctx.save(); ctx.globalAlpha = alpha * fadeP; drawTrueColour(); ctx.restore();
        if (fadeP < 1 || local < 8000) {
          ctx.save(); ctx.globalAlpha = alpha * fadeP * (1 - seg(local, 7600, 8000));
          label('LEVEL-2A SURFACE REFLECTANCE · B4 B3 B2 · 10 M', 12, ch - 14);
          ctx.restore();
        }
      }
    }
    function label(text, x, y) {
      ctx.font = `500 10px ${MONO}`;
      const m = ctx.measureText(text).width;
      ctx.textAlign = 'left';
      ctx.fillStyle = 'rgba(21,24,26,.78)';
      ctx.fillRect(x - 4, y - 11, m + 8, 15);
      ctx.fillStyle = '#fff';
      ctx.fillText(text, x, y);
    }
    function drawTrueColour() {
      ctx.imageSmoothingEnabled = cw / W() < 2.5;
      ctx.drawImage(imgTrue, 0, 0, cw, ch);
    }

    /* ---------- Final state ---------- */
    function pixelRect(x, y) {
      const s = cw / W();
      return [x * s, y * s, s, s];
    }
    function drawMarker(p, col, dashed) {
      const [x, y, s] = pixelRect(p.x, p.y);
      const pad = Math.max(3, s);
      ctx.save();
      ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(255,255,255,.9)';
      ctx.strokeRect(x - pad, y - pad, s + pad * 2, s + pad * 2);
      ctx.lineWidth = 1.5; ctx.strokeStyle = col;
      if (dashed) ctx.setLineDash([3, 3]);
      ctx.strokeRect(x - pad, y - pad, s + pad * 2, s + pad * 2);
      ctx.restore();
    }
    // The view actually on screen: during the timeline it follows the stages.
    function effectiveView() {
      if (t >= T_END) return view;
      return t >= STAGES[3].start ? 'classes' : 'image';
    }
    function sourceFor(v) {
      return v !== 'image' && dwLayers ? dwLayers[v] : imgTrue;
    }
    function drawFinal() {
      drawTrueColour();
      const v = effectiveView();
      const p = t >= T_END ? 1 : ease(seg(t, WIPE[0], WIPE[1]));
      if (v !== 'image' && dwLayers && p > 0) {
        ctx.save();
        ctx.beginPath(); ctx.rect(0, 0, cw * p, ch); ctx.clip();
        ctx.imageSmoothingEnabled = false;
        ctx.drawImage(dwLayers[v], 0, 0, cw, ch);
        ctx.restore();
        if (p < 1) {
          ctx.save(); ctx.strokeStyle = C.paper; ctx.lineWidth = 2;
          ctx.beginPath(); ctx.moveTo(cw * p, 0); ctx.lineTo(cw * p, ch); ctx.stroke(); ctx.restore();
        }
        if (t < T_END && t > WIPE[0]) {
          ctx.save(); ctx.globalAlpha = 1 - seg(t, 21400, 21900);
          label('DYNAMIC WORLD · PREDICTED LAND COVER · 10 M', 12, ch - 14);
          ctx.restore();
        }
      }
      updateKey(dwLayers && p > 0 ? v : 'image');
      if (pinned) drawMarker(pinned, C.accent, true);
      if (selected) drawMarker(selected, C.ink, false);
      if (cursor && (!selected || cursor.x !== selected.x || cursor.y !== selected.y)) {
        const [x, y, s] = pixelRect(cursor.x, cursor.y);
        ctx.save(); ctx.setLineDash([2, 2]); ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.5;
        ctx.strokeRect(x - 3, y - 3, s + 6, s + 6); ctx.restore();
      }
    }

    function drawLoupe(p, openP = 1) {
      const size = loupe.width;
      lctx.setTransform(1, 0, 0, 1, 0, 0);
      lctx.clearRect(0, 0, size, size);
      if (!p || openP <= 0) { loupe.style.opacity = '0'; loupeKey.style.opacity = '0'; return; }
      loupe.style.opacity = String(openP); loupeKey.style.opacity = String(openP);
      const n = 13, cell = size / n;
      const src = t >= T_END ? sourceFor(view) : imgTrue;
      const iw = (src.naturalWidth || src.width) / W();
      const sx = (p.x - 6) * iw, sy = (p.y - 6) * iw;
      lctx.imageSmoothingEnabled = false;
      lctx.fillStyle = C.paper; lctx.fillRect(0, 0, size, size);
      lctx.drawImage(src, sx, sy, n * iw, n * iw, 0, 0, size, size);
      lctx.strokeStyle = 'rgba(255,255,255,.35)'; lctx.lineWidth = 1;
      for (let i = 1; i < n; i++) {
        lctx.beginPath(); lctx.moveTo(i * cell, 0); lctx.lineTo(i * cell, size); lctx.stroke();
        lctx.beginPath(); lctx.moveTo(0, i * cell); lctx.lineTo(size, i * cell); lctx.stroke();
      }
      const ox = (q) => (q - (p.x - 6)) * cell, oy = (q) => (q - (p.y - 6)) * cell;
      // 60 m and 20 m footprints that contain this 10 m pixel.
      const x60 = p.x - (p.x % 6), y60 = p.y - (p.y % 6);
      lctx.setLineDash([2, 3]); lctx.strokeStyle = '#fff'; lctx.lineWidth = 1.5 * dpr;
      lctx.strokeRect(ox(x60), oy(y60), 6 * cell, 6 * cell);
      const x20 = p.x - (p.x % 2), y20 = p.y - (p.y % 2);
      lctx.setLineDash([5, 3]); lctx.strokeStyle = '#ffd9c7';
      lctx.strokeRect(ox(x20), oy(y20), 2 * cell, 2 * cell);
      lctx.setLineDash([]); lctx.strokeStyle = C.accent; lctx.lineWidth = 2.5 * dpr;
      lctx.strokeRect(ox(p.x), oy(p.y), cell, cell);
    }

    /* ---------- Land-cover key ---------- */
    function updateKey(v) {
      if (v === keyShown) return;
      keyShown = v;
      if (v === 'image' || !meta.dynamic_world) { classKey.hidden = true; classKey.replaceChildren(); return; }
      const info = meta.dynamic_world;
      const total = Object.values(info.pixel_counts).reduce((a, b) => a + b, 0) || 1;
      let html = '<p class="s2viz-kicker"><b>Predicted</b> · Dynamic World land cover, ' +
        (v === 'classes' ? 'most likely class per pixel' : 'probability of the most likely class') + '</p>';
      if (v === 'classes') {
        const present = info.classes.filter((c) => info.pixel_counts[c.key] > 0);
        const absent = info.classes.filter((c) => !info.pixel_counts[c.key]);
        html += '<ul class="s2viz-classes">' + present.map((c) =>
          `<li><i style="background:${c.color}"></i>${c.name} <span>${Math.round((100 * info.pixel_counts[c.key]) / total)}%</span></li>`).join('') + '</ul>';
        if (absent.length) html += `<p class="s2viz-keynote">Not predicted in this window: ${absent.map((c) => c.name.toLowerCase()).join(', ')}.</p>`;
      } else {
        const a = `rgb(${CONF_A.join(',')})`, b = `rgb(${CONF_B.join(',')})`;
        html += `<div class="s2viz-ramp"><span>≤ ${CONF_LO} less certain</span><i style="background:linear-gradient(90deg,${a},${b})"></i><span>${CONF_HI} more certain</span></div>` +
          `<p class="s2viz-keynote">Median ${info.top_probability_quartiles[1].toFixed(2)} in this window. These are the model’s own probabilities, not a measured accuracy.</p>`;
      }
      classKey.innerHTML = html;
      classKey.hidden = false;
    }

    /* ---------- Chart ---------- */
    const CH = { l: 46, r: 12, t: 14, b: 70, w: 440, h: 290 };
    const xScale = (nm) => CH.l + ((nm - 400) / (2300 - 400)) * (CH.w - CH.l - CH.r);
    let yMax = 0.5;
    const yScale = (v) => CH.t + (1 - v / yMax) * (CH.h - CH.t - CH.b);
    const gAxes = svgEl('g'), gPinned = svgEl('g', { class: 'series pinned' }), gSeries = svgEl('g', { class: 'series current' });
    chart.append(gAxes, gPinned, gSeries);

    function drawAxes() {
      gAxes.replaceChildren();
      const plotB = CH.h - CH.b;
      for (let v = 0; v <= yMax + 1e-9; v += 0.1) {
        const y = yScale(v);
        gAxes.append(svgEl('line', { x1: CH.l, x2: CH.w - CH.r, y1: y, y2: y, class: v === 0 ? 'axis' : 'grid' }));
        const tx = svgEl('text', { x: CH.l - 6, y: y + 3.5, class: 'tick', 'text-anchor': 'end' }); tx.textContent = v.toFixed(1);
        gAxes.append(tx);
      }
      for (const nm of [500, 1000, 1500, 2000]) {
        const x = xScale(nm);
        gAxes.append(svgEl('line', { x1: x, x2: x, y1: plotB, y2: plotB + 4, class: 'axis' }));
        const tx = svgEl('text', { x, y: plotB + 15, class: 'tick', 'text-anchor': 'middle' }); tx.textContent = nf.format(nm);
        gAxes.append(tx);
      }
      // Band strip: true centre and width of each band.
      const sy = plotB + 24;
      for (const b of BAND_ORDER) {
        const info = meta.bands[b];
        const x0 = xScale(info.center_nm - info.width_nm / 2), x1 = xScale(info.center_nm + info.width_nm / 2);
        const r = svgEl('rect', { x: x0, y: sy, width: Math.max(1.5, x1 - x0), height: 7, class: `band r${info.res_m}` });
        const tt = svgEl('title'); tt.textContent = `${b} · ${info.name} · ${info.center_nm} nm · ${info.res_m} m`;
        r.append(tt); gAxes.append(r);
      }
      const bandLabels = { B02: 'B2', B04: 'B4', B08: 'B8', B11: 'B11', B12: 'B12' };
      for (const [b, txt] of Object.entries(bandLabels)) {
        const tx = svgEl('text', { x: xScale(meta.bands[b].center_nm), y: sy + 18, class: 'tick band-label', 'text-anchor': 'middle' });
        tx.textContent = txt; gAxes.append(tx);
      }
      const re = svgEl('text', { x: xScale(742), y: sy - 4, class: 'tick band-label', 'text-anchor': 'middle' }); re.textContent = 'red edge';
      gAxes.append(re);
      const xl = svgEl('text', { x: CH.w - CH.r, y: CH.h - 4, class: 'axis-label', 'text-anchor': 'end' }); xl.textContent = 'Wavelength (nm)';
      const yl = svgEl('text', { x: 12, y: CH.t + 2, class: 'axis-label', transform: `rotate(-90 12 ${CH.t + 2})`, 'text-anchor': 'end' }); yl.textContent = 'Surface reflectance';
      gAxes.append(xl, yl);
    }

    function marker(b, v, cls) {
      const info = meta.bands[b];
      const x = xScale(info.center_nm), y = yScale(v);
      let m;
      if (info.res_m === 10) m = svgEl('circle', { cx: x, cy: y, r: 3.6 });
      else if (info.res_m === 20) m = svgEl('rect', { x: x - 3.4, y: y - 3.4, width: 6.8, height: 6.8, transform: `rotate(45 ${x} ${y})` });
      else m = svgEl('circle', { cx: x, cy: y, r: 3.4, class: 'hollow' });
      m.setAttribute('class', `${m.getAttribute('class') || ''} ${cls}`.trim());
      const tt = svgEl('title'); tt.textContent = `${b} (${info.center_nm} nm, ${info.res_m} m): ${fmt(v)}`;
      m.append(tt);
      return m;
    }
    function drawSeries(group, values, cls) {
      group.replaceChildren();
      if (!values) return;
      const pts = BAND_ORDER.filter((b) => values[b] != null).map((b) => `${xScale(meta.bands[b].center_nm)},${yScale(values[b])}`);
      group.append(svgEl('polyline', { points: pts.join(' '), class: `guide ${cls}` }));
      for (const b of BAND_ORDER) if (values[b] != null) group.append(marker(b, values[b], cls));
    }
    function fitY() {
      const all = [shown, pinned?.values, tween?.to].filter(Boolean).flatMap((v) => Object.values(v)).filter((v) => v != null);
      const need = Math.max(0.5, Math.ceil((Math.max(...all, 0) + 0.02) * 10) / 10);
      if (need !== yMax) { yMax = need; drawAxes(); }
    }
    function updateChart() {
      fitY();
      drawSeries(gPinned, pinned?.values, 'pinned');
      drawSeries(gSeries, shown, 'current');
      if (!shown) {
        const msg = svgEl('text', { x: (CH.l + CH.w - CH.r) / 2, y: (CH.t + CH.h - CH.b) / 2, class: 'empty', 'text-anchor': 'middle' });
        msg.textContent = 'The spectrum of a selected pixel appears here.';
        gSeries.append(msg);
      }
    }

    /* ---------- Selection ---------- */
    function describe(p) {
      const [e, n] = utm(p.x, p.y);
      const scl = sclAt(p.x, p.y);
      const lines = [];
      const name = p.example ? EXAMPLE_LABELS[p.example] : `Pixel ${p.x + 1}, ${p.y + 1}`;
      lines.push(`<p class="s2viz-pixel-name">${name}</p>`);
      lines.push(`<p class="s2viz-pixel-meta">E ${nf.format(e)} · N ${nf.format(n)} m (UTM 32N) · ESA scene classification: <b>${SCL_NAMES[scl] || 'Unknown'}</b></p>`);
      const notes = [];
      if (meta.scl_invalid_classes.includes(scl)) notes.push('This pixel is flagged by the scene classification (for example cloud or shadow); its values are not a reliable surface measurement.');
      if (mixedness(p.x, p.y) > 0.35) notes.push('Mixed surroundings: the 20 m and 60 m bands average over neighbouring surfaces that differ from this 10 m pixel.');
      if (p.example) notes.push('Example chosen by fixed rules in the data-preparation script (scene class, NDVI and a uniform 50 × 50 m neighbourhood).');
      const pred = predictionAt(p.x, p.y);
      if (pred && pred.ranked[0].p < 0.5) notes.push('The model is uncertain here: no land-cover class reaches a probability of 0.5.');
      if (notes.length) lines.push(`<p class="s2viz-note">${notes.join(' ')}</p>`);
      let predHtml = '';
      if (pred) {
        const top = pred.ranked[0];
        const rest = pred.ranked.slice(1).filter((c) => c.p >= 0.05).map((c) => `${c.name} ${c.p.toFixed(2)}`).join(' · ');
        predHtml = `<div class="s2viz-pred"><p class="s2viz-kicker"><b>Predicted</b> · Dynamic World</p>` +
          `<p class="s2viz-pred-top"><i style="background:${top.color}"></i>${top.name} <b>${top.p.toFixed(2)}</b></p>` +
          `<p class="s2viz-pred-bar" aria-hidden="true">${pred.probs.filter((c) => c.p > 0).map((c) => `<span style="width:${(c.p * 100).toFixed(1)}%;background:${c.color}" title="${c.name} ${c.p.toFixed(2)}"></span>`).join('')}</p>` +
          (rest ? `<p class="s2viz-pred-rest">Then ${rest}</p>` : '') + '</div>';
      }
      pixelInfo.innerHTML = `<div class="s2viz-obs">${lines.join('')}</div>${predHtml}`;
      return { name, scl, pred };
    }
    function fillTable() {
      const head = `<thead><tr><th scope="col">Band</th><th scope="col">Centre (nm)</th><th scope="col">Native res.</th><th scope="col">${selected ? 'Selected' : ''}</th>${pinned ? '<th scope="col">Pinned</th>' : ''}</tr></thead>`;
      const rows = BAND_ORDER.map((b) => {
        const i = meta.bands[b];
        const v = selected?.values[b];
        const pv = pinned?.values[b];
        return `<tr><th scope="row">${b}</th><td>${i.center_nm}</td><td>${i.res_m} m</td><td>${v == null ? '—' : fmt(v)}</td>${pinned ? `<td>${pv == null ? '—' : fmt(pv)}</td>` : ''}</tr>`;
      }).join('');
      table.innerHTML = `<caption>Level-2A surface reflectance</caption>${head}<tbody>${rows}</tbody>`;
    }
    function select(p, { announce = true } = {}) {
      if (!bins && !p.example) return;
      const values = p.example ? exampleSpectrum(p.example) : reflectanceAt(p.x, p.y);
      selected = { ...p, values };
      cursor = { x: p.x, y: p.y };
      for (const [k, b] of Object.entries(exampleButtons)) b.setAttribute('aria-pressed', String(k === p.example));
      const { name, scl, pred } = bins ? describe(selected) : { name: EXAMPLE_LABELS[p.example], scl: meta.examples[p.example].scl };
      if (!bins) pixelInfo.innerHTML = `<p class="s2viz-pixel-name">${name}</p>`;
      chartTitle.textContent = `Surface reflectance spectrum of ${name}, 12 Sentinel-2 Level-2A bands from ${meta.bands.B01.center_nm} to ${meta.bands.B12.center_nm} nm.`;
      startTween(values);
      fillTable();
      if (announce) live.textContent = `${name} selected. Scene classification ${SCL_NAMES[scl]}. Red ${fmt(values.B04)}, near infrared ${fmt(values.B08)}, shortwave infrared ${fmt(values.B11)}.` +
        (pred ? ` Dynamic World predicts ${pred.ranked[0].name}, probability ${pred.ranked[0].p.toFixed(2)}.` : '');
      if (t >= T_END) { drawFinal(); drawLoupe(selected); }
    }
    function startTween(to) {
      const from = shown || Object.fromEntries(BAND_ORDER.map((b) => [b, 0]));
      if (reducedMotion.matches) { shown = to; tween = null; updateChart(); return; }
      tween = { from, to, start: performance.now(), dur: 450 };
      tick();
    }
    function tick() {
      if (!tween) return;
      const p = ease(clamp((performance.now() - tween.start) / tween.dur));
      shown = Object.fromEntries(BAND_ORDER.map((b) => [b, tween.to[b] == null ? null : lerp(tween.from[b] ?? 0, tween.to[b], p)]));
      updateChart();
      if (p < 1) requestAnimationFrame(tick); else tween = null;
    }

    /* ---------- Timeline ---------- */
    function render() {
      if (!meta || !imgTrue || !imgCtx || !cw) return;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.fillStyle = C.paper; ctx.fillRect(0, 0, cw, ch);
      if (t >= T_END) { drawFinal(); drawLoupe(selected); return; }
      const aA = 1 - seg(t, 6300, 7000);
      if (t < 7000) drawObservation(t, aA);
      if (t >= 7000) drawAcquisition(Math.min(t, 15000), 1);
      if (t >= 15000) {
        drawFinal();
        drawLoupe(selected, ease(seg(t, 15000, 15800)));
      } else { drawLoupe(null); updateKey('image'); }
    }
    function setStage() {
      const i = STAGES.findIndex((s) => t < s.end);
      const idx = t >= T_END ? (view === 'image' ? 2 : 3) : (i === -1 ? STAGES.length - 1 : i);
      const v = effectiveView();
      for (const [k, b] of Object.entries(viewButtons)) b.setAttribute('aria-pressed', String(k === v));
      stepButtons.forEach((b, k) => b.setAttribute('aria-current', k === idx ? 'step' : 'false'));
      if (caption && caption.dataset.stage !== String(idx)) { caption.textContent = STAGES[idx].caption; caption.dataset.stage = String(idx); }
    }
    function frame(now) {
      if (!playing) return;
      t = Math.min(T_END, t + Math.min(100, now - lastFrame)); // no jump after a background tab
      lastFrame = now;
      if (t >= T_END) view = dwLayers ? 'classes' : 'image';
      if (t >= 15000 && !selected) select({ ...meta.examples.vegetation, example: 'vegetation' }, { announce: false });
      render(); setStage();
      if (t >= T_END) { setPlaying(false); return; }
      raf = requestAnimationFrame(frame);
    }
    function setPlaying(on) {
      playing = on && t < T_END;
      playBtn.textContent = playing ? 'Pause' : 'Play';
      playBtn.disabled = t >= T_END;
      cancelAnimationFrame(raf);
      if (playing) { lastFrame = performance.now(); raf = requestAnimationFrame(frame); }
    }
    function jump(to, play) {
      t = to;
      if (t >= 15000 && !selected) select({ ...meta.examples.vegetation, example: 'vegetation' }, { announce: false });
      render(); setStage(); setPlaying(play);
    }
    // Skip to the interactive state, keeping the view the timeline was showing.
    function finishIntro() {
      if (t >= T_END) return;
      view = dwLayers && t >= STAGES[3].start ? 'classes' : 'image';
      jump(T_END, false);
    }
    function setView(v) {
      finishIntro();
      view = v === 'image' || dwLayers ? v : 'image';
      render(); setStage();
      if (selected) drawLoupe(selected);
      live.textContent = `${VIEWS[view]} view.` + (view === 'image' ? '' : ' Dynamic World prediction, not a measurement.');
    }

    /* ---------- Events ---------- */
    playBtn.addEventListener('click', () => { autoPaused = false; setPlaying(!playing); });
    replayBtn.addEventListener('click', () => { view = 'image'; selected = null; shown = null; pinned = null; pinBtn.setAttribute('aria-pressed', 'false'); updateChart(); jump(0, !reducedMotion.matches); });
    stepButtons.forEach((b, i) => b.addEventListener('click', () => {
      const s = STAGES[i];
      if (i === 2) { view = 'image'; jump(T_END, false); return; } // spectra: the interactive state
      if (i === 3 && (reducedMotion.matches || !dwLayers)) { view = dwLayers ? 'classes' : 'image'; jump(T_END, false); return; }
      view = 'image';
      jump(reducedMotion.matches ? s.still : s.start, !reducedMotion.matches);
    }));
    for (const [key, b] of Object.entries(viewButtons)) b.addEventListener('click', () => setView(key));
    for (const [key, b] of Object.entries(exampleButtons)) b.addEventListener('click', () => {
      finishIntro();
      select({ ...meta.examples[key], example: key });
    });
    pinBtn.addEventListener('click', () => {
      if (pinned) { pinned = null; pinBtn.setAttribute('aria-pressed', 'false'); pinBtn.textContent = 'Compare'; }
      else if (selected) { pinned = { ...selected }; pinBtn.setAttribute('aria-pressed', 'true'); pinBtn.textContent = 'Clear comparison'; live.textContent = `${pixelInfo.querySelector('.s2viz-pixel-name')?.textContent} pinned for comparison. Select another pixel.`; }
      updateChart(); fillTable(); if (t >= T_END) drawFinal();
    });
    function pointToPixel(ev) {
      const r = canvas.getBoundingClientRect();
      return { x: clamp(Math.floor(((ev.clientX - r.left) / r.width) * W()), 0, W() - 1),
        y: clamp(Math.floor(((ev.clientY - r.top) / r.height) * H()), 0, H() - 1) };
    }
    canvas.addEventListener('click', (ev) => { finishIntro(); select(pointToPixel(ev)); });
    canvas.addEventListener('keydown', (ev) => {
      const step = ev.shiftKey ? 10 : 1;
      const moves = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
      if (moves[ev.key]) {
        ev.preventDefault(); finishIntro();
        const c = cursor || { x: Math.floor(W() / 2), y: Math.floor(H() / 2) };
        cursor = { x: clamp(c.x + moves[ev.key][0], 0, W() - 1), y: clamp(c.y + moves[ev.key][1], 0, H() - 1) };
        drawFinal(); drawLoupe(cursor);
      } else if ((ev.key === 'Enter' || ev.key === ' ') && cursor) {
        ev.preventDefault(); select({ ...cursor });
      }
    });
    new ResizeObserver(() => resize()).observe(stageBox);
    // Pause while the figure is off screen (or the Home view is hidden); resume when it returns.
    if ('IntersectionObserver' in window) new IntersectionObserver((entries) => {
      const visible = entries.some((e) => e.isIntersecting);
      if (!visible && playing) { autoPaused = true; setPlaying(false); }
      else if (visible && autoPaused) { autoPaused = false; setPlaying(true); }
    }).observe(figure);
    reducedMotion.addEventListener?.('change', () => { if (reducedMotion.matches) finishIntro(); });

    /* ---------- Load ---------- */
    (async () => {
      meta = await fetch(`${base}scene.json`).then((r) => r.json());
      [imgTrue, imgCtx] = await Promise.all([loadImage(`${base}truecolor.webp`), loadImage(`${base}context.webp`)]);
      await document.fonts?.ready;
      drawAxes();
      resize();
      updateChart();
      fillTable();
      const frozen = Number(new URLSearchParams(location.search).get('s2t'));
      if (frozen > 0) jump(Math.min(frozen, T_END), false);
      else if (reducedMotion.matches) jump(T_END, false);
      else jump(0, true);
      const load = async (f) => new Uint16Array(await fetch(base + f).then((r) => r.arrayBuffer()));
      const [b10, b20, b60, scl] = await Promise.all([load(meta.files['10']), load(meta.files['20']), load(meta.files['60']),
        fetch(base + meta.files.scl).then((r) => r.arrayBuffer()).then((a) => new Uint8Array(a))]);
      bins = { 10: b10, 20: b20, 60: b60, scl };
      try {
        dw = await loadDynamicWorld();
        dwLayers = buildLayers();
      } catch (err) {
        // The measured data still works without the prediction layer.
        console.warn('Dynamic World layer unavailable', err);
        dw = null; dwLayers = null; view = 'image';
        views.remove(); stepButtons[3].remove();
      }
      if (selected) describe(selected);
      render(); setStage();
      figure.classList.add('has-data');
    })().catch((err) => {
      console.error('Sentinel-2 visualization failed to load', err);
      setPlaying(false);
      if (fallback) body.replaceWith(fallback);
      controls.remove();
      figure.classList.add('has-error');
    });
  }

  function boot() {
    document.querySelectorAll('[data-s2viz]').forEach((figure) => {
      if (!('IntersectionObserver' in window)) { init(figure); return; }
      const io = new IntersectionObserver((entries) => {
        if (entries.some((e) => e.isIntersecting)) { io.disconnect(); init(figure); }
      }, { rootMargin: '200px' });
      io.observe(figure);
    });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
})();
