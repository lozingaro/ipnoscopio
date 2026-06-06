// ── Palette ────────────────────────────────────────────────────────────────
const PALETTE = ["#39ff14","#00cfff","#ff6b35","#ffdd00","#ff3399","#aa44ff","#ffffff","#ff4444"];

// ── Waveforms ──────────────────────────────────────────────────────────────
const WF = {
  sine:     t => Math.sin(2*Math.PI*t),
  square:   t => Math.sign(Math.sin(2*Math.PI*t)),
  sawtooth: t => 2*(t-Math.floor(t+0.5)),
  triangle: t => 2*Math.abs(2*(t-Math.floor(t+0.5)))-1,
};

function findTrigger(buf, level, hyst=0.02) {
  for (let i=1; i<buf.length-1; i++)
    if (buf[i-1]<level-hyst && buf[i]>=level) return i;
  return 0;
}

// ── Draw-mode geometry pipeline ──────────────────────────────────────────────
const clamp1 = v => v < -1 ? -1 : v > 1 ? 1 : v;

// nearest-neighbour traversal → continuous path
function sortPoints(pts) {
  if (pts.length < 2) return pts.slice();
  const rest = pts.slice();
  const path = [rest.shift()];
  while (rest.length) {
    const last = path[path.length-1];
    let bi = 0, bd = Infinity;
    for (let i=0; i<rest.length; i++) {
      const dx = rest[i].x-last.x, dy = rest[i].y-last.y, d = dx*dx+dy*dy;
      if (d < bd) { bd = d; bi = i; }
    }
    path.push(rest.splice(bi,1)[0]);
  }
  return path;
}

// equidistant resampling along a CLOSED path → M points (seamless loop)
function resamplePath(pts, M) {
  const p = pts.slice(); p.push(p[0]);          // close the loop
  const seg = []; let total = 0;
  for (let i=1; i<p.length; i++) {
    const d = Math.hypot(p[i].x-p[i-1].x, p[i].y-p[i-1].y);
    seg.push(d); total += d;
  }
  if (total === 0) return Array.from({length:M}, () => ({...p[0]}));
  const out = []; let si = 0, acc = 0;
  for (let i=0; i<M; i++) {
    const target = (i/M)*total;
    while (si < seg.length-1 && acc + seg[si] < target) { acc += seg[si]; si++; }
    const t = seg[si] > 0 ? (target-acc)/seg[si] : 0;
    const a = p[si], b = p[si+1];
    out.push({ x:a.x+(b.x-a.x)*t, y:a.y+(b.y-a.y)*t });
  }
  return out;
}

// closed Catmull-Rom spline → N smoothed points
function catmullRom(cp, N) {
  const m = cp.length, out = new Array(N);
  for (let i=0; i<N; i++) {
    const u = (i/N)*m, seg = Math.floor(u), t = u-seg;
    const p0 = cp[(seg-1+m)%m], p1 = cp[seg%m], p2 = cp[(seg+1)%m], p3 = cp[(seg+2)%m];
    const t2 = t*t, t3 = t2*t;
    out[i] = {
      x: 0.5*((2*p1.x) + (-p0.x+p2.x)*t + (2*p0.x-5*p1.x+4*p2.x-p3.x)*t2 + (-p0.x+3*p1.x-3*p2.x+p3.x)*t3),
      y: 0.5*((2*p1.y) + (-p0.y+p2.y)*t + (2*p0.y-5*p1.y+4*p2.y-p3.y)*t2 + (-p0.y+3*p1.y-3*p2.y+p3.y)*t3),
    };
  }
  return out;
}

// ── State ──────────────────────────────────────────────────────────────────
const G = { timebase:1, noise:0, trig:0, mode:"wave", running:true };

const CH = [
  { enabled:true, src:"synth", waveform:"sine", freq:2, amp:0.75, gain:2, yOff:0, color:"#39ff14", axis:"x",
    stream:null, actx:null, analyser:null, micBuf:null, micOk:false },
  { enabled:true, src:"synth", waveform:"sine", freq:3, amp:0.75, gain:2, yOff:0, color:"#00cfff", axis:"y",
    stream:null, actx:null, analyser:null, micBuf:null, micOk:false },
];

