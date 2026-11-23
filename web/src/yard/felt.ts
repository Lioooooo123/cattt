import * as THREE from 'three';

/**
 * 毛毡质感：完全哑光 + 一点绒光（sheen），表面按世界坐标叠一层纤维起伏。
 * 起始值取 3dviz-pro-max 的 style-felt-wool：roughness 1、sheen 0.6、sheenRoughness 0.8、暖白绒光。
 * 起伏用三维噪声按世界坐标算，不依赖 UV：Blender 出来的物件、程序生成的地形和实例化的石头都能用同一套。
 *
 * 开销：每个像素两次噪声（大块色差再加一次），法线起伏用同一份噪声的屏幕导数，不另外采样。
 * 第一版每像素七次噪声 + 全部带绒光，1440×900 下首屏一帧 41ms，压不进帧率判据，所以收成现在这样；
 * 铺满屏幕的大面（草地、远山、云）不带绒光（sheen: 0，走更便宜的标准材质），绒光只留给物件。
 */
export interface FeltOptions {
  /** 纤维颗粒的密度（每米多少个起伏周期） */
  scale?: number;
  /** 颜色深浅起伏的幅度，0–1 */
  mottle?: number;
  /** 法线起伏的幅度 */
  bump?: number;
  /** 大块的色差（草地用）：在 color 和这个颜色之间缓慢过渡 */
  patch?: THREE.ColorRepresentation;
  /** 绒光强度；0 = 不要绒光 */
  sheen?: number;
  /** 保留柔软造型，但木、石与灰泥不能都像同一块绒布。 */
  surface?: 'felt' | 'wood' | 'stone' | 'plaster' | 'ground' | 'cap';
}

const NOISE = /* glsl */ `
  float feltHash(vec3 p) {
    p = fract(p * 0.3183099 + 0.1);
    p *= 17.0;
    return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
  }
  float feltNoise(vec3 x) {
    vec3 i = floor(x);
    vec3 f = fract(x);
    f = f * f * (3.0 - 2.0 * f);
    return mix(
      mix(mix(feltHash(i), feltHash(i + vec3(1, 0, 0)), f.x), mix(feltHash(i + vec3(0, 1, 0)), feltHash(i + vec3(1, 1, 0)), f.x), f.y),
      mix(mix(feltHash(i + vec3(0, 0, 1)), feltHash(i + vec3(1, 0, 1)), f.x), mix(feltHash(i + vec3(0, 1, 1)), feltHash(i + vec3(1, 1, 1)), f.x), f.y),
      f.z);
  }
`;

