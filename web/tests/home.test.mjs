import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { HomeBehavior, pickTarget } from '../src/app/home-behavior.ts';
import { CameraGestures } from '../src/app/gestures.ts';

function make() {
  const cat = { state: 'idle', position: new THREE.Vector3(-2.35,0,-.55), drinkCompletions: 0, hopping: false, facingReady: true,
    sit() { this.state = 'sit_down'; }, stand() { this.state = 'idle'; }, doze() { this.state = 'sit_down'; }, sleep() { this.state = 'sleep_down'; },
    express(kind) { this.state = `${kind}_down`; },
    playPond() { this.state = 'pond_down'; }, drink() { this.state = 'drink_down'; }, lookAt() {}, faceToward() {},
    hopTo(point) { this.position.copy(point); return Promise.resolve({interrupted:false}); }, walkAlong() { return Promise.resolve({ interrupted: false }); } };
  const walker = { arrived: true, restore(goal) { this.goal = goal; this.arrived = false; } };
  return { cat, walker, behavior: new HomeBehavior(walker, cat) };
}
test('陪坐需等到真实坐稳，途中与坐下过渡不能算完成', () => {
  const { cat, walker, behavior } = make();
  behavior.accept({ id: 'company', place: 'grass', activity: 'sit' });
  behavior.update();
  assert.equal(cat.state, 'idle');
  walker.arrived = true; behavior.update();
  assert.equal(cat.state, 'sit_down');
  assert.equal(behavior.settled, false);
  cat.state = 'sit_idle';
  assert(behavior.settled && !behavior.fallback);
});

test('进窝落脚后才能趴睡，睡稳后才安顿', async () => {
  const { cat, walker, behavior } = make();
  behavior.accept({ id: 'a', place: 'bed', activity: 'rest' });
  behavior.update(); assert.equal(behavior.settled, false);
  walker.arrived = true; behavior.update(); behavior.update(); await Promise.resolve(); behavior.update();
  assert.equal(cat.state, 'sleep_down'); assert.equal(behavior.settled, false);
  cat.state = 'sleep_idle'; assert.equal(behavior.settled, true); assert.equal(behavior.fallback, false);
  behavior.accept({ id: 'a', place: 'bed', activity: 'rest' }); assert.equal(behavior.settled, true);
});
test('动作延后一帧启动时，旧姿势不能提前报安顿', () => {
  const { cat, walker, behavior } = make();
  cat.doze = () => {}; cat.stand = () => {};
  behavior.accept({ id: 'sit', place: 'house', activity: 'rest' }); walker.arrived = true;
  behavior.update(); assert.equal(cat.state, 'idle'); assert.equal(behavior.settled, false);
  behavior.update(); cat.state = 'doze_idle'; assert.equal(behavior.settled, true);
  behavior.accept({ id: 'stand', place: 'house', activity: 'watch' }); walker.arrived = true;
  behavior.update(); assert.equal(behavior.settled, false);
  cat.state = 'idle'; assert.equal(behavior.settled, true);
});
test('门口先转正，转向完成后才坐下；新意图取消等待', () => {
  const { cat, walker, behavior } = make();
  let target; cat.faceToward = value => { target = value; cat.facingReady = false; };
  behavior.accept({id:'front',place:'house',activity:'rest'}); walker.arrived = true;
  behavior.update(); behavior.update();
  assert.equal(cat.state,'idle'); assert(!behavior.settled); assert.equal(target.z,cat.position.z+1);
  cat.facingReady=true; behavior.update(); assert.equal(cat.state,'sit_down');
  behavior.accept({id:'leave',place:'pond',activity:'watch'}); behavior.update(); assert.equal(cat.state,'idle');
});
test('无水降级，有水也要完整动作完成才记录；已完成快照不重喝', async () => {
  const { cat, walker, behavior } = make();
  behavior.accept({ id: 'empty', place: 'house', activity: 'drink' }); walker.arrived = true;
  behavior.update(); assert(behavior.fallback); assert(!behavior.drinkDone);
  behavior.setWater(true); behavior.accept({id:'drink',place:'house',activity:'drink'}); walker.arrived=true;
  behavior.update(); await Promise.resolve(); behavior.update();
  assert.equal(cat.state,'drink_down'); assert(!behavior.drinkDone); assert(!behavior.settled);
  cat.drinkCompletions++; cat.state='idle'; behavior.update(); assert(behavior.drinkDone); assert(behavior.settled);
  behavior.restore(behavior.intent,true,true); behavior.update(); assert.equal(cat.state,'idle'); assert(behavior.drinkDone);
});
test('迟到的盆边行程不能启动旧喝水；中途没水不能完成', async () => {
  const { cat, walker, behavior } = make(); behavior.setWater(true);
  behavior.accept({ id: 'drink', place: 'house', activity: 'drink' }); walker.arrived = true;
  behavior.update(); behavior.accept({ id: 'next', place: 'pond', activity: 'watch' });
  await Promise.resolve(); assert.equal(behavior.intent.id, 'next'); assert.equal(behavior.moving, true);
  walker.arrived = true; behavior.update(); assert.equal(behavior.settled, false); assert.equal(cat.state, 'idle');
  behavior.accept({id:'drink2',place:'house',activity:'drink'});walker.arrived=true;behavior.update();await Promise.resolve();
  behavior.setWater(false);cat.drinkCompletions++;behavior.update();assert(!behavior.drinkDone);assert(behavior.fallback);
});
test('点击可返回坐标，拖动/双指/取消不产生点击', () => {
  const camera = { beginBrowse() {}, endBrowse() {}, dragBy() {}, zoomBy() {}, visibleWidth: 5 };
  const g = new CameraGestures(camera, () => 400);
  g.down(1, 10, 20, 0); assert.deepEqual(g.up(1, 10), { x: 10, y: 20 });
  g.down(2, 10, 20, 0); g.move(2, 20, 20, 10); assert.equal(g.up(2, 20), undefined);
  g.down(3, 10, 20, 0); g.down(4, 40, 20, 0); g.up(4, 10); assert.equal(g.up(3, 20), undefined);
  g.down(5, 10, 20, 0); g.cancel(); assert.equal(g.up(5, 20), undefined);
});
test('射线命中猫/信箱/水盆，实体遮挡挡住背后点击', () => {
  const scene = new THREE.Scene(), cat = new THREE.Group(), mailbox = new THREE.Group(); mailbox.name = 'mailbox';
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial()); mailbox.add(mesh); scene.add(mailbox, cat);
  const ray = { intersectObjects: () => [{ object: mesh }] };
  assert.equal(pickTarget(ray, scene, cat), 'mailbox');
  mailbox.name = 'bowl'; assert.equal(pickTarget(ray, scene, cat), 'bowl');
  const wall = new THREE.Mesh(); wall.name = 'house'; scene.add(wall);
  ray.intersectObjects = () => [{ object: wall }, { object: mesh }]; assert.equal(pickTarget(ray, scene, cat), null);
});