// ── Draw mode state (image → audio → XY) ─────────────────────────────────────
const DRAW = {
  active:false,     // sketching on the screen right now
  playing:false,    // a drawn shape is looping as audio
  strokes:[],       // array of strokes, each an array of {x,y} device px
  freq:55,          // loop frequency (Hz) → buffer length = sampleRate / freq
  N:0,              // samples per loop period (one cycle) for stable rendering
  saved:null,       // channel state to restore when draw playback ends
  actx:null, src:null, splitter:null, merger:null, gain:null,
  analyserX:null, analyserY:null,
};

// ── Canvas ─────────────────────────────────────────────────────────────────
const canvas = document.getElementById("scope");
const ctx    = canvas.getContext("2d");
let off, offCtx, W, H;

function initCanvas() {
  const dpr  = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  W = Math.round(rect.width*dpr);
  H = Math.round(rect.height*dpr);
  canvas.width=W; canvas.height=H;
  off = document.createElement("canvas");
  off.width=W; off.height=H;
  offCtx = off.getContext("2d");
  offCtx.fillStyle="#000"; offCtx.fillRect(0,0,W,H);
}

function drawGrid() {
  const cols=10, rows=8;
  for(let i=0;i<=cols;i++){
    ctx.strokeStyle=i===5?"rgba(57,255,20,0.28)":"rgba(57,255,20,0.12)";
    ctx.lineWidth=i===5?1:0.5;
    ctx.beginPath();ctx.moveTo((i/cols)*W,0);ctx.lineTo((i/cols)*W,H);ctx.stroke();
  }
  for(let j=0;j<=rows;j++){
    ctx.strokeStyle=j===4?"rgba(57,255,20,0.28)":"rgba(57,255,20,0.12)";
    ctx.lineWidth=j===4?1:0.5;
    ctx.beginPath();ctx.moveTo(0,(j/rows)*H);ctx.lineTo(W,(j/rows)*H);ctx.stroke();
  }
}

// ── Signal helpers ─────────────────────────────────────────────────────────
let t0=0;

function synthSample(ch, phase) {
  return WF[ch.waveform](phase*ch.freq)*ch.amp;
}

function getMicBuf(ch) {
  if (!ch.analyser||!ch.micBuf) return null;
  ch.analyser.getFloatTimeDomainData(ch.micBuf);
  return ch.micBuf;
}

// returns array of values -1..1 for wave mode
function getWaveSamples(ch, n) {
  if (ch.src==="draw") {
    const buf = getMicBuf(ch);
    if (!buf) return new Float32Array(n);
    // map over exactly one loop period (N) — the shape is closed, so any phase
    // start traces the same curve → stable, flicker-free, no overlaid copies
    const len = Math.min(DRAW.N || buf.length, buf.length);
    const out = new Float32Array(n);
    for (let i=0; i<n; i++) out[i] = buf[Math.floor(i/n*len)] || 0;
    return out;
  }
  if (ch.src==="mic") {
    const buf = getMicBuf(ch);
    if (!buf) return new Float32Array(n);
    const off2 = findTrigger(buf, G.trig);
    const win  = Math.min(Math.floor(1024*G.timebase), buf.length-off2);
    const out  = new Float32Array(n);
    for (let i=0;i<n;i++) {
      const idx = off2+Math.floor(i/n*win);
      out[i] = (buf[Math.min(idx,buf.length-1)]||0)*ch.gain;
    }
    return out;
  } else {
    const out = new Float32Array(n);
    for (let i=0;i<n;i++) {
      const t = (i/n)*G.timebase + t0*ch.freq*0.0001;
      out[i] = synthSample(ch, t);
    }
    return out;
  }
}

// returns single current value for dot/XY
function getCurrentSample(ch) {
  if (ch.src==="draw") {
    const buf = getMicBuf(ch);
    return buf ? (buf[0]||0) : 0;
  }
  if (ch.src==="mic") {
    const buf = getMicBuf(ch);
    if (!buf) return 0;
    const off2 = findTrigger(buf, G.trig);
    return (buf[off2]||0)*ch.gain;
  } else {
    const t = t0*ch.freq*0.0001;
    return synthSample(ch, t);
  }
}

