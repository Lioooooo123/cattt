import { test } from 'node:test';
import assert from 'node:assert/strict';
import { prepareStartup } from '../src/app/startup.ts';
import * as THREE from 'three';
import { prepareScene, shadowDepthMaterial } from '../src/render/prepare.ts';

test('按实际离屏目标预编译，避免首帧重新编译不同的色调映射变体', async () => {
  const target = {}, scene = {}, camera = {};
  let current = null;
  const gl = {
    getRenderTarget: () => current,
    setRenderTarget: value => { current = value; },
    compileAsync: async (actualScene, actualCamera) => {
      assert.equal(current, target);
      assert.equal(actualScene, scene);
      assert.equal(actualCamera, camera);
    },
  };
  await prepareScene(gl, scene, camera, target);
  assert.equal(current, null);
});

test('直接绘制保留空目标，编译异常也恢复之前的目标', async () => {
  const previous = {};
  let current = previous;
  const gl = {
    getRenderTarget: () => current,
    setRenderTarget: value => { current = value; },
    compileAsync: async () => {
      assert.equal(current, null);
      throw new Error('编译失败');
    },
  };
  await assert.rejects(prepareScene(gl, {}, {}, null), /编译失败/);
  assert.equal(current, previous);
});

test('异步着色器准备持续报告存活，完成后停止心跳', async context => {
  context.mock.timers.enable({ apis: ['setInterval'] });
  let finish;
  const phases = [];
  const pending = prepareStartup(() => new Promise(resolve => { finish = resolve; }), phase => phases.push(phase));
  context.mock.timers.tick(12000);
  assert.equal(phases[0], 'compileStarted');
  assert.equal(phases.filter(phase => phase === 'compiling').length, 12);
  finish();
  await pending;
  assert.equal(phases.at(-1), 'compileFinished');
  const count = phases.length;
  context.mock.timers.tick(12000);
  assert.equal(phases.length, count);
});

test('空场景立即完成，不留下心跳', async context => {
  context.mock.timers.enable({ apis: ['setInterval'] });
  const phases = [];
  await prepareStartup(() => Promise.resolve(), phase => phases.push(phase));
  context.mock.timers.tick(12000);
  assert.deepEqual(phases, ['compileStarted', 'compileFinished']);
});

test('离开页面会停止尚未完成的准备心跳', async context => {
  context.mock.timers.enable({ apis: ['setInterval'] });
  const controller = new AbortController();
  let finish;
  const phases = [];
  const pending = prepareStartup(() => new Promise(resolve => { finish = resolve; }), phase => phases.push(phase), controller.signal);
  controller.abort();
  context.mock.timers.tick(12000);
  assert.deepEqual(phases, ['compileStarted']);
  finish();
  await pending;
});

test('着色器准备失败向调用者抛错，并停止心跳', async context => {
  context.mock.timers.enable({ apis: ['setInterval'] });
  const phases = [];
  await assert.rejects(prepareStartup(() => Promise.reject(new Error('编译失败')), phase => phases.push(phase)), /编译失败/);
  context.mock.timers.tick(12000);
  assert.deepEqual(phases, ['compileStarted']);
});

test('阴影深度材质与 three 阴影一遍取同一变体：面翻转、透明测试贴图跟随原材质', () => {
  const map = new THREE.Texture();
  const front = shadowDepthMaterial(new THREE.MeshStandardMaterial({ map, alphaTest: .4 }));
  assert.equal(front.side, THREE.BackSide);
  assert.equal(front.map, map);
  assert.equal(front.alphaTest, .4);
  assert.equal(shadowDepthMaterial(new THREE.MeshStandardMaterial({ side: THREE.DoubleSide })).side, THREE.DoubleSide);
  assert.equal(shadowDepthMaterial(new THREE.MeshStandardMaterial({ shadowSide: THREE.FrontSide })).side, THREE.FrontSide);
});

test('首帧前一并预编译阴影深度与后处理程序，编完恢复材质、雾和目标', async () => {
  const scene = new THREE.Scene();
  scene.fog = new THREE.Fog(0xffffff, 1, 10);
  const light = new THREE.DirectionalLight();
  light.castShadow = true;
  const casterMaterial = new THREE.MeshStandardMaterial();
  const caster = new THREE.Mesh(new THREE.BoxGeometry(), casterMaterial);
  caster.castShadow = true;
  const flat = new THREE.Mesh(new THREE.PlaneGeometry(), new THREE.MeshBasicMaterial());
  scene.add(light, caster, flat);
  const camera = new THREE.PerspectiveCamera();
  const target = {}, offscreen = new THREE.ShaderMaterial(), screen = new THREE.ShaderMaterial();
  let current = null;
  const calls = [];
  const gl = {
    shadowMap: { enabled: true },
    getRenderTarget: () => current,
    setRenderTarget: value => { current = value; },
    compileAsync: async (root, actualCamera, targetScene = null) => {
      assert.equal(actualCamera, camera);
      const objects = [];
      root.traverse(object => { if (object.material) objects.push(object); });
      calls.push({ root, target: current, targetScene, fog: scene.fog, objects, materials: objects.map(object => object.material) });
    },
  };
  await prepareScene(gl, scene, camera, target, { offscreen: [offscreen], screen: [screen] });
  const [main, shadow, post, finish] = calls;
  assert.equal(main.root, scene);
  assert.equal(main.target, target);
  assert.equal(shadow.targetScene, scene);
  assert.equal(shadow.fog, null);
  assert.deepEqual(shadow.objects, [caster]);
  assert.ok(shadow.materials[0].isMeshDepthMaterial);
  assert.deepEqual(post.materials, [offscreen]);
  assert.equal(post.target, target);
  assert.deepEqual(finish.materials, [screen]);
  assert.equal(finish.target, null);
  for (const quad of [...post.objects, ...finish.objects]) assert.deepEqual(Object.keys(quad.geometry.attributes).sort(), ['position', 'uv']);
  assert.equal(caster.material, casterMaterial);
  assert.ok(scene.fog);
  assert.equal(current, null);
});
