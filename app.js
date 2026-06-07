// ── Palette ────────────────────────────────────────────────────────────────
const PALETTE = ["#39ff14","#00cfff","#ff6b35","#ffdd00","#ff3399","#aa44ff","#ffffff","#ff4444"];

// STRILLO (audible pitch, Hz) → number of wave cycles drawn on screen.
// One knob for both: turn it up and the tone rises AND the wave gets busier.
const visCycles = p => Math.min(20, Math.max(1, p/55));

// average two #rrggbb colours → a single blended #rrggbb
function blendHex(a, b) {
  const ch = (h,i) => parseInt(h.slice(1+i*2, 3+i*2), 16);
  const mix = i => Math.round((ch(a,i)+ch(b,i))/2).toString(16).padStart(2,"0");
  return "#"+mix(0)+mix(1)+mix(2);
}

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

// ── State ──────────────────────────────────────────────────────────────────
const G = { timebase:1, noise:0, trig:0, mode:"wave", running:true };

const CH = [
  { enabled:true, src:"synth", waveform:"sine", freq:2, pitch:220, amp:0.75, gain:2, yOff:0, color:"#39ff14", axis:"x",
    partials:[{ratio:1, amp:1, phase:0}],
    stream:null, micNode:null, analyser:null, micBuf:null, micOk:false },
  { enabled:true, src:"synth", waveform:"sine", freq:3, pitch:330, amp:0.75, gain:2, yOff:0, color:"#00cfff", axis:"y",
    partials:[{ratio:1, amp:1, phase:0}],
    stream:null, micNode:null, analyser:null, micBuf:null, micOk:false },
];
const MAXPARTIALS = 4;
// keep the additive sum bounded to -1..1 regardless of how many partials are on
const partNorm = ch => 1/Math.max(1, ch.partials.reduce((s,p)=>s+p.amp,0));

// ── Mixer / shared audio graph ───────────────────────────────────────────────
// One AudioContext for everyone. The mixer is PER CHANNEL: whatever source a
// channel currently uses (synth / mic / line) is routed into that channel's
// gain, and the two channel gains sum into the master gain → speakers:
//
//   ch0 source (osc | mic | lineL) ─► chan[0].gain ─┐
//   ch1 source (osc | mic | lineR) ─► chan[1].gain ─┴─► master ─► destination
//
// Audibility is governed by the channel gains, so the oscillators can run
// continuously and mute/volume changes never click (setTargetAtTime ramps).
const AUDIO = {
  ctx:null, master:null,
  masterVol:0.7, masterMute:false,
  chan:[
    { vol:0.6, mute:true, gain:null, synthSum:null, parts:[] },   // muted by default → silent start
    { vol:0.6, mute:true, gain:null, synthSum:null, parts:[] },
  ],
};

// Waveform names already match OscillatorNode.type values 1:1.
const oscType = wf => wf;

// Create the shared context + graph on first use (must run inside a user gesture).
function ensureAudio() {
  if (AUDIO.ctx) { if (AUDIO.ctx.state==="suspended") AUDIO.ctx.resume(); return AUDIO.ctx; }
  const ctx = new (window.AudioContext||window.webkitAudioContext)();
  AUDIO.ctx = ctx;
  AUDIO.master = ctx.createGain();
  AUDIO.master.gain.value = AUDIO.masterMute ? 0 : AUDIO.masterVol;
  AUDIO.master.connect(ctx.destination);
  AUDIO.chan.forEach((c,i) => {
    c.gain = ctx.createGain();
    c.gain.gain.value = 0;            // applyChan sets the real value below
    c.gain.connect(AUDIO.master);
    // the "synth" source is an additive bank of oscillators summing into synthSum
    c.synthSum = ctx.createGain();
    c.synthSum.gain.value = 1;
    buildChannelSynth(i);            // create one oscillator per partial
    routeChannel(i);                 // wire the channel's current source in
    applyChan(i);
  });
  if (ctx.state==="suspended") ctx.resume();
  return ctx;
}