// ── Draw modes ─────────────────────────────────────────────────────────────
function strokePts(c, pts, color, blur, lw) {
  if (pts.length<2) return;
  c.shadowBlur=blur; c.shadowColor=color; c.strokeStyle=color; c.lineWidth=lw;
  c.beginPath(); pts.forEach(([x,y],i)=>i?c.lineTo(x,y):c.moveTo(x,y)); c.stroke();
  c.shadowBlur=0;
}

function drawWave() {
  const n = Math.min(W*2, 1440);
  const margin = H/2-8;
  CH.forEach(ch => {
    if (!ch.enabled) return;
    const samples = getWaveSamples(ch, n);
    const pts = Array.from({length:n}, (_,i) => {
      const noise = (Math.random()-.5)*G.noise*2;
      const y = (samples[i]+noise);
      return [(i/(n-1))*W, H/2 - y*margin + ch.yOff*(H/8)];
    });
    strokePts(offCtx, pts, ch.color+"33", 0, 5);
    strokePts(offCtx, pts, ch.color, 6, 1.5);
  });
}

function drawDot() {
  const margin = H/2-16;
  CH.forEach(ch => {
    if (!ch.enabled) return;
    const v = getCurrentSample(ch) + (Math.random()-.5)*G.noise*2;
    const x = W/2;
    const y = H/2 - v*margin + ch.yOff*(H/8);
    const col = ch.color;
    const g2 = offCtx.createRadialGradient(x,y,0,x,y,20);
    g2.addColorStop(0, col+"ee");
    g2.addColorStop(0.3, col+"66");
    g2.addColorStop(1, col+"00");
    offCtx.fillStyle=g2;
    offCtx.beginPath(); offCtx.arc(x,y,20,0,Math.PI*2); offCtx.fill();
    offCtx.fillStyle="#fff";
    offCtx.shadowBlur=8; offCtx.shadowColor=col;
    offCtx.beginPath(); offCtx.arc(x,y,2.5,0,Math.PI*2); offCtx.fill();
    offCtx.shadowBlur=0;
  });
}

function drawXY() {
  // find X and Y channels
  const xCh = CH.find(c=>c.enabled&&c.axis==="x");
  const yCh = CH.find(c=>c.enabled&&c.axis==="y");
  if (!xCh&&!yCh) return;

  const n = Math.min(W*2, 1440);
  const samplesX = xCh ? getWaveSamples(xCh, n) : new Float32Array(n);
  const samplesY = yCh ? getWaveSamples(yCh, n) : new Float32Array(n);
  const marginX  = W/2-8;
  const marginY  = H/2-8;

  // color: blend or use whichever is active
  const col = xCh ? xCh.color : yCh.color;

  const pts = Array.from({length:n}, (_,i) => [
    W/2 + samplesX[i]*marginX,
    H/2 - samplesY[i]*marginY,
  ]);
  strokePts(offCtx, pts, col+"33", 0, 4);
  strokePts(offCtx, pts, col, 8, 1.5);
}

function drawSketch() {
  const total = DRAW.strokes.reduce((s,st)=>s+st.length, 0);
  if (total < 1) {
    // crosshair hint on empty canvas
    offCtx.strokeStyle="rgba(57,255,20,0.25)"; offCtx.lineWidth=1;
    offCtx.beginPath(); offCtx.moveTo(W/2,H/2-12); offCtx.lineTo(W/2,H/2+12);
    offCtx.moveTo(W/2-12,H/2); offCtx.lineTo(W/2+12,H/2); offCtx.stroke();
    return;
  }
  DRAW.strokes.forEach(st => {
    const path = st.map(p => [p.x, p.y]);
    strokePts(offCtx, path, "#39ff1433", 0, 5);
    strokePts(offCtx, path, "#39ff14", 8, 2);
  });
}

