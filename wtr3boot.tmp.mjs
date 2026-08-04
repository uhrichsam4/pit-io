import { chromium } from 'playwright';
const b = await chromium.launch({args:['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--disable-dev-shm-usage']});
const p = await b.newPage({viewport:{width:320,height:200}});
const errs=[]; p.on('pageerror',e=>errs.push(String(e.stack||e).split('\n').slice(0,3).join(' | ')));
const logs=[]; p.on('console',m=>logs.push(m.type()+': '+m.text().slice(0,300)));
await p.goto('http://localhost:5173/',{waitUntil:'domcontentloaded'});
try { await p.waitForFunction('!!window.DEV && !!window.__GAME__',null,{timeout:240000}); console.log('BOOTED'); }
catch { console.log('DID NOT BOOT'); }
console.log('ERRORS:\n' + (errs.join('\n') || 'none'));
console.log('LOGS:\n' + logs.slice(-40).join('\n'));
await b.close();