// (re)build the additive oscillator bank for a synth channel from CH[i].partials.
// Each partial: osc (waveform) → delay (phase) → gain (amp) → synthSum.
function buildChannelSynth(i) {
  const ctx = AUDIO.ctx, c = AUDIO.chan[i], ch = CH[i];
  if (!ctx || !c.synthSum) return;
  c.parts.forEach(pt => { try{pt.osc.stop();}catch(e){} try{pt.osc.disconnect();}catch(e){}
                          try{pt.delay.disconnect();}catch(e){} try{pt.gain.disconnect();}catch(e){} });
  c.parts = [];
  const norm = partNorm(ch);
  ch.partials.forEach(p => {
    const f = ch.pitch * p.ratio;
    const osc = ctx.createOscillator(); osc.type = oscType(ch.waveform); osc.frequency.value = f;
    const delay = ctx.createDelay(1);   delay.delayTime.value = p.phase/Math.max(1,f);
    const gain = ctx.createGain();      gain.gain.value = p.amp*norm;
    osc.connect(delay).connect(gain).connect(c.synthSum);
    osc.start();
    c.parts.push({ osc, delay, gain });
  });
}

// live-update one partial's audio params (no rebuild → no clicks)
function updatePartialAudio(i) {
  const ctx = AUDIO.ctx, c = AUDIO.chan[i], ch = CH[i];
  if (!ctx) return;
  if (c.parts.length !== ch.partials.length) { buildChannelSynth(i); return; }
  const t = ctx.currentTime, norm = partNorm(ch);
  ch.partials.forEach((p,j) => {
    const pt = c.parts[j], f = ch.pitch*p.ratio;
    pt.osc.frequency.setTargetAtTime(f, t, 0.02);
    pt.delay.delayTime.setTargetAtTime(p.phase/Math.max(1,f), t, 0.02);
    pt.gain.gain.setTargetAtTime(p.amp*norm, t, 0.02);
  });
}

// Connect the node matching the channel's current source to its mixer gain,
// detaching any previously-connected source first (so we never double up).
function routeChannel(i) {
  const c = AUDIO.chan[i];
  if (!c || !c.gain) return;
  const cg = c.gain;
  try { c.synthSum?.disconnect(cg); }    catch(e){}
  try { CH[i].micNode?.disconnect(cg); } catch(e){}
  try { INPUT.tap[i]?.disconnect(cg); }  catch(e){}
  if      (CH[i].src === "synth") c.synthSum?.connect(cg);
  else if (CH[i].src === "mic")   CH[i].micNode?.connect(cg);
  else if (CH[i].src === "input") INPUT.tap[i]?.connect(cg);
}

function applyChan(i) {
  const c = AUDIO.chan[i];
  if (!c || !c.gain) return;
  c.gain.gain.setTargetAtTime(c.mute ? 0 : c.vol, AUDIO.ctx.currentTime, 0.012);
}

function applyMaster() {
  if (!AUDIO.master) return;
  AUDIO.master.gain.setTargetAtTime(AUDIO.masterMute ? 0 : AUDIO.masterVol, AUDIO.ctx.currentTime, 0.012);
}

function mixChanMute(i) {
  AUDIO.chan[i].mute = !AUDIO.chan[i].mute;
  ensureAudio(); applyChan(i); refreshMuteBtn("ch"+i);
}

function mixMasterMute() {
  AUDIO.masterMute = !AUDIO.masterMute;
  ensureAudio(); applyMaster(); refreshMuteBtn("master");
}

function refreshMuteBtn(key) {
  const muted = key==="master" ? AUDIO.masterMute : AUDIO.chan[+key.slice(2)].mute;
  const btn = document.getElementById("mute-"+key);
  if (!btn) return;
  btn.textContent = muted ? "ZITTO" : "SUONA";
  btn.classList.toggle("muted", muted);
}

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

// additive sum of the channel's partials at parametric position t (in periods of
// the channel fundamental). Each partial: ratio (×fundamental), amp, phase (0..1).
function synthAt(ch, t) {
  const wf = WF[ch.waveform]; let s = 0;
  for (const p of ch.partials) s += p.amp * wf(p.ratio*t + p.phase);
  return s * ch.amp * partNorm(ch);
}

function getMicBuf(ch) {
  if (!ch.analyser||!ch.micBuf) return null;
  ch.analyser.getFloatTimeDomainData(ch.micBuf);
  return ch.micBuf;
}

