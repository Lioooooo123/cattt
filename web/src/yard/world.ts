import { BowlPour } from './bowl-pour.ts';
import * as THREE from 'three';
import { FlowerResponse } from './flower-response.ts';
import { POND_TOUCH } from './pond.ts';
import { PondEffects } from './pond-effects.ts';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import type { Atmosphere } from './atmosphere';
import { feltMaterial, feltify } from './felt';
import { ANCHORS, NODES, POND, PATHS, EDGES, YARD_BOUNDARY, type Ground } from './layout';
import { groundHeight } from './terrain';
import { batchStaticProps } from './static-props';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { GroundShadows } from './ground-shadows.ts';

/**
 * 院子：Blender 出的物件 + 这里程序生成的地面、石子路、池塘、草、远山、云、天、雨、落叶、雾。
 * 配色取自 iOS 院子现行素材（毛毡草地、石子路、蓝池塘、青绿远山、奶油色的云）。
 */
const COLORS = {
  lawn: '#819960',
  lawnPatch: '#607b46',
  cobble: '#bfb7a0',
  pathBed: '#77775a',
  stone: '#a79f8b',
  pad: '#4f9b3c',
  blade: '#748e50',
  bladeTip: '#a0ad70',
  hillNear: '#829d72',
  hillMid: '#799d91',
  hillFar: '#8ea9ac',
  treeline: '#486f56',
  cloud: '#fbf1dc',
  leaf: '#d9863a',
};

export class World {
  readonly scene = new THREE.Scene();
  readonly sunLight = new THREE.DirectionalLight('#ffffff', 2.4);
  readonly fillLight = new THREE.HemisphereLight('#ffffff', '#888888', 1.4);
  triangles = 0;
  /** 只含院子实体、路网与水面，供手机全景取景；不含远山/天空。 */
  readonly compositionBounds = new THREE.Box3();
  readonly cameraObstacles: THREE.Box3[] = [];
  readonly compositionParts: { id: string; box: THREE.Box3 }[] = [];

  private sky: THREE.Mesh<THREE.SphereGeometry, THREE.ShaderMaterial>;
  private clouds: { group: THREE.Group; speed: number }[] = [];
  private nestBaseInverse = new THREE.Matrix4();
  private nestWeight = 0;
  private nestLoad = 0;
  get motionSnapshot() { return { flower:this.flowerResponse.snapshot, time: this.time, nestWeight: this.nestWeight }; }
  restoreMotion(value: { time: number; nestWeight: number; flower?: ReturnType<World['flowerSnapshot']> }) { if(value.flower)this.flowerResponse.restore(value.flower); if (Number.isFinite(value.time) && Number.isFinite(value.nestWeight)) { this.time = value.time; this.nestWeight = value.nestWeight; } }
  private flowerResponse=new FlowerResponse();
  private flowerPaw:THREE.Vector3|null=null;
  private flowerState='idle';
  private flowerSnapshot(){return this.flowerResponse.snapshot;}
  setFlowerPaw(paw:THREE.Vector3|null,state:string){this.flowerPaw=paw;this.flowerState=state;}
  setNestLoad(value: number) { this.nestLoad = value; }
  get nestTransform() {
    this.nestPivot?.updateWorldMatrix(true, true);
    return this.nestPivot ? this.nestPivot.matrixWorld.clone().multiply(this.nestBaseInverse) : new THREE.Matrix4();
  }
  private nestPivot: THREE.Object3D | null = null;
  private crown: THREE.Object3D | null = null;
  private flag: THREE.Object3D | null = null;
  private bowlPour=new BowlPour();
  private bowlWaterY=0;
  private bowlWater: THREE.Object3D | null = null;
  private drinkingPhase: number | null = null;
  private pondEffects = new PondEffects();
  private pondPaw: THREE.Vector3 | null = null;
  private pondState = 'idle';
  setPondPaw(paw: THREE.Vector3 | null, state: string) { this.pondPaw = paw; this.pondState = state; }
  private bowlRipples = [0, 1].map(() => {
    const ring = new THREE.Mesh(new THREE.RingGeometry(.88, 1, 32), new THREE.MeshBasicMaterial({ color: '#b9e9df', transparent: true, opacity: 0, depthWrite: false, side: THREE.DoubleSide }));
    ring.rotation.x = -Math.PI / 2;
    ring.position.set(ANCHORS.bowl.x, .0476, ANCHORS.bowl.z);
    ring.visible = false;
    return ring;
  });
  setDrinking(phase: number | null) { this.drinkingPhase = phase; }
  private mailUp: boolean | null = null;
  setHomeFacts(full: boolean, mail: boolean) {
    this.mailUp = mail;
    this.bowlPour.setFull(full);
    if (this.bowlWater) this.bowlWater.visible = full;
  }
  private windowMaterial: THREE.MeshStandardMaterial | null = null;
  private windowLamp = new THREE.PointLight('#ffd69a', 0, 3.8, 1.8);
  private rain: THREE.LineSegments<THREE.BufferGeometry, THREE.ShaderMaterial>;
  private water: THREE.Mesh<THREE.BufferGeometry, THREE.ShaderMaterial>;
  private sunDisc: THREE.Sprite;
  private moonDisc: THREE.Sprite;
  private stars: THREE.Points<THREE.BufferGeometry, THREE.ShaderMaterial>;
  private grassUniforms = { uTime: { value: 0 }, uWind: { value: 1 } };
  private mist: { mesh: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>; x: number; speed: number; phase: number; weight: number }[] = [];
  private leaves: Leaves;
  private time = 0;
  private groundShadows = new GroundShadows();

  constructor(grassRatio = 1) {
    this.scene.fog = new THREE.Fog('#cfe3ea', 16, 130);
    this.scene.add(this.fillLight, ...this.bowlRipples, this.bowlPour.root);

    this.sunLight.castShadow = true;
    this.sunLight.shadow.mapSize.set(2048, 2048);
    const shadowCamera = this.sunLight.shadow.camera;
    shadowCamera.left = -6.2;
    shadowCamera.right = 6.2;
    shadowCamera.top = 5.8;
    shadowCamera.bottom = -5.8;
    shadowCamera.near = 1;
    shadowCamera.far = 26;
    this.sunLight.shadow.radius = 5;
    this.sunLight.shadow.bias = -0.0004;
    this.sunLight.shadow.normalBias = 0.02;
    this.scene.add(this.sunLight, this.sunLight.target);

    this.sky = makeSky();
    this.scene.add(this.sky);
    this.scene.add(makeGround(), makeContactShadows(), makePaths(), makeStones(), makeLilyPads(), makeHills(), makeShorePlants());
    this.scene.add(this.groundShadows.root);
    this.water = makeWater();
    this.scene.add(this.water, this.pondEffects.root);
    this.scene.add(makeGrass(this.grassUniforms, grassRatio));
    this.makeClouds();
    this.makeMist();

    this.sunDisc = makeDisc('#ffd9a0', 9);
    this.moonDisc = makeDisc('#f4f1df', 5);
    this.scene.add(this.sunDisc, this.moonDisc);
    this.stars = makeStars();
    this.scene.add(this.stars);
    this.rain = makeRain();
    this.scene.add(this.rain);
    this.leaves = new Leaves();
    this.scene.add(this.leaves.mesh);
    this.scene.add(this.windowLamp);
  }