// ── Render loop ────────────────────────────────────────────────────────────
function loop(ts) {
  requestAnimationFrame(loop);
  if (!G.running||!offCtx) return;
  t0 = ts;

  if (G.mode==="draw") {
    // full clear each frame so the sketch persists without fading
    offCtx.fillStyle="#000"; offCtx.fillRect(0,0,W,H);
    drawSketch();
  } else {
    offCtx.fillStyle="rgba(0,0,0,0.2)"; offCtx.fillRect(0,0,W,H);
    if (G.mode==="wave")      drawWave();
    else if (G.mode==="dot")  drawDot();
    else if (G.mode==="xy")   drawXY();
  }

  // trigger line (wave mode only)
  if (G.mode==="wave") {
    const ty = H/2 - G.trig*(H/2-8);
    offCtx.strokeStyle="rgba(255,220,0,0.25)"; offCtx.lineWidth=1; offCtx.setLineDash([3,6]);
    offCtx.beginPath(); offCtx.moveTo(0,ty); offCtx.lineTo(W,ty); offCtx.stroke();
    offCtx.setLineDash([]);
  }

  ctx.fillStyle="#000"; ctx.fillRect(0,0,W,H);
  ctx.drawImage(off,0,0);
  drawGrid();
  for(let y=0;y<H;y+=Math.max(2,H/180)){ctx.fillStyle="rgba(0,0,0,0.05)";ctx.fillRect(0,y,W,1);}
  const vg=ctx.createRadialGradient(W/2,H/2,H*.2,W/2,H/2,H*.8);
  vg.addColorStop(0,"transparent"); vg.addColorStop(1,"rgba(0,0,0,0.55)");
  ctx.fillStyle=vg; ctx.fillRect(0,0,W,H);
}

// ── Mic ────────────────────────────────────────────────────────────────────
async function startMic(ch) {
  try {
    const constraints = [{ audio:{sampleRate:44100} }, { audio:{sampleRate:48000} }, { audio:true }];
    let stream = null;
    for (const c of constraints) {
      try { stream = await navigator.mediaDevices.getUserMedia(c); break; }
      catch(e) { if (e.name!=="OverconstrainedError") throw e; }
    }
    if (!stream) throw new Error("no stream");
    ch.stream = stream;
    ch.actx = new (window.AudioContext||window.webkitAudioContext)();
    if (ch.actx.state==="suspended") await ch.actx.resume();
    ch.analyser = ch.actx.createAnalyser();
    ch.analyser.fftSize=2048; ch.analyser.smoothingTimeConstant=0;
    ch.actx.createMediaStreamSource(stream).connect(ch.analyser);
    ch.micBuf = new Float32Array(2048);
    ch.micOk = true;
    return true;
  } catch(e) {
    console.warn("Mic:", e.name, e.message);
    ch.micOk = false;
    return false;
  }
}

function stopMic(ch) {
  ch.stream?.getTracks().forEach(t=>t.stop());
  ch.actx?.close();
  ch.stream=null; ch.actx=null; ch.analyser=null; ch.micBuf=null; ch.micOk=false;
}

// ── Draw → audio → XY ────────────────────────────────────────────────────────
function startSketch() {
  stopDrawAudio();
  DRAW.strokes = [];
  DRAW.active = true;
  clearScreen();
}

function resetDraw() {
  stopDrawAudio();
  DRAW.strokes = [];
  DRAW.active = true;
  clearScreen();
}

// route a drawn-shape analyser into a channel so the XY renderer picks it up
function configureDrawChannel(i, analyser, axis) {
  const ch = CH[i];
  if (ch.src==="mic") stopMic(ch);   // release any live mic stream/context first
  ch.src = "draw";
  ch.analyser = analyser;
  ch.micBuf = new Float32Array(analyser.fftSize);
  ch.axis = axis;
  ch.enabled = true;
  updateSrcUI(i, "draw");
  setAxisUI(i, axis);
  refreshChannelEnabled(i);
}

function restoreChannelSynth(i) {
  const ch = CH[i];
  ch.src = "synth"; ch.analyser = null; ch.micBuf = null;
  // restore the channel state we overrode when the drawn signal took over
  if (DRAW.saved && DRAW.saved[i]) { ch.enabled = DRAW.saved[i].enabled; ch.axis = DRAW.saved[i].axis; }
  updateSrcUI(i, "synth");
  setAxisUI(i, ch.axis);
  refreshChannelEnabled(i);
}

