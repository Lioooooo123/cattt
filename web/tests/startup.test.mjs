import { test } from 'node:test';
import assert from 'node:assert/strict';
import { prepareStartup } from '../src/app/startup.ts';
import { prepareScene } from '../src/render/prepare.ts';

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
