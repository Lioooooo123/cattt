import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { feltMaterial, feltify } from '../src/yard/felt.ts';
import { GroundShadows } from '../src/yard/ground-shadows.ts';

test('不同表面独立缓存着色程序，普通毛毡材质仍可共享', () => {
  const options = ['felt', 'wood', 'stone', 'plaster', 'ground'];
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