// returns array of values -1..1 for the scope render
function getWaveSamples(ch, n) {
  if (ch.src==="mic" || ch.src==="input") {
    const buf = getMicBuf(ch);
    if (!buf) return new Float32Array(n);
    const win = Math.min(Math.floor(1024*G.timebase), buf.length);
    // X-Y: read the NEWEST window (no trigger) so X and Y stay time-aligned and
    // the figure tracks the live signal with minimal lag. ONDA: trigger to hold still.
    let start = (G.mode==="xy") ? (buf.length - win) : findTrigger(buf, G.trig);
    start = Math.max(0, Math.min(start, buf.length - win));
    const out = new Float32Array(n);
    for (let i=0;i<n;i++) out[i] = (buf[start + Math.floor(i/n*win)]||0)*ch.gain;
    return out;
  } else {
    // synth: additive partials over the channel fundamental (ch.freq cycles across
    // the window). Drives the figure; the audio bank plays the same partials.
    const out = new Float32Array(n);
    const drift = t0*ch.freq*0.0001;        // slow rotation so it isn't frozen
    for (let i=0;i<n;i++) out[i] = synthAt(ch, (i/n)*G.timebase*ch.freq + drift);
    return out;
  }
}

// ── Scope renderers ──────────────────────────────────────────────────────────
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
      const y = samples[i];
      return [(i/(n-1))*W, H/2 - y*margin + ch.yOff*(H/8)];
    });
    strokePts(offCtx, pts, ch.color+"33", 0, 5);
    strokePts(offCtx, pts, ch.color, 6, 1.5);
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

  const pts = Array.from({length:n}, (_,i) => [
    W/2 + samplesX[i]*marginX,
    H/2 - samplesY[i]*marginY,
  ]);
  const colA = xCh ? xCh.color : yCh.color;
  const colB = yCh ? yCh.color : xCh.color;
  paintXY(pts, colA, colB);
}

// stroke the X-Y figure in the channel-colour gradient (no transforms)
function paintXY(pts, colA, colB) {
  const grad = offCtx.createLinearGradient(0,0,W,H);
  grad.addColorStop(0, colA); grad.addColorStop(1, colB);
  const glow = blendHex(colA, colB);
  const path = lw => {
    offCtx.beginPath();
    pts.forEach(([px,py],i)=>{ i?offCtx.lineTo(px,py):offCtx.moveTo(px,py); });
    offCtx.lineWidth=lw; offCtx.stroke();
  };
  offCtx.shadowBlur=0; offCtx.strokeStyle=glow+"33"; path(4);
  offCtx.shadowBlur=8; offCtx.shadowColor=glow; offCtx.strokeStyle=grad; path(1.5);
  offCtx.shadowBlur=0;
}

// ── Render loop ────────────────────────────────────────────────────────────
function loop(ts) {
  requestAnimationFrame(loop);
  if (!offCtx || !G.running) return;
  t0 = ts;

  offCtx.fillStyle="rgba(0,0,0,0.2)"; offCtx.fillRect(0,0,W,H);
  if (G.mode==="wave")    drawWave();
  else if (G.mode==="xy") drawXY();

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
    const actx = ensureAudio();
    if (actx.state==="suspended") await actx.resume();
    ch.analyser = actx.createAnalyser();
    ch.analyser.fftSize=2048; ch.analyser.smoothingTimeConstant=0;
    ch.micNode = actx.createMediaStreamSource(stream);
    ch.micNode.connect(ch.analyser);             // for the scope render
    // the audio (monitor) path is wired by routeChannel() once src becomes "mic"
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
  try { ch.micNode?.disconnect(); } catch(e){}
  try { ch.analyser?.disconnect(); } catch(e){}
  // the AudioContext is shared (the mixer owns it) → never close it here
  ch.stream=null; ch.micNode=null; ch.analyser=null; ch.micBuf=null; ch.micOk=false;
}

// ── Line input (audio interface): ONE stereo stream, split L→CH1, R→CH2 ───────
const INPUT = {
  stream:null, source:null, splitter:null, deviceId:null,
  analyser:[null,null], buf:[null,null], tap:[null,null],
};

