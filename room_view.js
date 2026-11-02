// "Room" view for the Pozyx live map: the real space as a 3D model (GLB, in meters) with the
// visitor as a 1.7 m figure, the trail, the anchors and the phone taps.
//
// Pozyx coordinates (mm): x, y along the floor, z up; origin = floor below anchor A1.
// Here (meters, y up): (x, z, -y). The room model is moved, turned and scaled by the alignment
// settings so that it lines up with that.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { FBXLoader } from 'three/addons/loaders/FBXLoader.js';
import { TGALoader } from 'three/addons/loaders/TGALoader.js';

const P = (x, y, z) => new THREE.Vector3(x / 1000, z / 1000, -y / 1000);   // Pozyx mm -> room meters
const FIGURE_HEIGHT = 1.7;
const GLOW = new THREE.Color(0x33ff66);   // looked-at images glow this colour
const GLOW_FADE_S = 0.25;

// Names compared in capitals with every run of other characters as "_":
// "Miro A2.jpg" -> "MIRO_A2_JPG", "textures/miro-a2.png" -> "TEXTURES_MIRO_A2_PNG"
const norm = (n) => String(n || '').toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '');
// An image's name, without a file extension: "MIRO A2.jpg" -> "MIRO_A2"
export const imageKey = (name) => norm(String(name || '').replace(/\.(jpe?g|png|webp|gif|bmp|ktx2|basis|tga|tiff?)$/i, ''));
// A model name belongs to an image when it contains the image's name as a whole part:
// "MIRO_A2" matches MIRO_A2.jpg, MIRO_A2.001, MIRO_A2_baseColor, Mat_MIRO_A2, textures/MIRO_A2.png,
// but not MIRO_A20.
const namesMatch = (n, k) => !!k && (n === k || n.startsWith(k + '_') || n.endsWith('_' + k) || n.includes('_' + k + '_'));

