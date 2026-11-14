// ending.js — the thank-you page: its parts rise in when it comes on screen, and a few gear outlines turn slowly
// behind the title (the four gear colours of the report). Drawn only while the page is visible; still when the
// person prefers reduced motion.

export function createEnding() {
  const section = document.getElementById('thanks');
  if (!section) return null;
  const canvas = section.querySelector('.thanks-gears');
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  // past the article the KP index on the left edge has nothing to point at
  const tail = [document.getElementById('references'), section, document.getElementById('site-footer')].filter(Boolean);
  const seen = new Set();
  const endIo = new IntersectionObserver((es) => {
    for (const e of es) { if (e.isIntersecting) seen.add(e.target); else seen.delete(e.target); }
    document.documentElement.classList.toggle('at-end', seen.size > 0);
  }, { threshold: [0, 0.35], rootMargin: '0px 0px -40% 0px' });
  tail.forEach((el) => endIo.observe(el));
  const io = new IntersectionObserver(([e]) => {
    section.classList.toggle('is-in', e.isIntersecting);
    visible = e.isIntersecting;
    if (visible) start();
  }, { threshold: 0.25 });
  io.observe(section);

  if (!canvas) return null;
  const ctx = canvas.getContext('2d');
  const COLORS = ['#D7263D', '#1E9E5A', '#E8A917', '#1F6FD0'];
  // gear placement in the section's own coordinates (fractions of width / height); r in px at 1440 wide
  const GEARS = [
    { x: 0.12, y: 0.24, r: 130, teeth: 34, c: 0, dir: 1 },
    { x: 0.22, y: 0.52, r: 84, teeth: 22, c: 1, dir: -1 },
    { x: 0.86, y: 0.3, r: 112, teeth: 34, c: 3, dir: -1 },
    { x: 0.79, y: 0.72, r: 72, teeth: 22, c: 2, dir: 1 },
  ];
  let visible = false, raf = 0, angle = 0, last = 0;
  function size() {
    const r = canvas.getBoundingClientRect(), dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = Math.max(2, Math.round(r.width * dpr)); canvas.height = Math.max(2, Math.round(r.height * dpr));
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  function gear(g, w, h, a) {
    const k = Math.min(1.2, Math.max(0.5, w / 1440));
    const R = g.r * k, cx = g.x * w, cy = g.y * h, n = g.teeth, depth = R * 0.12;
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(a * g.dir * (34 / n));
    ctx.beginPath();
    for (let i = 0; i < n; i++) {
      const t0 = (i / n) * Math.PI * 2, t1 = ((i + 0.5) / n) * Math.PI * 2;
      const s = (Math.PI * 2) / n;
      ctx.lineTo(Math.cos(t0) * (R - depth), Math.sin(t0) * (R - depth));
      ctx.lineTo(Math.cos(t0 + s * 0.12) * R, Math.sin(t0 + s * 0.12) * R);
      ctx.lineTo(Math.cos(t1 - s * 0.12) * R, Math.sin(t1 - s * 0.12) * R);
      ctx.lineTo(Math.cos(t1) * (R - depth), Math.sin(t1) * (R - depth));
    }
    ctx.closePath();
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = COLORS[g.c];
    ctx.globalAlpha = 0.55;
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(0, 0, R * 0.28, 0, Math.PI * 2);
    ctx.globalAlpha = 0.35;
    ctx.stroke();
    ctx.restore();
  }
  function draw() {
    const r = canvas.getBoundingClientRect();
    ctx.clearRect(0, 0, r.width, r.height);
    for (const g of GEARS) gear(g, r.width, r.height, angle);
  }
  function frame(now) {
    raf = 0;
    if (!visible || document.hidden) return;
    const dt = last ? Math.min(0.05, (now - last) / 1000) : 0;
    last = now;
    angle += dt * 0.18;
    draw();
    raf = requestAnimationFrame(frame);
  }
  function start() { size(); draw(); if (!reduced && !raf) { last = 0; raf = requestAnimationFrame(frame); } }
  new ResizeObserver(() => { size(); draw(); }).observe(canvas);
  document.addEventListener('visibilitychange', () => { if (!document.hidden && visible) start(); });
  return { draw };
}