// open (or reopen) the chosen input device as a clean stereo line source
async function startInput(deviceId) {
  const ctx = ensureAudio();
  if (ctx.state==="suspended") await ctx.resume();
  stopInputStream();
  const audio = { echoCancellation:false, noiseSuppression:false, autoGainControl:false, channelCount:2 };
  if (deviceId) audio.deviceId = { exact: deviceId };
  let stream;
  try { stream = await navigator.mediaDevices.getUserMedia({ audio }); }
  catch(e) { console.warn("Input:", e.name, e.message); return false; }
  INPUT.stream = stream;
  INPUT.deviceId = deviceId || null;
  INPUT.source = ctx.createMediaStreamSource(stream);
  INPUT.splitter = ctx.createChannelSplitter(2);
  INPUT.source.connect(INPUT.splitter);
  for (let i=0;i<2;i++) {
    const a = ctx.createAnalyser(); a.fftSize=2048; a.smoothingTimeConstant=0;
    INPUT.splitter.connect(a, i);                 // scope tap (L=0 → CH1, R=1 → CH2)
    INPUT.analyser[i] = a; INPUT.buf[i] = new Float32Array(2048);
    const g = ctx.createGain(); INPUT.splitter.connect(g, i);  // mixer monitor tap
    INPUT.tap[i] = g;
  }
  return true;
}

function stopInputStream() {
  INPUT.stream?.getTracks().forEach(t=>t.stop());
  try { INPUT.source?.disconnect(); } catch(e){}
  try { INPUT.splitter?.disconnect(); } catch(e){}
  INPUT.tap.forEach(g => { try { g?.disconnect(); } catch(e){} });
  INPUT.stream=INPUT.source=INPUT.splitter=null;
  INPUT.analyser=[null,null]; INPUT.buf=[null,null]; INPUT.tap=[null,null];
}

// detach one channel from the line input; stop the stream if nobody else needs it
function detachInput(i) {
  try { INPUT.tap[i]?.disconnect(AUDIO.chan[i].gain); } catch(e){}
  CH[i].analyser=null; CH[i].micBuf=null;
  const other = i===0?1:0;
  if (CH[other].src!=="input") {
    stopInputStream();
    const card = document.getElementById("input-card");
    if (card) card.style.display="none";
  }
}

// fill the device dropdown (labels need a granted permission, so call after start)
async function populateInputDevices() {
  try {
    const devs = await navigator.mediaDevices.enumerateDevices();
    const sel = document.getElementById("input-device");
    if (!sel) return;
    sel.innerHTML = "";
    devs.filter(d=>d.kind==="audioinput").forEach((d,idx)=>{
      const o = document.createElement("option");
      o.value = d.deviceId;
      o.textContent = d.label || ("Ingresso "+(idx+1));
      sel.appendChild(o);
    });
    if (INPUT.deviceId) sel.value = INPUT.deviceId;
  } catch(e) { console.warn(e); }
}


// ── Controls ───────────────────────────────────────────────────────────────
function setMode(m) {
  G.mode = m;
  ["wave","xy"].forEach(id => {
    const btn = document.getElementById("tab-"+id);
    btn.className = m===id?"active":"";
    btn.style.color = m===id?"#39ff14":"#555";
    btn.style.boxShadow = m===id?"inset 0 -2px 0 #39ff14":"none";
  });
  const label = { wave:"ONDA", xy:"X-Y" }[m] || m.toUpperCase();
  document.getElementById("screen-label").textContent = label;
  // axis pickers only matter in X-Y; SU-GIU' (vertical offset) only in ONDA
  [0,1].forEach(i => {
    document.getElementById("axis-row-ch"+i).style.display = m==="xy"?"block":"none";
    document.getElementById("yoff-row-ch"+i).style.display = m==="xy"?"none":"flex";
  });
  clearScreen();
}

// ── Per-channel additive oscillators (internal synth only) ───────────────────
// Each synth channel is a stack of up to MAXPARTIALS partials {ratio, amp,
// phase} you can add/remove to experiment. The editor lives in the channel card.
function renderPartials(i) {
  const box = document.getElementById("osc-ch"+i);
  if (!box) return;
  const ch = CH[i], col = ch.color;
  let html = "";
  ch.partials.forEach((p,j) => {
    html += `<div class="osc" style="border-left-color:${col}">
      <div class="osc-head">
        <span class="osc-title" style="color:${col}">OSC ${j+1}</span>
        ${j>0?`<button class="osc-del" onclick="removePartial(${i},${j})" aria-label="Elimina oscillatore">RIMUOVI ✕</button>`:``}
      </div>
      <div class="slider-row">
        <div class="slider-meta"><span class="sl">RAPPORTO</span><span class="sv" id="vp-${i}-${j}-ratio">${p.ratio.toFixed(2)}</span></div>
        <input type="range" min="0.5" max="8" step="0.01" value="${p.ratio}" oninput="setPart(${i},${j},'ratio',this.value)">
      </div>
      <div class="slider-row">
        <div class="slider-meta"><span class="sl">AMPIEZZA</span><span class="sv" id="vp-${i}-${j}-amp">${p.amp.toFixed(2)}</span></div>
        <input type="range" min="0" max="1" step="0.01" value="${p.amp}" oninput="setPart(${i},${j},'amp',this.value)">
      </div>
      <div class="slider-row">
        <div class="slider-meta"><span class="sl">FASE</span><span class="sv" id="vp-${i}-${j}-phase">${p.phase.toFixed(2)}</span></div>
        <input type="range" min="0" max="1" step="0.01" value="${p.phase}" oninput="setPart(${i},${j},'phase',this.value)">
      </div>
    </div>`;
  });
  if (ch.partials.length < MAXPARTIALS)
    html += `<button class="osc-add" style="border-color:${col};color:${col}" onclick="addPartial(${i})">+ OSCILLATORE</button>`;
  box.innerHTML = html;
}