function stopDrawAudio() {
  if (DRAW.src) { try { DRAW.src.stop(); } catch(e){} }
  if (DRAW.actx) { try { DRAW.actx.close(); } catch(e){} }
  DRAW.actx = DRAW.src = DRAW.splitter = DRAW.merger = DRAW.gain = null;
  DRAW.analyserX = DRAW.analyserY = null;
  DRAW.playing = false;
  [0,1].forEach(i => { if (CH[i].src==="draw") restoreChannelSynth(i); });
  DRAW.saved = null;
}

// the full pipeline: sketch → sorted path → resample → spline → stereo loop → XY
function drawConvert() {
  const P0 = DRAW.strokes.flat();
  if (P0.length < 4) { alert("Disegna prima una forma!"); return; }
  stopDrawAudio();

  // normalise to -1..1 preserving aspect ratio (centre of screen = origin)
  const s = 2/Math.max(W,H);
  let P = P0.map(p => ({ x:(p.x-W/2)*s, y:-(p.y-H/2)*s }));
  P = sortPoints(P);

  const actx = new (window.AudioContext||window.webkitAudioContext)();
  if (actx.state==="suspended") actx.resume();

  const N = Math.max(64, Math.round(actx.sampleRate / DRAW.freq));
  DRAW.N = N;
  const M = Math.min(256, Math.max(8, P.length));
  const smooth = catmullRom(resamplePath(P, M), N);

  const buf = actx.createBuffer(2, N, actx.sampleRate);
  const L = buf.getChannelData(0), R = buf.getChannelData(1);
  for (let i=0; i<N; i++) { L[i] = clamp1(smooth[i].x); R[i] = clamp1(smooth[i].y); }

  const src = actx.createBufferSource(); src.buffer = buf; src.loop = true;
  const splitter = actx.createChannelSplitter(2);
  const aX = actx.createAnalyser(); aX.fftSize = 4096; aX.smoothingTimeConstant = 0;
  const aY = actx.createAnalyser(); aY.fftSize = 4096; aY.smoothingTimeConstant = 0;
  src.connect(splitter);
  splitter.connect(aX, 0);
  splitter.connect(aY, 1);
  // also play it (quietly) — it's oscilloscope music after all
  const merger = actx.createChannelMerger(2);
  splitter.connect(merger, 0, 0);
  splitter.connect(merger, 1, 1);
  const gain = actx.createGain(); gain.gain.value = 0.25;
  merger.connect(gain).connect(actx.destination);
  src.start();

  Object.assign(DRAW, { actx, src, splitter, merger, gain, analyserX:aX, analyserY:aY, playing:true });
  // remember channel state so we can restore it when playback ends
  DRAW.saved = [0,1].map(i => ({ enabled:CH[i].enabled, axis:CH[i].axis }));
  configureDrawChannel(0, aX, "x");
  configureDrawChannel(1, aY, "y");
  setMode("xy");
}

// ── Controls ───────────────────────────────────────────────────────────────
function setMode(m) {
  // a drawn shape only lives in XY/DRAW views; leaving them stops its audio
  if (DRAW.playing && m !== "xy" && m !== "draw") stopDrawAudio();
  G.mode = m;
  if (m !== "draw") DRAW.active = false;
  ["wave","dot","xy","draw"].forEach(id => {
    const btn = document.getElementById("tab-"+id);
    btn.className = m===id?"active":"";
    btn.style.color = m===id?"#39ff14":"#555";
    btn.style.boxShadow = m===id?"inset 0 -2px 0 #39ff14":"none";
  });
  document.getElementById("mode-label").textContent = m.toUpperCase();
  document.getElementById("screen-label").textContent = "● "+m.toUpperCase();
  // show/hide axis rows + draw card
  [0,1].forEach(i => {
    document.getElementById("axis-row-ch"+i).style.display = m==="xy"?"block":"none";
  });
  document.getElementById("draw-card").style.display = m==="draw"?"":"none";
  if (m === "draw") startSketch();
  else clearScreen();
}

// sync the toggle button, card opacity and LED to ch.enabled
function refreshChannelEnabled(i) {
  const ch = CH[i];
  const btn = document.getElementById("toggle-ch"+i);
  btn.textContent = ch.enabled?"ON":"OFF";
  btn.style.background  = ch.enabled ? ch.color : "transparent";
  btn.style.color       = ch.enabled ? "#000"   : "#555";
  btn.style.borderColor = ch.enabled ? ch.color  : "#333";
  document.getElementById("card-ch"+i).style.opacity = ch.enabled?"1":"0.4";
  updateLED(i);
}

