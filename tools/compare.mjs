#!/usr/bin/env node
/**
 * Build comparison sheets from PNGs so a reviewer can judge many shots at once,
 * or judge an A/B pair honestly.
 *
 *   # side-by-side A/B of the same presets from two runs, labels hidden
 *   node tools/compare.mjs --ab shots/before shots/after --out shots/ab.png --blind
 *
 *   # contact sheet of a whole directory
 *   node tools/compare.mjs --sheet shots/round3 --out shots/round3-sheet.png
 *
 * --blind randomises left/right per row and writes the answer key to a sidecar
 * .key.json instead of burning labels into the image, so a critic can pick a
 * winner without knowing which is ours-before and which is ours-after.
 */

import { chromium } from 'playwright';
import { readdirSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, join, basename, dirname } from 'node:path';

const argv = process.argv.slice(2);
const flag = (n, d = null) => {
  const i = argv.indexOf(`--${n}`);
  if (i < 0) return d;
  const v = argv[i + 1];
  return v === undefined || v.startsWith('--') ? true : v;
};
const has = (n) => argv.includes(`--${n}`);

const OUT = resolve(String(flag('out', 'shots/compare.png')));
const BLIND = has('blind');
const COLS = Number(flag('cols', 2));
mkdirSync(dirname(OUT), { recursive: true });

const pngs = (dir) =>
  readdirSync(dir).filter((f) => f.endsWith('.png')).sort();

const dataURI = (p) => `data:image/png;base64,${readFileSync(p).toString('base64')}`;

let rows = [];
let key = [];

if (has('ab')) {
  const i = argv.indexOf('--ab');
  const dirA = resolve(argv[i + 1]);
  const dirB = resolve(argv[i + 2]);
  const names = pngs(dirA).filter((f) => pngs(dirB).includes(f));
  if (!names.length) {
    console.error('No shared preset PNGs between those two directories.');
    process.exit(2);
  }
  for (const n of names) {
    const a = { src: dataURI(join(dirA, n)), tag: basename(dirA) };
    const b = { src: dataURI(join(dirB, n)), tag: basename(dirB) };
    const flip = BLIND && Math.random() < 0.5;
    const [left, right] = flip ? [b, a] : [a, b];
    rows.push({ label: n.replace('.png', ''), cells: [left, right] });
    key.push({ preset: n.replace('.png', ''), left: left.tag, right: right.tag });
  }
} else {
  const dir = resolve(String(flag('sheet', 'shots/latest')));
  const names = pngs(dir);
  for (let i = 0; i < names.length; i += COLS) {
    rows.push({
      label: '',
      cells: names.slice(i, i + COLS).map((n) => ({
        src: dataURI(join(dir, n)),
        tag: n.replace('.png', ''),
      })),
    });
  }
}

const CELL_W = 760;
const html = `
<style>
  body { margin:0; background:#11161c; font-family: ui-sans-serif, system-ui, sans-serif; }
  .row { display:flex; gap:10px; padding:10px; align-items:flex-start; }
  .cell { position:relative; }
  img { width:${CELL_W}px; display:block; border-radius:6px; }
  .tag { position:absolute; left:8px; top:8px; padding:3px 9px; border-radius:6px;
         background:rgba(0,0,0,.62); color:#fff; font-size:13px; font-weight:700;
         letter-spacing:.3px; }
  .side { position:absolute; left:8px; bottom:8px; padding:3px 9px; border-radius:6px;
          background:rgba(255,61,139,.85); color:#fff; font-size:13px; font-weight:800; }
  .rowlabel { color:#9fb0c0; font-size:14px; padding:2px 12px 0; font-weight:700;
              letter-spacing:1px; text-transform:uppercase; }
</style>
${rows.map((r, ri) => `
  ${r.label ? `<div class="rowlabel">${r.label}</div>` : ''}
  <div class="row">
    ${r.cells.map((c, ci) => `
      <div class="cell">
        <img src="${c.src}"/>
        ${BLIND
          ? `<div class="side">${ci === 0 ? 'LEFT' : 'RIGHT'}</div>`
          : `<div class="tag">${c.tag}</div>`}
      </div>`).join('')}
  </div>`).join('')}
`;

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: CELL_W * COLS + 40, height: 900 } });
await page.setContent(html);
await page.waitForTimeout(300);
await page.screenshot({ path: OUT, fullPage: true });
await browser.close();

if (BLIND) {
  const keyPath = OUT.replace(/\.png$/, '.key.json');
  writeFileSync(keyPath, JSON.stringify(key, null, 2));
  console.log(`Wrote ${OUT}\nAnswer key (do not read before judging): ${keyPath}`);
} else {
  console.log(`Wrote ${OUT}`);
}
