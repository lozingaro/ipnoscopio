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
  { enabled:true, src:"synth", waveform:"sine", freq:2, pitch:220, amp:0.75, gain:2, yOff:0, color:"#39ff14", axis:"x",
    stream:null, micNode:null, analyser:null, micBuf:null, micOk:false },
  { enabled:true, src:"synth", waveform:"sine", freq:3, pitch:330, amp:0.75, gain:2, yOff:0, color:"#00cfff", axis:"y",
    stream:null, micNode:null, analyser:null, micBuf:null, micOk:false },
];

// ── Draw mode state (image → audio → XY) ─────────────────────────────────────
const DRAW = {
  active:false,     // sketching on the screen right now
  playing:false,    // a drawn shape is looping as audio
  strokes:[],       // array of strokes, each an array of {x,y} device px
  freq:220,         // loop frequency (Hz) → buffer length = sampleRate / freq
  N:0,              // samples per loop period (one cycle) for stable rendering
  saved:null,       // channel state to restore when draw playback ends
  src:null, splitter:null,
  tap:[null,null],  // per-channel mono taps (L→ch0, R→ch1) feeding the mixer
  analyserX:null, analyserY:null,
};

// ── Mixer / shared audio graph ───────────────────────────────────────────────
// One AudioContext for everyone. The mixer is PER CHANNEL: whatever source a
// channel currently uses (synth / mic / draw) is routed into that channel's
// gain, and the two channel gains sum into the master gain → speakers:
//
//   ch0 source (osc | mic | drawL) ─► chan[0].gain ─┐
//   ch1 source (osc | mic | drawR) ─► chan[1].gain ─┴─► master ─► destination
//
// Audibility is governed by the channel gains, so the oscillators can run
// continuously and mute/volume changes never click (setTargetAtTime ramps).
const AUDIO = {
  ctx:null, master:null,
  masterVol:0.7, masterMute:false,
  noiseGain:null,                   // global white-noise level → master
  chan:[
    { vol:0.6, mute:true, gain:null, osc:null },   // muted by default → silent start
    { vol:0.6, mute:true, gain:null, osc:null },
  ],
};

// Waveform names already match OscillatorNode.type values 1:1.
const oscType = wf => wf;

// RUMORE slider (0..1) → white-noise gain into the master (kept modest)
const NOISE_AUDIO = 0.25;

// Create the shared context + graph on first use (must run inside a user gesture).
function ensureAudio() {
  if (AUDIO.ctx) { if (AUDIO.ctx.state==="suspended") AUDIO.ctx.resume(); return AUDIO.ctx; }
  const ctx = new (window.AudioContext||window.webkitAudioContext)();
  AUDIO.ctx = ctx;
  AUDIO.master = ctx.createGain();
  AUDIO.master.gain.value = AUDIO.masterMute ? 0 : AUDIO.masterVol;
  AUDIO.master.connect(ctx.destination);
  // global white noise: a looping random buffer → its own gain → master
  const nbuf = ctx.createBuffer(1, ctx.sampleRate*2, ctx.sampleRate);
  const nd = nbuf.getChannelData(0);
  for (let i=0;i<nd.length;i++) nd[i] = Math.random()*2-1;
  const nsrc = ctx.createBufferSource(); nsrc.buffer = nbuf; nsrc.loop = true;
  AUDIO.noiseGain = ctx.createGain();
  AUDIO.noiseGain.gain.value = G.noise*NOISE_AUDIO;
  nsrc.connect(AUDIO.noiseGain); AUDIO.noiseGain.connect(AUDIO.master);
  nsrc.start();
  AUDIO.chan.forEach((c,i) => {
    c.gain = ctx.createGain();
    c.gain.gain.value = 0;            // applyChan sets the real value below
    c.gain.connect(AUDIO.master);
    // a continuously-running oscillator backs the "synth" source
    const osc = ctx.createOscillator();
    osc.type = oscType(CH[i].waveform);
    osc.frequency.value = CH[i].pitch;
    osc.start();
    c.osc = osc;
    routeChannel(i);                 // wire the channel's current source in
    applyChan(i);
  });
  if (ctx.state==="suspended") ctx.resume();
  return ctx;
}

