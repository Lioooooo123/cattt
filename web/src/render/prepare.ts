import * as THREE from 'three';
import type { Camera, Material, Scene, WebGLRenderer, WebGLRenderTarget } from 'three';

const SHADOW_SIDE = { [THREE.FrontSide]: THREE.BackSide, [THREE.BackSide]: THREE.FrontSide, [THREE.DoubleSide]: THREE.DoubleSide };

/** 与阴影那一遍取到的深度材质同一程序变体（three WebGLShadowMap.getDepthMaterial 的定向光分支）。 */
export function shadowDepthMaterial(source: Material) {
  const material = new THREE.MeshDepthMaterial();
  const textured = source as Material & { map?: THREE.Texture | null; alphaMap?: THREE.Texture | null; displacementMap?: THREE.Texture | null; displacementScale?: number };
  material.side = source.shadowSide ?? SHADOW_SIDE[source.side];
  material.alphaTest = source.alphaToCoverage ? .5 : source.alphaTest;
  material.map = textured.map ?? null;
  material.alphaMap = textured.alphaMap ?? null;
  material.displacementMap = textured.displacementMap ?? null;
  material.displacementScale = textured.displacementScale ?? 1;
  material.clipShadows = source.clipShadows;
  material.clippingPlanes = source.clippingPlanes;
  return material;
}

type Compiler = Pick<WebGLRenderer, 'getRenderTarget' | 'setRenderTarget' | 'compileAsync'> & { shadowMap?: { enabled: boolean } };

/**
 * 首帧前把会用到的程序交给异步编译：场景材质、阴影深度变体、后处理全屏材质。
 * 有 KHR_parallel_shader_compile 时（WebKit）编译不占主线程；漏掉的变体会在首帧同步编译。
 */
export async function prepareScene(renderer: Compiler, scene: Scene, camera: Camera, target: WebGLRenderTarget | null,
  post: { offscreen: Material[]; screen: Material[] } = { offscreen: [], screen: [] }) {
  const previous = renderer.getRenderTarget();
  const pending: Promise<unknown>[] = [];
  try {
    renderer.setRenderTarget(target);
    pending.push(renderer.compileAsync(scene, camera));
    if (renderer.shadowMap?.enabled) pending.push(compileShadowDepth(renderer, scene, camera));
    if (post.offscreen.length) pending.push(renderer.compileAsync(quads(post.offscreen), camera));
    if (post.screen.length) {
      renderer.setRenderTarget(null);
      pending.push(renderer.compileAsync(quads(post.screen), camera));
    }
  } finally {
    renderer.setRenderTarget(previous);
  }
  await Promise.all(pending);
}

/** 投影物体临时换成深度材质，只编这些物体；光照取自原场景，物体类型（蒙皮、实例）与真实阴影一遍相同。 */
function compileShadowDepth(renderer: Compiler, scene: Scene, camera: Camera) {
  const casters: THREE.Mesh[] = [];
  scene.traverseVisible(object => {
    const mesh = object as THREE.Mesh;
    if (mesh.isMesh && mesh.castShadow && mesh.material) casters.push(mesh);
  });
  const originals = casters.map(mesh => mesh.material);
  const depth = new Map<Material, Material>();
  const variant = (material: Material) => depth.get(material) ?? depth.set(material, shadowDepthMaterial(material)).get(material)!;
  for (const mesh of casters) mesh.material = Array.isArray(mesh.material) ? mesh.material.map(variant) : variant(mesh.material);
  // compile 只给“新物体”建程序、光照从目标场景收集；用只列出投影物体的根代替整棵场景。
  const root = new THREE.Object3D();
  root.traverse = callback => casters.forEach(callback);
  root.traverseVisible = () => {};
  // 阴影一遍用空场景绘制，没有雾。
  const fog = scene.fog;
  scene.fog = null;
  try {
    // 不 dispose：程序按引用计数回收，临时材质一释放，刚编好的程序就会在首帧前被删掉。
    return renderer.compileAsync(root, camera, scene);
  } finally {
    scene.fog = fog;
    casters.forEach((mesh, index) => { mesh.material = originals[index]!; });
  }
}

/** 与后处理全屏三角形同样只有 position、uv（多一个 normal 属性程序变体就不同）。 */
function quads(materials: Material[]) {
  const scene = new THREE.Scene();
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute([-1, 3, 0, -1, -1, 0, 3, -1, 0], 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute([0, 2, 0, 0, 2, 0], 2));
  for (const material of materials) scene.add(new THREE.Mesh(geometry, material));
  return scene;
}
