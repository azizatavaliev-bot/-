#!/usr/bin/env node
/**
 * SmileKit Instagram carousel renderer.
 *
 * Usage:
 *   node carousel/render.js carousel/carousels/01-white-teeth.json
 *
 * Reads a carousel JSON, renders every slide to a 1080x1350 PNG in
 * carousel/out/<carousel-id>/slide-N.png using Playwright + Chromium.
 *
 * Slide types:
 *   hook    – brand-colour slide with a big headline (the "bait")
 *   compare – two full-bleed photos stacked: top = white teeth, bottom = yellow
 *   cta     – closing slide with logo, offer and call to action
 */
const fs = require('fs');
const path = require('path');

const W = 1080;
const H = 1350;
const ROOT = __dirname;

const BRAND = {
  indigo: '#2A1FD1',
  indigoDark: '#1E158F',
  ink: '#12102A',
  paper: '#F5F4FF',
  white: '#FFFFFF',
};

function loadPlaywright() {
  try {
    return require('playwright');
  } catch (e) {
    const globalRoot = require('child_process')
      .execSync('npm root -g')
      .toString()
      .trim();
    return require(path.join(globalRoot, 'playwright'));
  }
}

function fileToDataUri(p) {
  const abs = path.isAbsolute(p) ? p : path.join(ROOT, p);
  if (!fs.existsSync(abs)) return null;
  const ext = path.extname(abs).slice(1).toLowerCase();
  const mime =
    ext === 'ttf'
      ? 'font/ttf'
      : ext === 'png'
        ? 'image/png'
        : ext === 'webp'
          ? 'image/webp'
          : 'image/jpeg';
  return `data:${mime};base64,${fs.readFileSync(abs).toString('base64')}`;
}

function fontFace(family, weight, file) {
  const uri = fileToDataUri(path.join('assets/fonts', file));
  return `@font-face{font-family:'${family}';font-weight:${weight};src:url(${uri}) format('truetype');}`;
}

const FONT_CSS = [
  fontFace('Montserrat', 500, 'Montserrat-500.ttf'),
  fontFace('Montserrat', 700, 'Montserrat-700.ttf'),
  fontFace('Montserrat', 800, 'Montserrat-800.ttf'),
  fontFace('Montserrat', 900, 'Montserrat-900.ttf'),
  fontFace('Poppins', 600, 'Poppins-600.ttf'),
  fontFace('Poppins', 700, 'Poppins-700.ttf'),
].join('\n');

const BASE_CSS = `
  ${FONT_CSS}
  *{box-sizing:border-box;margin:0;padding:0}
  html,body{width:${W}px;height:${H}px;overflow:hidden;background:${BRAND.white};
    font-family:'Montserrat',sans-serif;color:${BRAND.ink};-webkit-font-smoothing:antialiased}
  .slide{position:relative;width:${W}px;height:${H}px;overflow:hidden}
  .wordmark{font-family:'Poppins',sans-serif;font-weight:700;letter-spacing:-0.03em}
  .tag{position:absolute;display:flex;align-items:center;gap:14px;
    padding:14px 26px 14px 18px;border-radius:999px;backdrop-filter:blur(14px);}
  .tag .dot{width:34px;height:34px;border-radius:50%;background:${BRAND.indigo};
    display:flex;align-items:center;justify-content:center}
  .tag .dot span{color:#fff;font-family:'Poppins';font-weight:700;font-size:22px;line-height:1;margin-top:-2px}
  .tag .name{font-family:'Poppins';font-weight:600;font-size:26px;letter-spacing:-0.02em}
  .counter{position:absolute;top:44px;right:44px;font-weight:700;font-size:26px;letter-spacing:0.06em}
`;

/** Round brand badge, replicates the avatar: indigo circle, white "smilekit", spaced tagline. */
function logoCircle(size, opts = {}) {
  const inverted = !!opts.inverted; // white circle + indigo text
  const bg = inverted ? BRAND.white : BRAND.indigo;
  const fg = inverted ? BRAND.indigo : BRAND.white;
  const word = Math.round(size * 0.235);
  const tag = Math.round(size * 0.058);
  return `
  <div style="width:${size}px;height:${size}px;border-radius:50%;background:${bg};
       display:flex;flex-direction:column;align-items:center;justify-content:center;
       box-shadow:0 30px 80px rgba(30,21,143,.28)">
    <div class="wordmark" style="color:${fg};font-size:${word}px;line-height:1;margin-top:${Math.round(size*0.02)}px">smilekit</div>
    <div style="color:${fg};font-weight:500;font-size:${tag}px;letter-spacing:0.42em;margin-top:${Math.round(size*0.05)}px;padding-left:0.42em">TEETH WHITENING</div>
  </div>`;
}

