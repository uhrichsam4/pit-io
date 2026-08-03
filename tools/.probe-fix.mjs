import { chromium } from 'playwright';
const browser = await chromium.launch({
  args: ['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--ignore-gpu-blocklist','--enable-webgl','--disable-dev-shm-usage'],
});
const page = await browser.newPage({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1 });
page.setDefaultTimeout(180000);
const ev = [];
page.on('console', (m) => ev.push(`[${m.type()}] ` + m.text().slice(0, 400)));
page.on('pageerror', (e) => ev.push('PAGEERROR ' + String(e && e.stack ? e.stack : e).slice(0, 1200)));
page.on('framenavigated', (f) => { if (f === page.mainFrame()) ev.push('NAV ' + f.url()); });
page.on('crash', () => ev.push('CRASH'));

await page.goto('http://localhost:5173/', { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForFunction('!!window.DEV', null, { timeout: 180000 });
ev.push('--- DEV ready ---');
try {
  await page.evaluate(() => { window.DEV.shot('menu-hero', { showUI: false, clearBots: true }); window.DEV.render(8); return true; });
  ev.push('--- shot() ok ---');
} catch (e) { ev.push('SHOT THREW ' + e.message.slice(0,600)); }
await page.waitForTimeout(220);
try { await page.evaluate((n) => window.DEV.render(n), 4); ev.push('--- render ok ---'); }
catch (e) { ev.push('RENDER THREW ' + e.message.slice(0,300)); }
try { const s = await page.evaluate('!!window.DEV'); ev.push('DEV present before screenshot: ' + s); } catch(e){ ev.push('probe threw ' + e.message.slice(0,200)); }
try { await page.screenshot({ path: 'shots/fc-probe/x.png', timeout: 180000 }); ev.push('--- screenshot ok ---'); }
catch (e) { ev.push('SHOT THREW ' + e.message.slice(0,300)); }
try { const s = await page.evaluate('!!window.DEV'); ev.push('DEV present after screenshot: ' + s); } catch(e){ ev.push('probe threw ' + e.message.slice(0,200)); }
console.log(ev.join('\n'));
await browser.close();
