import { runHeading } from '../tuanzi/run-path.ts';
import { SCRATCH_ENTRY } from '../tuanzi/scratch-motion.ts';
import * as THREE from 'three';
import { POND_APPROACH, POND_LOOK } from '../yard/pond.ts';
import { FLOWER_ENTRY } from '../tuanzi/flower-motion.ts';
import { FENCE_ENTRY } from '../tuanzi/fence-motion.ts';
import { NEST_ENTRY } from '../tuanzi/nest-motion.ts';
import type { Tuanzi, Expression } from '../tuanzi/tuanzi.ts';
import type { Walker } from '../yard/cat.ts';
import { ANCHORS, place, PLACE_ORDER, type PlaceId } from '../yard/layout.ts';
import { minimumClearance } from '../yard/collision.ts';

const EXPRESSIONS = ['tilt', 'groom', 'happy', 'sulk', 'sad'] as const;
const isExpression = (activity: string): activity is Expression => EXPRESSIONS.includes(activity as Expression);
export type HomeIntent = { id: string; place: PlaceId; activity: string };
/** 场景动作以落脚、姿势和完整周期作为回执依据。 */
export class HomeBehavior {
  intent: HomeIntent = { id: 'initial', place: 'house', activity: 'rest' };
  private applied = false;
  private stage = 'route';
  private generation = 0;
  private onBed = false;
  private water = false;
  private degraded = false;
  private drinkStart = 0;
  drinkDone = false;
  private readonly bedPoint = { x: ANCHORS.bed.x, y: .072, z: ANCHORS.bed.z };
  private walker: Walker;
  private cat: Tuanzi;
  constructor(walker: Walker, cat: Tuanzi) { this.walker = walker; this.cat = cat; }
  setWater(full: boolean) {
    this.water = full;
    if (!full && this.intent.activity === 'drink' && this.applied && !this.drinkDone) {
      this.cat.stand(); this.degraded = true;
    }
  }
  accept(value: HomeIntent) {
    if (!value.id || !PLACE_ORDER.includes(value.place) || !['sit', 'rest', 'watch', 'drink', 'flower', 'scratch', 'chase', 'stretch', 'run', ...EXPRESSIONS].includes(value.activity)) throw new Error('行为意图无效');
    if (value.id === this.intent.id) return;
    if (this.cat.nestCanRest && value.place === 'tree' && ['rest', 'watch'].includes(value.activity)) {
      this.intent = { ...value }; this.cat.setNestRest(value.activity === 'rest');
      this.applied = true; this.stage = 'active'; this.degraded = false; this.drinkDone = false; this.generation++; return;
    }
    this.intent = { ...value }; this.applied = false; this.degraded = false; this.drinkDone = false; this.generation++;
    this.cat.lookAt(null); this.cat.stand();
    if (this.cat.running) { this.stage='run-exit'; }
    else if (this.cat.playingStretch) { this.stage='stretch-exit'; }
    else if (this.cat.playingChase) { this.stage='chase-exit'; }
    else if (this.cat.playingScratch) { this.stage = 'scratch-exit'; }
    else if (this.cat.playingFlower) { this.stage = 'flower-exit'; }
    else if (this.cat.fencing) { this.stage = 'fence-exit'; }
    else if (this.cat.nesting) { this.stage = 'nest-exit'; }
    else if (this.onBed || this.cat.hopping) { if (this.stage !== 'bed-out') this.stage = 'bed-exit'; }
    else this.route();
  }
  projectShared(intent: HomeIntent) {
    if (!intent.id || !PLACE_ORDER.includes(intent.place) || !['watch', 'sit'].includes(intent.activity)) throw new Error('共享院子投影无效');
    this.cat.restorePose(this.cat.position, this.cat.facing);
    this.walker.teleport(intent.place);
    this.restore(intent, false);
    // A confirmed seat can be displayed, but restoration never settles an action receipt.
    if (intent.activity === 'sit') this.cat.sit();
  }
  private route() {
    if (this.intent.place === 'tree' && this.intent.activity === 'scratch' && this.cat.state === 'idle' &&
        this.cat.position.distanceTo(new THREE.Vector3().copy(SCRATCH_ENTRY)) < .015) {
      this.walker.restore('tree', true);
      this.cat.faceToward({ x: SCRATCH_ENTRY.x, y: 0, z: ANCHORS.tree.z });
      this.stage = 'scratch-face'; return;
    }
    this.stage = 'route'; this.walker.restore(this.intent.place, false);
  }
  restore(value: HomeIntent, settled: boolean, drinkDone = false, saved?: { stage: string; onBed: boolean; applied: boolean; degraded: boolean; drinkStart: number }) {
    this.intent = { ...value }; this.applied = false; this.degraded = false; this.drinkDone = drinkDone; this.generation++;
    this.onBed = this.cat.position.y > .02 && Math.hypot(this.cat.position.x - ANCHORS.bed.x, this.cat.position.z - ANCHORS.bed.z) < .2;
    this.cat.bedSupport = this.onBed ? ANCHORS.bed : null;
    if (this.cat.running) { this.stage=saved?.stage ?? 'active';this.applied=saved?.applied ?? true;return; }
    if (this.cat.playingStretch) { this.stage=saved?.stage ?? 'active';this.applied=saved?.applied ?? true;return; }
    if (this.cat.playingChase) { this.stage=saved?.stage ?? 'active';this.applied=saved?.applied ?? true;return; }
    if (this.cat.playingScratch) { this.stage = saved?.stage ?? 'active'; this.applied=saved?.applied ?? true; return; }
    if (this.cat.playingFlower) { this.stage = saved?.stage ?? 'active'; this.applied=saved?.applied ?? true; return; }
    if (this.cat.fencing) { this.stage = saved?.stage ?? 'active'; this.applied = saved?.applied ?? true; return; }
    if (this.cat.nesting) { this.stage = saved?.stage ?? 'active'; this.applied = saved?.applied ?? true; return; }
    if (saved && (saved.onBed || this.cat.hopping || saved.stage === 'active')) {
      this.onBed = saved.onBed; this.stage = saved.stage; this.applied = saved.applied;
      this.degraded = saved.degraded; this.drinkStart = saved.drinkStart;
      this.cat.bedSupport = this.onBed || this.cat.hopping ? ANCHORS.bed : null;
      if (this.stage === 'bed-rest-face') this.faceAcrossBed();
      return;
    }
    if (this.onBed) {
      this.stage = value.place === 'bed' && value.activity === 'rest' ? 'bed-rest-face' : 'bed-exit';
      if (this.stage === 'bed-rest-face') this.faceAcrossBed();
    }
    else if (value.activity === 'drink' && drinkDone) { this.cat.stand(); this.applied = true; this.stage = 'active'; }
    else if (value.activity === 'drink' && settled) this.route(); // 未完成的周期重走安全入口，不沿用“已到达”伪记完成。
    else this.stage = 'route';
  }
  private faceAcrossBed() { this.cat.faceToward({ x: this.cat.position.x + Math.sqrt(3), y: this.cat.position.y, z: this.cat.position.z + 1 }); }
  update() {
    if(this.stage==='run-exit'){if(this.cat.running)return;this.route();}
    if(this.stage==='run-face'){if(!this.cat.facingReady||this.cat.state!=='idle')return;this.cat.playRun();this.applied=true;this.stage='active';}
    if(this.stage==='stretch-exit'){if(this.cat.playingStretch)return;this.route();}
    if(this.stage==='chase-exit'){if(this.cat.playingChase)return;this.route();}
    if (this.stage === 'scratch-exit') { if(this.cat.playingScratch)return; this.route(); }
    if (this.stage === 'scratch-face') {
      if (!this.cat.facingReady || this.cat.state !== 'idle') return;
      this.cat.playScratch(); this.applied=true; this.stage='active';
    }
    if (this.stage === 'flower-exit') { if(this.cat.playingFlower)return; this.route(); }
    if (this.stage === 'flower-face') {
      if (!this.cat.facingReady || this.cat.state !== 'idle') return;
      this.cat.playFlower(); this.applied=true; this.stage='active';
    }
    if (this.stage === 'fence-exit') { if (this.cat.fencing) return; this.route(); }
    if (this.stage === 'fence-face') {
      if (!this.cat.facingReady || this.cat.state !== 'idle') return;
      this.cat.enterFence(); this.applied = true; this.stage = 'active';
    }
    if (this.stage === 'nest-exit') { if (this.cat.nesting) return; this.route(); }
    if (this.stage === 'scratch-approach' || this.stage === 'flower-approach' || this.stage === 'fence-approach' || this.stage === 'nest-approach' || this.stage === 'pond-approach') return;
    if (this.stage === 'pond-face') {
      if (!this.cat.facingReady || this.cat.state !== 'idle') return;
      this.cat.playPond(); this.applied = true; this.stage = 'active';
    }
    if (this.stage === 'nest-face') {
      if (!this.cat.facingReady || this.cat.state !== 'idle') return;
      this.cat.enterNest(this.intent.activity === 'rest'); this.applied = true; this.stage = 'active';
    }
    if (this.stage === 'bed-in' && !this.cat.hopping) {
      this.onBed = true; this.stage = 'bed-rest-face';
      this.faceAcrossBed();
    }
    if (this.stage === 'bed-rest-face') {
      if (!this.cat.facingReady || this.cat.state !== 'idle') return;
      this.stage = 'bed-rest';
    }
    if (this.stage === 'bed-out' && !this.cat.hopping) { this.onBed = false; this.cat.bedSupport = null; this.route(); }
    if (this.stage === 'bed-exit') {
      if (this.cat.hopping) return;
      this.stage = 'bed-out';
      const exit = place('bed').point;
      void this.cat.hopTo({ ...exit, y: 0 });
      return;
    }
    if (this.stage === 'bed-in' || this.stage === 'bed-out' || this.stage === 'drink-approach') return;
    if (this.stage === 'expression-face') {
      if (!this.cat.facingReady || this.cat.state !== 'idle') return;
      if (isExpression(this.intent.activity)) this.cat.express(this.intent.activity);
      this.applied = true; this.stage = 'active';
    }
    if (this.stage === 'house-face') {
      if (!this.cat.facingReady || this.cat.state !== 'idle') return;
      this.cat.doze(); this.applied = true; this.stage = 'active';
    }
    if (this.stage === 'bed-face') {
      if (!this.cat.facingReady || this.cat.state !== 'idle') return;
      this.cat.bedSupport = ANCHORS.bed; this.stage = 'bed-in';
      void this.cat.hopTo(this.bedPoint);
      return;
    }
    if (this.stage === 'bed-rest') { this.cat.sleep(); this.applied = true; this.stage = 'active'; }
    if (this.applied) {
      if (this.intent.activity === 'drink' && !this.degraded && this.cat.drinkCompletions > this.drinkStart) this.drinkDone = true;
      return;
    }
    if (!this.walker.arrived) return;
    if(this.intent.activity==='run' && this.intent.place==='grass' && this.cat.state==='idle'){
      const yaw=runHeading(this.cat.position);
      if(yaw===null){this.degraded=true;this.applied=true;this.stage='active';return;}
      this.cat.faceToward({x:this.cat.position.x+Math.sin(yaw),y:0,z:this.cat.position.z+Math.cos(yaw)});this.stage='run-face';return;
    }
    if(this.intent.activity==='stretch' && this.intent.place==='grass' && this.cat.state==='idle'){this.cat.playStretch();this.applied=true;this.stage='active';return;}
    if(this.intent.activity==='chase' && this.intent.place==='grass' && this.cat.state==='idle'){this.cat.playChase();this.applied=true;this.stage='active';return;}
    if(this.intent.activity==='scratch' && this.intent.place==='tree') {
      this.stage='scratch-approach';const generation=this.generation;
      void this.cat.walkAlong([SCRATCH_ENTRY]).then(result=>{
        if(generation!==this.generation||result.interrupted)return;
        this.cat.faceToward({x:SCRATCH_ENTRY.x,y:0,z:ANCHORS.tree.z});this.stage='scratch-face';
      });return;
    }
    if(this.intent.activity==='flower' && this.intent.place==='fence') {
      this.stage='flower-approach';const generation=this.generation;
      void this.cat.walkAlong([FLOWER_ENTRY]).then(result=>{
        if(generation!==this.generation||result.interrupted)return;
        this.cat.faceToward({x:FLOWER_ENTRY.x,y:0,z:ANCHORS.flower.z});this.stage='flower-face';
      });return;
    }
    if (this.intent.place === 'fence' && ['watch', 'rest'].includes(this.intent.activity)) {
      this.stage = 'fence-approach'; const generation = this.generation;
      void this.cat.walkAlong([FENCE_ENTRY]).then(result => {
        if (generation !== this.generation || result.interrupted) return;
        this.cat.faceToward({x:FENCE_ENTRY.x,y:0,z:-3.1}); this.stage = 'fence-face';
      });
      return;
    }
    if (this.intent.place === 'tree' && ['watch', 'rest'].includes(this.intent.activity)) {
      this.stage = 'nest-approach'; const generation = this.generation;
      void this.cat.walkAlong([NEST_ENTRY]).then(result => {
        if (generation !== this.generation || result.interrupted) return;
        this.cat.faceToward({ x: NEST_ENTRY.x, y: .715, z: ANCHORS.nest.z }); this.stage = 'nest-face';
      });
      return;
    }
    if (this.intent.place === 'pond' && this.intent.activity === 'watch') {
      this.stage = 'pond-approach'; const generation = this.generation;
      void this.cat.walkAlong([POND_APPROACH]).then(result => {
        if (generation !== this.generation || result.interrupted) return;
        this.cat.faceToward(POND_LOOK); this.stage = 'pond-face';
      });
      return;
    }
    if (this.intent.activity === 'rest' && this.intent.place === 'bed') {
      this.cat.faceToward(this.bedPoint); this.stage = 'bed-face'; return;
    }
    if (isExpression(this.intent.activity)) {
      this.cat.faceToward({ x: this.cat.position.x, y: 0, z: this.cat.position.z + 1 });
      this.stage = 'expression-face'; return;
    }
    if (this.intent.activity === 'drink') {
      const basin = ANCHORS.bowl, home = place('house').point;
      const dx = home.x - basin.x, dz = home.z - basin.z, length = Math.hypot(dx, dz);
      const approach = { x: basin.x + dx / length * .236, y: 0, z: basin.z + dz / length * .236 };
      this.degraded = !this.water || this.intent.place !== 'house';
      for (let i = 0; i <= 40 && !this.degraded; i++) {
        const t = i / 40;
        this.degraded = minimumClearance({ x: home.x + (approach.x - home.x) * t, z: home.z + (approach.z - home.z) * t }).clearance < 0;
      }
      if (!this.degraded) {
        this.stage = 'drink-approach'; const generation = this.generation;
        void this.cat.walkAlong([approach]).then(result => {
          if (generation !== this.generation || result.interrupted) return;
          this.drinkStart = this.cat.drinkCompletions;
          this.degraded = !this.water;
          if (this.water) this.cat.drink(); else this.cat.stand();
          this.applied = true; this.stage = 'active';
        });
        return;
      }
      this.cat.stand(); this.cat.lookAt({ x: basin.x, y: .045, z: basin.z });
    } else if (this.intent.activity === 'sit') {
      this.cat.sit();
    } else if (this.intent.activity === 'rest' && this.intent.place === 'house') {
      this.cat.faceToward({ x: this.cat.position.x, y: 0, z: this.cat.position.z + 1 });
      this.stage = 'house-face'; return;
    }
    else if (this.intent.activity === 'rest' || this.intent.activity === 'groom') { this.cat.sit(); this.degraded = true; }
    else { this.cat.stand(); if(['flower','scratch','chase','stretch','run'].includes(this.intent.activity))this.degraded=true; }
    this.applied = true; this.stage = 'active';
  }
  get moving() { return (this.cat.nesting && !this.cat.nestSettled) || !this.walker.arrived || !['route', 'active'].includes(this.stage); }
  get settled() {
    if (!this.applied || this.moving) return false;
    if(this.intent.activity==='run')return !this.cat.running&&this.cat.state==='idle';
    if(this.intent.activity==='stretch')return !this.cat.playingStretch&&this.cat.state==='idle';
    if(this.intent.activity==='chase')return !this.cat.playingChase&&this.cat.state==='idle';
    if (this.intent.activity==='scratch') return !this.cat.playingScratch && this.cat.state==='idle';
    if (this.intent.activity==='flower') return !this.cat.playingFlower && this.cat.state==='idle';
    if (this.cat.fencing) return this.cat.fenceSettled;
    if (this.cat.nesting) return this.cat.nestSettled;
    if (this.intent.place === 'pond' && this.intent.activity === 'watch') return !this.cat.pondBusy && this.cat.state === 'idle';
    if (this.intent.activity === 'drink') return this.degraded ? this.cat.state === 'idle' : this.drinkDone && this.cat.state === 'idle';
    if (isExpression(this.intent.activity)) return this.cat.state === `${this.intent.activity}_idle`;
    if (this.intent.activity === 'sit') return this.cat.state === 'sit_idle';
    const expected = this.intent.activity === 'rest' && !this.degraded ? (this.intent.place === 'bed' ? 'sleep_idle' : 'doze_idle') : ['rest', 'groom'].includes(this.intent.activity) ? 'sit_idle' : 'idle';
    return this.cat.state === expected;
  }
  get fallback() { return this.degraded; }
  /** 窝与池边专用站位另验实际接触；池边圆形包络过于保守，三只承重爪仍在岸上。 */
  get supportCollider() { return this.cat.playingScratch || this.stage.startsWith('scratch-') ? 'tree' : this.cat.fencing ? 'fence-back' : (Math.abs(this.cat.position.x - POND_APPROACH.x) < .12 && this.cat.position.z >= POND_APPROACH.z - .001 && this.cat.position.z < POND_APPROACH.z + .3) ? 'pond' : this.cat.nesting ? 'tree' : this.onBed || this.cat.hopping ? 'bed' : undefined; }
  get snapshot() { return { intent: this.intent, settled: this.settled, drinkDone: this.drinkDone, execution: { stage: this.stage, onBed: this.onBed, applied: this.applied, degraded: this.degraded, drinkStart: this.drinkStart } }; }
}

/** 射线点选只认最近的真实物件；拖动、双指和取消由手势层排除。 */
export function pickTarget(ray: THREE.Raycaster, scene: THREE.Scene, cat: THREE.Object3D): string | null {
  for (const hit of ray.intersectObjects(scene.children, true)) {
    if (!hit.object.visible || !hit.object.parent) continue;
    let object: THREE.Object3D | null = hit.object;
    while (object) {
      if (object === cat) return 'cat';
      if (object.name === 'mailbox') return 'mailbox';
      if (object.name === 'bowl') return 'bowl';
      object = object.parent;
    }
    // 天空/程序草不是实体遮挡；其它模型会挡住后面的点击。
    if (hit.object.name || hit.object.type === 'SkinnedMesh') return null;
  }
  return null;
}
