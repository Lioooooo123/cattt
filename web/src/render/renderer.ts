import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { AdaptiveScaleGovernor, type ScaleDecision } from './adaptive-scale';
import { prepareScene } from './prepare';

// 帧率不够时降渲染分辨率，下限 0.75（方案第 6、8 节）
const MIN_SCALE = 0.75;

export interface ResolutionScaleEvent {
  phase: 'queued' | 'applied' | 'rendered';
  scale: number;
  reason: ScaleDecision['reason'];
  at: number;
}


/**
 * 收尾一遍做完：暗角、很轻的颗粒、ACES 色调映射、sRGB 输出。
 * 原先是"暗角颗粒"和"输出"两个全屏通道，实测后处理占一帧近一半，能并的都并了。
 * ACES 用的是 three 内置的那套拟合（RRT + ODT），曝光自己传。
 */
const FinishShader = {
  uniforms: { tDiffuse: { value: null }, uTime: { value: 0 }, uVignette: { value: 0.24 }, uGrain: { value: 0.008 }, uExposure: { value: 1 } },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse; uniform float uTime; uniform float uVignette; uniform float uGrain; uniform float uExposure;
    varying vec2 vUv;
    float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
    vec3 yardFit(vec3 v) {
      vec3 a = v * (v + 0.0245786) - 0.000090537;
      vec3 b = v * (0.983729 * v + 0.4329510) + 0.238081;
      return a / b;
    }
    vec3 yardAces(vec3 color) {
      const mat3 inputMat = mat3(vec3(0.59719, 0.07600, 0.02840), vec3(0.35458, 0.90834, 0.13383), vec3(0.04823, 0.01566, 0.83777));
      const mat3 outputMat = mat3(vec3(1.60475, -0.10208, -0.00327), vec3(-0.53108, 1.10813, -0.07276), vec3(-0.07367, -0.00605, 1.07602));
      color *= uExposure / 0.6;
      color = outputMat * yardFit(inputMat * color);
      return clamp(color, 0.0, 1.0);
    }
    void main() {
      vec3 color = texture2D(tDiffuse, vUv).rgb;
      vec2 d = (vUv - 0.5) * vec2(1.0, 0.92);
      color *= 1.0 - uVignette * smoothstep(0.32, 0.86, length(d) * 1.35);
      color = yardAces(color);
      color = mix(color * 12.92, pow(color, vec3(1.0 / 2.4)) * 1.055 - 0.055, step(0.0031308, color));
      color += (hash(vUv * 1024.0 + uTime * 61.0) - 0.5) * uGrain;
      gl_FragColor = vec4(color, 1.0);
    }`,
};

/**
 * 画布固定铺满视口。管线：离屏半浮点（2 倍多重采样）→ 泛光（只有窗灯、日月、星星这类够亮的东西会亮起来）
 * → 收尾（暗角、颗粒、色调映射、输出）。`?post=0` 关掉后处理直接画，对比用。
 */
export class Renderer {
  readonly gl: THREE.WebGLRenderer;
  fps = 60;
  scale = 1;
  /** 像素比封顶。不给就按视口大小取 1.25／1.5；App 里实测各档清晰度时从网址参数给 */
  maxRatio: number | null = null;

  private composer: EffectComposer | null = null;
  private finish: ShaderPass | null = null;
  private frames = 0;
  private frame = 0;
  private windowStart = performance.now();
  private governor = new AdaptiveScaleGovernor(MIN_SCALE);
  private pendingScale: ScaleDecision | null = null;
  private appliedScale: ScaleDecision | null = null;
  targetFps = 60;
  bloomEnabled = true;
  onScaleEvent: (event: ResolutionScaleEvent) => void = () => {};
  private resizeListener = () => this.resize();
  private onResize: (width: number, height: number) => void = () => {};

  /** preserve：保留绘图缓冲，只给调试时取图用（平时不开，省一次拷贝） */
  constructor(canvas: HTMLCanvasElement, post = true, preserve = false, samples = 2) {
    this.gl = new THREE.WebGLRenderer({ canvas, antialias: !post, powerPreference: 'high-performance', preserveDrawingBuffer: preserve });
    this.gl.toneMapping = THREE.ACESFilmicToneMapping;
    this.gl.toneMappingExposure = 1.0;
    this.gl.shadowMap.enabled = true;
    this.gl.shadowMap.type = THREE.PCFShadowMap;
    // 阴影隔一帧更新一次：院子里动得最快的是走路的团子（每秒 0.25 m），慢一帧看不出来，阴影那一遍省一半
    this.gl.shadowMap.autoUpdate = false;
    if (post) {
      const target = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, samples });
      this.composer = new EffectComposer(this.gl, target);
    }
    addEventListener('resize', this.resizeListener);
  }

  get width() {
    return document.documentElement.clientWidth;
  }

  get height() {
    return window.innerHeight;
  }

  bind(scene: THREE.Scene, camera: THREE.Camera, onResize: (width: number, height: number) => void) {
    this.onResize = onResize;
    if (this.composer) {
      this.finish = new ShaderPass(FinishShader);
      this.composer.addPass(new RenderPass(scene, camera));
      if (this.bloomEnabled) this.composer.addPass(new UnrealBloomPass(new THREE.Vector2(this.width, this.height), 0.26, 0.6, 1.15));
      this.composer.addPass(this.finish);
    }
    this.resize();
  }

  async prepare(scene: THREE.Scene, camera: THREE.Camera) {
    await prepareScene(this.gl, scene, camera, this.composer?.readBuffer ?? this.gl.getRenderTarget(), this.postMaterials());
  }

  /** 各后处理通道的全屏材质，按最后落到屏幕还是离屏目标分开（色调映射与输出色彩空间不同）。 */
  private postMaterials() {
    const offscreen: THREE.Material[] = [], screen: THREE.Material[] = [];
    if (!this.composer) return { offscreen, screen };
    const passes = this.composer.passes.filter(pass => pass.enabled);
    passes.forEach((pass, index) => {
      const last = index === passes.length - 1;
      for (const value of Object.values(pass).flat()) {
        if (!(value instanceof THREE.Material) || value instanceof THREE.MeshBasicMaterial) continue;
        // 泛光通道里只有叠回的那一步可能直接上屏，其余都画进它自己的离屏目标。
        const toScreen = last && (!(pass instanceof UnrealBloomPass) || value === pass.blendMaterial);
        (toScreen ? screen : offscreen).push(value);
      }
    });
    return { offscreen, screen };
  }

  render(scene: THREE.Scene, camera: THREE.Camera, time = 0) {
    // 自适应倍率只能在绘制开头应用。resize 重建完后，本次调用继续 render，
    // WebKit 不会合成到一个要等下一帧才有内容的后备存储。
    if (this.pendingScale) {
      this.scale = this.pendingScale.scale;
      this.appliedScale = this.pendingScale;
      this.pendingScale = null;
      this.resize();
      this.emitScale('applied', this.appliedScale);
    }
    this.gl.shadowMap.needsUpdate = this.frame++ % 2 === 0;
    if (this.composer && this.finish) {
      this.finish.uniforms.uTime!.value = time % 100;
      this.finish.uniforms.uExposure!.value = this.gl.toneMappingExposure;
      this.composer.render();
    } else {
      this.gl.render(scene, camera);
    }
    if (this.appliedScale) {
      this.emitScale('rendered', this.appliedScale);
      this.appliedScale = null;
    }
    this.govern();
  }

  /** Debug 实测用：让录屏能覆盖多次倍率重建，不改变正式治理阈值。 */
  requestScale(scale: number, reason: ScaleDecision['reason'] = 'slow') {
    const next = Math.max(MIN_SCALE, Math.min(1, Math.round(scale * 100) / 100));
    if (next === this.scale || this.pendingScale) return;
    this.pendingScale = { scale: next, reason };
    this.emitScale('queued', this.pendingScale);
  }

  resetTiming() {
    this.frames = 0;
    this.windowStart = performance.now();
    this.governor.reset();
  }

  dispose() {
    removeEventListener('resize', this.resizeListener);
    for (const pass of this.composer?.passes ?? []) pass.dispose();
    this.composer?.dispose();
    this.gl.dispose();
  }

  private resize() {
    const small = this.width * this.height < 620000;
    // 像素比封顶 1.5：视网膜屏按 2 倍渲染是 520 万像素，毛毡着色器撑不住；1.5 倍肉眼差别很小
    const ratio = Math.min(devicePixelRatio, this.maxRatio ?? (small ? 1.25 : 1.5)) * this.scale;
    this.gl.setPixelRatio(ratio);
    this.gl.setSize(this.width, this.height, false);
    if (this.composer) {
      this.composer.setPixelRatio(ratio);
      this.composer.setSize(this.width, this.height);
    }
    this.onResize(this.width, this.height);
  }

  private govern() {
    this.frames++;
    const now = performance.now();
    const elapsed = now - this.windowStart;
    if (elapsed < 1000) return;
    this.fps = (this.frames * 1000) / elapsed;
    this.frames = 0;
    this.windowStart = now;
    if (document.hidden) return;
    if (this.pendingScale) return;
    const decision = this.governor.sample(this.fps, this.targetFps, this.scale);
    if (!decision || decision.scale === this.scale) return;
    this.pendingScale = decision;
    this.emitScale('queued', decision);
  }

  private emitScale(phase: ResolutionScaleEvent['phase'], decision: ScaleDecision) {
    this.onScaleEvent({ phase, scale: decision.scale, reason: decision.reason, at: performance.now() });
  }
}