// getState() returns { anchors: Map id->{x,y,z}, tags: Map id->{pos,trail,color}, showTrail, tapMarks: [{x,y,z,label}], look: text }
export function createRoomView(container, getState) {
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  container.appendChild(renderer.domElement);
  const label = document.createElement('div');
  label.className = 'roomlabel';
  label.hidden = true;
  container.appendChild(label);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(getComputedStyle(document.body).getPropertyValue('--grid').trim() || '#ebe9e2');
  scene.add(new THREE.HemisphereLight(0xffffff, 0x8a8a80, 2.0));
  const sun = new THREE.DirectionalLight(0xffffff, 1.4);
  sun.position.set(4, 10, 6);
  scene.add(sun);

  const camera = new THREE.PerspectiveCamera(50, 1, 0.05, 500);
  camera.position.set(6, 6, 8);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.target.set(2, 0, -2);

  // the room model, inside a group that carries the alignment
  const modelGroup = new THREE.Group();
  scene.add(modelGroup);
  let model = null;
  const floorGrid = new THREE.GridHelper(20, 20, 0xb4b2a9, 0xd3d1c7);   // shown while there is no model
  floorGrid.position.set(5, 0, -5);
  scene.add(floorGrid);
  const axes = new THREE.AxesHelper(1);   // Pozyx origin: red = x (towards A2), blue = -y
  scene.add(axes);

  // anchors, figures, trails, tap marks
  const dyn = new THREE.Group();
  scene.add(dyn);
  const anchorMat = new THREE.MeshStandardMaterial({ color: 0x1d9e75 });
  const tapMat = new THREE.MeshStandardMaterial({ color: 0xb4531a });
  const figures = new Map();   // tag id -> {group, trail, last}

  function makeFigure(color) {
    const mat = new THREE.MeshStandardMaterial({ color, roughness: 0.6 });
    const g = new THREE.Group();
    const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.18, 1.06, 6, 16), mat);   // 1.42 m tall
    body.position.y = 0.71;
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.13, 20, 14), mat);
    head.position.y = FIGURE_HEIGHT - 0.13;
    const nose = new THREE.Mesh(new THREE.ConeGeometry(0.05, 0.14, 12), mat);   // shows the walking direction
    nose.rotation.x = Math.PI / 2;
    nose.position.set(0, FIGURE_HEIGHT - 0.14, 0.15);
    const shadow = new THREE.Mesh(new THREE.CircleGeometry(0.3, 24), new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.18 }));
    shadow.rotation.x = -Math.PI / 2;
    shadow.position.y = 0.01;
    g.add(body, head, nose, shadow);
    const trail = new THREE.Line(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.7 }));
    scene.add(g, trail);
    return { group: g, trail, heading: 0, last: null };
  }

  let dynSig = null;
  const boxGeo = new THREE.BoxGeometry(0.12, 0.12, 0.12), tapGeo = new THREE.OctahedronGeometry(0.1);
  const poleMat = new THREE.LineDashedMaterial({ color: 0x1d9e75, dashSize: 0.08, gapSize: 0.06 });
  function rebuildMarkers(state, sig) {
    dynSig = sig;
    dyn.traverse(o => { if (o.isLine) o.geometry.dispose(); });
    dyn.clear();
    for (const a of state.anchors.values()) {
      const p = P(a.x, a.y, a.z);
      const box = new THREE.Mesh(boxGeo, anchorMat);
      box.position.copy(p);
      const pole = new THREE.Line(new THREE.BufferGeometry().setFromPoints([p, new THREE.Vector3(p.x, 0, p.z)]), poleMat);
      pole.computeLineDistances();
      dyn.add(box, pole);
    }
    for (const m of state.tapMarks || []) {
      const d = new THREE.Mesh(tapGeo, tapMat);
      d.position.copy(P(m.x, m.y, 0)).setY(0.1);
      dyn.add(d);
    }
  }

  function updateDynamic(state) {
    // anchors (a small box at their height with a line to the floor) and tap marks,
    // rebuilt only when they change
    const sig = [...state.anchors.values()].map(a => `${a.x},${a.y},${a.z}`).join(';') + '|' +
      (state.tapMarks || []).map(m => `${m.x},${m.y}`).join(';');
    if (sig !== dynSig) rebuildMarkers(state, sig);
    // figures stand on the floor at the tag's x, y (the measured height is not used)
    const seen = new Set();
    let labelText = '', labelPos = null;
    for (const [id, t] of state.tags) {
      if (!t.pos) continue;
      seen.add(id);
      let f = figures.get(id);
      if (!f) { f = makeFigure(t.color); figures.set(id, f); }
      const p = P(t.pos.x, t.pos.y, 0);
      if (f.last && f.last.distanceTo(p) > 0.03) f.heading = Math.atan2(p.x - f.last.x, p.z - f.last.z);
      f.last = p.clone();
      f.group.position.copy(p);
      f.group.rotation.y = f.heading;
      f.group.visible = true;
      const pts = state.showTrail ? t.trail.map(q => P(q.x, q.y, 0).setY(0.03)) : [];
      f.trail.geometry.dispose();
      f.trail.geometry = new THREE.BufferGeometry().setFromPoints(pts);
      if (!labelPos) { labelPos = p.clone().setY(FIGURE_HEIGHT + 0.25); labelText = id + (state.look ? ' · ' + state.look : ''); }
    }
    for (const [id, f] of figures) if (!seen.has(id)) { f.group.visible = false; f.trail.geometry = new THREE.BufferGeometry(); }
    // label above the first figure's head
    if (labelPos) {
      const v = labelPos.project(camera);
      label.hidden = v.z > 1;
      label.style.left = ((v.x + 1) / 2 * container.clientWidth) + 'px';
      label.style.top = ((1 - v.y) / 2 * container.clientHeight) + 'px';
      label.textContent = labelText;
    } else label.hidden = true;
  }

  function resize() {
    const w = container.clientWidth, h = container.clientHeight;
    if (!w || !h) return;
    renderer.setSize(w, h, false);
    renderer.domElement.style.width = '100%';
    renderer.domElement.style.height = '100%';
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }
  new ResizeObserver(resize).observe(container);

  let running = false, lastFrame = performance.now();
  function frame() {
    if (!running) return;
    const now = performance.now(), dt = (now - lastFrame) / 1000;
    lastFrame = now;
    controls.update();
    const state = getState();
    updateDynamic(state);
    if (model) updateGlow(state.lookImage, dt);
    renderer.render(scene, camera);
    requestAnimationFrame(frame);
  }

  // Frames the model (or the anchors when there is no model)
  function resetView() {
    const box = new THREE.Box3();
    if (model) box.setFromObject(modelGroup);
    for (const a of getState().anchors.values()) box.expandByPoint(P(a.x, a.y, a.z));
    if (box.isEmpty()) box.set(new THREE.Vector3(0, 0, -5), new THREE.Vector3(5, 2.5, 0));
    const c = box.getCenter(new THREE.Vector3()), size = box.getSize(new THREE.Vector3()).length();
    controls.target.copy(c);
    camera.position.copy(c).add(new THREE.Vector3(size * 0.45, size * 0.55, size * 0.6));
    camera.near = Math.max(0.02, size / 500);
    camera.far = size * 20;
    camera.updateProjectionMatrix();
  }

  const loader = new GLTFLoader();
  const draco = new DRACOLoader();
  draco.setDecoderPath('https://cdn.jsdelivr.net/npm/three@0.160.0/examples/jsm/libs/draco/gltf/');
  loader.setDRACOLoader(draco);
  loader.setMeshoptDecoder(MeshoptDecoder);

  // align = {ox, oy, oz, rot (degrees around the vertical), scale}
  function setAlign(a) {
    modelGroup.position.set(+a.ox || 0, +a.oy || 0, +a.oz || 0);
    modelGroup.rotation.set(0, (+a.rot || 0) * Math.PI / 180, 0);
    modelGroup.scale.setScalar(+a.scale || 1);
  }

  // The model sits in "upright" (turns a Z-up model to Y-up) inside modelGroup (the alignment)
  const upright = new THREE.Group();
  modelGroup.add(upright);
  function setUpright(zUp) { upright.rotation.set(zUp ? -Math.PI / 2 : 0, 0, 0); }

  // GLB: one file. FBX: opts.files maps texture file names (lower case) to their addresses, because
  // an FBX refers to its textures by the path they had on the computer that made it.
  // Returns {zUp} for FBX: whether the model was found (or set) to be Z-up.
  // Large model files are stored gzip-compressed (name ending .gz): download and unpack them here
  async function fetchGunzip(url, onProgress) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`could not download the model (${res.status})`);
    const total = +res.headers.get('content-length') || 0;
    let loaded = 0;
    const counted = res.body.pipeThrough(new TransformStream({
      transform(chunk, ctl) { loaded += chunk.length; if (onProgress && total) onProgress({ loaded, total }); ctl.enqueue(chunk); },
    }));
    return new Response(counted.pipeThrough(new DecompressionStream('gzip'))).arrayBuffer();
  }

  async function loadModel(url, onProgress, opts = {}) {
    const progress = (e) => { if (onProgress && e.total) onProgress(e.loaded / e.total); };
    let root, result = {};
    if (opts.type === 'fbx') {
      const manager = new THREE.LoadingManager();
      manager.addHandler(/\.tga$/i, new TGALoader(manager));
      manager.setURLModifier((u) => {
        if (u === url || u.startsWith('blob:') || u.startsWith('data:')) return u;
        const base = decodeURIComponent(u.split(/[\\/]/).pop().split('?')[0]).toLowerCase();
        return (opts.files && opts.files[base]) || u;
      });
      const texturesDone = new Promise((res) => { manager.onLoad = res; });
      const fbxLoader = new FBXLoader(manager);
      root = url.endsWith('.gz') ? fbxLoader.parse(await fetchGunzip(url, progress), '') : await fbxLoader.loadAsync(url, progress);
      // some exporters leave out surface normals, which makes everything black: work them out
      root.traverse((o) => { if (o.isMesh && !o.geometry.attributes.normal) o.geometry.computeVertexNormals(); });
      // FBX units: UnitScaleFactor = centimeters per unit (1 = cm, 100 = m); assume cm when missing
      root.scale.multiplyScalar((root.userData.unitScaleFactor || 1) / 100);
      let zUp = opts.zUp;
      if (zUp === null || zUp === undefined) {   // a room is wider than it is tall: if "up" is not the smallest side, it is Z-up
        const size = new THREE.Box3().setFromObject(root).getSize(new THREE.Vector3());
        zUp = size.y > Math.min(size.x, size.z);
      }
      result.zUp = zUp;
      setUpright(zUp);
      texturesDone.then(() => { if (model === root) { indexGlow(); if (opts.onTextures) opts.onTextures(); } });
    } else {
      root = (url.endsWith('.gz') ? await loader.parseAsync(await fetchGunzip(url, progress), '') : await loader.loadAsync(url, progress)).scene;
      setUpright(false);
    }
    if (model) upright.remove(model);
    model = root;
    upright.add(model);
    floorGrid.visible = false;
    indexGlow();
    resetView();
    return result;
  }

  // Parts of the model that light up when the visitor looks at an image: materials whose
  // texture names, material name or object name contain the image's name (see namesMatch)
  let glowEntries = [];          // every material, once: {mat, names, color, emissive, w}
  const glowCache = new Map();   // image key -> entries that belong to it
  const MAPS = ['map', 'emissiveMap', 'aoMap', 'lightMap', 'normalMap', 'roughnessMap', 'metalnessMap', 'alphaMap'];
  function indexGlow() {
    glowEntries = [];
    glowCache.clear();
    const seen = new Map();   // a material shared by several objects is handled once
    model.traverse((o) => {
      if (!o.isMesh) return;
      for (const m of [].concat(o.material)) {
        if (!m) continue;
        let e = seen.get(m);
        if (!e) {
          e = { mat: m, names: new Set(), textures: new Set(), color: m.color ? m.color.clone() : null, emissive: m.emissive ? m.emissive.clone() : null, w: 0 };
          seen.set(m, e);
          glowEntries.push(e);
          if (m.name) e.names.add(norm(m.name));
          for (const k of MAPS) {
            if (!m[k]) continue;
            const src = m[k].image && (m[k].image.currentSrc || m[k].image.src);
            const file = src && !/^(blob|data):/.test(src) ? decodeURIComponent(src.split('?')[0].split('/').pop()) : '';
            for (const n of [m[k].name, file]) if (n) { e.names.add(norm(n)); e.textures.add(n); }
          }
        }
        if (o.name) e.names.add(norm(o.name));
      }
    });
  }
  function entriesFor(imageName) {
    const k = imageKey(imageName);
    if (!glowCache.has(k)) glowCache.set(k, glowEntries.filter(e => [...e.names].some(n => namesMatch(n, k))));
    return glowCache.get(k);
  }
  function updateGlow(lookImage, dt) {
    const on = new Set(lookImage ? entriesFor(lookImage) : []);
    const step = Math.min(1, dt / GLOW_FADE_S);
    for (const e of glowEntries) {
      const goal = on.has(e) ? 1 : 0;
      if (e.w === goal) continue;
      e.w = goal > e.w ? Math.min(1, e.w + step) : Math.max(0, e.w - step);
      if (e.color) e.mat.color.copy(e.color).lerp(GLOW, e.w * 0.55);
      if (e.emissive) e.mat.emissive.copy(e.emissive).add(GLOW.clone().multiplyScalar(e.w * 0.45));
    }
  }
  // which of these image names have something to light up in the model
  function glowMatches(names) {
    return names.map(n => ({ name: n, found: entriesFor(n).length > 0 }));
  }
  // texture and material names in the model, to compare with the image names
  function modelNames() {
    const textures = new Set(), materials = new Set();
    let unnamedTextures = 0;
    for (const e of glowEntries) {
      if (e.mat.name) materials.add(e.mat.name);
      for (const t of e.textures) textures.add(t);
      for (const k of MAPS) {
        const t = e.mat[k];
        const src = t && t.image && (t.image.currentSrc || t.image.src);
        if (t && !t.name && !(src && !/^(blob|data):/.test(src))) unnamedTextures++;
      }
    }
    return { textures: [...textures].sort(), materials: [...materials].sort(), unnamedTextures };
  }
  function removeModel() {
    if (model) upright.remove(model);
    model = null;
    floorGrid.visible = true;
  }

  // Two-point alignment: the caller asks for a click on the model; the point comes back in the
  // model's own coordinates (before alignment)
  const ray = new THREE.Raycaster();
  let pickCb = null, down = null;
  renderer.domElement.addEventListener('pointerdown', (e) => { down = { x: e.clientX, y: e.clientY }; });
  renderer.domElement.addEventListener('pointerup', (e) => {
    if (!pickCb || !model || !down || Math.hypot(e.clientX - down.x, e.clientY - down.y) > 5) return;   // a drag, not a click
    const r = renderer.domElement.getBoundingClientRect();
    ray.setFromCamera(new THREE.Vector2((e.clientX - r.left) / r.width * 2 - 1, -(e.clientY - r.top) / r.height * 2 + 1), camera);
    const hit = ray.intersectObject(model, true)[0];
    if (!hit) return;
    const cb = pickCb;
    pickCb = null;
    renderer.domElement.style.cursor = '';
    cb(modelGroup.worldToLocal(hit.point.clone()));
  });
  function pick(cb) { pickCb = cb; renderer.domElement.style.cursor = cb ? 'crosshair' : ''; }

  // Alignment that puts model point p1 on the floor below A1 and p2 in the direction of A2
  // (scale is kept). a1, a2 = anchor positions in mm.
  function alignFromPoints(m1, m2, a1, a2, scale) {
    const s = +scale || 1;
    const p1 = new THREE.Vector3(m1.x, m1.y, m1.z), p2 = new THREE.Vector3(m2.x, m2.y, m2.z);
    const w1 = P(a1.x, a1.y, 0), w2 = P(a2.x, a2.y, 0);
    const angModel = Math.atan2(-(p2.z - p1.z), p2.x - p1.x);
    const angWorld = Math.atan2(-(w2.z - w1.z), w2.x - w1.x);
    const rot = angWorld - angModel;
    const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), rot);
    const p1w = p1.clone().multiplyScalar(s).applyQuaternion(q);
    const modelDist = Math.hypot(p2.x - p1.x, p2.z - p1.z) * s, pozyxDist = Math.hypot(w2.x - w1.x, w2.z - w1.z);
    let deg = rot * 180 / Math.PI;
    deg = ((deg + 540) % 360) - 180;
    return { ox: w1.x - p1w.x, oy: -p1w.y, oz: w1.z - p1w.z, rot: deg, scale: s, modelDist, pozyxDist };
  }

  return {
    show() { if (!running) { running = true; resize(); requestAnimationFrame(frame); } },
    hide() { running = false; label.hidden = true; },
    loadModel, removeModel, setAlign, setUpright, resetView, pick, alignFromPoints, glowMatches, modelNames,
    get hasModel() { return !!model; },
    get model() { return model; },
  };
}
