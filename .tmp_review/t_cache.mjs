const base = '/Users/sam/untitled folder 6/src/';
const { HeatSystem, HEAT, RESPONSE } = await import(base + 'gameplay/heat.js');
const { makeRNG } = await import(base + 'core/rng.js');
const { HOLE, TIER_LIST, WORLD } = await import(base + 'config.js');
const { ZONE, buildLayout } = await import(base + 'world/cityLayout.js');
const THREE = await import('/Users/sam/untitled folder 6/node_modules/three/build/three.module.js');
function stubHole(score=0,x=0,z=0){return{position:new THREE.Vector3(x,0,z),velocity:new THREE.Vector3(),score,alive:true,spawnGrace:0,isPlayer:true,
 get radius(){return Math.min(HOLE.MAX_RADIUS,this.trueRadius);},
 get trueRadius(){return HOLE.START_RADIUS*Math.pow(1+this.score/HOLE.GROWTH_K,HOLE.GROWTH_P);},
 get tier(){let t=0;for(let i=0;i<TIER_LIST.length;i++)if(this.radius>=TIER_LIST[i].eatRadius)t=i;return t;},
 addScore(n){this.score=Math.max(0,this.score+n);return n;}};}
const noFx={puff(){},sparks(){},chunks(){},shockwave(){},popup(){},addShake(){}};
const layout = buildLayout(20260803);

/* --- A. negative _roads() cache: layout installed AFTER construction ----- */
{
  const hs = new HeatSystem({ rng: makeRNG(5), effects: noFx });   // no layout yet
  const h = stubHole(4000, 0, 0);
  hs.bump(h, 0.95);
  hs.update(1/60, [h], 1/60);          // one tick with no world -> _roads() caches []
  hs.layout = layout;                   // world arrives
  let t = 1/60;
  for (let i=0;i<60*30;i++){ t+=1/60; hs.update(1/60,[h],t); }
  console.log('A) layout installed after first tick -> units spawned in 30s:', hs.units().length,
    ' _nodes.length =', hs._nodes.length);
}

/* --- B. inPlay (shrink ring) baked into the node cache ------------------- */
{
  let ringR = 90;                        // small ring at first
  const hs = new HeatSystem({ rng: makeRNG(5), effects: noFx, layout,
    inPlay: (x,z) => Math.hypot(x,z) <= ringR });
  const h = stubHole(4000, 0, 0);
  hs.bump(h, 0.95);
  let t=0; for (let i=0;i<60*5;i++){ t+=1/60; hs.update(1/60,[h],t); }
  const nEarly = hs._nodes.length;
  ringR = 100000;                        // ring opens right up (or is removed)
  for (let i=0;i<60*30;i++){ t+=1/60; hs.update(1/60,[h],t); }
  console.log('B) nodes cached with tiny ring:', nEarly, '-> after ring opens:', hs._nodes.length,
    ' units:', hs.units().length);
  // and the reverse: node set built wide, then ring closes
  const hs2 = new HeatSystem({ rng: makeRNG(5), effects: noFx, layout, inPlay: () => true });
  const h2 = stubHole(4000, 0, 0);
  hs2.bump(h2, 0.95);
  let t2=0; for (let i=0;i<60*5;i++){ t2+=1/60; hs2.update(1/60,[h2],t2); }
  console.log('B2) nodes with open ring:', hs2._nodes.length, 'units:', hs2.units().length);
}

/* --- C. real-layout lane position on a medianed boulevard ---------------- */
{
  const LANE_OFF = 1.7;
  for (const name of ['S Miami Ave','Brickell Ave','Biscayne Blvd']) {
    const r = layout.roadsX.find(r => r.name === name);
    console.log(`C) ${name}: pos ${r.pos} half ${r.half} cls ${r.cls} median ${r.median} medianW ${r.medianW}`,
      `-> heat unit sits at x=${r.pos-LANE_OFF} / ${r.pos+LANE_OFF};`,
      `median occupies ${r.pos - r.medianW/2} .. ${r.pos + r.medianW/2}`,
      `| roadNetwork kerb lane would be at ${r.pos - ((2-0.5)*3.4 + r.medianW*0.5)}`);
  }
}
