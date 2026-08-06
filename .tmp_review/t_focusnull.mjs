const base = '/Users/sam/untitled folder 6/src/';
const { HeatSystem, HEAT, RESPONSE } = await import(base + 'gameplay/heat.js');
const { makeRNG } = await import(base + 'core/rng.js');
const { HOLE, TIER_LIST } = await import(base + 'config.js');
const { ZONE } = await import(base + 'world/cityLayout.js');
const THREE = await import('/Users/sam/untitled folder 6/node_modules/three/build/three.module.js');

function stubHole(score = 0) {
  return {
    position: new THREE.Vector3(0,0,0),
    velocity: new THREE.Vector3(0,0,0),
    score, alive: true, spawnGrace: 0, isPlayer: true,
    get radius(){ return Math.min(HOLE.MAX_RADIUS, this.trueRadius); },
    get trueRadius(){ return HOLE.START_RADIUS*Math.pow(1+this.score/HOLE.GROWTH_K, HOLE.GROWTH_P); },
    get tier(){ let t=0; for(let i=0;i<TIER_LIST.length;i++) if(this.radius>=TIER_LIST[i].eatRadius) t=i; return t; },
    addScore(n){ this.score = Math.max(0,this.score+n); return n; },
  };
}
const lines = [-200,-100,0,100,200], half = 11;
const layout = {
  roadsX: lines.map(pos=>({pos,half,cls:'street'})),
  roadsZ: lines.map(pos=>({pos,half,cls:'street'})),
  blocks: [{x:50,z:50,w:60,d:60,zone:ZONE.PLAZA}],
  isRoad(x,z){ for(const p of lines){ if(Math.abs(x-p)<half) return true; } for(const p of lines){ if(Math.abs(z-p)<half) return true; } return false; },
  isWater(){ return false; },
};
const noFx = { puff(){},sparks(){},chunks(){},shockwave(){},popup(){},addShake(){} };

const hs = new HeatSystem({ rng: makeRNG(7), layout, effects: noFx });
const hole = stubHole(300);       // small hole: cannot devour a cruiser
hs.bump(hole, 0.95);
let t = 0;
for (let i=0;i<60*8;i++){ t+=1/60; hs.update(1/60,[hole],t); }
console.log('units after ramp-up:', hs.units().length, 'tier', hs.tierOf(hole));

// Now drop heat to zero -> focus becomes null.
hs.state.get(hole).heat = 0;
for (let i=0;i<60*3;i++){ t+=1/60; hs.update(1/60,[hole],t); }
console.log('after heat=0 for 3s -> tier', hs.tierOf(hole), 'focus', hs.focus, 'units', hs.units().length);

// Run 60 MORE seconds. LEAVE_LIFE is 8s, so the roster must be empty.
for (let i=0;i<60*60;i++){ t+=1/60; hs.state.get(hole).heat = 0; hs.update(1/60,[hole],t); }
const u = hs.units();
console.log('after 60s more: units =', u.length, 'LEAVE_LIFE =', HEAT.LEAVE_LIFE);
for (const x of u) console.log('  ', x.kind, 'state', x.state, 'age', (t - x.born).toFixed(1), 'stateT', x.stateT.toFixed(2), 'now', t.toFixed(2), 'pos', x.x.toFixed(1), x.z.toFixed(1));

// And 5 minutes more.
for (let i=0;i<60*300;i++){ t+=1/60; hs.state.get(hole).heat = 0; hs.update(1/60,[hole],t); }
console.log('after 6 more minutes: units =', hs.units().length);
