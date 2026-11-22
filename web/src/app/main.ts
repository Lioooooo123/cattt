import * as THREE from 'three';
import { Renderer } from '../render/renderer';
import { loadTuanzi } from '../tuanzi';
import { Atmosphere, type TimeSlot, type Weather } from '../yard/atmosphere';
import { Walker, applyCatGlow } from '../yard/cat';
import { minimumClearance } from '../yard/collision';
import { ANCHORS, PLACE_ORDER, LAYOUT_VERSION, YARD_BOUNDARY, NODES, type PlaceId } from '../yard/layout';
import { World } from '../yard/world';
import { identity, inApp, post } from './bridge';
import { FramePacer, PerfRecorder } from './performance';
import { FollowCamera } from './follow';
import { CameraGestures } from './gestures';
import { projectBox, type ScreenRect, type Insets } from './composition';
import { HomeBehavior, pickTarget, type HomeIntent } from './home-behavior';
import { layoutRestorePoint } from './layout-snapshot';

// 参数由 Debug 实测页限定；与桌面共用资源，独立生命周期。
const params = new URLSearchParams(location.search);
const SLOTS: TimeSlot[] = ['dawn', 'day', 'dusk', 'evening', 'night'];
const slotValue = (value: unknown): TimeSlot | null => SLOTS.includes(value as TimeSlot) ? value as TimeSlot : null;
const placeValue = (value: unknown): PlaceId => {
  if (!PLACE_ORDER.includes(value as PlaceId)) throw new Error(`无效地点：${String(value)}`);
  return value as PlaceId;
};