function toggleCh(i) {
  CH[i].enabled = !CH[i].enabled;
  refreshChannelEnabled(i);
}

function updateSrcUI(i, val) {
  const ch = CH[i];
  // seg buttons (no button matches "draw" → both inactive, signalling external src)
  document.querySelectorAll("#src-ch"+i+" button").forEach(b=>{
    const a = b.dataset.v===val;
    b.className = a?"active":"";
    b.style.background  = a?ch.color:"transparent";
    b.style.color       = a?"#000":"#444";
    b.style.borderColor = a?ch.color:"#2a2a2a";
  });
  document.getElementById("synth-ch"+i).style.display    = val==="synth"?"block":"none";
  document.getElementById("freq-row-ch"+i).style.display = val==="synth"?"flex":"none";
  document.getElementById("amp-row-ch"+i).style.display  = val==="synth"?"flex":"none";
  document.getElementById("gain-row-ch"+i).style.display = val==="mic"?"flex":"none";
}

async function setSrc(i, btn) {
  const ch = CH[i];
  const val = btn.dataset.v;
  if (ch.src==="draw") stopDrawAudio();   // leaving a drawn shape → tear it down
  if (val===ch.src) return;
  if (val==="mic") {
    const ok = await startMic(ch);
    if (!ok) { alert("Microfono non disponibile o negato"); return; }
  } else {
    stopMic(ch);
  }
  ch.src = val;
  updateSrcUI(i, val);
}

function setWave(i, btn) {
  CH[i].waveform = btn.dataset.w;
  btn.closest(".seg").querySelectorAll("button").forEach(b=>{
    const a = b===btn;
    b.className = a?"active":"";
    applySegStyle(b, a, CH[i].color);
  });
}

function setAxisUI(i, val) {
  document.querySelectorAll("#axis-ch"+i+" button").forEach(b=>{
    const a = b.dataset.v===val;
    b.className = a?"active":"";
    applySegStyle(b, a, CH[i].color);
  });
}

function setAxis(i, btn) {
  CH[i].axis = btn.dataset.v;
  setAxisUI(i, CH[i].axis);
}

function applySegStyle(btn, active, color) {
  btn.style.background  = active?color:"transparent";
  btn.style.color       = active?"#000":"#444";
  btn.style.borderColor = active?color:"#2a2a2a";
}

function setColor(i, color) {
  CH[i].color = color;
  // update dot, name, toggle button
  document.getElementById("dot-ch"+i).style.background = color;
  document.getElementById("dot-ch"+i).style.boxShadow  = `0 0 6px ${color}`;
  const toggle = document.getElementById("toggle-ch"+i);
  if (CH[i].enabled) { toggle.style.background=color; toggle.style.borderColor=color; }
  // update swatch selection
  document.querySelectorAll("#swatches-ch"+i+" .swatch").forEach(s=>{
    s.classList.toggle("selected", s.dataset.c===color);
  });
  // recolor active seg buttons for this channel
  document.querySelectorAll("#src-ch"+i+" button.active, #axis-ch"+i+" button.active").forEach(b=>{
    b.style.background=color; b.style.borderColor=color;
  });
  // update slider accent
  ["sl-freq-ch"+i,"sl-amp-ch"+i,"sl-gain-ch"+i,"sl-yoff-ch"+i].forEach(id=>{
    const el = document.getElementById(id);
    if (el) el.style.accentColor = color;
  });
  // update value displays
  ["v-freq-ch"+i,"v-amp-ch"+i,"v-gain-ch"+i,"v-yoff-ch"+i].forEach(id=>{
    const el = document.getElementById(id);
    if (el) el.style.color = color;
  });
  updateLED(i);
}

function updateLED(i) {
  const led = document.getElementById("led-ch"+(i+1));
  const ch  = CH[i];
  led.style.background = ch.enabled ? ch.color : "#1a1a1a";
  led.style.boxShadow  = ch.enabled ? `0 0 4px ${ch.color}` : "none";
}