// Connect the node matching the channel's current source to its mixer gain,
// detaching any previously-connected source first (so we never double up).
function routeChannel(i) {
  const c = AUDIO.chan[i];
  if (!c || !c.gain) return;
  const cg = c.gain;
  try { c.osc?.disconnect(cg); }         catch(e){}
  try { CH[i].micNode?.disconnect(cg); } catch(e){}
  try { DRAW.tap[i]?.disconnect(cg); }   catch(e){}
  try { INPUT.tap[i]?.disconnect(cg); }  catch(e){}
  if      (CH[i].src === "synth") c.osc?.connect(cg);
  else if (CH[i].src === "mic")   CH[i].micNode?.connect(cg);
  else if (CH[i].src === "draw")  DRAW.tap[i]?.connect(cg);
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
  btn.textContent = muted ? "MUTO" : "SUONA";
  btn.classList.toggle("muted", muted);
}

// Diagnostic: play a plain 440 Hz beep straight into the master bus for ~0.5 s.
// If you hear THIS but not a drawn shape → routing bug. If you hear nothing at
// all → the AudioContext/output/device is the problem, not the draw code.
function audioTest() {
  const ctx = ensureAudio();
  const go = () => {
    const osc = ctx.createOscillator(); osc.type = "sine"; osc.frequency.value = 440;
    const g = ctx.createGain(); g.gain.value = 0;
    osc.connect(g); g.connect(AUDIO.master);
    const t = ctx.currentTime;
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.4, t+0.02);
    g.gain.setValueAtTime(0.4, t+0.45);
    g.gain.linearRampToValueAtTime(0, t+0.5);
    osc.start(t); osc.stop(t+0.52);
  };
  if (ctx.state==="suspended") ctx.resume().then(go); else go();
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
    // TRIGGER: lock the start to a rising crossing of the LIVELLO so the wave
    // stays still on screen instead of sliding. Map over exactly one loop period.
    const len  = Math.min(DRAW.N || buf.length, buf.length);
    const off2 = findTrigger(buf, G.trig);
    const out  = new Float32Array(n);
    for (let i=0; i<n; i++) out[i] = buf[Math.min(off2 + Math.floor(i/n*len), buf.length-1)] || 0;
    return out;
  }
  if (ch.src==="mic" || ch.src==="input") {
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
      const noise = (Math.random()-.5)*G.noise*0.3;   // visual grain echoes the audible noise
      const y = (samples[i]+noise);
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

  if (xCh && yCh) {
    // two channels → a spatial gradient from CANALE 1 (X) colour to CANALE 2 (Y)
    // colour, so both colours are visible and either one affects the trace
    const grad = offCtx.createLinearGradient(0, 0, W, H);
    grad.addColorStop(0, xCh.color);
    grad.addColorStop(1, yCh.color);
    const glow = blendHex(xCh.color, yCh.color);
    const trace = lw => {
      offCtx.beginPath();
      pts.forEach(([x,y],i)=> i?offCtx.lineTo(x,y):offCtx.moveTo(x,y));
      offCtx.lineWidth = lw; offCtx.stroke();
    };
    offCtx.shadowBlur = 0;  offCtx.strokeStyle = glow+"33"; trace(4);          // soft underlay
    offCtx.shadowBlur = 8;  offCtx.shadowColor = glow; offCtx.strokeStyle = grad; trace(1.5);
    offCtx.shadowBlur = 0;
  } else {
    const col = xCh ? xCh.color : yCh.color;
    strokePts(offCtx, pts, col+"33", 0, 4);
    strokePts(offCtx, pts, col, 8, 1.5);
  }
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
  if (!offCtx) return;
  // STOP pauses the live signals, but DISEGNA stays interactive so you can keep
  // sketching whether the scope is running or stopped
  if (!G.running && G.mode!=="draw") return;
  t0 = ts;

  if (G.mode==="draw") {
    // full clear each frame so the sketch persists without fading
    offCtx.fillStyle="#000"; offCtx.fillRect(0,0,W,H);
    drawSketch();
  } else {
    offCtx.fillStyle="rgba(0,0,0,0.2)"; offCtx.fillRect(0,0,W,H);
    if (G.mode==="wave")    drawWave();
    else if (G.mode==="xy") drawXY();
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

// ── Draw → audio → XY ────────────────────────────────────────────────────────
// Entering draw mode is non-destructive: an existing sketch is kept so you can
// return from X-Y, tweak it and re-SUONA. Only PULISCI wipes it.
function startSketch() {
  DRAW.active = true;
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
  routeChannel(i);                 // src is now "draw" → feed the draw tap into the mixer
  // make sure you actually hear it: a drawn shape forces its channels audible
  AUDIO.chan[i].mute = false;
  applyChan(i);
  refreshMuteBtn("ch"+i);
}

function restoreChannelSynth(i) {
  const ch = CH[i];
  ch.src = "synth"; ch.analyser = null; ch.micBuf = null;
  // restore the channel state we overrode when the drawn signal took over
  if (DRAW.saved && DRAW.saved[i]) {
    ch.enabled = DRAW.saved[i].enabled;
    ch.axis = DRAW.saved[i].axis;
    AUDIO.chan[i].mute = DRAW.saved[i].mute;
  }
  updateSrcUI(i, "synth");
  setAxisUI(i, ch.axis);
  refreshChannelEnabled(i);
  routeChannel(i);                 // back to the synth oscillator
  applyChan(i);
  refreshMuteBtn("ch"+i);
}

function stopDrawAudio() {
  if (DRAW.src) { try { DRAW.src.stop(); } catch(e){} try { DRAW.src.disconnect(); } catch(e){} }
  try { DRAW.splitter?.disconnect(); } catch(e){}
  try { DRAW.tap[0]?.disconnect(); } catch(e){}
  try { DRAW.tap[1]?.disconnect(); } catch(e){}
  // the AudioContext is shared (the mixer owns it) → never close it here
  DRAW.src = DRAW.splitter = null;
  DRAW.tap = [null,null];
  DRAW.analyserX = DRAW.analyserY = null;
  DRAW.playing = false;
  [0,1].forEach(i => { if (CH[i].src==="draw") restoreChannelSynth(i); });
  DRAW.saved = null;
}

// the full pipeline: sketch → sorted path → resample → spline → stereo loop → XY
async function drawConvert() {
  const P0 = DRAW.strokes.flat();
  if (P0.length < 4) { alert("Disegna prima una forma!"); return; }
  stopDrawAudio();

  // normalise on the DRAWING's own bounding box (not the screen): centre it and
  // scale to fill ~95% of -1..1 keeping aspect ratio. This makes the audio loud
  // and consistent regardless of how big/where you drew, and centres the figure.
  let P = P0.map(p => ({ x:p.x, y:p.y }));
  let minX=Infinity, maxX=-Infinity, minY=Infinity, maxY=-Infinity;
  for (const p of P) { minX=Math.min(minX,p.x); maxX=Math.max(maxX,p.x); minY=Math.min(minY,p.y); maxY=Math.max(maxY,p.y); }
  const cxp=(minX+maxX)/2, cyp=(minY+maxY)/2;
  const half = Math.max((maxX-minX)/2, (maxY-minY)/2) || 1;
  const k = 0.95/half;
  P = P.map(p => ({ x:(p.x-cxp)*k, y:-(p.y-cyp)*k }));
  P = sortPoints(P);

  const actx = ensureAudio();
  if (actx.state==="suspended") await actx.resume();

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
  splitter.connect(aX, 0);   // scope tap, X
  splitter.connect(aY, 1);   // scope tap, Y
  // per-channel mono audio taps: X → channel 1, Y → channel 2. routeChannel()
  // connects these into each channel's mixer gain (it's oscilloscope music).
  const tapL = actx.createGain(); splitter.connect(tapL, 0);
  const tapR = actx.createGain(); splitter.connect(tapR, 1);
  src.start();

  Object.assign(DRAW, { src, splitter, tap:[tapL,tapR], analyserX:aX, analyserY:aY, playing:true });
  // remember channel state so we can restore it when playback ends
  DRAW.saved = [0,1].map(i => ({ enabled:CH[i].enabled, axis:CH[i].axis, mute:AUDIO.chan[i].mute }));
  configureDrawChannel(0, aX, "x");
  configureDrawChannel(1, aY, "y");
  if (!G.running) toggleRun();   // SUONA from a stopped scope resumes play so you see+hear it
  setMode("xy");
}

// ── Controls ───────────────────────────────────────────────────────────────
function setMode(m) {
  // a drawn shape now survives every view: X-Y shows the figure, ONDA shows its
  // two source waves X(t)/Y(t). It's torn down only by PULISCI or a source change.
  G.mode = m;
  if (m !== "draw") DRAW.active = false;
  ["wave","xy","draw"].forEach(id => {
    const btn = document.getElementById("tab-"+id);
    btn.className = m===id?"active":"";
    btn.style.color = m===id?"#39ff14":"#555";
    btn.style.boxShadow = m===id?"inset 0 -2px 0 #39ff14":"none";
  });
  const label = { wave:"ONDA", xy:"X-Y", draw:"DISEGNA" }[m] || m.toUpperCase();
  document.getElementById("mode-label").textContent = label;
  document.getElementById("screen-label").textContent = label;
  // axis pickers only matter in X-Y; SU-GIU' (vertical offset) only in ONDA/DISEGNA
  [0,1].forEach(i => {
    document.getElementById("axis-row-ch"+i).style.display = m==="xy"?"block":"none";
    document.getElementById("yoff-row-ch"+i).style.display = m==="xy"?"none":"flex";
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
  if (ch.src==="draw")  stopDrawAudio();
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
  const s = AUDIO.chan[i];
  if (s && s.osc) s.osc.type = oscType(CH[i].waveform);
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
  btn.textContent = G.running?"STOP":"RUN";
  btn.classList.toggle("stopped", !G.running);
  const led = document.getElementById("led-run");
  led.style.background = G.running?"#39ff14":"#333";
  led.style.boxShadow  = G.running?"0 0 4px #39ff14":"none";
  // STOP/RUN double as audio pause/play: suspend/resume the whole engine
  if (AUDIO.ctx) { G.running ? AUDIO.ctx.resume() : AUDIO.ctx.suspend(); }
}

function toggleFullscreen() {
  const el = document.getElementById("screen-wrap");
  const on = el.classList.toggle("fs");
  document.getElementById("btn-fs").textContent = on ? "ESCI" : "TUTTO SCHERMO";
  // try the native API too (nice on Android/desktop; harmless where unsupported)
  try {
    if (on && el.requestFullscreen) el.requestFullscreen().catch(()=>{});
    else if (!on && document.fullscreenElement && document.exitFullscreen) document.exitFullscreen().catch(()=>{});
  } catch(e){}
  // the canvas changed size → recompute the backing store next frame
  requestAnimationFrame(initCanvas);
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
  bindSlider("sl-noise", "v-noise", G, "noise", v=>v.toFixed(2));
  // RUMORE drives a real white-noise voice in the audio, not just the visual grain
  document.getElementById("sl-noise").addEventListener("input", e=>{
    ensureAudio();
    if (AUDIO.noiseGain) AUDIO.noiseGain.gain.setTargetAtTime(parseFloat(e.target.value)*NOISE_AUDIO, AUDIO.ctx.currentTime, 0.02);
  });
  bindSlider("sl-dfreq", "v-dfreq", DRAW, "freq",  v=>v.toFixed(0)+"Hz");

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
      const s = AUDIO.chan[i];
      if (s.osc) s.osc.frequency.setTargetAtTime(p, AUDIO.ctx.currentTime, 0.01);
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

  // run LED
  const led = document.getElementById("led-run");
  led.style.background = "#39ff14";
  led.style.boxShadow  = "0 0 4px #39ff14";

  // init mode tab styles
  setMode("wave");

  requestAnimationFrame(loop);
});