test('第二批动作转正后进入，持续阶段才安顿；离开和恢复不伪造饮水', () => {
  for (const activity of ['tilt','groom','happy','sulk','sad']) {
    const {cat,walker,behavior}=make();
    behavior.accept({id:activity,place:'house',activity});walker.arrived=true;
    behavior.update(); assert(!behavior.settled);
    behavior.update();assert.equal(cat.state,`${activity}_down`);assert(!behavior.settled);
    cat.state=`${activity}_idle`;assert(behavior.settled);assert(!behavior.fallback);assert(!behavior.drinkDone);
    const saved=behavior.snapshot;
    behavior.restore(saved.intent,true,false,saved.execution);assert(behavior.settled);
    behavior.accept({id:'leave',place:'pond',activity:'watch'});assert(!behavior.settled);assert(!behavior.drinkDone);
  }
});

test('匹配的共享快照只投影确认地点，清除旧意图后允许真实命令', () => {
  const { cat, walker, behavior } = make();
  cat.restorePose = () => cat.stand();
  walker.teleport = place => { walker.goal = place; walker.arrived = true; };
  behavior.accept({ id: 'discard', place: 'fence', activity: 'drink' });
  behavior.projectShared({ id: 'shared', place: 'pond', activity: 'watch' });
  assert.equal(walker.goal, 'pond');
  assert.equal(behavior.intent.id, 'shared');
  assert.equal(behavior.moving, false);
  assert.equal(behavior.settled, false);
  assert.equal(behavior.drinkDone, false);
  behavior.accept({ id: 'confirmed', place: 'grass', activity: 'sit' });
  assert.equal(walker.goal, 'grass');
  assert.equal(behavior.moving, true);
});
