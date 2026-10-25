// Builds the overlays for one AR image, for ar_editor.html (3D preview) and ar_viewer.html (camera).
// Coordinates are MindAR's: the image is 1 unit wide and centred on 0,0; x right, y up, z towards
// the viewer. An overlay's x, y are measured from the image's top-left corner (0..1), and its
// size and z (height above the image) are fractions of the image width.
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

const gltfLoader = new GLTFLoader();
const textureLoader = new THREE.TextureLoader();
textureLoader.setCrossOrigin('anonymous');
const deg = (d) => (+d || 0) * Math.PI / 180;

export const aspect = (target) => target.height_px / target.width_px;

// Soft light so 3D models are not black
export function addLights(scene) {
  scene.add(new THREE.HemisphereLight(0xffffff, 0x666666, 2.2));
  const sun = new THREE.DirectionalLight(0xffffff, 1.6);
  sun.position.set(0.5, 1, 1.5);
  scene.add(sun);
}

// The poster itself, for the editor preview
export async function imagePlane(target, url) {
  const tex = await textureLoader.loadAsync(url);
  tex.colorSpace = THREE.SRGBColorSpace;
  return new THREE.Mesh(new THREE.PlaneGeometry(1, aspect(target)), new THREE.MeshBasicMaterial({ map: tex }));
}

// Text overlay drawn on a canvas (also shown as-is in the editor)
export function textCanvas(ov) {
  const fontPx = 64, pad = 28, lineH = fontPx * 1.25;
  const lines = String(ov.text || ' ').split('\n');
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  const font = `600 ${fontPx}px system-ui, -apple-system, "Segoe UI", sans-serif`;
  ctx.font = font;
  canvas.width = Math.ceil(Math.max(...lines.map(l => ctx.measureText(l).width), fontPx) + pad * 2);
  canvas.height = Math.ceil(lines.length * lineH + pad * 2);
  ctx.font = font;   // resizing the canvas resets it
  if (ov.background && ov.background !== 'transparent') {
    ctx.fillStyle = ov.background;
    ctx.beginPath();
    ctx.roundRect(0, 0, canvas.width, canvas.height, 24);
    ctx.fill();
  }
  ctx.fillStyle = ov.color || '#ffffff';
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'center';
  lines.forEach((l, i) => ctx.fillText(l, canvas.width / 2, pad + lineH * (i + 0.5)));
  return canvas;
}

function textTexture(ov) {
  const canvas = textCanvas(ov);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return { tex, ratio: canvas.height / canvas.width };
}

function flat(tex, width, ratio) {
  return new THREE.Mesh(
    new THREE.PlaneGeometry(width, width * ratio),
    new THREE.MeshBasicMaterial({ map: tex, transparent: true, side: THREE.DoubleSide }),
  );
}

// A red box where a file could not be loaded, so the problem is visible
function missing(size) {
  return new THREE.Mesh(new THREE.BoxGeometry(size, size, size * 0.2),
    new THREE.MeshBasicMaterial({ color: 0xd04040, wireframe: true }));
}

async function modelObject(url, size) {
  const gltf = await gltfLoader.loadAsync(url);
  const root = gltf.scene;
  // scale so the largest side is `size`, and stand it on the point (bottom centre at 0,0,0)
  const box = new THREE.Box3().setFromObject(root);
  const dims = box.getSize(new THREE.Vector3());
  const s = size / Math.max(dims.x, dims.y, dims.z, 1e-6);
  const centre = box.getCenter(new THREE.Vector3());
  const holder = new THREE.Group();
  root.scale.setScalar(s);
  root.position.set(-centre.x * s, -box.min.y * s, -centre.z * s);
  holder.add(root);
  if (gltf.animations && gltf.animations.length) {   // play the model's first animation, if it has one
    const mixer = new THREE.AnimationMixer(root);
    mixer.clipAction(gltf.animations[0]).play();
    holder.userData.mixer = mixer;
  }
  return holder;
}

// One overlay, positioned on its image. fileUrl(path) gives a stored file's address.
export async function buildOverlay(ov, target, fileUrl) {
  let obj;
  try {
    if (ov.kind === 'text') {
      const { tex, ratio } = textTexture(ov);
      obj = flat(tex, ov.size, ratio);
    } else if (ov.kind === 'image') {
      const tex = await textureLoader.loadAsync(fileUrl(ov.asset_path));
      tex.colorSpace = THREE.SRGBColorSpace;
      obj = flat(tex, ov.size, tex.image.height / tex.image.width);
    } else {
      obj = await modelObject(fileUrl(ov.asset_path), ov.size);
    }
  } catch (e) {
    console.warn('Could not load overlay', ov.id, e);
    obj = missing(ov.size);
  }
  const g = new THREE.Group();
  g.add(obj);
  g.position.set(ov.x - 0.5, (0.5 - ov.y) * aspect(target), +ov.z || 0);
  g.rotation.set(deg(ov.rot_x), deg(ov.rot_y), deg(ov.rot_z));
  g.userData.overlayId = ov.id;
  if (obj.userData.mixer) g.userData.mixer = obj.userData.mixer;
  return g;
}

// All overlays of one image in a group
export async function buildTargetGroup(target, overlays, fileUrl) {
  const group = new THREE.Group();
  const objs = await Promise.all(overlays.map(ov => buildOverlay(ov, target, fileUrl)));
  objs.forEach(o => group.add(o));
  return group;
}

// Animation mixers inside a group, to update every frame
export function mixersIn(group) {
  const out = [];
  group.traverse(o => { if (o.userData.mixer) out.push(o.userData.mixer); });
  return out;
}

// Is the screen centre (0, 0 in normalised screen units) over this image?
const corner = new THREE.Vector3();
export function centreIsOn(target, anchorGroup, camera) {
  const h = aspect(target) / 2;
  const pts = [[-0.5, h], [0.5, h], [0.5, -h], [-0.5, -h]].map(([x, y]) => {
    corner.set(x, y, 0).applyMatrix4(anchorGroup.matrixWorld).project(camera);
    return [corner.x, corner.y];
  });
  let sign = 0;
  for (let i = 0; i < 4; i++) {   // the centre is inside if it is on the same side of all 4 edges
    const [ax, ay] = pts[i], [bx, by] = pts[(i + 1) % 4];
    const cross = (bx - ax) * (0 - ay) - (by - ay) * (0 - ax);
    if (cross !== 0) {
      if (sign === 0) sign = Math.sign(cross);
      else if (Math.sign(cross) !== sign) return false;
    }
  }
  return true;
}
