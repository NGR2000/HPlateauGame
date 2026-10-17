// 創作の世界で操縦する1号車だけに使うモデル。
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

export async function loadCreativeCarModel() {
  const url = new URL('./assets/sky_chase_car.glb', import.meta.url);
  const { scene } = await new GLTFLoader().loadAsync(url.href);
  scene.name = 'creative-sky-chase-car';
  return scene;
}
