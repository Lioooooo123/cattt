import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { feltMaterial, feltify } from '../src/yard/felt.ts';
import { GroundShadows } from '../src/yard/ground-shadows.ts';

test('不同表面独立缓存着色程序，普通毛毡材质仍可共享', () => {
  const options = ['felt', 'wood', 'stone', 'plaster', 'ground', 'cap'];
  const keys = options.map(surface => feltMaterial('#ffffff', { surface }).customProgramCacheKey());
  assert.equal(new Set(keys).size, options.length);
  assert.equal(feltMaterial('#ffffff').customProgramCacheKey(), feltMaterial('#ff0000').customProgramCacheKey());
});

test('材质分类保留灯和水、同材质复用及双面设置', () => {
  const root = new THREE.Group();
  const wood = new THREE.MeshStandardMaterial({ color: '#965b37', side: THREE.DoubleSide });
  wood.name = 'wood_light.002';
  const water = new THREE.MeshStandardMaterial(); water.name = 'water';
  const lamp = new THREE.MeshStandardMaterial(); lamp.name = 'window_glow';
  const bowl = new THREE.MeshStandardMaterial(); bowl.name = 'bowl_teal';
  for (const material of [wood, wood, water, lamp, bowl]) root.add(new THREE.Mesh(new THREE.BoxGeometry(), material));
  feltify(root, ['water', 'window_glow']);
  const [a, b, c, d, e] = root.children;
  assert.equal(a.material, b.material);
  assert.equal(a.material.side, THREE.DoubleSide);
  assert.ok(a.material.color.equals(wood.color));
  assert.equal(c.material, water); assert.equal(d.material, lamp);
  assert.ok(e.material.roughness < a.material.roughness);
});

test('树影随光源反向移动、雨天减弱、乘色带预乘透明度', () => {
  const shadows = new GroundShadows(), patch = shadows.root.children[0];
  shadows.update(new THREE.Vector3(1, 1, 0).normalize(), 2.8, 0);
  const x = patch.position.x, clear = patch.material.opacity;
  shadows.update(new THREE.Vector3(-1, 1, 0).normalize(), 2.8, 1);
  assert.ok(patch.position.x > x);
  assert.ok(patch.material.opacity < clear);
  assert.equal(patch.material.blending, THREE.MultiplyBlending);
  assert.equal(patch.material.premultipliedAlpha, true);
  assert.equal(patch.material.depthWrite, false);
});

test('房屋投影连接墙脚与伞盖，随低角度光延长，雨夜收弱且边缘全透明', () => {
  const shadows = new GroundShadows();
  const roof = shadows.root.getObjectByName('house-roof-shadow');
  const wall = shadows.root.getObjectByName('house-wall-shadow');
  shadows.update(new THREE.Vector3(.6, 1, .4).normalize(), 2.8, 0);
  const clear = roof.material.opacity, short = wall.scale.y, right = roof.position.x;
  assert.ok(roof.position.distanceTo(wall.position) > 0);
  const texture = roof.material.map.image;
  for (let x = 0; x < texture.width; x++) {
    assert.equal(texture.data[x * 4 + 3], 0);
    assert.equal(texture.data[((texture.height - 1) * texture.width + x) * 4 + 3], 0);
  }
  shadows.update(new THREE.Vector3(-1, .1, 0).normalize(), .5, 1);
  assert.ok(roof.position.x > right);
  assert.ok(wall.scale.y > short && wall.scale.y < 3);
  assert.ok(roof.material.opacity < clear * .2);
  shadows.update(new THREE.Vector3(0, 1, 0), 0, 0);
  assert.equal(roof.material.opacity, 0);
  assert.equal(wall.scale.y, 1);
});

test('伞盖与釉陶保留原色，不再共用布料表面的强起伏', () => {
  const root = new THREE.Group();
  for (const name of ['cap', 'bowl_teal', 'rope']) {
    const material = new THREE.MeshStandardMaterial({ color: '#cd5946' });
    material.name = name;
    root.add(new THREE.Mesh(new THREE.BoxGeometry(), material));
  }
  feltify(root, []);
  const [cap, bowl, rope] = root.children.map(mesh => mesh.material);
  assert.ok(cap.color.equals(rope.color));
  assert.ok(bowl.roughness < cap.roughness && cap.roughness < rope.roughness);
  assert.equal(bowl.isMeshPhysicalMaterial, undefined);
});
