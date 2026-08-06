const base = '/Users/sam/untitled folder 6/src/';
const { HeatSystem, HEAT } = await import(base + 'gameplay/heat.js');
const { makeRNG } = await import(base + 'core/rng.js');
const { HOLE, TIER_LIST } = await import(base + 'config.js');
const { ZONE } = await import(base + 'world/cityLayout.js');
const THREE = await import('/Users/sam/untitled folder 6/node_modules/three/build/three.module.js');
function stubHole(score=0){return{position:new THREE.Vector3(),velocity:new THREE.Vector3(),score,alive:true,spawnGrace:0,isPlayer:true,
 get radius(){return Math.min(HOLE.MAX_RADIUS,this.trueRadius);},
 get trueRadius(){return HOLE.START_RADIUS*Math.pow(1+this.score/HOLE.GROWTH_K,HOLE.GROWTH_P);},
 get tier(){let t=0;for(let i=0;i<TIER_LIST.length;i++)if(this.radius>=TIER_LIST[i].eatRadius)t=i;return t;},
 addScore(n){this.score=Math.max(0,this.score+n);return n;}};}
const lines=[-200,-100,0,100,200],half=11;
const layout={roadsX:lines.map(pos=>({pos,half,cls:'street'})),roadsZ:lines.map(pos=>({pos,half,cls:'street'})),
 blocks:[{x:50,z:50,w:60,d:60,zone:ZONE.PLAZA}],
 isRoad(x,z){for(const p of lines)if(Math.abs(x-p)<half)return true;for(const p of lines)if(Math.abs(z-p)<half)return true;return false;},
 isWater(){return false;}};
const noFx={puff(){},sparks(){},chunks(){},shockwave(){},popup(){},addShake(){}};

const hs=new HeatSystem({rng:makeRNG(7),layout,effects:noFx});
const hole=stubHole(300);
let t=0;
// Cycle heat hot -> cold four times, like a real match.
for(let cycle=0;cycle<4;cycle++){
  hs.bump(hole,1.0);
  for(let i=0;i<60*10;i++){t+=1/60;hs.update(1/60,[hole],t);}
  const hot=hs.units().length;
  hs.state.get(hole).heat=0;
  for(let i=0;i<60*20;i++){t+=1/60;hs.state.get(hole).heat=0;hs.update(1/60,[hole],t);}
  console.log(`cycle ${cycle}: peak ${hot} units, after cooldown ${hs.units().length} units ->`,
    hs.units().map(u=>`${u.kind}:${u.state}@${u.x.toFixed(0)},${u.z.toFixed(0)}`).join(' '));
}
console.log('MAX_UNITS =', HEAT.MAX_UNITS, ' stranded =', hs.units().length);
// Steering from a stranded barrier?
const st = hs.steerAt(hs.units().filter(u=>u.kind==='barrier').map(u=>u.x)[0] ?? 0,
                      hs.units().filter(u=>u.kind==='barrier').map(u=>u.z)[0] ?? 0);
console.log('steerAt near a stranded barrier:', st);
// clearAll residue
hs.clearAll();
console.log('after clearAll: units', hs.units().length, 'state', hs.state.size, 'focus', hs.focus,
  '| _nodes cached?', Array.isArray(hs._nodes), hs._nodes && hs._nodes.length,
  '| _protected cached?', Array.isArray(hs._protected), '| lastCue', hs.lastCue, '| t', hs.t.toFixed(1), '| _pruneAt', hs._pruneAt.toFixed(1));