function setPart(i,j,key,val) {
  CH[i].partials[j][key] = parseFloat(val);
  const el = document.getElementById(`vp-${i}-${j}-${key}`);
  if (el) el.textContent = parseFloat(val).toFixed(2);
  updatePartialAudio(i);
}

function addPartial(i) {
  if (CH[i].partials.length >= MAXPARTIALS) return;
  CH[i].partials.push({ ratio:CH[i].partials.length+1, amp:0.5, phase:0 });
  buildChannelSynth(i); renderPartials(i);
}

function removePartial(i,j) {
  CH[i].partials.splice(j,1);
  buildChannelSynth(i); renderPartials(i);
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
  // highlight the active source button
  document.querySelectorAll("#src-ch"+i+" button").forEach(b=>{
    const a = b.dataset.v===val;
    b.className = a?"active":"";
    b.style.background  = a?ch.color:"transparent";
    b.style.color       = a?"#000":"#444";
    b.style.borderColor = a?ch.color:"#2a2a2a";
  });
  document.getElementById("synth-ch"+i).style.display     = val==="synth"?"block":"none";
  document.getElementById("amp-row-ch"+i).style.display   = val==="synth"?"flex":"none";
  document.getElementById("pitch-row-ch"+i).style.display = val==="synth"?"flex":"none";
  document.getElementById("gain-row-ch"+i).style.display  = (val==="mic"||val==="input")?"flex":"none";
}

async function setSrc(i, btn) {
  const ch = CH[i];
  const val = btn.dataset.v;
  if (val===ch.src) return;
  // tear down whatever this channel was using
  if (ch.src==="mic")   stopMic(ch);
  if (ch.src==="input") detachInput(i);

  if (val==="mic") {
    const ok = await startMic(ch);
    if (!ok) { alert("Microfono non disponibile o negato"); return; }
    ch.src = "mic";
    AUDIO.chan[i].mute = true;            // monitor muted → no Larsen surprise
  } else if (val==="input") {
    if (!INPUT.stream) {
      const ok = await startInput(INPUT.deviceId);
      if (!ok) { alert("Ingresso audio non disponibile o negato"); return; }
    }
    await populateInputDevices();
    const card = document.getElementById("input-card");
    if (card) card.style.display = "";
    ch.src = "input";
    ch.analyser = INPUT.analyser[i];      // L → CH1, R → CH2
    ch.micBuf = INPUT.buf[i];
    AUDIO.chan[i].mute = true;            // monitor muted by default → no feedback
  } else {
    ch.src = "synth";
    ch.analyser = null; ch.micBuf = null;
  }
  updateSrcUI(i, val);
  routeChannel(i);                        // wire the newly-selected source into the mixer
  applyChan(i);
  refreshMuteBtn("ch"+i);
}

function setWave(i, btn) {
  CH[i].waveform = btn.dataset.w;
  AUDIO.chan[i]?.parts.forEach(pt => { if (pt.osc) pt.osc.type = oscType(CH[i].waveform); });
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
  // tint this channel's mixer strip name
  const mixName = document.getElementById("mixname-ch"+i);
  if (mixName) mixName.style.color = color;
  // update slider accent
  ["sl-amp-ch"+i,"sl-pitch-ch"+i,"sl-gain-ch"+i,"sl-yoff-ch"+i].forEach(id=>{
    const el = document.getElementById(id);
    if (el) el.style.accentColor = color;
  });
  // update value displays
  ["v-amp-ch"+i,"v-pitch-ch"+i,"v-gain-ch"+i,"v-yoff-ch"+i].forEach(id=>{
    const el = document.getElementById(id);
    if (el) el.style.color = color;
  });
  renderPartials(i);    // recolor the oscillator editor accents
  updateLED(i);
}