async function boot() {
  const started = performance.now();
  const canvas = document.getElementById('gl') as HTMLCanvasElement;
  const hud = document.getElementById('hud')!;
  hud.hidden = !params.has('debug');
  const atmosphere = new Atmosphere();
  atmosphere.choose(slotValue(params.get('time')), params.get('weather') === 'rain' ? 'rain' : 'clear', true);
  const renderer = new Renderer(canvas, params.get('post') !== '0', false, Number(params.get('msaa') ?? 2));
  renderer.maxRatio = Number(params.get('dpr') ?? 1.25);
  renderer.targetFps = params.get('fps') === '30' ? 30 : 60;
  renderer.bloomEnabled = params.get('bloom') !== '0';
  const world = new World(params.get('grass') === '0.5' ? 0.5 : 1);
  world.sunLight.shadow.mapSize.setScalar(Number(params.get('shadow') ?? 2048));
  if (!await world.loadProps('/models/yard.glb')) throw new Error('院子模型加载失败，本轮无效');
  const cat = await loadTuanzi(params.get('fault') === 'model-missing' ? '/models/missing.glb' : '/models/tuanzi.glb');
  if (!cat) throw new Error('团子模型加载失败，本轮无效');
  if (params.get('fuzz') === '0') cat.appearance.apply({ surface: 'felt', outline: false, fuzz: false });
  cat.appearance.setFuzzLayers(params.get('shells') === '2' ? 2 : 4);
  world.scene.add(cat.root);
  const walker = new Walker(cat);
  cat.lookAt(null);
  const home = params.get('home') === '1';
  const behavior = home ? new HomeBehavior(walker, cat) : null;
  const composition = home || params.get('composition') === '1';
  const follow = new FollowCamera(composition);
  const occlusion: Insets = { top: Number(params.get('top') ?? 0), bottom: Number(params.get('bottom') ?? 0),
    left: Number(params.get('left') ?? 0), right: Number(params.get('right') ?? 0) };
  if (composition) {
    follow.setBounds(world.compositionBounds, world.cameraObstacles, world.compositionParts.map(part => part.box), YARD_BOUNDARY.map(p => new THREE.Vector3(p.x, 0, p.z)));
  }
  renderer.bind(world.scene, follow.camera, (width, height) => follow.resize(width, height, occlusion));
  renderer.gl.info.autoReset = false;
  if (composition) {
    const view = params.get('view') === 'comparison' ? 'overview' : params.get('view') ?? 'house';
    walker.teleport(view === 'overview' ? 'grass' : placeValue(view));
    cat.restorePose(cat.position, 0.25);
    if (view === 'overview') follow.overview(true); else follow.lookAtPlace(placeValue(view), true);
    if (home) follow.findCat();
  }

  // 完整帧序列只用于显式调试/验收。正式运行不累积、排序和跨桥传输整段统计。
  const recorder = new PerfRecorder(params.has('review') || params.has('debug'));
  const pacer = new FramePacer(renderer.targetFps);
  const listeners = new AbortController();
  let walking = params.get('walk') === '1';
  let next = 1, restSeconds = 0, motionRate = 1;
  let reviewView: 'front' | 'side' | 'bowl' | null = null;
  let reviewHeading: number | null = null;
  let initialized = false, appActive = !inApp(), contextOK = true, disposed = false;
  let raf = 0, running = false, previous: number | null = null;
  let rafTicks = 0;
  const lifecycleTrace = (reason: string) => {
    if (params.has('review')) post({ type: 'lifecycleTrace', reason, rafTicks, initialized, appActive,
      hidden: document.hidden, visibility: document.visibilityState, running, contextOK, disposed,
      width: canvas.clientWidth, height: canvas.clientHeight });
  };
  let firstFrame = false, visualReady = false, visualReadyPending = false, frameIndex = 0, reportAt = 0;
  let contextTestTimer: ReturnType<typeof setTimeout> | undefined;
  let scaleTestTimer: ReturnType<typeof setInterval> | undefined;
  const resolutionEvents: { phase: string; scale: number; reason: string; at: number }[] = [];
  const visitedNodes = new Set<string>();
  const nodeEntries = Object.entries(NODES);
  let trajectoryMinClearance = Infinity, trajectoryViolations = 0, colliding = false;
  renderer.onScaleEvent = event => {
    const record = { ...event, at: event.at - started };
    resolutionEvents.push(record);
    post({ type: 'resolutionScale', event: record });
  };
  let pendingTouches: { at: number; frame: number }[] = [];
  let pointerId: number | null = null, lastX = 0, lastPointerAt = 0;
  const motionPreference = matchMedia('(prefers-reduced-motion: reduce)');
  follow.reduceMotion = motionPreference.matches;
  const gestures = new CameraGestures(follow, () => renderer.width);
  motionPreference.addEventListener('change', event => { follow.reduceMotion = event.matches; }, { signal: listeners.signal });
  let restored = false;
  let lastHomeState = '';
  const raycaster = new THREE.Raycaster();
  const catScreenPosition = new THREE.Vector3();
  const tap = (x: number, y: number) => {
    raycaster.setFromCamera(new THREE.Vector2(x / renderer.width * 2 - 1, 1 - y / renderer.height * 2), follow.camera);
    const target = pickTarget(raycaster, world.scene, cat.root);
    if (target) {
      const slot = world.scene.getObjectByName('mailbox_slot');
      const projected = slot?.getWorldPosition(new THREE.Vector3()).project(follow.camera);
      post({ type: 'tap', target, x: target === 'mailbox' && projected ? (projected.x + 1) * renderer.width / 2 : x,
        y: target === 'mailbox' && projected ? (1 - projected.y) * renderer.height / 2 : y });
    }
  };
  const report = () => ({ ...recorder.report(), performanceRecording: recorder.enabled, resolutionEvents,
    visitedNodes: [...visitedNodes], journey: { arrived: walker.arrived, goal: walker.goal, position: cat!.position.toArray() },
    trajectoryClearance: { minimum: Number.isFinite(trajectoryMinClearance) ? trajectoryMinClearance : null, violations: trajectoryViolations } });
  const compositionMetrics = () => {
    const catBox = new THREE.Box3().setFromObject(cat.root, true);
    const head = cat.model.bones.get('head');
    const point = head?.getWorldPosition(new THREE.Vector3()).project(follow.camera);
    return { viewport: { width: renderer.width, height: renderer.height }, occlusion,
      camera: follow.snapshot(), limits: follow.limits,
      cat: projectBox(catBox, follow.camera, renderer.width, renderer.height),
      head: point ? { x: (point.x + 1) * renderer.width / 2, y: (1 - point.y) * renderer.height / 2 } : null,
      yard: projectBox(world.compositionBounds, follow.camera, renderer.width, renderer.height),
      layoutVersion: LAYOUT_VERSION, boundary: YARD_BOUNDARY,
      parts: world.compositionParts.map(part => ({ id: part.id, rect: projectBox(part.box, follow.camera, renderer.width, renderer.height) })),
      viewMatrix: follow.camera.matrixWorld.toArray(), projectionMatrix: follow.camera.projectionMatrix.toArray(),
      comparison: params.get('view') === 'comparison',
      bounds: { min: world.compositionBounds.min.toArray(), max: world.compositionBounds.max.toArray() } };
  };
  const snapshot = () => ({
    worldMotion: world.motionSnapshot,
    home: behavior?.snapshot,
    activity: cat.snapshotActivity(),
    hour: atmosphere.hourOverride,
    layoutVersion: LAYOUT_VERSION,
    position: { x: cat.position.x, y: cat.position.y, z: cat.position.z }, facing: cat.facing,
    goal: walker.goal, arrived: walker.arrived, camera: follow.snapshot(),
    slot: atmosphere.slot, shownSlot: atmosphere.slotShown, weather: atmosphere.weather,
    walking, next, restSeconds,
  });
  type Snapshot = ReturnType<typeof snapshot>;
  function restore(s: Snapshot) {
    if (s.worldMotion) world.restoreMotion(s.worldMotion);
    const goal = placeValue(s.goal);
    const numbers = [s.position.x, s.position.y, s.position.z, s.facing, ...s.camera.focus, ...s.camera.position];
    if ('centerX' in s.camera) numbers.push(s.camera.centerX);
    if ('centerZ' in s.camera) numbers.push(s.camera.centerZ);
    if ('velocity' in s.camera) numbers.push(s.camera.velocity);
    if (!numbers.every(Number.isFinite)) throw new Error('恢复快照坐标无效');
    const migrated = layoutRestorePoint(s.layoutVersion, goal);
    cat!.restorePose(migrated ?? s.position, s.facing);
    walker.restore(goal, migrated ? true : s.arrived);
    if (migrated) {
      if (s.camera.mode === 'overview') follow.overview(true);
      else if (s.camera.mode === 'following') follow.findCat();
      else follow.lookAtPlace(goal, true);
    } else follow.restore(s.camera);
    // 先恢复离开时天色；自动时钟在后续更新继续跟随。
    atmosphere.choose(s.shownSlot, s.weather, true);
    atmosphere.slot = s.slot;
    if (behavior && s.activity && s.home?.execution && (s.home.execution.applied || s.home.execution.onBed || s.activity.hop || s.activity.nest || s.activity.fence || s.activity.flower || s.activity.scratch || s.activity.chase || s.activity.stretch || s.activity.run)) cat!.restoreActivity(s.activity);
    if (behavior && s.home) behavior.restore(s.home.intent, s.home.settled, s.home.drinkDone, s.home.execution);
    atmosphere.hourOverride = s.hour ?? null;
    walking = s.walking; next = s.next; restSeconds = s.restSeconds;
    restored = true;
  }
  const sendSnapshot = (type = 'snapshot') => post({ type, snapshot: snapshot() });

  let sharedProjection = false;
  function projectShared(message: Record<string, unknown>) {
    if (!behavior) throw new Error('首页行为未启用');
    walking = false;
    behavior.projectShared(message.intent as HomeIntent);
    behavior.setWater(message.full === true);
    world.setHomeFacts(message.full === true, mailboxHasMail);
    atmosphere.hourOverride = null;
    atmosphere.choose(slotValue(message.slot), message.weather === 'rain' ? 'rain' : 'clear', true);
    sharedProjection = true;
    lastHomeState = '';
  }
  let mailboxHasMail = false;

  function syncRunning(reason: string) {
    const shouldRun = initialized && appActive && !document.hidden && contextOK && !disposed;
    lifecycleTrace(`syncRunning:${reason}:${shouldRun}`);
    if (shouldRun === running) return;
    running = shouldRun;
    if (!running) {
      cancelAnimationFrame(raf); raf = 0;
      recorder.pause(performance.now(), reason);
      previous = null; pacer.reset(); pendingTouches = [];
      follow.endBrowse(true); gestures.cancel(); pointerId = null;
      post({ type: 'paused', reason, snapshot: snapshot(), report: report() });
    } else {
      renderer.resetTiming(); previous = null; pacer.reset(); lastHomeState = "";
      post({ type: 'resumed', reason, snapshot: snapshot() });
      if (params.get('fault') !== 'no-first-frame') raf = requestAnimationFrame(frame);
    }
  }

  function frame(now: number) {
    rafTicks++;
    lifecycleTrace('raf');
    try { drawFrame(now); }
    catch (error) {
      cancelAnimationFrame(raf); raf = 0;
      post({ type: 'error', message: String(error), stack: error instanceof Error ? error.stack : undefined });
    }
  }

  function drawFrame(now: number) {
    raf = 0;
    if (!running || disposed) return;
    raf = requestAnimationFrame(frame);
    if (!pacer.due(now)) return;
    // 动画大步长仍限幅，性能统计保留完整前台间隔，两者不能混用。
    const dt = previous === null ? 0 : Math.min(0.05, (now - previous) / 1000);
    previous = now;
    atmosphere.update(dt);
    // 桌面章节的离屏追赶会传送猫；手机浏览镜头不应触发这个机制。
    if (!composition) walker.update(follow.camera, dt);
    cat!.update(dt * motionRate);
    if (!sharedProjection) behavior?.update();
    if (composition && !firstFrame) {
      cat!.root.updateMatrixWorld(true);
      cat!.root.traverse(object => { const mesh = object as THREE.SkinnedMesh; if (mesh.isSkinnedMesh) mesh.skeleton.update(); });
      follow.setSubjectSize(new THREE.Box3().setFromObject(cat!.root, true).getSize(new THREE.Vector3()));
    }
    for (const [id, p] of nodeEntries) if (Math.hypot(p.x - cat!.position.x, p.z - cat!.position.z) < .09) visitedNodes.add(id);
    const gap = minimumClearance(cat!.position, behavior?.supportCollider);
    trajectoryMinClearance = Math.min(trajectoryMinClearance, gap.clearance);
    if (gap.clearance < 0 && !colliding) {
      trajectoryViolations++;
      post({ type: 'collision', collider: gap.id, clearance: gap.clearance, position: { x: cat!.position.x, z: cat!.position.z } });
    }
    colliding = gap.clearance < 0;
    if (composition && !firstFrame && params.get('view') === 'comparison') {
      // 与第一版真机总览完全相同的相机外参；禁止为对照缩放物件。
      follow.compareAt([-.010704768687506583, 1.1834000200033188, -.38656030884626813],
        [-.010704768687506583, 10.421823627659451, 20.363278846854261]);
    }
    follow.update(cat!.position, dt);
    if (reviewView === 'bowl') {
      const p=ANCHORS.bowl;follow.compareAt([p.x+.08,.12,p.z],[p.x+.5,.8,p.z+1.15]);
    } else if (reviewView) {
      const p = cat!.position, angle = (reviewHeading ?? (cat!.nesting || cat!.fencing || cat!.playingFlower ? 0 : cat!.facing)) - (reviewView === 'side' ? Math.PI / 2 : 0);
      const flowerReview = behavior?.intent.activity === 'flower' && reviewHeading !== null;
      const stretchReview = ['stretch','run'].includes(behavior?.intent.activity ?? '') && reviewHeading !== null;
      const scratchReview = behavior?.intent.activity === 'scratch' && reviewHeading !== null;
      const z = flowerReview ? -2.38 : scratchReview ? -1.40 : p.z, distance = scratchReview ? 2.30 : flowerReview ? 2.05 : 1.75;
      const reviewY = behavior?.intent.activity === 'run' ? 0 : p.y;
      follow.compareAt([p.x, reviewY + .14, z], [p.x + Math.sin(angle) * distance, reviewY + (stretchReview ? 1.15 : .65), z + Math.cos(angle) * distance]);
    }
    frameIndex++;
    if (behavior) {
      const center = catScreenPosition.set(cat!.position.x, cat!.position.y + .2, cat!.position.z).project(follow.camera);
      const state = { id: behavior.intent.id, nearest: walker.arrived ? walker.goal : walker.nearest,
        moving: behavior.moving, settled: behavior.settled, action: cat!.state, activity: behavior.intent.activity,
        fallback: behavior.fallback, drinkDone: behavior.drinkDone, offscreen: Math.abs(center.x) > 1.1 || Math.abs(center.y) > 1.1 || center.z > 1,
        cameraMode: follow.mode };
      const json = JSON.stringify(state);
      if (json !== lastHomeState) { lastHomeState = json; post({ type: 'cat', ...state, snapshot: snapshot() }); }
    }
    for (const touch of pendingTouches) recorder.touch(frameIndex - touch.frame, performance.now() - touch.at);
    pendingTouches = [];
    world.setDrinking(cat!.drinkingPhase);
    world.setPondPaw(cat!.pondPaw, cat!.state);
    world.setFlowerPaw(cat!.flowerPaw,cat!.state);
    world.setNestLoad(cat!.nestLoad);
    world.update(dt, atmosphere, follow.camera, false, follow.reduceMotion);
    if (cat!.nesting) cat!.applyNestSupport(world.nestTransform);
    renderer.gl.toneMappingExposure = atmosphere.current.exposure;
    applyCatGlow(cat!, atmosphere.current.catGlow);
    if (walking && walker.arrived) {
      restSeconds += dt;
      if (restSeconds >= 2) {
        restSeconds = 0;
        walker.goTo(PLACE_ORDER[next % PLACE_ORDER.length]!); next++;
      }
    }
    renderer.gl.info.reset();
    renderer.render(world.scene, follow.camera, now / 1000);
    const finished = performance.now();
    recorder.frame(finished, renderer.scale);
    if (!firstFrame) {
      firstFrame = true;
      post({ type: 'firstFrame', renderMs: finished - started, snapshot: snapshot() });
      if (restored) post({ type: 'restored', snapshot: snapshot() });
      // Debug 实测故障注入：真正丢失/重建 GL 上下文，走与系统丢失相同的事件链。
      if (params.get('fault') === 'context-loss') {
        const extension = renderer.gl.getContext().getExtension('WEBGL_lose_context');
        if (!extension) post({ type: 'error', message: '当前环境没有 WEBGL_lose_context，无法完成故障验证' });
        else contextTestTimer = setTimeout(() => {
          extension.loseContext();
          contextTestTimer = setTimeout(() => extension.restoreContext(), 500);
        }, 1500);
      }
    }
    // render 返回只表示命令提交。再等一轮 RAF，才通知原生层淡出启动／重载遮罩。
    if (!visualReady && !visualReadyPending) {
      visualReadyPending = true;
      requestAnimationFrame(() => {
        visualReadyPending = false;
        if (!running || disposed || !contextOK || visualReady) return;
        visualReady = true;
        post({ type: 'visualReady', renderMs: performance.now() - started, snapshot: snapshot() });
      });
    }
    if (finished - reportAt >= 1000) {
      reportAt = finished;
      const info = renderer.gl.info.render;
      if (recorder.enabled) {
        post({ type: 'perf', report: report(), snapshot: snapshot(), fps: renderer.fps, scale: renderer.scale,
          nearest: walker.nearest, calls: info.calls, triangles: info.triangles });
      } else sendSnapshot(); // 保持每秒恢复检查点，不依赖性能采样。
      if (!hud.hidden) hud.textContent = `${renderer.fps.toFixed(0)} fps · ×${renderer.scale.toFixed(2)} · ${walker.nearest}`;
    }
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    clearTimeout(contextTestTimer);
    clearInterval(scaleTestTimer);
    syncRunning('dispose');
    listeners.abort();
    world.scene.traverse(object => {
      const mesh = object as THREE.Mesh;
      mesh.geometry?.dispose();
      const materials = Array.isArray(mesh.material) ? mesh.material : mesh.material ? [mesh.material] : [];
      for (const material of materials) {
        for (const value of Object.values(material)) if (value instanceof THREE.Texture) value.dispose();
        material.dispose();
      }
    });
    cat!.mixer.stopAllAction();
    renderer.dispose();
  }

  const eventOptions = { signal: listeners.signal };
  canvas.addEventListener('pointerdown', event => {
    if (!running) return;
    if (composition) {
      gestures.down(event.pointerId, event.clientX, event.clientY, performance.now());
      canvas.setPointerCapture(event.pointerId); return;
    }
    pointerId = event.pointerId; lastX = event.clientX; lastPointerAt = performance.now(); follow.beginBrowse();
    canvas.setPointerCapture(event.pointerId);
  }, eventOptions);
  canvas.addEventListener('pointermove', event => {
    if (!running) return;
    if (composition) {
      if (gestures.move(event.pointerId, event.clientX, event.clientY, performance.now())) pendingTouches.push({ at: performance.now(), frame: frameIndex });
      return;
    }
    if (event.pointerId !== pointerId) return;
    const now = performance.now();
    const delta = -((event.clientX - lastX) / renderer.width) * follow.visibleWidth;
    follow.dragBy(delta, Math.max(0.001, (now - lastPointerAt) / 1000));
    lastX = event.clientX; lastPointerAt = now;
    pendingTouches.push({ at: performance.now(), frame: frameIndex });
  }, eventOptions);
  for (const name of ['pointerup', 'pointercancel'] as const) canvas.addEventListener(name, event => {
    if (composition) { if (name === 'pointercancel') gestures.cancel(); else { const point = gestures.up(event.pointerId, performance.now()); if (home && point) tap(point.x, point.y); } return; }
    if (event.pointerId === pointerId) { pointerId = null; follow.endBrowse(follow.reduceMotion || name === 'pointercancel'); }
  }, eventOptions);
  canvas.addEventListener('lostpointercapture', event => { gestures.lost(event.pointerId); }, eventOptions);
  document.addEventListener('visibilitychange', () => syncRunning('visibility'), eventOptions);
  canvas.addEventListener('webglcontextlost', event => {
    event.preventDefault(); contextOK = false; visualReady = false; visualReadyPending = false;
    post({ type: 'contextLost', snapshot: snapshot() }); syncRunning('contextLost');
  }, eventOptions);
  canvas.addEventListener('webglcontextrestored', () => {
    contextOK = true; post({ type: 'contextRestored' }); syncRunning('contextRestored');
  }, eventOptions);
  addEventListener('pagehide', dispose, { once: true, signal: listeners.signal });

  window.__app = { command(json: string) {
    const message = JSON.parse(json) as Record<string, unknown>;
    if (message.runId !== identity.runId || message.pageId !== identity.pageId) return JSON.stringify({ error: 'stale' });
    switch (message.type) {
      case 'initialize':
        if (initialized) break;
        // 先恢复原生安全区与控件，再夹镜头距离，避免重载按默认布局缩近。
        for (const config of (message.configuration as Record<string, unknown>[] | undefined) ?? []) {
          if (!['viewport', 'controls', 'previewMotion', 'facts'].includes(String(config.type))) throw new Error('初始化配置无效');
          window.__app!.command(JSON.stringify({ ...config, ...identity }));
        }
        if (message.sharedWorld) projectShared(message.sharedWorld as Record<string, unknown>);
        else {
          if (message.snapshot) restore(message.snapshot as Snapshot);
          if (behavior && message.intent && (!restored || (message.intent as HomeIntent).id !== behavior.intent.id)) behavior.accept(message.intent as HomeIntent);
        }
        appActive = message.active === true; initialized = true; syncRunning('initialize'); break;
      case 'active': appActive = message.on === true; syncRunning('native'); break;
      case 'snapshot': sendSnapshot(); return JSON.stringify(snapshot());
      case 'report': return JSON.stringify(report());
      case 'dispose': dispose(); break;
      case 'facts': mailboxHasMail = message.mail === true; behavior?.setWater(message.full === true); world.setHomeFacts(message.full === true, mailboxHasMail); break;
      case 'sharedWorld': projectShared(message); break;
      case 'intent':
        if (!behavior) throw new Error('首页行为未启用');
        walking = false; sharedProjection = false; behavior.accept(message as unknown as HomeIntent); break;
      case 'poke': cat!.earFlick(); cat!.lookAt(follow.camera.position); break;
      case 'atmosphere': atmosphere.hourOverride = typeof message.hour === 'number' ? message.hour : null; atmosphere.choose(slotValue(message.slot), message.weather === 'rain' ? 'rain' : 'clear', message.instant === true); break;
      case 'goTo': walking = false; walker.goTo(placeValue(message.place)); break;
      case 'teleport':
        walking = false;
        cat!.restorePose(cat!.position, cat!.facing);
        walker.teleport(placeValue(message.place));
        behavior?.restore(behavior.intent, false);
        break;
      case 'walk': walking = message.on === true; restSeconds = 0; break;
      case 'stroll': walking = false; walker.stroll(); break;
      case 'controls': {
        const rects = message.rects as ScreenRect[];
        if (!Array.isArray(rects) || rects.some(r => ![r.x, r.y, r.width, r.height].every(Number.isFinite) || r.width < 0 || r.height < 0)) throw new Error('控件矩形无效');
        follow.setControls(rects); break;
      }
      case 'findCat': gestures.cancel(); follow.findCat(); break;
      case 'overview': gestures.cancel(); follow.overview(message.instant === true); break;
      case 'look': gestures.cancel(); follow.lookAtPlace(placeValue(message.place), message.instant === true); break;
      case 'viewport': {
        const next = message.insets as Insets;
        if (!next || !['top', 'bottom', 'left', 'right'].every(key => Number.isFinite(next[key as keyof Insets]) && next[key as keyof Insets] >= 0)) throw new Error('安全区参数无效');
        Object.assign(occlusion, next); follow.resize(renderer.width, renderer.height, occlusion); break;
      }
      case 'compositionMetrics': return JSON.stringify(compositionMetrics());
      case 'reviewBowl':
        if (!params.has('review')) throw new Error('非验收页面');
        reviewView='bowl';reviewHeading=null;break;
      case 'reviewFront':
      case 'reviewSide':
        if (!params.has('review')) throw new Error('非验收页面');
        reviewView = message.type === 'reviewFront' ? 'front' : 'side';
        reviewHeading = behavior?.intent.activity === 'flower' ? -.35 : behavior?.intent.activity === 'scratch' ? .35 : behavior?.intent.activity === 'run' ? (cat?.facing ?? 0) + 1 : behavior?.intent.activity === 'stretch' ? (cat?.facing ?? 0) + .8 : behavior?.intent.activity === 'chase' ? 0 : null; break;
      case 'motionRate': if (!params.has('review')) throw new Error('非验收页面'); motionRate = Math.max(.05, Math.min(2, Number(message.value))); break;
      case 'reviewTargets': {
        if (!params.has('review')) throw new Error('非验收页面');
        const targets = [['cat', cat!.root], ['mailbox', world.scene.getObjectByName('mailbox_slot')], ['bowl', world.scene.getObjectByName('bowl_body')]].map(([name, object]) => {
          if (!(object instanceof THREE.Object3D)) return { name, hit: null };
          const point = new THREE.Box3().setFromObject(object, true).getCenter(new THREE.Vector3()).project(follow.camera);
          const x = (point.x + 1) * renderer.width / 2, y = (1 - point.y) * renderer.height / 2;
          raycaster.setFromCamera(new THREE.Vector2(point.x, point.y), follow.camera);
          return { name, x, y, hit: x >= 0 && x <= renderer.width && y >= 0 && y <= renderer.height ? pickTarget(raycaster, world.scene, cat!.root) : null };
        });
        return JSON.stringify({ targets, composition: compositionMetrics() });
      }
      case 'reviewTap': if (!params.has('review')) throw new Error('非验收页面'); tap(Number(message.x), Number(message.y)); break;
      // 独立预览的录屏与回归入口，不作为正式用户控件。
      case 'previewZoom':
        if (!composition) throw new Error('仅构图预览可用');
        follow.zoomBy(Number(message.ratio), renderer.width / 2, renderer.height / 2); follow.endBrowse(true); break;
      case 'previewMotion':
        if (!composition) throw new Error('仅构图预览可用');
        follow.reduceMotion = message.on === true; break;
      case 'scale': renderer.requestScale(Number(message.scale), Number(message.scale) < renderer.scale ? 'slow' : 'fast'); break;
      case 'sit': cat!.sit(); break;
      case 'stand': cat!.stand(); break;
      default: return JSON.stringify({ error: `不认识的命令：${String(message.type)}` });
    }
    return '{}';
  } };
  post({ type: 'ready', loadMs: performance.now() - started, triangles: world.triangles });
  if (params.get('fault') === 'scale-cycle') {
    let low = true;
    scaleTestTimer = setInterval(() => {
      renderer.requestScale(low ? 0.8 : 1, low ? 'slow' : 'fast');
      low = !low;
    }, 800);
  }
  if (!inApp()) {
    if (behavior && params.has('review') && params.has('life')) {
      const life = params.get('life');
      behavior.setWater(true);
      behavior.accept({ id: 'life-review', place: life === 'bed' ? 'bed' : 'house', activity: life && ['drink', 'tilt', 'groom', 'happy', 'sulk', 'sad'].includes(life) ? life : 'rest' });
    }
    initialized = true; syncRunning('browser');
  }
}
void boot().catch(error => post({ type: 'error', message: String(error) }));
