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
    stream:null, micNode:null, analyser:null, micBuf:null, micOk:false },
  { enabled:true, src:"synth", waveform:"sine", freq:3, pitch:330, amp:0.75, gain:2, yOff:0, color:"#00cfff", axis:"y",
    stream:null, micNode:null, analyser:null, micBuf:null, micOk:false },
];

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
    { vol:0.6, mute:true, gain:null, osc:null },   // muted by default → silent start
    { vol:0.6, mute:true, gain:null, osc:null },
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
  try { INPUT.tap[i]?.disconnect(cg); }  catch(e){}
  if      (CH[i].src === "synth") c.osc?.connect(cg);
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

function synthSample(ch, phase) {
  return WF[ch.waveform](phase*ch.freq)*ch.amp;
}

function getMicBuf(ch) {
  if (!ch.analyser||!ch.micBuf) return null;
  ch.analyser.getFloatTimeDomainData(ch.micBuf);
  return ch.micBuf;
}

// returns array of values -1..1 for wave mode.
// freqOverride (optional) replaces the synth visual frequency (used by COMBINA).
function getWaveSamples(ch, n, freqOverride) {
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
    const out = new Float32Array(n);
    const f = freqOverride || ch.freq;
    for (let i=0;i<n;i++) {
      const t = (i/n)*G.timebase + t0*f*0.0001;
      out[i] = WF[ch.waveform](t*f)*ch.amp;
    }
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
  // COMBINA · SORGENTI: RAPPORTO locks the Y synth frequency to X×ratio (stable
  // Lissajous from two synths); for mic/line it's ignored.
  const yFreq = (xCh && yCh && yCh.src==="synth" && xCh.src==="synth") ? xCh.freq*GEN.ratio : null;
  let samplesY = yCh ? getWaveSamples(yCh, n, yFreq) : new Float32Array(n);
  // FASE: rotate Y by a fraction of the window → rotates the figure (works for any
  // source, synth or input)
  if (GEN.phase) {
    const k = Math.floor(((GEN.phase%1)+1)%1 * n);
    if (k) { const r = new Float32Array(n); for (let i=0;i<n;i++) r[i]=samplesY[(i+k)%n]; samplesY = r; }
  }
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

// generative engine → X-Y figure (its own analysers, channel colours)
function drawGen() {
  if (!GEN.on || !GEN.analyser[0]) return;
  GEN.analyser[0].getFloatTimeDomainData(GEN.buf[0]);
  GEN.analyser[1].getFloatTimeDomainData(GEN.buf[1]);
  const bx = GEN.buf[0], by = GEN.buf[1], Ln = bx.length;
  const n = Math.min(W*2, 1440), marginX = W/2-8, marginY = H/2-8;
  const pts = Array.from({length:n}, (_,i) => {
    const idx = Math.floor(i/n*Ln);
    return [W/2 + (bx[idx]||0)*marginX, H/2 - (by[idx]||0)*marginY];
  });
  paintXY(pts, CH[0].color, CH[1].color);
}

// ── MODULA: movement & rhythm applied to any X-Y figure ──────────────────────
const MOD = { rot:0, pulse:0, doppio:0, tragitto:0 };

// pulse envelope (1 at each beat → decays). pulse=0 → steady (1).
function pulseHit() {
  if (MOD.pulse<=0) return 1;
  const phase = ((t0/1000)*MOD.pulse) % 1;
  const d = 1-phase;
  return d*d;                          // sharp-ish percussive decay
}

// transform + stroke the figure with rotation / scale(pulse) / translation /
// optional doubled copy, in the channel-colour gradient
function paintXY(pts, colA, colB) {
  const cx=W/2, cy=H/2, tsec=t0/1000;
  const th = MOD.rot*tsec*Math.PI*2, cosT=Math.cos(th), sinT=Math.sin(th);
  const sc = 0.30 + 0.70*pulseHit();          // PULSO scales the figure visually
  const dx = MOD.tragitto*W*0.18*Math.sin(tsec*0.70);
  const dy = MOD.tragitto*H*0.18*Math.sin(tsec*0.93);
  const grad = offCtx.createLinearGradient(0,0,W,H);
  grad.addColorStop(0, colA); grad.addColorStop(1, colB);
  const glow = blendHex(colA, colB);
  const drawCopy = (ox,oy,scale,alpha) => {
    const tf = ([x,y]) => {
      const X=(x-cx)*scale, Y=(y-cy)*scale;
      return [cx + X*cosT - Y*sinT + dx + ox, cy + X*sinT + Y*cosT + dy + oy];
    };
    const path = lw => {
      offCtx.beginPath();
      pts.forEach((p,i)=>{ const [px,py]=tf(p); i?offCtx.lineTo(px,py):offCtx.moveTo(px,py); });
      offCtx.lineWidth=lw; offCtx.stroke();
    };
    offCtx.globalAlpha=alpha;
    offCtx.shadowBlur=0; offCtx.strokeStyle=glow+"33"; path(4);
    offCtx.shadowBlur=8; offCtx.shadowColor=glow; offCtx.strokeStyle=grad; path(1.5);
    offCtx.globalAlpha=1; offCtx.shadowBlur=0;
  };
  drawCopy(0, 0, sc, 1);
  if (MOD.doppio>0) {
    const off = MOD.doppio*W*0.16;
    drawCopy(off, -off*0.6, sc*(1-0.25*MOD.doppio), 0.55);
  }
}

// ── Render loop ────────────────────────────────────────────────────────────
function loop(ts) {
  requestAnimationFrame(loop);
  if (!offCtx || !G.running) return;
  t0 = ts;

  offCtx.fillStyle="rgba(0,0,0,0.2)"; offCtx.fillRect(0,0,W,H);
  if (G.mode==="wave")    drawWave();
  else if (G.mode==="xy") { if (GEN.on) drawGen(); else drawXY(); }

  // PULSO drives the engine's master amplitude too → the rhythm is audible
  if (GEN.on && GEN.master) {
    const g = MOD.pulse>0 ? 0.5*(0.15+0.85*pulseHit()) : 0.5;
    GEN.master.gain.setTargetAtTime(g, AUDIO.ctx.currentTime, 0.008);
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

// ── Generative engine ────────────────────────────────────────────────────────
// Two flavours, both producing a stable X-Y figure + stereo audio (L=X, R=Y):
//  • LISSAJOUS: 2 sines per axis (fundamental + 3rd harmonic), DelayNode on Y = phase
//  • SPIROGRAFO: epicycle = outer circle (R) + inner circle (r) at k× speed; DelayNodes
//    make the cos/sin pairs and set the inner phase. Knobs: FREQUENZA · RAPPORTO/GIRI ·
//    ARMONICA/RAGGIO · FASE. Everything glides (no clicks).
const GEN = {
  on:false, type:"sorgenti",
  base:110, ratio:2, harm:0, phase:0.25,
  master:null, busX:null, busY:null,
  oscs:[], disc:[],
  analyser:[null,null], buf:[null,null],
  // lissajous refs
  delayY:null, oscX1:null, oscX2:null, oscY1:null, oscY2:null, gHarmX:null, gHarmY:null,
  // spiro refs
  oscO:null, oscI:null, dOY:null, dIX:null, dIY:null, gIX:null, gIY:null,
};
const GEN_HARM = 3;          // which harmonic the ARMONICA knob adds (lissajous)
const GEN_FUND = 0.6;        // fundamental level (leaves headroom for the harmonic)
const GEN_HMAX = 0.4;        // max harmonic level → fundamental+harmonic ≤ 1
const SPIRO_R  = 0.55;       // outer circle radius
const SPIRO_RMAX = 0.45;     // max inner radius → R + r ≤ 1

function buildLissajous(ctx, busX, busY) {
  const fX = GEN.base, fY = GEN.base*GEN.ratio;
  GEN.oscX1 = ctx.createOscillator(); GEN.oscX1.type="sine"; GEN.oscX1.frequency.value=fX;
  const gX1 = ctx.createGain(); gX1.gain.value=GEN_FUND; GEN.oscX1.connect(gX1).connect(busX);
  GEN.oscX2 = ctx.createOscillator(); GEN.oscX2.type="sine"; GEN.oscX2.frequency.value=fX*GEN_HARM;
  GEN.gHarmX = ctx.createGain(); GEN.gHarmX.gain.value=GEN.harm*GEN_HMAX; GEN.oscX2.connect(GEN.gHarmX).connect(busX);

  const preY = ctx.createGain();
  GEN.oscY1 = ctx.createOscillator(); GEN.oscY1.type="sine"; GEN.oscY1.frequency.value=fY;
  const gY1 = ctx.createGain(); gY1.gain.value=GEN_FUND; GEN.oscY1.connect(gY1).connect(preY);
  GEN.oscY2 = ctx.createOscillator(); GEN.oscY2.type="sine"; GEN.oscY2.frequency.value=fY*GEN_HARM;
  GEN.gHarmY = ctx.createGain(); GEN.gHarmY.gain.value=GEN.harm*GEN_HMAX; GEN.oscY2.connect(GEN.gHarmY).connect(preY);
  GEN.delayY = ctx.createDelay(1); GEN.delayY.delayTime.value = GEN.phase/Math.max(1,fY);
  preY.connect(GEN.delayY).connect(busY);

  GEN.oscs.push(GEN.oscX1,GEN.oscX2,GEN.oscY1,GEN.oscY2);
  GEN.disc.push(gX1,GEN.gHarmX,gY1,GEN.gHarmY,preY,GEN.delayY);
}

function buildSpiro(ctx, busX, busY) {
  const f = GEN.base, k = GEN.ratio, r = GEN.harm*SPIRO_RMAX, ph = GEN.phase;
  // outer circle: one osc → X direct, → Y via 90° delay
  GEN.oscO = ctx.createOscillator(); GEN.oscO.type="sine"; GEN.oscO.frequency.value=f;
  const gOX = ctx.createGain(); gOX.gain.value=SPIRO_R; GEN.oscO.connect(gOX).connect(busX);
  GEN.dOY = ctx.createDelay(1); GEN.dOY.delayTime.value=0.25/Math.max(1,f);
  const gOY = ctx.createGain(); gOY.gain.value=SPIRO_R; GEN.oscO.connect(GEN.dOY); GEN.dOY.connect(gOY).connect(busY);
  // inner circle at k× speed: phase ph on X, ph+90° on Y
  GEN.oscI = ctx.createOscillator(); GEN.oscI.type="sine"; GEN.oscI.frequency.value=f*k;
  GEN.dIX = ctx.createDelay(1); GEN.dIX.delayTime.value=ph/Math.max(1,f*k);
  GEN.gIX = ctx.createGain(); GEN.gIX.gain.value=r; GEN.oscI.connect(GEN.dIX); GEN.dIX.connect(GEN.gIX).connect(busX);
  GEN.dIY = ctx.createDelay(1); GEN.dIY.delayTime.value=(ph+0.25)/Math.max(1,f*k);
  GEN.gIY = ctx.createGain(); GEN.gIY.gain.value=r; GEN.oscI.connect(GEN.dIY); GEN.dIY.connect(GEN.gIY).connect(busY);

  GEN.oscs.push(GEN.oscO,GEN.oscI);
  GEN.disc.push(gOX,GEN.dOY,gOY,GEN.dIX,GEN.gIX,GEN.dIY,GEN.gIY);
}

function startGen() {
  if (GEN.on) return;
  const ctx = ensureAudio();
  if (ctx.state==="suspended") ctx.resume();
  GEN.oscs = []; GEN.disc = [];
  const busX = ctx.createGain(), busY = ctx.createGain();
  GEN.busX = busX; GEN.busY = busY;

  const aX = ctx.createAnalyser(); aX.fftSize=2048; aX.smoothingTimeConstant=0;
  const aY = ctx.createAnalyser(); aY.fftSize=2048; aY.smoothingTimeConstant=0;
  busX.connect(aX); busY.connect(aY);
  GEN.analyser=[aX,aY]; GEN.buf=[new Float32Array(2048), new Float32Array(2048)];

  GEN.master = ctx.createGain(); GEN.master.gain.value=0.5;
  const merger = ctx.createChannelMerger(2);
  busX.connect(merger,0,0); busY.connect(merger,0,1);
  merger.connect(GEN.master); GEN.master.connect(AUDIO.master);
  GEN.disc.push(busX,busY,aX,aY,merger);

  if (GEN.type==="spiro") buildSpiro(ctx, busX, busY); else buildLissajous(ctx, busX, busY);
  GEN.oscs.forEach(o=>o.start());
  GEN.on = true;
}

function updateGen() {
  if (!GEN.on || !AUDIO.ctx) return;
  const t = AUDIO.ctx.currentTime, ramp = (p,v)=>p.setTargetAtTime(v,t,0.02);
  if (GEN.type==="spiro") {
    const f = GEN.base, k = GEN.ratio, r = GEN.harm*SPIRO_RMAX, ph = GEN.phase;
    ramp(GEN.oscO.frequency, f); ramp(GEN.oscI.frequency, f*k);
    ramp(GEN.dOY.delayTime, 0.25/Math.max(1,f));
    ramp(GEN.dIX.delayTime, ph/Math.max(1,f*k));
    ramp(GEN.dIY.delayTime, (ph+0.25)/Math.max(1,f*k));
    ramp(GEN.gIX.gain, r); ramp(GEN.gIY.gain, r);
  } else {
    const fX = GEN.base, fY = GEN.base*GEN.ratio;
    ramp(GEN.oscX1.frequency, fX); ramp(GEN.oscX2.frequency, fX*GEN_HARM);
    ramp(GEN.oscY1.frequency, fY); ramp(GEN.oscY2.frequency, fY*GEN_HARM);
    ramp(GEN.gHarmX.gain, GEN.harm*GEN_HMAX); ramp(GEN.gHarmY.gain, GEN.harm*GEN_HMAX);
    ramp(GEN.delayY.delayTime, GEN.phase/Math.max(1,fY));
  }
}

function stopGen() {
  if (!GEN.on) return;
  GEN.oscs.forEach(o=>{ try{o.stop();}catch(e){} try{o.disconnect();}catch(e){} });
  GEN.disc.forEach(nd=>{ try{nd.disconnect();}catch(e){} });
  try { GEN.master.disconnect(); } catch(e){}
  GEN.on = false;
}

// switch the X-Y combination flavour: relabel/show the right knobs, (re)build engine
function setGenType(type) {
  GEN.type = type;
  document.querySelectorAll("#gen-type button").forEach(b=>b.classList.toggle("active", b.dataset.t===type));
  document.getElementById("lbl-gratio").textContent = type==="spiro" ? "GIRI INTERNI" : "RAPPORTO X:Y";
  document.getElementById("lbl-gharm").textContent  = type==="spiro" ? "RAGGIO INT."  : "ARMONICA";
  // SORGENTI uses only RAPPORTO + FASE (combines the two selectable sources);
  // the engines also use FREQUENZA + ARMONICA/RAGGIO
  const engine = (type!=="sorgenti");
  document.getElementById("row-gbase").style.display = engine ? "flex" : "none";
  document.getElementById("row-gharm").style.display = engine ? "flex" : "none";
  stopGen();
  applyGenMode();
  refreshChannelCards();
}


// ── Controls ───────────────────────────────────────────────────────────────
function setMode(m) {
  // the X-Y generative engines run only in X-Y
  if (m !== "xy") stopGen();
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
  document.getElementById("combina-card").style.display = m==="xy"?"":"none";
  if (m === "xy") applyGenMode();        // start engine / show channels per COMBINA type
  clearScreen();
  refreshChannelCards();
}

// in X-Y, the synthetic engines (lissajous/spiro) hide the per-channel cards;
// SORGENTI keeps them visible (you pick the two sources)
function refreshChannelCards() {
  const hide = (G.mode==="xy" && GEN.type!=="sorgenti");
  [0,1].forEach(i => { document.getElementById("card-ch"+i).style.display = hide?"none":""; });
}

// reconcile the engine with the current COMBINA type (only meaningful in X-Y)
function applyGenMode() {
  if (G.mode!=="xy") { stopGen(); return; }
  if (GEN.type==="lissajous" || GEN.type==="spiro") startGen();
  else stopGen();                       // SORGENTI → no synthetic engine
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

  // generative engine knobs
  bindSlider("sl-gbase",  "v-gbase",  GEN, "base",  v=>v.toFixed(0)+"Hz");
  bindSlider("sl-gratio", "v-gratio", GEN, "ratio", v=>v.toFixed(2));
  bindSlider("sl-gharm",  "v-gharm",  GEN, "harm",  v=>v.toFixed(2));
  bindSlider("sl-gphase", "v-gphase", GEN, "phase", v=>v.toFixed(2));
  ["sl-gbase","sl-gratio","sl-gharm","sl-gphase"].forEach(id =>
    document.getElementById(id).addEventListener("input", updateGen));

  // MODULA: movement & rhythm
  bindSlider("sl-mrot",   "v-mrot",   MOD, "rot",      v=>v.toFixed(2));
  bindSlider("sl-mpulse", "v-mpulse", MOD, "pulse",    v=>v.toFixed(1));
  bindSlider("sl-mdop",   "v-mdop",   MOD, "doppio",   v=>v.toFixed(2));
  bindSlider("sl-mtrag",  "v-mtrag",  MOD, "tragitto", v=>v.toFixed(2));

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

  // init COMBINA panel (labels + which knobs show) and mode tab styles
  setGenType("sorgenti");
  setMode("wave");

  requestAnimationFrame(loop);
});