  /** 读 Blender 导出的物件。读不到也能跑（只剩地形），方便单独调页面。 */
  async loadProps(url: string) {
    const gltf = await new GLTFLoader().loadAsync(url).catch(() => null);
    if (!gltf) return false;
    gltf.scene.traverse((object) => {
      const mesh = object as THREE.Mesh;
      if (!mesh.isMesh) return;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      const index = mesh.geometry.index;
      this.triangles += (index ? index.count : mesh.geometry.attributes.position!.count) / 3;
      const material = mesh.material as THREE.MeshStandardMaterial;
      if (material.name === 'window_glow') {
        this.windowMaterial = material;
        material.emissive = new THREE.Color('#ffb860');
        material.emissiveIntensity = 0;
        material.roughness = 0.6;
        mesh.castShadow = false;
        mesh.getWorldPosition(this.windowLamp.position);
      }
      if (material.name === 'water') {
        mesh.castShadow = false;
        material.roughness = 0.3;
      }
    });
    feltify(gltf.scene, ['window_glow', 'water']);
    this.scene.add(gltf.scene);
    this.scene.updateMatrixWorld(true);
    this.compositionBounds.setFromObject(gltf.scene);
    for (const p of [...Object.values(NODES), ...POND, ...YARD_BOUNDARY]) this.compositionBounds.expandByPoint(new THREE.Vector3(p.x, 0, p.z));
    gltf.scene.traverse(object => {
      const mesh = object as THREE.Mesh;
      if (mesh.isMesh) this.cameraObstacles.push(new THREE.Box3().setFromObject(mesh));
    });
    for (const object of gltf.scene.children) {
      const box = new THREE.Box3().setFromObject(object);
      if (!box.isEmpty()) this.compositionParts.push({ id: object.name, box });
    }
    this.compositionParts.push({ id: 'pond', box: new THREE.Box3().setFromPoints(POND.map(p => new THREE.Vector3(p.x, .08, p.z))).expandByScalar(.13) });
    for (const name of ['house', 'bench', 'rocks', 'flowerbed', 'fence', 'flower', 'tree_wood', 'tree_crown', 'nest_pivot']) {
      const root = gltf.scene.getObjectByName(name);
      if (root) batchStaticProps(root);
    }
    const flower=gltf.scene.getObjectByName('flower');
    if(flower){this.scene.add(this.flowerResponse.root);this.flowerResponse.root.attach(flower);}
    this.nestPivot = gltf.scene.getObjectByName('nest_pivot') ?? null;
    if (this.nestPivot) { this.nestPivot.updateWorldMatrix(true, true); this.nestBaseInverse.copy(this.nestPivot.matrixWorld).invert(); }
    this.crown = gltf.scene.getObjectByName('tree_crown') ?? null;
    this.flag = gltf.scene.getObjectByName('mailbox_flag') ?? null;
    this.bowlWater = gltf.scene.getObjectByName('bowl_water') ?? null;
    this.bowlWaterY=this.bowlWater?.position.y ?? 0;
    if (this.windowMaterial) {
      // 灯放在窗外一点，照到门前的地面
      const house = new THREE.Vector3(ANCHORS.house.x, 0, ANCHORS.house.z);
      const out = this.windowLamp.position.clone().sub(house).setY(0).normalize().multiplyScalar(0.2);
      this.windowLamp.position.add(out);
    }
    return true;
  }

  update(dt: number, atmosphere: Atmosphere, camera: THREE.Camera, still: boolean, reduceMotion = false) {
    if (!still) this.time += dt;
    const t = this.time;
    const sky = atmosphere.current;
    this.bowlPour.update(dt,still || reduceMotion);
    if(this.bowlWater){this.bowlWater.visible=this.bowlPour.level>0;this.bowlWater.position.y=this.bowlWaterY-.022*(1-this.bowlPour.level);}
    // 每次舔饮带出两道薄水纹，吞咽、空盆和中断时收住。
    const drink = this.drinkingPhase;
    this.bowlRipples.forEach((ring, i) => {
      const age = drink === null ? 1 : ((drink * 4 + i * .5) % 1);
      ring.visible = !!this.bowlWater?.visible && drink !== null && drink < 2;
      ring.scale.setScalar(.012 + .063 * age);
      ring.material.opacity = .6 * (1 - age);
    });

    // 天、雾、光
    const skyUniforms = this.sky.material.uniforms;
    skyUniforms.uTop!.value.copy(sky.top);
    skyUniforms.uHorizon!.value.copy(sky.horizon);
    skyUniforms.uGlow!.value.copy(sky.light).multiplyScalar(sky.glow * 0.55);
    this.sky.position.copy(camera.position);
    const fog = this.scene.fog as THREE.Fog;
    fog.color.copy(sky.horizon);
    // 拉远的总览相机不应给整个院子罩上等量灰雾；雾仍从院外开始分层。
    const aerial = Math.max(0, camera.position.y - 3) * .85;
    fog.near = THREE.MathUtils.lerp(16, 7, sky.mist) + aerial;
    fog.far = THREE.MathUtils.lerp(115, 48, sky.mist) + aerial;
    this.sunLight.color.copy(sky.light);
    this.sunLight.intensity = sky.lightIntensity;
    const azimuth = THREE.MathUtils.degToRad(sky.azimuth);
    const elevation = THREE.MathUtils.degToRad(sky.elevation);
    const direction = new THREE.Vector3(Math.sin(azimuth) * Math.cos(elevation), Math.sin(elevation), Math.cos(azimuth) * Math.cos(elevation));
    this.sunLight.position.copy(direction).multiplyScalar(12);
    this.groundShadows.update(direction, sky.lightIntensity, sky.rain);
    this.fillLight.color.copy(sky.fill);
    this.fillLight.groundColor.copy(sky.ground);
    this.fillLight.intensity = sky.fillIntensity;

    // 太阳只在清晨和黄昏贴着地平线露面；月亮在右上。都跟着镜头走，永远在远处
    const sunSide = sky.azimuth < 0 ? -1 : 1;
    this.sunDisc.position.copy(camera.position).add(new THREE.Vector3(sunSide * 22, 5.5, -70));
    skyUniforms.uGlowDir!.value.set(sunSide * 22, 5.5, -70).normalize();
    this.sunDisc.material.opacity = sky.sun;
    this.sunDisc.material.color.copy(sky.light).multiplyScalar(2.2);
    this.moonDisc.position.copy(camera.position).add(new THREE.Vector3(20, 26, -70));
    this.moonDisc.material.opacity = sky.moon;
    this.moonDisc.material.color.set('#f4f1df').multiplyScalar(1.6);
    this.stars.position.copy(camera.position);
    this.stars.material.uniforms.uOpacity!.value = sky.stars;
    this.stars.material.uniforms.uTime!.value = t;

    // 窗灯：入夜亮起，轻轻呼吸（幅度两成以内）
    const breathe = 1 + 0.025 * Math.sin(t * 0.7) + 0.012 * Math.sin(t * 1.3 + 1.0);
    if (this.windowMaterial) this.windowMaterial.emissiveIntensity = sky.windowLit * 0.92 * breathe;
    this.windowLamp.intensity = sky.windowLit * 0.68 * breathe;

    // 没人操作也在动：云、吊窝、树冠、草、水、旗子、落叶、雾
    const wind = 1 + sky.rain * 0.8;
    for (const cloud of this.clouds) {
      if (!still) cloud.group.position.x += cloud.speed * dt * wind;
      if (cloud.group.position.x > 34) cloud.group.position.x = -34;
    }
    if (this.nestPivot) {
      this.nestWeight = THREE.MathUtils.damp(this.nestWeight, this.nestLoad, 4, dt);
      this.nestPivot.rotation.z = Math.sin(t * 0.9) * (0.05 * wind + .018 * this.nestWeight);
      this.nestPivot.rotation.x = Math.sin(t * 0.63 + 1.2) * (0.03 * wind + .01 * this.nestWeight);
    }
    if (this.crown) {
      this.crown.rotation.z = Math.sin(t * 0.5) * 0.012 * wind;
      this.crown.rotation.x = Math.sin(t * 0.37 + 0.6) * 0.008 * wind;
    }
    if (this.flag) {
      this.flag.rotation.y = Math.sin(t * 0.8) * 0.04;
      if (this.mailUp !== null) this.flag.rotation.z = THREE.MathUtils.damp(this.flag.rotation.z, this.mailUp ? 0 : -Math.PI / 2, 10, dt);
    }
    this.grassUniforms.uTime.value = t;
    this.grassUniforms.uWind.value = wind;

    this.flowerResponse.update(still ? 0 : dt,this.flowerPaw,this.flowerState);
    this.pondEffects.update(still ? 0 : dt, this.pondPaw, this.pondState);
    const water = this.water.material.uniforms;
    water.uTime!.value = t;
    water.uRain!.value = sky.rain;
    water.uSky!.value.copy(sky.top).lerp(sky.horizon, 0.45);
    // 水面不吃场景灯光，亮度自己按主光和补光的明度折算，夜里才暗得下来
    const luminance = (c: THREE.Color) => 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
    const lit = (sky.lightIntensity * luminance(sky.light) * 0.3 + sky.fillIntensity * luminance(sky.fill) * 0.55) * 0.8;
    water.uLight!.value = THREE.MathUtils.clamp(lit, 0.16, 1.15);

    this.leaves.update(still ? 0 : dt, t, 1 - sky.rain);

    for (const slab of this.mist) {
      slab.mesh.position.x = slab.x + Math.sin(t * slab.speed + slab.phase) * 1.6;
      slab.mesh.quaternion.copy(camera.quaternion);
      slab.mesh.material.opacity = sky.mist * slab.weight;
      slab.mesh.material.color.copy(sky.horizon);
      slab.mesh.visible = sky.mist > 0.01;
    }

    this.rain.material.uniforms.uTime!.value = t;
    this.rain.material.uniforms.uAmount!.value = sky.rain;
    this.rain.material.uniforms.uBright!.value = THREE.MathUtils.clamp(sky.horizon.r + sky.horizon.g + sky.horizon.b, 0.5, 2.4) / 2.4;
    this.rain.visible = sky.rain > 0.01;
    this.rain.position.set(camera.position.x, 0, camera.position.z - 4);
  }

