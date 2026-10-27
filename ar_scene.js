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

// Round play button for an audio item, with its label (also shown in the editor and live map)
export function audioCanvas(ov, playing) {
  const S = 256, label = String(ov.text || '').trim();
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  const font = `600 60px system-ui, -apple-system, "Segoe UI", sans-serif`;
  ctx.font = font;
  const labelW = label ? Math.ceil(ctx.measureText(label).width) + 56 : 0;
  canvas.width = S + labelW;
  canvas.height = S;
  ctx.fillStyle = 'rgba(20, 20, 18, 0.78)';
  ctx.beginPath();
  ctx.roundRect(0, 0, canvas.width, S, S / 2);
  ctx.fill();
  ctx.fillStyle = '#ffffff';
  ctx.beginPath();
  ctx.arc(S / 2, S / 2, S * 0.38, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#0f6e56';
  if (playing) {   // pause bars
    ctx.fillRect(S * 0.38, S * 0.33, S * 0.09, S * 0.34);
    ctx.fillRect(S * 0.53, S * 0.33, S * 0.09, S * 0.34);
  } else {         // play triangle
    ctx.beginPath();
    ctx.moveTo(S * 0.42, S * 0.31);
    ctx.lineTo(S * 0.70, S * 0.5);
    ctx.lineTo(S * 0.42, S * 0.69);
    ctx.closePath();
    ctx.fill();
  }
  if (label) {
    ctx.font = font;
    ctx.fillStyle = '#ffffff';
    ctx.textBaseline = 'middle';
    ctx.fillText(label, S - 8, S / 2);
  }
  return canvas;
}

// Play sign drawn over a paused video
function playBadgeTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const ctx = c.getContext('2d');
  ctx.fillStyle = 'rgba(20, 20, 18, 0.7)';
  ctx.beginPath(); ctx.arc(64, 64, 60, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = '#ffffff';
  ctx.beginPath(); ctx.moveTo(50, 36); ctx.lineTo(94, 64); ctx.lineTo(50, 92); ctx.closePath(); ctx.fill();
  return new THREE.CanvasTexture(c);
}

// Audio and video items keep their player in userData.media = {el, ov, hit}, so a page can
// start them when the visitor taps one (hit = the meshes that react to a tap).
function audioObject(ov, url) {
  const audio = new Audio();
  audio.crossOrigin = 'anonymous';
  audio.preload = 'metadata';
  audio.loop = !!ov.loop_play;
  audio.src = url;
  const tex = new THREE.CanvasTexture(audioCanvas(ov, false));
  tex.colorSpace = THREE.SRGBColorSpace;
  const mesh = flat(tex, ov.size, tex.image.height / tex.image.width);
  const redraw = () => { tex.image = audioCanvas(ov, !audio.paused); tex.needsUpdate = true; };
  audio.addEventListener('play', redraw);
  audio.addEventListener('pause', redraw);
  const holder = new THREE.Group();
  holder.add(mesh);
  holder.userData.media = { el: audio, ov, hit: [mesh] };
  return holder;
}

function videoObject(ov, url) {
  const video = document.createElement('video');
  video.crossOrigin = 'anonymous';
  video.playsInline = true;
  video.setAttribute('playsinline', '');
  video.preload = 'auto';
  video.loop = !!ov.loop_play;
  video.src = url;
  const tex = new THREE.VideoTexture(video);
  tex.colorSpace = THREE.SRGBColorSpace;
  const size = ov.size;
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(size, size * 9 / 16),
    new THREE.MeshBasicMaterial({ map: tex, side: THREE.DoubleSide }));
  const badge = new THREE.Mesh(new THREE.PlaneGeometry(size * 0.18, size * 0.18),
    new THREE.MeshBasicMaterial({ map: playBadgeTexture(), transparent: true }));
  badge.position.z = 0.002;
  mesh.add(badge);
  video.addEventListener('loadedmetadata', () => {   // use the video's own shape
    if (!video.videoWidth) return;
    mesh.geometry.dispose();
    mesh.geometry = new THREE.PlaneGeometry(size, size * video.videoHeight / video.videoWidth);
  });
  video.addEventListener('loadeddata', () => { tex.needsUpdate = true; });   // show the first frame
  const update = () => { badge.visible = video.paused; };
  video.addEventListener('play', update);
  video.addEventListener('pause', update);
  const holder = new THREE.Group();
  holder.add(mesh);
  holder.userData.media = { el: video, ov, hit: [mesh, badge] };
  return holder;
}

// Audio and video players inside a group: [{el, ov, hit, object}]
export function mediaIn(group) {
  const out = [];
  group.traverse(o => { if (o.userData.media) out.push({ ...o.userData.media, object: o }); });
  return out;
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
    } else if (ov.kind === 'audio') {
      obj = audioObject(ov, fileUrl(ov.asset_path));
    } else if (ov.kind === 'video') {
      obj = videoObject(ov, fileUrl(ov.asset_path));
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

// A flat picture of a poster with one mode's items drawn on it (like the AR editor), for the live map.
// 3D models are shown as labelled boxes standing on their point.
export function posterView(target, overlays, fileUrl) {
  const wrap = document.createElement('div');
  wrap.style.cssText = 'position:relative; width:100%; overflow:hidden; border-radius:6px; line-height:0';
  const img = document.createElement('img');
  img.src = fileUrl(target.image_path);
  img.alt = target.name;
  img.style.cssText = 'display:block; width:100%; height:auto';
  wrap.appendChild(img);
  for (const ov of overlays) {
    const el = document.createElement('div');
    el.style.cssText = `position:absolute; left:${ov.x * 100}%; top:${ov.y * 100}%; width:${ov.size * 100}%;` +
      `transform:${ov.kind === 'model' ? 'translate(-50%, -100%)' : 'translate(-50%, -50%)'} rotate(${-(+ov.rot_z || 0)}deg);` +
      `transform-origin:${ov.kind === 'model' ? '50% 100%' : '50% 50%'}`;
    if (ov.kind === 'text') {
      const c = textCanvas(ov);
      c.style.cssText = 'display:block; width:100%; height:auto';
      el.appendChild(c);
    } else if (ov.kind === 'image') {
      const i = document.createElement('img');
      i.src = fileUrl(ov.asset_path);
      i.alt = '';
      i.style.cssText = 'display:block; width:100%; height:auto';
      el.appendChild(i);
    } else if (ov.kind === 'audio') {
      const c = audioCanvas(ov, false);
      c.style.cssText = 'display:block; width:100%; height:auto';
      el.appendChild(c);
    } else if (ov.kind === 'video') {
      const v = document.createElement('video');
      v.src = fileUrl(ov.asset_path) + '#t=0.1';   // shows a frame near the start
      v.muted = true;
      v.preload = 'metadata';
      v.style.cssText = 'display:block; width:100%; height:auto; background:#000';
      el.appendChild(v);
    } else {
      el.style.cssText += 'aspect-ratio:1; border:2px dashed #fff; background:rgba(24,95,165,.35); color:#fff; display:flex;' +
        'align-items:center; justify-content:center; text-align:center; font:600 11px/1.2 system-ui, sans-serif; padding:2px; text-shadow:0 1px 2px #000';
      el.textContent = '3D · ' + (ov.asset_name || 'model');
    }
    wrap.appendChild(el);
  }
  return wrap;
}
