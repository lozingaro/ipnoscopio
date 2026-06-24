// Shared navigation + weather logo for about.html / guide.html
const WF = {
  sine:     t => Math.sin(2*Math.PI*t),
  square:   t => Math.sign(Math.sin(2*Math.PI*t)),
  sawtooth: t => 2*(t-Math.floor(t+0.5)),
  triangle: t => 2*Math.abs(2*(t-Math.floor(t+0.5)))-1,
};

function toggleMenu() {
  const d = document.getElementById('menu-dropdown');
  d.classList.toggle('hidden');
  document.addEventListener('pointerdown', function outside(e) {
    if (!d.contains(e.target) && e.target.id !== 'btn-menu') {
      d.classList.add('hidden');
      document.removeEventListener('pointerdown', outside);
    }
  });
}

function openCommentModal() {
  const m = document.getElementById('comment-modal');
  if (m) { m.classList.remove('hidden'); document.getElementById('comment-text').focus(); }
}
function closeCommentModal() {
  const m = document.getElementById('comment-modal');
  if (m) { m.classList.add('hidden'); document.getElementById('comment-text').value = ''; }
}
function submitComment() {
  const text = document.getElementById('comment-text').value.trim();
  if (!text) return;
  window.open(
    'https://github.com/lozingaro/ipnoscopio/issues/new'
    + '?title=' + encodeURIComponent('Commento da Ipnoscopio')
    + '&body='  + encodeURIComponent(text),
    '_blank', 'noopener'
  );
  closeCommentModal();
}
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeCommentModal(); });

// Weather logo (Bologna hardcoded)
(async function() {
  const lat = 44.49, lon = 11.34;
  let temp = 15, code = 0;
  try {
    const r = await fetch(
      `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=temperature_2m,weather_code&forecast_days=1`
    );
    const d = await r.json();
    temp = d.current?.temperature_2m ?? 15;
    code = d.current?.weather_code  ?? 0;
  } catch(e) {}

  const col = temp < 0  ? '#00cfff'
            : temp < 10 ? '#44aaff'
            : temp < 18 ? '#39ff14'
            : temp < 25 ? '#ffdd00'
            : temp < 32 ? '#ff6b35'
            :             '#ff4444';

  const wf = code <= 3 ? 'sine' : code <= 48 ? 'triangle'
           : code <= 67 ? 'sawtooth' : code <= 77 ? 'triangle'
           : code <= 82 ? 'sawtooth' : 'square';

  const fn = WF[wf];

  // header canvas
  const hw = document.getElementById('header-wave');
  if (hw) {
    const W = hw.width, H = hw.height;
    const hc = hw.getContext('2d');
    hc.clearRect(0, 0, W, H);
    hc.strokeStyle = col; hc.lineWidth = 4;
    hc.shadowColor = col; hc.shadowBlur = 6;
    hc.beginPath();
    for (let x = 0; x <= W; x++) {
      const y = H/2 - fn(x/W*2) * (H/2-1);
      x === 0 ? hc.moveTo(x,y) : hc.lineTo(x,y);
    }
    hc.stroke();
  }

  // favicon
  const cv = document.createElement('canvas'); cv.width = cv.height = 32;
  const c2 = cv.getContext('2d');
  c2.fillStyle = '#000'; c2.fillRect(0,0,32,32);
  c2.strokeStyle = col; c2.lineWidth = 2;
  c2.shadowColor = col; c2.shadowBlur = 4;
  c2.beginPath();
  for (let x = 0; x <= 32; x++) {
    const y = 16 - fn(x/32*2)*11;
    x === 0 ? c2.moveTo(x,y) : c2.lineTo(x,y);
  }
  c2.stroke();
  let link = document.querySelector("link[rel='icon']");
  if (!link) { link = document.createElement('link'); link.rel='icon'; document.head.appendChild(link); }
  link.type = 'image/png';
  link.href = cv.toDataURL('image/png');
})();