  private makeClouds() {
    const material = feltMaterial(COLORS.cloud, { scale: 6, mottle: 0.08, bump: 0.2, sheen: 0 });
    material.fog = false;
    const rand = lcg(11);
    for (let i = 0; i < 7; i++) {
      const group = new THREE.Group();
      const puffs = 3 + Math.floor(rand() * 3);
      for (let j = 0; j < puffs; j++) {
        const middle = 1 - Math.abs(j - (puffs - 1) / 2) / puffs;
        const r = (0.8 + rand() * 0.5) * (0.7 + middle * 0.7);
        const puff = new THREE.Mesh(new THREE.SphereGeometry(r, 20, 14), material);
        puff.position.set((j - (puffs - 1) / 2) * 1.15, r * 0.25, rand() * 0.4);
        puff.scale.set(1, 0.7, 0.6);
        group.add(puff);
      }
      group.position.set(-32 + i * 10 + rand() * 4, 9 + rand() * 6, -30 - rand() * 12);
      group.scale.setScalar(1.2 + rand() * 0.9);
      this.clouds.push({ group, speed: 0.1 + rand() * 0.1 });
      this.scene.add(group);
    }
  }

  /** 雾片：几块大的半透明面，始终朝向镜头，横向慢移。清晨和雨天浓，其余几乎看不见。 */
  private makeMist() {
    const size = 256;
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = size;
    const context = canvas.getContext('2d')!;
    const gradient = context.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
    gradient.addColorStop(0, 'rgba(255,255,255,0.9)');
    gradient.addColorStop(0.5, 'rgba(255,255,255,0.35)');
    gradient.addColorStop(1, 'rgba(255,255,255,0)');
    context.fillStyle = gradient;
    context.fillRect(0, 0, size, size);
    const texture = new THREE.CanvasTexture(canvas);
    const slabs: [number, number, number, number, number][] = [
      [-2.5, 0.35, -2.6, 7, 0.5], [2.2, 0.3, -2.2, 6, 0.45], [0, 0.5, -5, 10, 0.6], [-5, 0.6, -7, 12, 0.6], [5, 0.7, -8, 13, 0.6],
    ];
    slabs.forEach(([x, y, z, width, weight], i) => {
      const mesh = new THREE.Mesh(
        new THREE.PlaneGeometry(width, width * 0.28),
        new THREE.MeshBasicMaterial({ map: texture, transparent: true, opacity: 0, depthWrite: false, fog: false }),
      );
      mesh.position.set(x, y, z);
      mesh.renderOrder = 4;
      this.mist.push({ mesh, x, speed: 0.05 + i * 0.013, phase: i * 1.9, weight });
      this.scene.add(mesh);
    });
  }
}

// ── 程序生成的部分 ───────────────────────────────────────────────────────

function lcg(seed: number) {
  let s = seed;
  return () => ((s = (s * 16807) % 2147483647) / 2147483647);
}