export function feltMaterial(color: THREE.ColorRepresentation, options: FeltOptions = {}) {
  const { scale = 90, mottle = 0.16, bump = 0.32, patch, sheen = 0.5, surface = 'felt' } = options;
  const material =
    sheen > 0
      ? new THREE.MeshPhysicalMaterial({ color, roughness: 1, metalness: 0, sheen, sheenRoughness: 0.8, sheenColor: new THREE.Color('#ffe6cf') })
      : new THREE.MeshStandardMaterial({ color, roughness: 1, metalness: 0 });
  const patchColor = new THREE.Color(patch ?? color);
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uFeltScale = { value: scale };
    shader.uniforms.uFeltMottle = { value: mottle };
    shader.uniforms.uFeltBump = { value: bump };
    shader.uniforms.uFeltPatch = { value: patchColor };
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vFeltPos;')
      .replace(
        '#include <project_vertex>',
        /* glsl */ `#include <project_vertex>
        vec4 feltWorld = vec4(transformed, 1.0);
        #ifdef USE_INSTANCING
          feltWorld = instanceMatrix * feltWorld;
        #endif
        vFeltPos = (modelMatrix * feltWorld).xyz;`,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
        varying vec3 vFeltPos;
        uniform float uFeltScale; uniform float uFeltMottle; uniform float uFeltBump; uniform vec3 uFeltPatch;
        float feltFine;
        ${NOISE}`,
      )
      .replace(
        '#include <color_fragment>',
        /* glsl */ `#include <color_fragment>
        vec3 feltP = vFeltPos * uFeltScale;
        feltFine = feltNoise(feltP) * 0.6 + feltNoise(feltP * 2.7) * 0.4;
        ${patch ? 'diffuseColor.rgb = mix(diffuseColor.rgb, uFeltPatch, smoothstep(0.25, 0.8, feltNoise(vFeltPos * 1.3 + 7.0)) * 0.8);' : ''}
        ${surface === 'wood' ? `
          // 顺着木件长轴拉开的纹理；低频弯曲打散重复条带。
          float grain = feltNoise(vFeltPos * vec3(28.0, 2.2, 28.0) + feltNoise(vFeltPos * 3.0) * 2.0);
          diffuseColor.rgb *= mix(0.72, 1.12, grain);
          feltFine = mix(feltFine, grain, 0.45);` : ''}
        ${surface === 'stone' || surface === 'plaster' ? `
          float mineral = feltNoise(vFeltPos * ${surface === 'stone' ? '13.0' : '5.0'});
          diffuseColor.rgb *= mix(0.8, 1.08, mineral);
          feltFine = mix(feltFine, mineral, 0.3);` : ''}
        ${surface === 'ground' ? `
          // 米级斑驳与细纤维分开：避免草坪读成一整块均匀地毯。
          float meadow = feltNoise(vFeltPos * 0.72) * 0.65 + feltNoise(vFeltPos * 3.6) * 0.35;
          diffuseColor.rgb *= mix(0.76, 1.12, meadow);
          diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * vec3(1.12, 0.96, 0.73), smoothstep(0.56, 0.8, meadow) * 0.48);` : ''}
        ${surface === 'cap' ? `
          // 伞盖保留柔软造型，但大色斑和细腻表皮不再像草坪的绒毛。
          float skin = feltNoise(vFeltPos * vec3(3.2, 1.5, 3.2));
          diffuseColor.rgb *= mix(0.88, 1.08, skin);
          feltFine = mix(feltFine, skin, 0.35);` : ''}
        diffuseColor.rgb *= 1.0 - uFeltMottle * 0.5 + uFeltMottle * feltFine;`,
      )
      .replace(
        '#include <normal_fragment_maps>',
        /* glsl */ `#include <normal_fragment_maps>
        // 用同一份噪声的屏幕导数推一下法线：远处导数大，限幅免得闪
        vec2 feltSlope = clamp(vec2(dFdx(feltFine), dFdy(feltFine)) * 5.0, -0.5, 0.5);
        normal = normalize(normal + vec3(feltSlope, 0.0) * uFeltBump);`,
      );
  };
  // 同一个类、不同选项要编译成不同程序
  material.customProgramCacheKey = () => `felt-${sheen > 0 ? 's' : 'n'}-${patch ? 'p' : 'n'}-${surface}`;
  return material;
}

/** 把 glb 里的普通材质换成毛毡（按材质缓存，同名只建一次）。发光的窗和水面不换。 */
export function feltify(root: THREE.Object3D, skip: string[]) {
  const cache = new Map<THREE.Material, THREE.Material>();
  root.traverse((object) => {
    const mesh = object as THREE.Mesh;
    if (!mesh.isMesh) return;
    const source = mesh.material as THREE.MeshStandardMaterial;
    if (skip.includes(source.name)) return;
    let felt = cache.get(source);
    if (!felt) {
      const rope = source.name.startsWith('rope');
      const name = source.name;
      const options: FeltOptions = rope ? { scale: 65, bump: .38, mottle: .14 }
        : name === 'cap' ? { scale: 130, bump: .07, mottle: .055, sheen: 0, surface: 'cap' }
        : name.startsWith('wood') ? { scale: 120, bump: .2, mottle: .10, sheen: 0, surface: 'wood' }
        : name.startsWith('stone') ? { scale: 48, bump: .28, mottle: .18, sheen: 0, surface: 'stone' }
        : ['cream', 'gill', 'spot'].includes(name) ? { scale: 95, bump: .1, mottle: .06, sheen: 0, surface: 'plaster' }
        : name.startsWith('bowl') ? { scale: 140, bump: .035, mottle: .025, sheen: 0 }
        : name.startsWith('leaf') ? { scale: 80, bump: .22, mottle: .10, sheen: .25 }
        : { scale: 105, bump: .24, mottle: .10, sheen: .4 };
      felt = feltMaterial(source.color, options);
      if (name === 'cap') felt.roughness = .76;
      if (name.startsWith('bowl')) {
        // 釉陶保留柔和高光，与绳窝和布垫分开。
        (felt as THREE.MeshStandardMaterial).roughness = .34;
        if (felt instanceof THREE.MeshPhysicalMaterial) felt.sheen = 0;
      }
      felt.name = source.name;
      felt.side = source.side;
      cache.set(source, felt);
    }
    mesh.material = felt;
  });
}
