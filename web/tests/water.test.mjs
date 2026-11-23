import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { POND } from '../src/yard/layout.ts';
import { makeWater } from '../src/yard/water.ts';

test('水面仍贴合原池岸、三角形朝上；水深从中心连续降到岸边', () => {
  const water = makeWater();
  const { geometry } = water;
  const vertices = geometry.getAttribute('position'), depth = geometry.getAttribute('depth');
  const outline = new THREE.CatmullRomCurve3(POND.map(p => new THREE.Vector3(p.x, 0, p.z)), true, 'centripetal').getPoints(72);
  assert.equal(vertices.count, 73);
  assert.equal(depth.getX(0), 1);
  for (let i = 1; i < vertices.count; i++) {
    assert.ok(Math.abs(vertices.getX(i) - outline[i - 1].x) < 1e-6);
    assert.ok(Math.abs(vertices.getZ(i) - outline[i - 1].z) < 1e-6);
    assert.equal(depth.getX(i), 0);
  }
  const index = geometry.getIndex();
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  for (let i = 0; i < index.count; i += 3) {
    a.fromBufferAttribute(vertices, index.getX(i));
    b.fromBufferAttribute(vertices, index.getX(i + 1));
    c.fromBufferAttribute(vertices, index.getX(i + 2));
    assert.ok(b.sub(a).cross(c.sub(a)).y > 0, `三角形 ${i / 3} 背面朝上`);
  }
  assert.equal(water.position.y, .012);
});
