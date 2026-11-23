import * as THREE from 'three';
import { ANCHORS } from './layout.ts';

/** 局部软投影，不使用曾在 WebKit 大地面上出现硬矩形边界的阴影接收面。 */
export class GroundShadows {
  readonly root = new THREE.Group();
  private material: THREE.MeshBasicMaterial;
  private houseMaterial: THREE.MeshBasicMaterial;
  private patches: { mesh: THREE.Mesh; x: number; z: number; height: number; stretch?: boolean }[] = [];

  constructor() {
    const size = 128;
    const data = new Uint8Array(size * size * 4);
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
      const u = (x + .5) / size * 2 - 1, v = (y + .5) / size * 2 - 1;
      const edge = Math.max(0, 1 - Math.hypot(u, v));
      const leaves = .55 + .45 * Math.sin(u * 29 + Math.sin(v * 19)) * Math.sin(v * 31 + Math.sin(u * 17));
      const i = (y * size + x) * 4;
      data[i] = data[i + 1] = data[i + 2] = 30;
      data[i + 3] = Math.round(180 * Math.min(1, edge * 5) * leaves);
    }
    const texture = new THREE.DataTexture(data, size, size);
    texture.magFilter = texture.minFilter = THREE.LinearFilter;
    texture.needsUpdate = true;
    this.material = new THREE.MeshBasicMaterial({
      map: texture, transparent: true, depthWrite: false,
      blending: THREE.MultiplyBlending, premultipliedAlpha: true,
    });
    const tree = ANCHORS.tree;
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(2.8, 2.5), this.material);
    mesh.rotation.x = -Math.PI / 2;
    mesh.renderOrder = 2;
    this.patches.push({ mesh, x: tree.x, z: tree.z, height: 1.5 });
    this.root.add(mesh);

    // 蘑菇顶是一整块连续轮廓，不能和树冠共用斑驳叶影。
    const soft = new Uint8Array(size * size * 4);
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
      const radius = Math.hypot((x + .5) / size * 2 - 1, (y + .5) / size * 2 - 1);
      const edge = THREE.MathUtils.smoothstep(radius, .4, .98);
      const i = (y * size + x) * 4;
      soft[i] = soft[i + 1] = soft[i + 2] = 30;
      soft[i + 3] = Math.round(200 * (1 - edge));
    }
    const softTexture = new THREE.DataTexture(soft, size, size);
    softTexture.magFilter = softTexture.minFilter = THREE.LinearFilter;
    softTexture.needsUpdate = true;
    this.houseMaterial = this.material.clone();
    this.houseMaterial.map = softTexture;
    const house = ANCHORS.house;
    for (const [width, height, stretch] of [[2.15, 1.05, false], [1.25, .4, true]] as const) {
      const shadow = new THREE.Mesh(new THREE.PlaneGeometry(width, width), this.houseMaterial);
      shadow.rotation.x = -Math.PI / 2;
      shadow.renderOrder = 2;
      shadow.name = stretch ? 'house-wall-shadow' : 'house-roof-shadow';
      this.patches.push({ mesh: shadow, x: house.x, z: house.z, height, stretch });
      this.root.add(shadow);
    }
  }

  update(direction: THREE.Vector3, directLight: number, rain: number) {
    this.material.opacity = THREE.MathUtils.clamp(directLight * .25, 0, .65) * (1 - rain * .85);
    this.houseMaterial.opacity = this.material.opacity * .62;
    // 低太阳只延长到局部地面；不把假投影拉到远山或活动区外。
    const elevation = Math.max(.45, direction.y);
    for (const patch of this.patches) {
      patch.mesh.position.set(patch.x - direction.x / elevation * patch.height, .014, patch.z - direction.z / elevation * patch.height);
      if (patch.stretch) {
        patch.mesh.rotation.z = Math.atan2(direction.x, direction.z);
        patch.mesh.scale.y = 1 + Math.hypot(direction.x, direction.z) / elevation * patch.height * 2 / 1.25;
        // 墙影略高一层，避免两片软投影深度相同造成闪烁。
        patch.mesh.position.y = .015;
      }
    }
  }
}