function updateLED(i) {
  const led = document.getElementById("led-ch"+(i+1));
  if (!led) return;
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
  btn.textContent = G.running?"FERMA":"VAI";
  btn.classList.toggle("stopped", !G.running);
  const led = document.getElementById("led-run");
  if (led) {
    led.style.background = G.running?"#39ff14":"#333";
    led.style.boxShadow  = G.running?"0 0 4px #39ff14":"none";
  }
  // STOP/RUN double as audio pause/play: suspend/resume the whole engine
  if (AUDIO.ctx) { G.running ? AUDIO.ctx.resume() : AUDIO.ctx.suspend(); }
}

function toggleFullscreen() {
  const el = document.getElementById("screen-wrap");
  const on = el.classList.toggle("fs");
  document.getElementById("btn-fs").textContent = on ? "BASTA" : "GIGANTE";
  // try the native API too (nice on Android/desktop; harmless where unsupported)
  try {
    if (on && el.requestFullscreen) el.requestFullscreen().catch(()=>{});
    else if (!on && document.fullscreenElement && document.exitFullscreen) document.exitFullscreen().catch(()=>{});
  } catch(e){}
  // the canvas changed size → recompute the backing store next frame
  requestAnimationFrame(initCanvas);
}

function clearScreen() {
  if (offCtx){offCtx.fillStyle="#000";offCtx.fillRect(0,0,W,H);}
}

// ── Init ───────────────────────────────────────────────────────────────────
window.addEventListener("load", ()=>{
  initCanvas();
  new ResizeObserver(initCanvas).observe(canvas);

  // line-input device picker: switch interface and re-point the active channels
  document.getElementById("input-device").addEventListener("change", async e=>{
    const ok = await startInput(e.target.value);
    if (!ok) return;
    [0,1].forEach(i => {
      if (CH[i].src==="input") {
        CH[i].analyser = INPUT.analyser[i];
        CH[i].micBuf = INPUT.buf[i];
        routeChannel(i);
      }
    });
  });

  // sliders per channel
  [0,1].forEach(i=>{
    const ch = CH[i];
    bindSlider(`sl-amp-ch${i}`,  `v-amp-ch${i}`,  ch, "amp",   v=>v.toFixed(2));
    bindSlider(`sl-pitch-ch${i}`,`v-pitch-ch${i}`,ch, "pitch", v=>v.toFixed(0)+"Hz");
    bindSlider(`sl-gain-ch${i}`, `v-gain-ch${i}`, ch, "gain",  v=>"×"+v.toFixed(1));
    bindSlider(`sl-yoff-ch${i}`, `v-yoff-ch${i}`, ch, "yOff",  v=>(v>=0?"+":"")+v.toFixed(1));
    // STRILLO is one knob: it sets the audible pitch AND the on-screen wave
    // density (higher pitch → busier wave), so there's no separate FREQ control.
    ch.freq = visCycles(ch.pitch);
    document.getElementById(`sl-pitch-ch${i}`).addEventListener("input", e=>{
      const p = parseFloat(e.target.value);
      ch.freq = visCycles(p);
      updatePartialAudio(i);            // repitch every partial of the bank
    });

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

  // mixer: per-channel volume faders + master
  const bindMixVol = (chIdx, slId, vvId) => {
    const sl = document.getElementById(slId), vv = document.getElementById(vvId);
    if (!sl||!vv) return;
    vv.textContent = parseFloat(sl.value).toFixed(2);
    sl.addEventListener("input", ()=>{
      const v = parseFloat(sl.value);
      if (chIdx===null) AUDIO.masterVol = v; else AUDIO.chan[chIdx].vol = v;
      vv.textContent = v.toFixed(2);
      ensureAudio();
      if (chIdx===null) applyMaster(); else applyChan(chIdx);
    });
  };
  [0,1].forEach(i=>{
    bindMixVol(i, "vol-ch"+i, "vv-ch"+i);
    refreshMuteBtn("ch"+i);
  });
  bindMixVol(null, "vol-master", "vv-master");
  refreshMuteBtn("master");

  // init per-channel oscillator editors + mode tab styles
  [0,1].forEach(renderPartials);
  setMode("wave");

  requestAnimationFrame(loop);
});
