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
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { MeshBVH } from 'three-mesh-bvh';

const P = (x, y, z) => new THREE.Vector3(x / 1000, z / 1000, -y / 1000);   // Pozyx mm -> room meters
const FIGURE_HEIGHT = 1.7;
const GLOW = new THREE.Color(0x33ff66);   // looked-at images glow this colour
const GLOW_FADE_S = 0.25;
// Detail levels: drawing sharpness (pixel ratio) and the largest texture size
const QUALITY = {
  high: { pixelRatio: () => Math.min(window.devicePixelRatio || 1, 2), maxTexture: Infinity },
  balanced: { pixelRatio: () => Math.min(window.devicePixelRatio || 1, 1), maxTexture: 2048 },
  light: { pixelRatio: () => 0.75, maxTexture: 1024 },
};

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
export function createRoomView(container, getState, initialQuality = 'balanced') {
  let quality = QUALITY[initialQuality] ? initialQuality : 'balanced';
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(QUALITY[quality].pixelRatio());
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
  // Draw only when something changed (view turned, visitor moved, a glow fading), not 60 times a second
  let needsRender = true, lastStateKey = '';
  controls.addEventListener('change', () => { needsRender = true; });

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

  // Each tag is shown as the phone it is fixed to (at the measured position, turned like the
  // phone), as a person (a 1.7 m figure standing behind it), or both: see setShowAs()
  let showAs = 'phone';
  const PHONE_SCALE = 1.5;   // a little larger than a real phone, so it is easy to see
  const PERSON_BEHIND = 0.35;   // meters between the phone and the person's centre
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
    shadow.userData.shadow = true;
    g.add(body, head, nose, shadow);
    // the phone: screen towards +z, back camera looking along -z, top along +y
    const phone = new THREE.Group();
    const caseMesh = new THREE.Mesh(new THREE.BoxGeometry(0.075, 0.155, 0.009), mat);
    const screen = new THREE.Mesh(new THREE.PlaneGeometry(0.067, 0.142), new THREE.MeshBasicMaterial({ color: 0x1a1a1a }));
    screen.position.z = 0.0046;
    const lens = new THREE.Mesh(new THREE.CylinderGeometry(0.008, 0.008, 0.004, 16), new THREE.MeshBasicMaterial({ color: 0x111111 }));
    lens.rotation.x = Math.PI / 2;
    lens.position.set(-0.022, 0.06, -0.006);
    phone.add(caseMesh, screen, lens);
    phone.scale.setScalar(PHONE_SCALE);
    phone.rotation.order = 'YXZ';
    const ring = new THREE.Mesh(new THREE.RingGeometry(0.14, 0.18, 32), new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.5, side: THREE.DoubleSide }));
    ring.rotation.x = -Math.PI / 2;   // on the floor below the phone, to find it from above
    const stem = new THREE.Line(new THREE.BufferGeometry(), new THREE.LineDashedMaterial({ color, dashSize: 0.06, gapSize: 0.05 }));
    const trail = new THREE.Line(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.7 }));
    // where the phone's camera points: a see-through cone from the phone (or the head)
    const cone = new THREE.Mesh(new THREE.ConeGeometry(0.45, 2, 24, 1, true),
      new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.18, side: THREE.DoubleSide, depthWrite: false }));
    cone.visible = false;
    scene.add(g, phone, ring, stem, trail, cone);
    return { group: g, phone, ring, stem, trail, cone, heading: 0, last: null };
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
    const showPhone = showAs !== 'person', showPerson = showAs !== 'phone';
    const seen = new Set();
    let labelText = '', labelPos = null;
    for (const [id, t] of state.tags) {
      if (!t.pos) continue;
      seen.add(id);
      let f = figures.get(id);
      if (!f) { f = makeFigure(t.color); figures.set(id, f); }
      const floor = P(t.pos.x, t.pos.y, 0);
      const phonePos = P(t.pos.x, t.pos.y, Number.isFinite(t.pos.z) && t.pos.z > 0 ? t.pos.z : 1200);   // the tag is on the phone
      const dir = !labelPos && state.dir ? state.dir : null;   // the phone carries the first tag
      if (dir) f.heading = Math.atan2(Math.cos(dir.angle), -Math.sin(dir.angle));   // faces where the phone points
      else if (f.last && f.last.distanceTo(floor) > 0.03) f.heading = Math.atan2(floor.x - f.last.x, floor.z - f.last.z);   // or where it walks
      f.last = floor.clone();
      const forward = new THREE.Vector3(Math.sin(f.heading), 0, Math.cos(f.heading));
      // the phone, turned like the real one (direction, tilt, roll)
      f.phone.visible = f.ring.visible = f.stem.visible = showPhone;
      f.phone.position.copy(phonePos);
      f.phone.rotation.set(dir ? dir.pitch : 0, f.heading + Math.PI, dir ? dir.roll || 0 : 0);   // + PI: the camera looks along -z
      f.ring.position.copy(floor).setY(0.012);
      f.stem.geometry.dispose();
      f.stem.geometry = new THREE.BufferGeometry().setFromPoints([phonePos, floor]);
      f.stem.computeLineDistances();
      // the person stands behind the phone
      f.group.visible = showPerson;
      f.group.position.copy(floor).addScaledVector(forward, showPhone ? -PERSON_BEHIND : 0);
      f.group.rotation.y = f.heading;
      for (const m of f.group.children) if (m.material && !m.userData.shadow) { m.material.transparent = showPhone; m.material.opacity = showPhone ? 0.35 : 1; }   // faint behind the phone
      f.cone.visible = !!dir;
      if (dir) {
        const d = new THREE.Vector3(Math.cos(dir.pitch) * Math.cos(dir.angle), Math.sin(dir.pitch), -Math.cos(dir.pitch) * Math.sin(dir.angle));
        const from = showPhone ? phonePos : floor.clone().setY(FIGURE_HEIGHT - 0.15);
        f.cone.position.copy(from).addScaledVector(d, 1);   // the cone is 2 m long, its tip at the camera
        f.cone.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), d.clone().negate());
      }
      const pts = state.showTrail ? t.trail.map(q => P(q.x, q.y, 0).setY(0.03)) : [];
      f.trail.geometry.dispose();
      f.trail.geometry = new THREE.BufferGeometry().setFromPoints(pts);
      if (!labelPos) {
        labelPos = showPhone ? phonePos.clone().add(new THREE.Vector3(0, 0.3, 0)) : floor.clone().setY(FIGURE_HEIGHT + 0.25);
        labelText = id + (state.look ? ' · ' + state.look : '');
      }
    }
    for (const [id, f] of figures) if (!seen.has(id)) { f.group.visible = f.phone.visible = f.ring.visible = f.stem.visible = f.cone.visible = false; f.trail.geometry = new THREE.BufferGeometry(); }
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
    needsRender = true;
  }
  new ResizeObserver(resize).observe(container);

  let running = false, lastFrame = performance.now();
  function frame() {
    if (!running) return;
    const now = performance.now(), dt = (now - lastFrame) / 1000;
    lastFrame = now;
    controls.update();
    const state = getState();
    let key = `${state.look}|${state.showTrail}|${dynSig}|${state.dir ? state.dir.angle.toFixed(3) + ',' + state.dir.pitch.toFixed(3) : ''}`;
    for (const [id, t] of state.tags) if (t.pos) key += `|${id}:${t.pos.x},${t.pos.y},${t.trail.length}`;
    if (key !== lastStateKey) { lastStateKey = key; needsRender = true; }
    if (needsRender) { updateDynamic(state); placePlanLabels(); }
    if (model && updateGlow(state.lookImage, dt)) needsRender = true;
    if (needsRender) {
      renderer.render(scene, camera);
      needsRender = false;
    }
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
    needsRender = true;
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
    needsRender = true;
    modelGroup.position.set(+a.ox || 0, +a.oy || 0, +a.oz || 0);
    modelGroup.rotation.set(0, (+a.rot || 0) * Math.PI / 180, 0);
    modelGroup.scale.setScalar(+a.scale || 1);
  }

  // The model sits in "upright" (turns a Z-up model to Y-up) inside modelGroup (the alignment)
  const upright = new THREE.Group();
  modelGroup.add(upright);
  function setUpright(zUp) { upright.rotation.set(zUp ? -Math.PI / 2 : 0, 0, 0); needsRender = true; }

  // GLB: one file. FBX: opts.files maps texture file names (lower case) to their addresses, because
  // an FBX refers to its textures by the path they had on the computer that made it.
  // Returns {zUp} for FBX: whether the model was found (or set) to be Z-up.
  // Large model files are stored gzip-compressed (name ending .gz) and/or in pieces (parts):
  // download the pieces, join them and unpack
  async function fetchModelData(url, parts, onProgress) {
    const urls = parts && parts.length ? parts : [url];
    const blobs = [];
    for (let i = 0; i < urls.length; i++) {
      const res = await fetch(urls[i]);
      if (!res.ok) throw new Error(`could not download the model (${res.status})`);
      const total = +res.headers.get('content-length') || 0;
      const reader = res.body.getReader(), chunks = [];
      let loaded = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        loaded += value.length;
        if (onProgress && total) onProgress({ loaded: i + loaded / total, total: urls.length });
      }
      blobs.push(new Blob(chunks));
    }
    let stream = new Blob(blobs).stream();
    if (url.endsWith('.gz')) stream = stream.pipeThrough(new DecompressionStream('gzip'));
    return new Response(stream).arrayBuffer();
  }

  async function loadModel(url, onProgress, opts = {}) {
    const progress = (e) => { if (onProgress && e.total) onProgress(e.loaded / e.total); };
    const packed = url.endsWith('.gz') || !!(opts.parts && opts.parts.length);   // compressed or in pieces
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
      root = packed ? fbxLoader.parse(await fetchModelData(url, opts.parts, progress), '') : await fbxLoader.loadAsync(url, progress);
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
      texturesDone.then(() => {
        if (model !== root) return;
        indexGlow();
        limitTextures();
        needsRender = true;
        if (opts.onTextures) opts.onTextures();
      });
    } else {
      root = (packed ? await loader.parseAsync(await fetchModelData(url, opts.parts, progress), '') : await loader.loadAsync(url, progress)).scene;
      setUpright(false);
    }
    planMeshes = [];
    const merged = mergeByMaterial(root);   // fewer, bigger parts draw much faster
    stats = { parts: merged.before, drawn: merged.group.children.length };
    root = merged.group;
    if (model) upright.remove(model);
    model = root;
    upright.add(model);
    floorGrid.visible = false;
    indexGlow();
    limitTextures();
    resetView();
    return result;
  }

  // Objects that share a material are joined into one (in the model's own position), so the
  // browser handles tens of parts instead of thousands. The objects' names are kept on the
  // material, for the glow. Animated, mirrored and multi-material objects stay as they are.
  let stats = null;
  function mergeByMaterial(root) {
    root.updateMatrixWorld(true);
    const groups = new Map(), keep = [];
    let before = 0;
    root.traverse((o) => {
      if (!o.isMesh) return;
      before++;
      const m = o.material;
      for (const mm of [].concat(m)) if (mm && o.name) (mm.userData.objectNames ||= new Set()).add(o.name);
      if (o.isSkinnedMesh || o.isInstancedMesh || Array.isArray(m) || o.morphTargetInfluences || o.matrixWorld.determinant() < 0) { keep.push(o); return; }
      const g = o.geometry;
      const key = m.uuid + '|' + Object.keys(g.attributes).sort().join(',') + (g.index ? '|i' : '|n');
      if (!groups.has(key)) groups.set(key, { material: m, geos: [] });
      groups.get(key).geos.push(g.clone().applyMatrix4(o.matrixWorld));
    });
    const out = new THREE.Group();
    for (const { material, geos } of groups.values()) {
      const one = geos.length === 1 ? geos[0] : mergeGeometries(geos, false);
      if (one) { out.add(new THREE.Mesh(one, material)); if (geos.length > 1) geos.forEach(g => g.dispose()); }
      else geos.forEach(g => out.add(new THREE.Mesh(g, material)));   // could not be joined
    }
    for (const o of keep) out.attach(o);
    root.traverse((o) => { if (o.isMesh && !keep.includes(o)) o.geometry.dispose(); });
    return { group: out, before };
  }

  // Textures bigger than the detail level allows are drawn smaller (the original is kept, to go back)
  function limitTextures() {
    if (!model) return;
    const max = QUALITY[quality].maxTexture;
    const done = new Set();
    model.traverse((o) => {
      if (!o.isMesh) return;
      for (const m of [].concat(o.material)) for (const k of MAPS) {
        const t = m && m[k];
        if (!t || done.has(t)) continue;
        done.add(t);
        const img = t.userData.original || t.image;
        if (!img || !img.width) continue;
        if (!t.userData.file) {   // remember the file name: the smaller copy has none
          const src = img.currentSrc || img.src;
          if (src && !/^(blob|data):/.test(src)) t.userData.file = decodeURIComponent(src.split('?')[0].split('/').pop());
        }
        const big = Math.max(img.width, img.height);
        if (big <= max) {
          if (t.userData.original) { t.image = t.userData.original; delete t.userData.original; t.needsUpdate = true; }
          continue;
        }
        const k2 = max / big, c = document.createElement('canvas');
        c.width = Math.max(1, Math.round(img.width * k2));
        c.height = Math.max(1, Math.round(img.height * k2));
        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
        t.userData.original = img;
        t.image = c;
        t.needsUpdate = true;
      }
    });
    needsRender = true;
  }
  function setQuality(q) {
    if (!QUALITY[q]) return;
    quality = q;
    renderer.setPixelRatio(QUALITY[q].pixelRatio());
    resize();
    limitTextures();
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
          for (const n of m.userData.objectNames || []) e.names.add(norm(n));
          for (const k of MAPS) {
            if (!m[k]) continue;
            const src = m[k].image && (m[k].image.currentSrc || m[k].image.src);
            const file = m[k].userData.file || (src && !/^(blob|data):/.test(src) ? decodeURIComponent(src.split('?')[0].split('/').pop()) : '');
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
    let changed = false;
    for (const e of glowEntries) {
      const goal = on.has(e) ? 1 : 0;
      if (e.w === goal) continue;
      changed = true;
      e.w = goal > e.w ? Math.min(1, e.w + step) : Math.max(0, e.w - step);
      if (e.color) e.mat.color.copy(e.color).lerp(GLOW, e.w * 0.55);
      if (e.emissive) e.mat.emissive.copy(e.emissive).add(GLOW.clone().multiplyScalar(e.w * 0.45));
    }
    return changed;
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
        if (t && !t.name && !t.userData.file && !(src && !/^(blob|data):/.test(src))) unnamedTextures++;
      }
    }
    return { textures: [...textures].sort(), materials: [...materials].sort(), unnamedTextures };
  }
  function removeModel() {
    if (model) upright.remove(model);
    model = null;
    floorGrid.visible = true;
    needsRender = true;
  }

  /* ---------- anchor planning (before installing) ---------- */
  // Proposed anchors in room coordinates (meters: x, z along the floor, h = height above the
  // model's floor) and a floor map of how many of them a phone held at PLAN_PHONE_H can see with no
  // wall, partition or display case in between: green 4+, yellow 3, red 2 or fewer.
  const PLAN_PHONE_H = 1.3, PLAN_CELL = 0.4;
  const planGroup = new THREE.Group();
  planGroup.visible = false;
  scene.add(planGroup);
  let plan = [], planFloorY = 0, planLabels = [], coverageRun = 0, onCoverage = null;
  const planMat = new THREE.MeshStandardMaterial({ color: 0xe8812a, emissive: 0x7a3a00 });
  const planPoleMat = new THREE.LineDashedMaterial({ color: 0xe8812a, dashSize: 0.08, gapSize: 0.06 });
  const planGeo = new THREE.OctahedronGeometry(0.13);

  function modelBox() { return new THREE.Box3().setFromObject(modelGroup); }
  let planCentre = null;   // a floor point inside the room being planned (the model's middle unless picked)
  // The room's inside: from its centre at 1.5 m, the nearest wall to the left, right, front and back
  function roomInterior() {
    if (!planMeshes.length || !planMeshes[0].geometry.boundsTree) prepareRays();
    const b = modelBox(), c = planCentre ? planCentre.clone() : b.getCenter(new THREE.Vector3());
    planFloorY = b.min.y;
    const y = planFloorY + 1.5;
    const side = (ox, oz, dx, dz, fallback) => {
      const d = firstHit(new THREE.Vector3(ox, y, oz), new THREE.Vector3(dx, 0, dz), 100);
      return d === null ? fallback : d;
    };
    // First guess from the centre, then 7 parallel rays across that width: a partition or a display
    // case only stops some of them, so the second farthest wall counts (one ray out of a door is ignored)
    let r = {
      x0: c.x - side(c.x, c.z, -1, 0, c.x - b.min.x), x1: c.x + side(c.x, c.z, 1, 0, b.max.x - c.x),
      z0: c.z - side(c.x, c.z, 0, -1, c.z - b.min.z), z1: c.z + side(c.x, c.z, 0, 1, b.max.z - c.z),
    };
    const across = (a0, a1) => [...Array(7)].map((_, k) => a0 + (a1 - a0) * (k + 0.5) / 7);
    const far = list => { list.sort((p, q) => q - p); return list[Math.min(1, list.length - 1)]; };
    const zs = across(r.z0, r.z1), xs = across(r.x0, r.x1);
    return {
      x0: c.x - Math.min(c.x - b.min.x, far(zs.map(z => side(c.x, z, -1, 0, 0)))),
      x1: c.x + Math.min(b.max.x - c.x, far(zs.map(z => side(c.x, z, 1, 0, 0)))),
      z0: c.z - Math.min(c.z - b.min.z, far(xs.map(x => side(x, c.z, 0, -1, 0)))),
      z1: c.z + Math.min(b.max.z - c.z, far(xs.map(x => side(x, c.z, 0, 1, 0)))),
    };
  }
  // Four corners alternating high and low, and a high anchor on a stand in the middle
  function suggestPlan() {
    const r = roomInterior(), i = 0.3;
    const x0 = r.x0 + i, x1 = r.x1 - i, z0 = r.z0 + i, z1 = r.z1 - i;
    return [{ x: x0, z: z1, h: 2.7 }, { x: x1, z: z1, h: 1.0 }, { x: x1, z: z0, h: 2.7 }, { x: x0, z: z0, h: 1.0 }, { x: (x0 + x1) / 2, z: (z0 + z1) / 2, h: 2.7 }];
  }
  // Click on the floor of the room to plan (when the model has several rooms)
  function pickPlanCentre(done) {
    pick((local, hit) => { planCentre = hit.world.clone(); if (done) done(); });
  }
  function setPlan(list) {
    plan = list.map(a => ({ x: +a.x, z: +a.z, h: +a.h }));
    renderPlan();
    computeCoverage();
  }
  function showPlan(on) {
    planGroup.visible = !!on;
    for (const l of planLabels) l.hidden = !on;
    needsRender = true;
    if (on) computeCoverage();
  }
  function renderPlan() {
    planGroup.clear();
    planLabels.forEach(l => l.remove());
    planLabels = [];
    if (!model) return;
    planFloorY = modelBox().min.y;
    plan.forEach((a, i) => {
      const top = new THREE.Vector3(a.x, planFloorY + a.h, a.z);
      const m = new THREE.Mesh(planGeo, planMat);
      m.position.copy(top);
      const pole = new THREE.Line(new THREE.BufferGeometry().setFromPoints([top, new THREE.Vector3(a.x, planFloorY, a.z)]), planPoleMat);
      pole.computeLineDistances();
      planGroup.add(m, pole);
      const l = document.createElement('div');
      l.className = 'roomlabel planlabel';
      l.textContent = `A${i + 1} · ${a.h.toFixed(1)} m`;
      l.hidden = !planGroup.visible;
      container.appendChild(l);
      planLabels.push(l);
    });
    needsRender = true;
  }
  function placePlanLabels() {
    if (!planGroup.visible) return;
    plan.forEach((a, i) => {
      const v = new THREE.Vector3(a.x, planFloorY + a.h + 0.25, a.z).project(camera), l = planLabels[i];
      if (!l) return;
      l.hidden = v.z > 1;
      l.style.left = ((v.x + 1) / 2 * container.clientWidth) + 'px';
      l.style.top = ((1 - v.y) / 2 * container.clientHeight) + 'px';
    });
  }
  // Move anchor i to the next click: on a wall it goes 25 cm out from it (as on a bracket)
  function movePlanAnchor(i, done) {
    pick((local, hit) => {
      const n = hit.normal, flat = new THREE.Vector3(n.x, 0, n.z);
      const p = hit.world.clone();
      if (Math.abs(n.y) < 0.5 && flat.lengthSq() > 0) p.addScaledVector(flat.normalize(), 0.25);
      plan[i] = { ...plan[i], x: p.x, z: p.z };
      renderPlan();
      computeCoverage();
      if (done) done(plan);
    });
  }

  // Line of sight is checked against the model on both sides of every surface, sped up with a
  // bounding volume tree per mesh (built once)
  let planMeshes = [];
  const inv = new THREE.Matrix4(), localRay = new THREE.Ray();
  function prepareRays() {
    planMeshes = [];
    model.updateMatrixWorld(true);
    model.traverse((o) => {
      if (!o.isMesh || !o.geometry.attributes.position) return;
      if (!o.geometry.boundsTree) o.geometry.boundsTree = new MeshBVH(o.geometry);
      planMeshes.push(o);
    });
  }
  function firstHit(origin, dir, far) {   // distance to the nearest surface along dir, or null
    let best = null;
    for (const m of planMeshes) {
      inv.copy(m.matrixWorld).invert();
      localRay.set(origin, dir).applyMatrix4(inv);
      const h = m.geometry.boundsTree.raycastFirst(localRay, THREE.DoubleSide);
      if (!h) continue;
      const d = h.point.applyMatrix4(m.matrixWorld).distanceTo(origin);
      if (d <= far && (best === null || d < best)) best = d;
    }
    return best;
  }
  let coverageMesh = null;
  async function computeCoverage() {
    const run = ++coverageRun;
    if (!model || !planGroup.visible || !plan.length) return;
    await new Promise(r => setTimeout(r, 30));   // let several quick changes settle
    if (run !== coverageRun) return;
    if (!planMeshes.length || !planMeshes[0].geometry.boundsTree) prepareRays();
    const r = roomInterior(), down = new THREE.Vector3(0, -1, 0), cells = [];
    const tops = plan.map(a => new THREE.Vector3(a.x, planFloorY + a.h, a.z));
    let t0 = performance.now();
    for (let x = r.x0 + PLAN_CELL / 2; x < r.x1; x += PLAN_CELL) {
      for (let z = r.z0 + PLAN_CELL / 2; z < r.z1; z += PLAN_CELL) {
        // the floor below this spot: the first surface under phone height, low enough to stand on
        const start = new THREE.Vector3(x, planFloorY + PLAN_PHONE_H, z);
        const fd = firstHit(start, down, PLAN_PHONE_H + 0.5);
        if (fd === null || PLAN_PHONE_H - fd > 0.4) continue;   // outside the model, or on a case or wall top
        const floorY = start.y - fd, eye = new THREE.Vector3(x, floorY + PLAN_PHONE_H, z);
        let seen = 0;
        for (const top of tops) {
          const d = top.clone().sub(eye), len = d.length();
          if (firstHit(eye, d.normalize(), len - 0.2) === null) seen++;
        }
        cells.push({ x, z, y: floorY + 0.02, seen });
        if (performance.now() - t0 > 25) {   // keep the page responsive
          await new Promise(r => setTimeout(r));
          if (run !== coverageRun) return;
          t0 = performance.now();
        }
      }
    }
    if (coverageMesh) { planGroup.remove(coverageMesh); coverageMesh.geometry.dispose(); }
    const quad = new THREE.PlaneGeometry(PLAN_CELL * 0.92, PLAN_CELL * 0.92).rotateX(-Math.PI / 2);
    coverageMesh = new THREE.InstancedMesh(quad, new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.55, depthWrite: false }), Math.max(1, cells.length));
    const mtx = new THREE.Matrix4(), col = new THREE.Color();
    const count = { good: 0, ok: 0, bad: 0 };
    cells.forEach((c, i) => {
      mtx.makeTranslation(c.x, c.y, c.z);
      coverageMesh.setMatrixAt(i, mtx);
      const k = c.seen >= 4 ? 'good' : c.seen === 3 ? 'ok' : 'bad';
      count[k]++;
      coverageMesh.setColorAt(i, col.set(k === 'good' ? 0x2fbf71 : k === 'ok' ? 0xf2c14e : 0xe5534b));
    });
    coverageMesh.count = cells.length;
    planGroup.add(coverageMesh);
    needsRender = true;
    let far = 0;
    for (let i = 0; i < tops.length; i++) for (let j = i + 1; j < tops.length; j++) far = Math.max(far, tops[i].distanceTo(tops[j]));
    if (onCoverage) onCoverage({ ...count, total: cells.length, maxDistance: far });
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
    const normal = hit.face ? hit.face.normal.clone().transformDirection(hit.object.matrixWorld) : new THREE.Vector3(0, 1, 0);
    cb(modelGroup.worldToLocal(hit.point.clone()), { world: hit.point.clone(), normal });
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
    show() { if (!running) { running = true; needsRender = true; resize(); requestAnimationFrame(frame); } },
    hide() { running = false; label.hidden = true; },
    loadModel, removeModel, setAlign, setUpright, resetView, pick, alignFromPoints, glowMatches, modelNames,
    get hasModel() { return !!model; },
    get model() { return model; },
    get stats() { return stats; },
    suggestPlan, setPlan, showPlan, movePlanAnchor, pickPlanCentre,
    get planCentre() { return planCentre; },
    set planCentre(p) { planCentre = p ? new THREE.Vector3(p.x, p.y || 0, p.z) : null; },
    get plan() { return plan; },
    set onCoverage(fn) { onCoverage = fn; },
    setShowAs(v) { if (['phone', 'person', 'both'].includes(v)) { showAs = v; needsRender = true; lastStateKey = ''; } },
    setQuality,
  };
}