function makeSky() {
  const material = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    fog: false,
    uniforms: {
      uTop: { value: new THREE.Color() },
      uHorizon: { value: new THREE.Color() },
      uGlow: { value: new THREE.Color() },
      uGlowDir: { value: new THREE.Vector3(0, 0, -1) },
    },
    vertexShader: /* glsl */ `
      varying vec3 vDir;
      void main() {
        vDir = normalize(position);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }`,
    fragmentShader: /* glsl */ `
      uniform vec3 uTop; uniform vec3 uHorizon; uniform vec3 uGlow; uniform vec3 uGlowDir;
      varying vec3 vDir;
      void main() {
        vec3 dir = normalize(vDir);
        float h = clamp(dir.y * 1.5 + 0.03, 0.0, 1.0);
        vec3 col = mix(uHorizon, uTop, pow(h, 0.62));
        // 太阳那一侧的地平线多一团暖光
        float toward = max(dot(dir, uGlowDir), 0.0);
        col += uGlow * (pow(toward, 6.0) * 0.55 + pow(toward, 40.0) * 0.9) * (1.0 - h * 0.6);
        gl_FragColor = vec4(col, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
  });
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(95, 32, 16), material);
  mesh.renderOrder = -10;
  mesh.frustumCulled = false;
  return mesh;
}

function makeGround() {
  // 院子是一片略微起伏的草地，远处缓缓抬高接到远山
  const geometry = new THREE.PlaneGeometry(130, 150, 124, 144);
  geometry.rotateX(-Math.PI / 2);
  const position = geometry.attributes.position!;
  for (let i = 0; i < position.count; i++) {
    const x = position.getX(i);
    const z = position.getZ(i) - 20; // 网格整体后移 20 m，这里换回世界坐标
    position.setY(i, groundHeight(x, z));
  }
  geometry.computeVertexNormals();
  const colors = new Float32Array(position.count * 3);
  for (let i = 0; i < position.count; i++) {
    const x = position.getX(i), z = position.getZ(i) - 20;
    const far = THREE.MathUtils.smoothstep(Math.hypot(x * .7, z), 6, 24);
    const tint = new THREE.Color('#ffffff').lerp(new THREE.Color('#94b6ad'), far * .58);
    // 门前、长凳周围轻微磨淡的草，院中仍留完整草地。
    const wear = Math.exp(-((x + 2.35) ** 2 / .8 + (z + .95) ** 2 / .28))
      + .6 * Math.exp(-((x + 3.85) ** 2 / .55 + (z - .25) ** 2 / .3));
    tint.lerp(new THREE.Color('#e5d2a7'), Math.min(.38, wear * .38));
    tint.toArray(colors, i * 3);
  }
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  const ground = new THREE.Mesh(geometry, feltMaterial(COLORS.lawn, { scale: 65, mottle: 0.15, bump: 0.2, patch: COLORS.lawnPatch, sheen: 0, surface: 'ground' }));
  ground.material.vertexColors = true;
  ground.position.z = -20;
  // iOS WebKit 在宽地面上会把定向光阴影贴图的边界画成硬矩形；局部接地阴影单独处理。
  ground.receiveShadow = false;
  return ground;
}

function makeContactShadows() {
  const size = 64;
  const data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const d = Math.hypot((x + .5) / size * 2 - 1, (y + .5) / size * 2 - 1);
    const alpha = Math.round(145 * Math.max(0, 1 - d * d) ** 2);
    const i = (y * size + x) * 4;
    data[i] = 40; data[i + 1] = 59; data[i + 2] = 37; data[i + 3] = alpha;
  }
  const texture = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  texture.needsUpdate = true;
  texture.magFilter = THREE.LinearFilter;
  texture.minFilter = THREE.LinearFilter;
  // 乘色只压暗已有的光照，夜里不会变成一块自发光的绿色。
  const material = new THREE.MeshBasicMaterial({ map: texture, transparent: true, depthWrite: false, blending: THREE.MultiplyBlending, premultipliedAlpha: true });
  const group = new THREE.Group();
  const footprints: [number, number, number, number][] = [
    [ANCHORS.house.x, ANCHORS.house.z, 2.9, 2.1],
    [ANCHORS.tree.x, ANCHORS.tree.z, 2.1, 1.8],
    [ANCHORS.bench.x, ANCHORS.bench.z, 1.7, .85],
    [ANCHORS.bowl.x, ANCHORS.bowl.z, .33, .3],
  ];
  for (const [x, z, width, depth] of footprints) {
    const shadow = new THREE.Mesh(new THREE.PlaneGeometry(width, depth), material);
    shadow.rotation.x = -Math.PI / 2;
    shadow.position.set(x, .012, z);
    shadow.renderOrder = 1;
    group.add(shadow);
  }
  return group;
}

/** 石子路：路网每条边上铺一层浅色路基，上面排一粒粒压扁的石子（iOS 院子的石子路） */
function makePaths() {
  const group = new THREE.Group();
  const bed = feltMaterial(COLORS.pathBed, { scale: 70, mottle: 0.24, sheen: 0, surface: 'ground' });
  // 一条曲线一路铺装；采样节点与导航共用，石块间距按整段弧长统一。
  const runs = PATHS.map(run => ({points: run.nodes.map(id => NODES[id]!), width: run.width}));
  const beds: THREE.BufferGeometry[] = [];
  const rand = lcg(77);
  const stones: THREE.Matrix4[] = [];
  const tints: THREE.Color[] = [];
  for (const { points, width } of runs) {
    const curve = new THREE.CurvePath<THREE.Vector3>();
    for (let i=1; i<points.length; i++) {
      const a=points[i-1]!, b=points[i]!;
      curve.add(new THREE.LineCurve3(new THREE.Vector3(a.x,0,a.z),new THREE.Vector3(b.x,0,b.z)));
    }
    beds.push(ribbon(curve, width, bed).geometry);
    const length = curve.getLength();
    const rows = Math.max(2, Math.round(length / 0.12));
    const across = 2;
    for (let i = 0; i <= rows; i++) {
      const u = i / rows;
      const tangent = curve.getTangentAt(u);
      const side = new THREE.Vector3(-tangent.z, 0, tangent.x).normalize();
      for (let j = 0; j < across; j++) {
        const p = curve.getPointAt(Math.min(1, u + (j ? .045 / length : 0)));
        const offset = ((j + 0.5) / across - 0.5) * width * 0.92 + (rand() - 0.5) * 0.024;
        const r = 0.052 + rand() * 0.014;
        const m = new THREE.Matrix4().compose(
          new THREE.Vector3(p.x + side.x * offset, 0.007 + rand() * .004, p.z + side.z * offset),
          new THREE.Quaternion().setFromEuler(new THREE.Euler((rand() - .5) * .08, -Math.atan2(tangent.z, tangent.x) + (rand() - .5) * .65, 0)),
          new THREE.Vector3(r * (.85 + rand() * .25), 0.014 + rand() * 0.006, width * (.15 + rand() * .065)),
        );
        stones.push(m);
        tints.push(new THREE.Color(COLORS.cobble).offsetHSL((rand() - .5) * .04, (rand() - .5) * .08, (rand() - 0.5) * 0.16));
      }
    }
  }
  const mesh = new THREE.InstancedMesh(new THREE.SphereGeometry(1, 9, 5), feltMaterial('#ffffff', { scale: 80, mottle: 0.22, bump: .24, sheen: 0, surface: 'stone' }), stones.length);
  stones.forEach((m, i) => {
    mesh.setMatrixAt(i, m);
    mesh.setColorAt(i, tints[i]!);
  });
  mesh.receiveShadow = true;
  const pathBed = new THREE.Mesh(mergeGeometries(beds), bed);
  pathBed.receiveShadow = true;
  beds.forEach(geometry => geometry.dispose());
  group.add(pathBed, mesh);
  return group;
}

function ribbon(curve: THREE.Curve<THREE.Vector3>, width: number, material: THREE.Material) {
  const steps = Math.max(12, Math.round(curve.getLength() / 0.06));
  const vertices: number[] = [];
  const indices: number[] = [];
  const closed = curve.getPointAt(0).distanceTo(curve.getPointAt(1)) < .001;
  for (let i = 0; i <= steps; i++) {
    const u = i / steps;
    const p = curve.getPointAt(u);
    const tangent = curve.getTangentAt(u);
    const side = new THREE.Vector3(-tangent.z, 0, tangent.x).normalize().multiplyScalar(width / 2);
    // 两头收圆
    const end = Math.min(u, 1 - u) * curve.getLength();
    const taper = closed ? 1 : Math.sqrt(Math.min(1, end / (width * 0.5)) * 0.9 + 0.1);
    vertices.push(p.x - side.x * taper, 0.005, p.z - side.z * taper, p.x + side.x * taper, 0.005, p.z + side.z * taper);
    if (i < steps) {
      const a = i * 2;
      indices.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  const mesh = new THREE.Mesh(geometry, material);
  mesh.receiveShadow = true;
  return mesh;
}

function pondCurve() {
  return new THREE.CatmullRomCurve3(POND.map((p) => new THREE.Vector3(p.x, 0, p.z)), true, 'centripetal');
}

/**
 * 水面：颜色跟着天走；几道缓慢漂移的白线（iOS 池塘上缝的那几针）；
 * 雨量控制涟漪环的多少，晴天只偶尔冒一两圈。
 */
function makeWater() {
  const outline = pondCurve().getPoints(72);
  const center = outline.reduce((sum, p) => sum.add(p), new THREE.Vector3()).multiplyScalar(1 / outline.length);
  const vertices = [center.x, 0, center.z];
  const depths = [1];
  const indices: number[] = [];
  for (let i = 0; i < outline.length - 1; i++) {
    const p = outline[i]!; vertices.push(p.x, 0, p.z); depths.push(0);
    indices.push(0, (i + 1) % (outline.length - 1) + 1, i + 1);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
  geometry.setAttribute('depth', new THREE.Float32BufferAttribute(depths, 1));
  geometry.setIndex(indices); geometry.computeVertexNormals();
  const material = new THREE.ShaderMaterial({
    fog: true,
    uniforms: {
      ...THREE.UniformsUtils.clone(THREE.UniformsLib.fog),
      uTime: { value: 0 },
      uRain: { value: 0 },
      uSky: { value: new THREE.Color('#70bee4') },
      uLight: { value: 1 },
      uBase: { value: new THREE.Color('#518e9a') },
    },
    vertexShader: /* glsl */ `
      #include <fog_pars_vertex>
      varying vec3 vWorld;
      attribute float depth; varying float vDepth;
      void main() {
        vDepth = depth;
        vec4 world = modelMatrix * vec4(position, 1.0);
        vWorld = world.xyz;
        vec4 mvPosition = viewMatrix * world;
        gl_Position = projectionMatrix * mvPosition;
        #include <fog_vertex>
      }`,
    fragmentShader: /* glsl */ `
      #include <common>
      #include <fog_pars_fragment>
      uniform float uTime; uniform float uRain; uniform vec3 uSky; uniform float uLight; uniform vec3 uBase;
      varying vec3 vWorld; varying float vDepth;
      float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
      // 一格一个涟漪：格子里随机位置、随机相位，环向外扩、淡出
      float ripples(vec2 p, float density, float amount) {
        vec2 cell = floor(p * density);
        float sum = 0.0;
        for (int y = -1; y <= 1; y++) for (int x = -1; x <= 1; x++) {
          vec2 c = cell + vec2(float(x), float(y));
          float seed = hash(c);
          if (seed > amount) continue;
          vec2 center = (c + 0.2 + 0.6 * vec2(hash(c + 3.1), hash(c + 7.7))) / density;
          float life = fract(uTime * (0.35 + seed * 0.3) + seed * 9.0);
          float radius = life * 0.75 / density;
          float d = abs(length(p - center) - radius);
          sum += smoothstep(0.012, 0.0, d) * (1.0 - life) * (1.0 - life);
        }
        return sum;
      }
      void main() {
        vec2 p = vWorld.xz;
        float shore = 1.0 - smoothstep(0.0, 0.27, vDepth);
        vec3 base = mix(uBase, vec3(0.28, 0.43, 0.32), shore * .55);
        vec3 col = mix(base, uSky, 0.20 + (1.0 - shore) * .10) * uLight;
        col *= .94 + .06 * sin(p.x * 2.0 + sin(p.y * 2.7 + uTime * .12));
        // 缝线一样的波纹：几道断续的细白线慢慢横移
        float band = sin(p.y * 22.0 + sin(p.x * 3.0 + uTime * 0.35) * 1.6);
        float dash = smoothstep(0.35, 0.65, sin(p.x * 9.0 + p.y * 4.0 - uTime * 0.25 + band));
        float thread = smoothstep(0.965, 1.0, band) * dash;
        col += vec3(0.85) * thread * 0.18 * uLight;
        float rings = ripples(p, 2.6, 0.06 + uRain * 0.48) + ripples(p + 3.7, 4.3, uRain * 0.32);
        col += vec3(0.9) * rings * (0.16 + 0.25 * uLight);
        gl_FragColor = vec4(col, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
        #include <fog_fragment>
      }`,
  });
  const water = new THREE.Mesh(geometry, material);
  water.position.y = 0.012;
  return water;
}

function makeStones() {
  const curve = pondCurve();
  const count = 36;
  const mesh = new THREE.InstancedMesh(new THREE.SphereGeometry(1, 14, 10), feltMaterial('#ffffff', { scale: 58, mottle: 0.12, bump: 0.2, sheen: 0 }), count);
  const rand = lcg(5);
  const m = new THREE.Matrix4();
  for (let i = 0; i < count; i++) {
    const u = (i + .22 * Math.sin(i * 1.9)) / count;
    const p = curve.getPointAt(u);
    const big = i % 7 < 2;
    const r = big ? .09 + rand() * .02 : .035 + rand() * .035;
    m.compose(new THREE.Vector3(p.x, r * .27, p.z), new THREE.Quaternion().setFromEuler(new THREE.Euler(.08, rand() * 6, .1)), new THREE.Vector3(r * 1.28, r * .7, r));
    // 留出前爪探水的小口，避免伸爪路径被岸石挡住。
    if (Math.hypot(p.x-POND_TOUCH.x,p.z-POND_TOUCH.z)<.19) m.scale(new THREE.Vector3(0,0,0));
    mesh.setMatrixAt(i, m);
    mesh.setColorAt(i, new THREE.Color(COLORS.stone).offsetHSL((rand() - .5) * .02, 0, (rand() - .5) * .08));
  }
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

/** 岸生叶集中在两段池岸，留出前岸的喝水位置。 */
function makeShorePlants() {
  const curve = pondCurve();
  const parts: THREE.BufferGeometry[] = [];
  const rand = lcg(87);
  for (const u of [.12, .66]) {
    const root = curve.getPointAt(u);
    for (let i = 0; i < 14; i++) {
      const leaf = new THREE.PlaneGeometry(.018, .11 + rand() * .08, 1, 3);
      leaf.translate(0, .08, 0);
      leaf.rotateX((rand() - .5) * .9); leaf.rotateY(rand() * Math.PI * 2);
      leaf.translate(root.x + (rand() - .5) * .10, .01, root.z + (rand() - .5) * .10);
      parts.push(leaf);
    }
  }
  const geometry = mergeGeometries(parts); parts.forEach(p => p.dispose());
  const material = new THREE.MeshLambertMaterial({ color: '#6d8956', side: THREE.DoubleSide });
  const mesh = new THREE.Mesh(geometry, material); mesh.receiveShadow = true;
  return mesh;
}

function makeLilyPads() {
  const box = new THREE.Box2().setFromPoints(POND.map((p) => new THREE.Vector2(p.x, p.z)));
  const center = box.getCenter(new THREE.Vector2());
  const size = box.getSize(new THREE.Vector2());
  const group = new THREE.Group();
  const material = feltMaterial(COLORS.pad, { scale: 80 });
  const spots: [number, number, number][] = [[-0.22, -0.1, 0.11], [0.05, 0.12, 0.085], [0.24, -0.05, 0.12], [-0.05, -0.2, 0.07], [0.3, 0.2, 0.06]];
  spots.forEach(([x, z, r], i) => {
    const pad = new THREE.Mesh(new THREE.CircleGeometry(r, 24, 0.35, Math.PI * 2 - 0.7), material);
    pad.rotation.x = -Math.PI / 2;
    pad.rotation.z = i * 1.7;
    pad.position.set(center.x + x * size.x, 0.02, center.y + z * size.y);
    pad.receiveShadow = true;
    group.add(pad);
  });
  return group;
}

/**
 * 草：一片叶子是一条收尖的弯面片，实例化。随风摆在顶点着色器里算，CPU 不逐片更新。
 * 草丛那一处密、高，前后夹住团子；院子前沿一排给全景当近景；其余零星矮草。
 */
function makeGrass(uniforms: { uTime: { value: number }; uWind: { value: number } }, ratio = 1) {
  const blade = new THREE.PlaneGeometry(0.012, 1, 1, 4);
  blade.translate(0, 0.5, 0);
  const position = blade.attributes.position!;
  for (let i = 0; i < position.count; i++) {
    const y = position.getY(i);
    position.setX(i, position.getX(i) * (1 - y * y * 0.92));
    position.setZ(i, y * y * 0.09);
  }
  blade.computeVertexNormals();

  const rand = lcg(23);
  const matrices: THREE.Matrix4[] = [];
  const tints: THREE.Color[] = [];
  const add = (x: number, z: number, height: number, width = 1) => {
    matrices.push(new THREE.Matrix4().compose(
      new THREE.Vector3(x, groundHeight(x, z), z),
      new THREE.Quaternion().setFromEuler(new THREE.Euler((rand() - 0.5) * 0.25, rand() * 6.28, 0)),
      new THREE.Vector3(width * (0.8 + rand() * 0.6), height, height),
    ));
    tints.push(new THREE.Color(COLORS.blade).offsetHSL((rand() - 0.5) * 0.045, 0, (rand() - 0.5) * 0.13));
  };
  const clump = ANCHORS.grass;
  for (let i = 0; i < 2600; i++) {
    const a = rand() * Math.PI * 2;
    const r = Math.sqrt(rand()) * 0.46;
    const z = clump.z + Math.sin(a) * r * 0.6;
    // 中间留一条缝，团子站在 d3-1 时身子露一半
    if (Math.abs(z - NODES['d3-1']!.z) < 0.06) continue;
    add(clump.x + Math.cos(a) * r, z, 0.17 + rand() * 0.17 * (1 - r), 1.1);
  }
  // 放在所有章节机位的前面（最靠前的机位 z≈2.4），只给首屏和结尾的全景当近景
  for (let i = 0; i < 1900; i++) {
    const x = -6 + rand() * 12;
    if (Math.abs(x) < 2.2 && rand() < .86) continue;
    add(x, 4.3 + rand() * 0.8 + Math.abs(x) * 0.025, 0.035 + rand() * 0.065, 1.0);
  }
  // 院子里零星的矮草，避开路和池塘
  const pond = POND.map((p) => new THREE.Vector2(p.x, p.z));
  const paths = EDGES.map(edge => [NODES[edge.a]!, NODES[edge.b]!] as const);
  const nearPath = (x: number, z: number) => paths.some(([a, b]) => {
    const dx = b.x - a.x, dz = b.z - a.z;
    const t = THREE.MathUtils.clamp(((x - a.x) * dx + (z - a.z) * dz) / (dx * dx + dz * dz || 1), 0, 1);
    return Math.hypot(x - a.x - dx * t, z - a.z - dz * t) < .22;
  });
  for (let i = 0; i < 9000; i++) {
    const x = -9 + rand() * 18;
    const z = -6 + rand() * 11.8;
    // 越往外越稀，边缘自然散开，不出现一块矩形的"草毯"
    const falloff = Math.hypot(x / 8.5, (z + 0.25) / 5.6);
    if (rand() < falloff * falloff) continue;
    if (nearPath(x, z)) continue;
    if (insidePolygon(x, z, pond, 0.12)) continue;
    // 院中只留低矮草叶，中央空地与猫的轮廓都能读清。
    // 同一个根部出几根细叶，疏密成簇，不再均匀撒白色三角纸屑。
    const height = 0.025 + rand() * 0.035;
    for (let j = 0; j < 3; j++) add(x + (rand() - .5) * .035, z + (rand() - .5) * .035, height * (.65 + rand() * .55), .7 + rand() * .5);
  }

  // 草叶片数多、近景重叠多，用最便宜的漫反射材质
  const material = new THREE.MeshLambertMaterial({ color: '#ffffff', side: THREE.DoubleSide });
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = uniforms.uTime;
    shader.uniforms.uWind = uniforms.uWind;
    shader.uniforms.uTip = { value: new THREE.Color(COLORS.bladeTip) };
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nuniform float uTime; uniform float uWind; varying float vBlade;')
      // 草叶是竖着的薄片，按真实法线算几乎吃不到天光，会比草地黑一截；法线一律朝上，和草地同样受光
      .replace('#include <beginnormal_vertex>', 'vec3 objectNormal = vec3(0.0, 1.0, 0.0);')
      .replace(
        '#include <begin_vertex>',
        /* glsl */ `#include <begin_vertex>
        vBlade = position.y;
        vec3 bladeRoot = (instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
        float gust = sin(uTime * 1.3 + bladeRoot.x * 1.7 + bladeRoot.z * 1.3) + 0.5 * sin(uTime * 2.9 + bladeRoot.x * 4.1);
        transformed.x += gust * 0.028 * uWind * position.y * position.y;`,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform vec3 uTip; varying float vBlade;')
      .replace('#include <color_fragment>', '#include <color_fragment>\ndiffuseColor.rgb = mix(diffuseColor.rgb, uTip, vBlade * vBlade * .36);')
      // 背面不翻法线，两面受光一致
      .replace('#include <normal_fragment_begin>', '#include <normal_fragment_begin>\nnormal = normalize(vNormal);');
  };
  // 取原有草叶的确定性子集，减半时不重新随机摆放，以便单变量对照。
  const selected = matrices.map((_, index) => index).filter(index => ratio >= 1 || index % 2 === 0);
  const mesh = new THREE.InstancedMesh(blade, material, selected.length);
  selected.forEach((source, index) => {
    mesh.setMatrixAt(index, matrices[source]!);
    mesh.setColorAt(index, tints[source]!);
  });
  mesh.receiveShadow = true;
  mesh.frustumCulled = false;
  return mesh;
}

function insidePolygon(x: number, z: number, polygon: THREE.Vector2[], margin: number) {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i]!;
    const b = polygon[j]!;
    if (a.y > z !== b.y > z && x < ((b.x - a.x) * (z - a.y)) / (b.y - a.y) + a.x) inside = !inside;
    if (Math.hypot(a.x - x, a.y - z) < margin) return true;
  }
  return inside;
}

/** 远山三层（近的黄绿、远的青绿），山脚一条深绿的树线。空气透视交给雾。 */
function makeHills() {
  const group = new THREE.Group();
  const layers: { color: string; hills: [number, number, number, number][] }[] = [
    { color: COLORS.hillNear, hills: [[-15, -36, 13, 4.4], [19, -37, 12, 4.0]] },
    { color: COLORS.hillMid, hills: [[2, -48, 18, 6.2], [-33, -50, 16, 6.6], [36, -52, 18, 7.0]] },
    { color: COLORS.hillFar, hills: [[-8, -64, 24, 8.8], [26, -67, 26, 9.5], [-44, -67, 22, 9]] },
  ];
  for (const { color, hills } of layers) {
    const material = feltMaterial(color, { scale: 3, mottle: 0.1, bump: 0.12, sheen: 0 });
    for (const [x, z, radius, height] of hills) {
      const hill = new THREE.Mesh(new THREE.SphereGeometry(1, 40, 16, 0, Math.PI * 2, 0, Math.PI / 2), material);
      hill.scale.set(radius, height, radius * 0.7);
      hill.position.set(x, groundHeight(x, z) - .15, z);
      group.add(hill);
    }
  }
  const rand = lcg(41);
  const count = 72;
  const round = new THREE.InstancedMesh(new THREE.SphereGeometry(1, 18, 12), feltMaterial('#ffffff', { scale: 4, mottle: 0.12, bump: 0.15, sheen: 0 }), count);
  const pine = new THREE.InstancedMesh(new THREE.ConeGeometry(1, 2.6, 8), feltMaterial('#ffffff', { scale: 4, mottle: 0.12, bump: 0.15, sheen: 0 }), 34);
  const m = new THREE.Matrix4();
  for (let i = 0; i < count; i++) {
    const r = 0.55 + rand() * 0.75;
    const cluster = [-31, -24, 23, 32][i % 4]!;
    const x = cluster + (rand() - .5) * 7;
    const z = -22 - rand() * 8;
    m.compose(new THREE.Vector3(x, groundHeight(x, z) + r * .72, z), new THREE.Quaternion(), new THREE.Vector3(r, r * 1.2, r));
    round.setMatrixAt(i, m);
    round.setColorAt(i, new THREE.Color(i % 4 === 0 ? '#809563' : COLORS.treeline).offsetHSL((rand() - 0.5) * 0.04, 0, (rand() - 0.4) * 0.12));
  }
  for (let i = 0; i < 34; i++) {
    const r = 0.7 + rand() * 0.5;
    const x = (i % 2 ? -1 : 1) * (22 + rand() * 18), z = -29 - rand() * 6;
    m.compose(new THREE.Vector3(x, groundHeight(x, z) + r * 1.4, z), new THREE.Quaternion(), new THREE.Vector3(r, r * 1.3, r));
    pine.setMatrixAt(i, m);
    pine.setColorAt(i, new THREE.Color('#456b60').offsetHSL(0, 0, (rand() - 0.5) * 0.08));
  }
  group.add(round, pine);

  // 院子外的草地上散几丛灌木和小花，免得中景一片空
  const bushes = new THREE.InstancedMesh(new THREE.SphereGeometry(1, 16, 12), feltMaterial('#ffffff', { scale: 30, mottle: 0.16, sheen: 0 }), 46);
  const flowers = new THREE.InstancedMesh(new THREE.SphereGeometry(1, 8, 6), feltMaterial('#ffffff', { scale: 80, sheen: 0 }), 160);
  for (let i = 0; i < 46; i++) {
    const a = rand() * Math.PI * 2;
    const d = 5.2 + rand() * 7;
    const x = Math.cos(a) * d * 1.3;
    const z = -1.5 - Math.abs(Math.sin(a)) * d;
    const r = 0.18 + rand() * 0.3;
    m.compose(new THREE.Vector3(x, groundHeight(x, z) + r * 0.5, z), new THREE.Quaternion(), new THREE.Vector3(r * 1.3, r, r));
    bushes.setMatrixAt(i, m);
    bushes.setColorAt(i, new THREE.Color(i % 3 ? '#718a56' : '#4e7054').offsetHSL(0, 0, (rand() - 0.5) * 0.08));
  }
  for (let i = 0; i < 160; i++) {
    const x = -8 + rand() * 16;
    const z = -7 + rand() * 9.5;
    const r = 0.014 + rand() * 0.012;
    m.compose(new THREE.Vector3(x, groundHeight(x, z) + 0.03 + rand() * 0.03, z), new THREE.Quaternion(), new THREE.Vector3(r, r * 0.6, r));
    flowers.setMatrixAt(i, m);
    flowers.setColorAt(i, new THREE.Color(['#f7f3e8', '#f0c23b', '#f2a7b5'][i % 3]!));
  }
  bushes.castShadow = true;
  bushes.receiveShadow = true;
  group.add(bushes, flowers);
  return group;
}

function makeDisc(color: string, size: number) {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 256;
  const context = canvas.getContext('2d')!;
  const gradient = context.createRadialGradient(128, 128, 0, 128, 128, 128);
  gradient.addColorStop(0, 'rgba(255,255,255,1)');
  gradient.addColorStop(0.3, 'rgba(255,255,255,1)');
  gradient.addColorStop(0.34, 'rgba(255,255,255,0.35)');
  gradient.addColorStop(1, 'rgba(255,255,255,0)');
  context.fillStyle = gradient;
  context.fillRect(0, 0, 256, 256);
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(canvas), color, transparent: true, opacity: 0, fog: false, depthWrite: false, toneMapped: false }));
  sprite.scale.setScalar(size);
  sprite.renderOrder = -8;
  return sprite;
}

function makeStars() {
  const count = 420;
  const positions = new Float32Array(count * 3);
  const seeds = new Float32Array(count);
  const rand = lcg(3);
  for (let i = 0; i < count; i++) {
    const azimuth = rand() * Math.PI * 2;
    const elevation = 0.1 + rand() * 1.35;
    positions.set([Math.cos(azimuth) * Math.cos(elevation) * 85, Math.sin(elevation) * 85, Math.sin(azimuth) * Math.cos(elevation) * 85], i * 3);
    seeds[i] = rand();
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('aSeed', new THREE.BufferAttribute(seeds, 1));
  const material = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    uniforms: { uOpacity: { value: 0 }, uTime: { value: 0 }, uPixel: { value: Math.min(devicePixelRatio, 2) } },
    vertexShader: /* glsl */ `
      attribute float aSeed; uniform float uTime; uniform float uPixel; varying float vAlpha;
      void main() {
        vAlpha = 0.55 + 0.45 * sin(uTime * (0.6 + aSeed * 1.8) + aSeed * 40.0);
        gl_PointSize = (1.4 + aSeed * aSeed * 3.2) * uPixel;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }`,
    fragmentShader: /* glsl */ `
      uniform float uOpacity; varying float vAlpha;
      void main() {
        float d = length(gl_PointCoord - 0.5);
        gl_FragColor = vec4(vec3(1.0, 0.96, 0.84) * 1.4, smoothstep(0.5, 0.1, d) * vAlpha * uOpacity);
      }`,
  });
  const stars = new THREE.Points(geometry, material);
  stars.renderOrder = -9;
  stars.frustumCulled = false;
  return stars;
}

/**
 * 雨：线段粒子，位置全在着色器里按时间算，CPU 每帧只改 uTime（Temple Night 的做法）。
 * 和它不同的两处：uAmount 控制可见条数与不透明度（3 秒起落用）；正常混合的浅灰线，亮天空下也看得见。
 */
function makeRain() {
  const count = 1400;
  const position = new Float32Array(count * 6);
  const top = new Float32Array(count * 2);
  const speed = new Float32Array(count * 2);
  const length = new Float32Array(count * 2);
  const rank = new Float32Array(count * 2);
  for (let i = 0; i < count; i++) {
    const x = (Math.random() - 0.5) * 16;
    const y = Math.random() * 7;
    const z = (Math.random() - 0.5) * 12;
    position.set([x, y, z, x, y, z], i * 6);
    top.set([0, 1], i * 2);
    const s = 5 + Math.random() * 4;
    speed.set([s, s], i * 2);
    const l = 0.075 + Math.random() * 0.12;
    length.set([l, l], i * 2);
    const r = Math.random();
    rank.set([r, r], i * 2);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(position, 3));
  geometry.setAttribute('aTop', new THREE.BufferAttribute(top, 1));
  geometry.setAttribute('aSpeed', new THREE.BufferAttribute(speed, 1));
  geometry.setAttribute('aLength', new THREE.BufferAttribute(length, 1));
  geometry.setAttribute('aRank', new THREE.BufferAttribute(rank, 1));
  const material = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    uniforms: { uTime: { value: 0 }, uAmount: { value: 0 }, uBright: { value: 1 } },
    vertexShader: /* glsl */ `
      attribute float aTop; attribute float aSpeed; attribute float aLength; attribute float aRank;
      uniform float uTime; uniform float uAmount;
      varying float vAlpha;
      void main() {
        vec3 p = position;
        float y = mod(p.y - uTime * aSpeed, 7.0);
        p.y = y + aTop * aLength;
        p.x += (y + aTop * aLength) * 0.10;   // 一点风的斜度
        vAlpha = smoothstep(0.0, 0.6, y) * smoothstep(7.0, 5.5, y) * step(aRank, uAmount) * uAmount;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
      }`,
    fragmentShader: /* glsl */ `
      uniform float uBright;
      varying float vAlpha;
      void main() {
        vec3 col = mix(vec3(0.62, 0.70, 0.80), vec3(0.93, 0.95, 0.97), uBright);
        gl_FragColor = vec4(col, vAlpha * 0.24);
      }`,
  });
  const rain = new THREE.LineSegments(geometry, material);
  rain.frustumCulled = false;
  rain.renderOrder = 6;
  return rain;
}

/** 落叶：只在大树下方，几十片以内；两个轴同时转所以会翻面，左右按正弦飘。雨天不落。 */
class Leaves {
  readonly mesh: THREE.InstancedMesh;
  private state: { x: number; y: number; z: number; fall: number; sway: number; phase: number; amplitude: number; spin: number; roll: number; tilt: number; rollSpeed: number; size: number; wait: number }[] = [];
  private dummy = new THREE.Object3D();

  constructor() {
    const geometry = new THREE.CircleGeometry(0.03, 6);
    geometry.scale(1, 0.62, 1);
    const material = new THREE.MeshStandardMaterial({ color: '#ffffff', roughness: 1, side: THREE.DoubleSide });
    const count = 26;
    this.mesh = new THREE.InstancedMesh(geometry, material, count);
    this.mesh.frustumCulled = false;
    const rand = lcg(91);
    for (let i = 0; i < count; i++) {
      this.state.push({ x: 0, y: -1, z: 0, fall: 0.18 + rand() * 0.2, sway: 0.6 + rand() * 1.2, phase: rand() * 6.28, amplitude: 0.08 + rand() * 0.16, spin: (rand() - 0.5) * 2.4, roll: rand() * 6, tilt: rand() * 6, rollSpeed: 0.6 + rand() * 1.8, size: 0.7 + rand() * 0.7, wait: rand() * 22 });
      this.mesh.setColorAt(i, new THREE.Color(i % 3 ? COLORS.leaf : '#8dbf3f').offsetHSL((rand() - 0.5) * 0.04, 0, (rand() - 0.5) * 0.1));
    }
  }

  update(dt: number, t: number, amount: number) {
    const tree = ANCHORS.tree;
    this.state.forEach((leaf, i) => {
      if (leaf.y <= 0.01) {
        // 落地以后歇一会儿再从树冠里出来；雨天不再出来
        leaf.wait -= dt;
        if (leaf.wait <= 0 && amount > 0.5) {
          const a = Math.random() * Math.PI * 2;
          const r = Math.sqrt(Math.random()) * 0.85;
          leaf.x = tree.x + Math.cos(a) * r;
          leaf.z = tree.z + Math.sin(a) * r * 0.8;
          leaf.y = 1.5 + Math.random() * 0.5;
          leaf.wait = 6 + Math.random() * 26;
        }
      } else {
        leaf.y -= leaf.fall * dt;
        leaf.roll += leaf.rollSpeed * dt;
        leaf.tilt += leaf.spin * dt;
      }
      const sway = Math.sin(t * leaf.sway + leaf.phase);
      const airborne = leaf.y > 0.01;
      this.dummy.position.set(leaf.x + (airborne ? sway * leaf.amplitude : 0), Math.max(leaf.y, 0.012), leaf.z + (airborne ? Math.cos(t * leaf.sway * 0.7 + leaf.phase) * leaf.amplitude * 0.6 : 0));
      if (airborne) this.dummy.rotation.set(leaf.roll, leaf.tilt, sway * 0.55);
      else this.dummy.rotation.set(-Math.PI / 2, 0, leaf.phase);
      // 还没落过的叶子（初始 y = -1）先藏起来
      this.dummy.scale.setScalar(leaf.y < -0.5 ? 0 : leaf.size);
      this.dummy.updateMatrix();
      this.mesh.setMatrixAt(i, this.dummy.matrix);
    });
    this.mesh.instanceMatrix.needsUpdate = true;
  }
}