function brandTag(light) {
  const bg = light ? 'rgba(255,255,255,.86)' : 'rgba(18,16,42,.55)';
  const color = light ? BRAND.ink : BRAND.white;
  return `<div class="tag" style="left:44px;top:44px;background:${bg};color:${color}">
    <div class="dot"><span>s</span></div><div class="name">smilekit</div></div>`;
}

function placeholder(label, hint) {
  return `
  <div style="width:100%;height:100%;display:flex;flex-direction:column;align-items:center;justify-content:center;
       gap:18px;background:repeating-linear-gradient(135deg,#ECEBFA 0 28px,#E2E0F6 28px 56px);color:#3F38A8">
    <svg width="150" height="150" viewBox="0 0 24 24" fill="none" stroke="#3F38A8" stroke-width="1.2">
      <circle cx="12" cy="8" r="4"/><path d="M4 21c0-4 3.6-7 8-7s8 3 8 7"/></svg>
    <div style="font-weight:800;font-size:40px;letter-spacing:0.02em">${label}</div>
    <div style="font-weight:500;font-size:26px;opacity:.75">${hint}</div>
  </div>`;
}

function photo(src, label, hint, pos) {
  const uri = src ? fileToDataUri(path.join('assets/photos', src)) : null;
  if (!uri) return placeholder(label, hint);
  return `<img src="${uri}" style="width:100%;height:100%;object-fit:cover;object-position:${pos || 'center 30%'}">`;
}

function halfLabel(text, side) {
  if (!text) return '';
  const y = side === 'top' ? 'bottom:34px' : 'bottom:34px';
  return `<div style="position:absolute;left:44px;${y};padding:14px 26px;border-radius:999px;
     background:rgba(18,16,42,.62);backdrop-filter:blur(12px);color:#fff;font-weight:700;font-size:28px;
     letter-spacing:0.02em">${text}</div>`;
}

/* ---------- slide templates ---------- */

function slideHook(s, i, n) {
  const title = (s.title || '').replace(/\n/g, '<br>');
  return `<div class="slide" style="background:${BRAND.indigo};color:#fff">
    <div style="position:absolute;inset:0;background:
      radial-gradient(900px 700px at 85% -10%,rgba(255,255,255,.18),transparent 60%),
      radial-gradient(700px 600px at -10% 110%,rgba(0,0,0,.25),transparent 60%)"></div>
    ${brandTag(false)}
    <div class="counter" style="color:rgba(255,255,255,.7)">${i}/${n}</div>
    <div style="position:absolute;left:80px;right:80px;top:50%;transform:translateY(-54%)">
      ${s.kicker ? `<div style="font-weight:700;font-size:34px;letter-spacing:0.22em;opacity:.8;margin-bottom:40px">${s.kicker}</div>` : ''}
      <div style="font-weight:900;font-size:${s.titleSize || 132}px;line-height:.98;letter-spacing:-0.035em">${title}</div>
      ${s.sub ? `<div style="font-weight:500;font-size:40px;line-height:1.3;margin-top:56px;opacity:.9;max-width:860px">${s.sub}</div>` : ''}
    </div>
    <div style="position:absolute;left:80px;bottom:80px;display:flex;align-items:center;gap:22px;font-weight:700;font-size:34px">
      <span>${s.footer || 'листай'}</span>
      <svg width="64" height="34" viewBox="0 0 64 34" fill="none" stroke="#fff" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"><path d="M2 17h56M44 3l14 14-14 14"/></svg>
    </div>
  </div>`;
}

