import { chromium } from 'playwright';
const URL=process.argv[2], LABEL=process.argv[3];
const b=await chromium.launch({args:['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--disable-dev-shm-usage']});
const p=await b.newPage({viewport:{width:900,height:700}});
p.on('pageerror',e=>console.log('  PAGEERROR',String(e).split('\n')[0]));
await p.goto(URL,{waitUntil:'domcontentloaded',timeout:180000});
await p.waitForFunction('!!window.DEV && !!window.__GAME__',null,{timeout:480000});
await p.evaluate(()=>localStorage.removeItem('miami-devour:name'));
console.log(`===== ${LABEL} =====`);

// (2) MAIN LOBBY: is a match running behind the menu?
const lobby = await p.evaluate(()=>{const g=window.__GAME__;
  const hud=document.getElementById('hud-layer');
  return { phase:g.match.phase, timeLeft:+g.match.timeLeft.toFixed(1),
    bots:g.bots.length, holes:g.holes.length, player:!!g.player,
    hudOpacity:hud?getComputedStyle(hud).opacity:'n/a',
    trafficRuns:!!g.trafficUpdate, onIsland:!!g.onIsland };});
console.log(' LOBBY  ', JSON.stringify(lobby));

// (3) PRE-LOBBY: click Play, then watch REAL time
await p.evaluate(()=>{const el=document.querySelector('.shell');
  [...el.querySelectorAll('button')].find(x=>/^\s*play\s*$/i.test(x.textContent||''))?.click();});
await p.waitForTimeout(1500);
const t0=Date.now();
const pre=await p.evaluate(()=>{const g=window.__GAME__;const hud=document.getElementById('hud-layer');
  return {screen:document.querySelector('.shell [data-screen]')?.dataset.screen, phase:g.match.phase,
    island:!!g.onIsland, lobbyLeft:g.lobbyLeft, clock:document.querySelector('[data-clock]')?.textContent,
    hudOpacity:hud?getComputedStyle(hud).opacity:'n/a'};});
console.log(' PRELOBBY', JSON.stringify(pre));
// wait 8 REAL seconds and see if it survived
await p.waitForTimeout(8000);
const after8=await p.evaluate(()=>{const g=window.__GAME__;
  return {phase:g.match.phase, island:!!g.onIsland,
    lobbyLeft:g.lobbyLeft==null?null:+g.lobbyLeft.toFixed(1),
    clock:document.querySelector('[data-clock]')?.textContent};});
console.log(` +8s REAL`, JSON.stringify(after8), `(elapsed ${((Date.now()-t0)/1000).toFixed(1)}s)`);

// (1) SPAWN: force a match and check where the hole lands
await p.evaluate(()=>{const g=window.__GAME__; g.startNow&&g.startNow();});
await p.waitForTimeout(2500);
const spawn=await p.evaluate(()=>{const g=window.__GAME__; const pl=g.player; if(!pl) return {none:true};
  const x=pl.position.x,z=pl.position.z;
  const water=g.layout&&g.layout.isWater?g.layout.isWater(x,z):null;
  // nearest consumables
  let near=0, nearest=1e9;
  for(const c of g.allConsumables||[]){ if(!c||c.state!==0) continue;
    const d=Math.hypot(c.position.x-x,c.position.z-z);
    if(d<nearest) nearest=d; if(d<25) near++; }
  return {x:Math.round(x),z:Math.round(z), inWater:water, propsWithin25m:near,
          nearestProp:Math.round(nearest), phase:g.match.phase, r:+pl.radius.toFixed(2)};});
console.log(' SPAWN  ', JSON.stringify(spawn));
await b.close();
