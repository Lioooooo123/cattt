import type { Camera, Scene, WebGLRenderer, WebGLRenderTarget } from 'three';

export async function prepareScene(renderer: WebGLRenderer, scene: Scene, camera: Camera, target: WebGLRenderTarget | null) {
  const previous = renderer.getRenderTarget();
  try {
    renderer.setRenderTarget(target);
    await renderer.compileAsync(scene, camera);
  } finally {
    renderer.setRenderTarget(previous);
  }
}