function slideCompare(s, i, n) {
  return `<div class="slide" style="background:#000">
    <div style="position:absolute;left:0;top:0;width:${W}px;height:${H / 2}px;overflow:hidden">
      ${photo(s.top, 'ФОТО 1 — БЕЛЫЕ ЗУБЫ', 'верхняя половина, 1080×675', s.topPos)}
      ${halfLabel(s.labelTop, 'top')}
    </div>
    <div style="position:absolute;left:0;top:${H / 2}px;width:${W}px;height:${H / 2}px;overflow:hidden">
      ${photo(s.bottom, 'ФОТО 2 — ЖЁЛТЫЕ ЗУБЫ', 'нижняя половина, 1080×675', s.bottomPos)}
      ${halfLabel(s.labelBottom, 'bottom')}
    </div>
    <div style="position:absolute;left:0;right:0;top:${H / 2 - 3}px;height:6px;background:#fff;opacity:.9"></div>
    ${brandTag(false)}
    <div class="counter" style="color:#fff;text-shadow:0 2px 12px rgba(0,0,0,.6)">${i}/${n}</div>
    ${s.caption ? `<div style="position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);padding:18px 40px;border-radius:999px;background:#fff;color:${BRAND.ink};font-weight:800;font-size:34px;letter-spacing:0.01em;white-space:nowrap;box-shadow:0 12px 40px rgba(0,0,0,.35)">${s.caption}</div>` : ''}
  </div>`;
}

function slideCta(s, i, n) {
  const bullets = (s.bullets || [])
    .map(
      (b) => `<li style="display:flex;align-items:flex-start;gap:22px;font-weight:600;font-size:38px;line-height:1.25">
        <span style="flex:none;width:44px;height:44px;border-radius:50%;background:${BRAND.indigo};display:flex;align-items:center;justify-content:center;margin-top:2px">
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 12l5 5L20 6"/></svg>
        </span><span>${b}</span></li>`,
    )
    .join('');
  const title = (s.title || '').replace(/\n/g, '<br>');
  return `<div class="slide" style="background:${BRAND.paper}">
    <div style="position:absolute;inset:0;background:radial-gradient(800px 600px at 50% -20%,rgba(42,31,209,.14),transparent 60%)"></div>
    <div class="counter" style="color:${BRAND.indigo}">${i}/${n}</div>
    <div style="position:absolute;left:0;right:0;top:110px;display:flex;justify-content:center">${logoCircle(300)}</div>
    <div style="position:absolute;left:80px;right:80px;top:456px">
      <div style="font-weight:900;font-size:${s.titleSize || 84}px;line-height:1.02;letter-spacing:-0.03em;color:${BRAND.ink}">${title}</div>
      ${s.sub ? `<div style="font-weight:500;font-size:36px;line-height:1.35;margin-top:28px;color:#4B4870">${s.sub}</div>` : ''}
      <ul style="list-style:none;display:flex;flex-direction:column;gap:22px;margin-top:48px">${bullets}</ul>
    </div>
    <div style="position:absolute;left:80px;right:80px;bottom:80px;display:flex;align-items:center;gap:28px">
      <div style="flex:1;padding:34px 44px;border-radius:999px;background:${BRAND.indigo};color:#fff;font-weight:800;font-size:40px;text-align:center;letter-spacing:-0.01em;box-shadow:0 20px 50px rgba(42,31,209,.35)">${s.button || 'Написать в директ'}</div>
    </div>
    ${s.note ? `<div style="position:absolute;left:80px;right:80px;bottom:36px;font-weight:600;font-size:22px;color:#6E6B93;text-align:center">${s.note}</div>` : ''}
  </div>`;
}

const TEMPLATES = { hook: slideHook, compare: slideCompare, cta: slideCta };

async function main() {
  const cfgPath = process.argv[2];
  if (!cfgPath) {
    console.error('usage: node carousel/render.js <carousel.json>');
    process.exit(1);
  }
  const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  const outDir = path.join(ROOT, 'out', cfg.id);
  fs.mkdirSync(outDir, { recursive: true });

  const { chromium } = loadPlaywright();
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });

  const n = cfg.slides.length;
  for (let idx = 0; idx < n; idx++) {
    const s = cfg.slides[idx];
    const tpl = TEMPLATES[s.type];
    if (!tpl) throw new Error(`unknown slide type: ${s.type}`);
    const html = `<!doctype html><html><head><meta charset="utf-8"><style>${BASE_CSS}</style></head><body>${tpl(s, idx + 1, n)}</body></html>`;
    await page.setContent(html, { waitUntil: 'load' });
    await page.evaluate(() => document.fonts.ready);
    const file = path.join(outDir, `slide-${idx + 1}.png`);
    await page.screenshot({ path: file, type: 'png' });
    console.log('✓', path.relative(process.cwd(), file));
  }
  await browser.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
