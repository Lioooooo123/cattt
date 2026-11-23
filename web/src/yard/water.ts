import * as THREE from 'three';
import { POND } from './layout.ts';

/** 单层水面：浅岸透色、随视角变化的天光和微波法线；不增加反射渲染通道。 */
export function makeWater() {
  const outline = new THREE.CatmullRomCurve3(POND.map(p => new THREE.Vector3(p.x, 0, p.z)), true, 'centripetal').getPoints(72);
  const center = outline.reduce((sum, p) => sum.add(p), new THREE.Vector3()).multiplyScalar(1 / outline.length);
  const vertices = [center.x, 0, center.z], depths = [1], indices: number[] = [];
  for (let i = 0; i < outline.length - 1; i++) {
    const p = outline[i]!;
    vertices.push(p.x, 0, p.z); depths.push(0);
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
      uTime: { value: 0 }, uRain: { value: 0 },
      uSky: { value: new THREE.Color('#70bee4') }, uLight: { value: 1 },
      uBase: { value: new THREE.Color('#396e72') },
      uSunDirection: { value: new THREE.Vector3(0, 1, 0) },
      uSunColor: { value: new THREE.Color('#fff0da') }, uSunStrength: { value: 0 },
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
      uniform vec3 uSunDirection; uniform vec3 uSunColor; uniform float uSunStrength;
      varying vec3 vWorld; varying float vDepth;
      float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
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
          float aa = max(fwidth(d), 0.002);
          sum += (1.0 - smoothstep(0.003, 0.006 + aa, d)) * (1.0 - life) * (1.0 - life);
        }
        return sum;
      }
      void main() {
        vec2 p = vWorld.xz;
        float shore = 1.0 - smoothstep(0.0, 0.3, vDepth);
        // 岸边偏暖、中心更深；不把整面池水涂成同一层蓝漆。
        float night = 1.0 - smoothstep(0.18, 0.65, uLight);
        vec3 deep = mix(uBase, vec3(0.08, 0.23, 0.28), night * 0.65);
        vec3 base = mix(deep, vec3(0.18, 0.25, 0.12), shore * 0.72);
        float waveA = p.x * 8.0 + p.y * 5.0 + uTime * 0.48;
        float waveB = p.x * -4.5 + p.y * 11.0 - uTime * 0.35;
        vec3 normal = normalize(vec3(cos(waveA) * 0.028 + cos(waveB) * 0.018, 1.0,
          cos(waveA) * 0.018 - cos(waveB) * 0.026));
        vec3 view = normalize(cameraPosition - vWorld);
        float facing = clamp(dot(view, normal), 0.0, 1.0);
        float fresnel = 0.02 + 0.98 * pow(1.0 - facing, 5.0);
        float reflection = (0.16 + fresnel * 0.72) * (1.0 - shore * 0.55);
        vec3 col = mix(base, uSky, reflection) * uLight;
        col *= 0.97 + 0.025 * sin(waveA) * sin(waveB);
        vec3 halfVector = normalize(view + uSunDirection);
        float glint = pow(max(dot(normal, halfVector), 0.0), 160.0);
        col += uSunColor * glint * uSunStrength * (1.0 - uRain * 0.85) * (1.0 - shore);
        // 保留少量细水纹，退掉原先横贯全池的白色缝线。
        float crest = pow(0.5 + 0.5 * sin(waveA + sin(waveB) * 0.6), 28.0);
        vec3 rippleLight = mix(uSky, vec3(0.58, 0.72, 0.76), 0.65);
        col += rippleLight * crest * 0.065 * uLight * (1.0 - shore);
        float rings = ripples(p, 2.6, 0.06 + uRain * 0.48) + ripples(p + 3.7, 4.3, uRain * 0.32);
        // 夜里天色已很暗，水纹再乘一次天色会消失；保留少量月色可读性。
        col += rippleLight * rings * (0.12 + 0.20 * uRain) * mix(0.6, 1.0, uLight);
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