function bindSlider(id, valId, obj, key, fmt) {
  const sl = document.getElementById(id);
  const vl = document.getElementById(valId);
  if (!sl||!vl) return;
  sl.addEventListener("input", ()=>{
    obj[key] = parseFloat(sl.value);
    vl.textContent = fmt(obj[key]);
  });
}

function toggleRun() {
  G.running = !G.running;
  const btn = document.getElementById("btn-run");
  btn.textContent = G.running?"■\u00a0\u00a0STOP":"▶\u00a0\u00a0RUN";
  btn.classList.toggle("stopped", !G.running);
  const led = document.getElementById("led-run");
  led.style.background = G.running?"#39ff14":"#333";
  led.style.boxShadow  = G.running?"0 0 4px #39ff14":"none";
}

function clearScreen() {
  if (DRAW.active) DRAW.strokes = [];
  if (offCtx){offCtx.fillStyle="#000";offCtx.fillRect(0,0,W,H);}
}

// ── Init ───────────────────────────────────────────────────────────────────
window.addEventListener("load", ()=>{
  initCanvas();
  new ResizeObserver(initCanvas).observe(canvas);

  // sliders global
  bindSlider("sl-time",  "v-time",  G, "timebase", v=>v.toFixed(1)+"×");
  bindSlider("sl-noise", "v-noise", G, "noise",    v=>v.toFixed(2));
  bindSlider("sl-trig",  "v-trig",  G, "trig",     v=>v.toFixed(2));
  bindSlider("sl-dfreq", "v-dfreq", DRAW, "freq",  v=>v.toFixed(0)+"Hz");

  // drawing input
  let sketching = false;
  const sketchPoint = e => {
    if (G.mode!=="draw" || !DRAW.active) return;
    const stroke = DRAW.strokes[DRAW.strokes.length-1];
    if (!stroke) return;
    const rect = canvas.getBoundingClientRect();
    const x = (e.clientX-rect.left)/rect.width*W;
    const y = (e.clientY-rect.top)/rect.height*H;
    const last = stroke[stroke.length-1];
    if (!last || Math.hypot(x-last.x, y-last.y) > Math.max(2, W*0.004)) stroke.push({x,y});
  };
  canvas.addEventListener("pointerdown", e=>{
    if (G.mode!=="draw") return;
    sketching = true;
    DRAW.strokes.push([]);          // start a new stroke (multi-stroke shapes)
    canvas.setPointerCapture?.(e.pointerId);
    sketchPoint(e); e.preventDefault();
  });
  canvas.addEventListener("pointermove", e=>{ if (sketching){ sketchPoint(e); e.preventDefault(); } });
  canvas.addEventListener("pointerup",   ()=>{ sketching = false; });
  canvas.addEventListener("pointercancel", ()=>{ sketching = false; });

  // sliders per channel
  [0,1].forEach(i=>{
    const ch = CH[i];
    bindSlider(`sl-freq-ch${i}`, `v-freq-ch${i}`, ch, "freq",  v=>v.toFixed(1)+"Hz");
    bindSlider(`sl-amp-ch${i}`,  `v-amp-ch${i}`,  ch, "amp",   v=>v.toFixed(2));
    bindSlider(`sl-gain-ch${i}`, `v-gain-ch${i}`, ch, "gain",  v=>"×"+v.toFixed(1));
    bindSlider(`sl-yoff-ch${i}`, `v-yoff-ch${i}`, ch, "yOff",  v=>(v>=0?"+":"")+v.toFixed(1));

    // swatches
    const container = document.getElementById("swatches-ch"+i);
    PALETTE.forEach(c=>{
      const s = document.createElement("div");
      s.className = "swatch" + (c===ch.color?" selected":"");
      s.dataset.c = c;
      s.style.background = c;
      s.style.boxShadow  = `0 0 4px ${c}55`;
      s.onclick = ()=>setColor(i, c);
      container.appendChild(s);
    });

    // init visual state
    setColor(i, ch.color);
    updateLED(i);
  });

  // run LED
  const led = document.getElementById("led-run");
  led.style.background = "#39ff14";
  led.style.boxShadow  = "0 0 4px #39ff14";

  // init mode tab styles
  setMode("wave");

  requestAnimationFrame(loop);
});
