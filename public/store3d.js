// Dashboard 3D town: every crawled store as a storefront on a small street grid, in four district
// blocks (Market, Clothing, Electronics, Food), and four robots, one per district, each with a car
// in the parking lot in front of the iPromotion HQ.
// - Refresh: each robot drives (shortest route over the streets, right-hand lane, turning at the
//   crossings) to the store of its district that is being crawled, parks at the curb, walks to the
//   door and scans the shop, then moves on; when the district is done it drives back to the lot and
//   celebrates, or slumps if a store failed. It follows /api/status (updateStore3d from dashboard.js).
// - "Find all discounts": the same tour on demand, without crawling: each robot visits all its
//   stores and reads out their deals.
// - Click a storefront: its robot drives there and reads out the store's best deals. Click a robot:
//   it says which stores it looks after.
// Shop windows show each store's two best deals (GET /api/stores/top, real product photos).
//
// three.js loads from the CDN in the import map (index.html) only when the dashboard is opened.
// Robots and cars are built from primitives and posed in code (no model files), following the
// procedural agents of github.com/lucwj/ai-agent-3d-prompts: pose functions per state, blended by
// weights. The scene renders only while it is on screen and the tab is visible.

// ---------- the map ----------
// Streets run along these lines (2 m wide); the blocks between them hold the shops. Columns: left
// districts, the HQ/parking column, right districts. Rows: back and front districts.
const STREET_X = [-16, -4, 4, 16];
const STREET_Z = [-6, 0, 6];
const ROAD_HALF = 1;
const LANE = 0.45; // right-hand lane, from the street's centre line
const SHOP_GAP = 2;

const DISTRICTS = [
  { segment: 'groceries', bot: 'Market bot', label: 'Market', color: 0x2e9e5b, col: 0, row: 0, spot: -2.1, page: '/promotions' },
  { segment: 'clothing', bot: 'Cloth bot', label: 'Clothing', color: 0x8b5cf6, col: 2, row: 0, spot: 2.1, page: '/clothing' },
  { segment: 'electronics', bot: 'Tech bot', label: 'Electronics', color: 0x3b82f6, col: 0, row: 1, spot: -0.7, page: '/electronics' },
  { segment: 'food', bot: 'Food bot', label: 'Food', color: 0xe5484d, col: 2, row: 1, spot: 0.7, page: '/food' },
];
const BOT_SCALE = 0.62;
const CAR_SCALE = 1.15;
const LOT_Z = 2.7; // parking spots in the front-centre block, noses to the street at z = 0

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const euro = (n) => (n == null ? '' : `${Number(n).toFixed(2).replace('.', ',').replace(/,00$/, '')} €`);
const hex = (n) => `#${n.toString(16).padStart(6, '0')}`;
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
const coarse = matchMedia('(pointer: coarse)').matches;
const damp = (a, b, lambda, dt) => a + (b - a) * (1 - Math.exp(-lambda * dt));
const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));

// A block's area between streets: col 0..2, row 0..1.
const block = (col, row) => ({ x0: STREET_X[col] + ROAD_HALF, x1: STREET_X[col + 1] - ROAD_HALF, z0: STREET_Z[row] + ROAD_HALF, z1: STREET_Z[row + 1] - ROAD_HALF });

// Street graph: crossings are nodes, street pieces between them are edges.
const NODES = STREET_X.flatMap((x) => STREET_Z.map((z) => ({ id: `${x},${z}`, x, z })));
const EDGES = [
  ...STREET_Z.flatMap((z) => STREET_X.slice(1).map((x, i) => [`${STREET_X[i]},${z}`, `${x},${z}`])),
  ...STREET_X.flatMap((x) => STREET_Z.slice(1).map((z, i) => [`${x},${STREET_Z[i]}`, `${x},${z}`])),
];
const node = (id) => NODES.find((n) => n.id === id);
const dist = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);
// The street piece of row z (horizontal) that contains x.
const edgeAlongZ = (z, x) => EDGES.find(([a, b]) => node(a).z === z && node(b).z === z && Math.min(node(a).x, node(b).x) <= x && x <= Math.max(node(a).x, node(b).x));

// Ground height: pavement blocks are raised 12 cm, the parking lot is flush with the street.
const isLot = (x, z) => Math.abs(x) < STREET_X[2] - ROAD_HALF && z > STREET_Z[1] + ROAD_HALF && z < STREET_Z[2] - ROAD_HALF;
function groundY(x, z) {
  if (isLot(x, z)) return 0.02;
  const onStreet = STREET_X.some((sx) => Math.abs(x - sx) < ROAD_HALF) || STREET_Z.some((sz) => Math.abs(z - sz) < ROAD_HALF);
  return onStreet ? 0 : 0.12;
}

// The nearest point on the streets, for a car that changes plans halfway (or leaves the lot).
function nearestStreet(p) {
  let best = null;
  for (const e of EDGES) {
    const a = node(e[0]);
    const b = node(e[1]);
    const l2 = (b.x - a.x) ** 2 + (b.z - a.z) ** 2;
    const t = Math.max(0, Math.min(1, ((p.x - a.x) * (b.x - a.x) + (p.z - a.z) * (b.z - a.z)) / l2));
    const q = { x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t };
    const d = dist(p, q);
    if (!best || d < best.d) best = { d, curb: q, edge: e };
  }
  return best;
}

// Shortest route between two curb points on the street graph, as waypoints in the right-hand lane.
function route(from, to) {
  if (from.edge === to.edge) return [to.curb];
  // Dijkstra from the two ends of the start piece.
  const d = new Map(NODES.map((n) => [n.id, Infinity]));
  const prev = new Map();
  for (const id of from.edge) d.set(id, dist(from.curb, node(id)));
  const open = new Set(NODES.map((n) => n.id));
  while (open.size) {
    let u = null;
    for (const id of open) if (u === null || d.get(id) < d.get(u)) u = id;
    open.delete(u);
    for (const [a, b] of EDGES) {
      const v = a === u ? b : b === u ? a : null;
      if (!v || !open.has(v)) continue;
      const alt = d.get(u) + dist(node(u), node(v));
      if (alt < d.get(v)) (d.set(v, alt), prev.set(v, u));
    }
  }
  const end = to.edge.reduce((best, id) => (d.get(id) + dist(node(id), to.curb) < d.get(best) + dist(node(best), to.curb) ? id : best));
  const ids = [end];
  while (prev.has(ids[0])) ids.unshift(prev.get(ids[0]));
  const raw = [from.curb, ...ids.map(node), to.curb];
  // Crossing points shifted into the right-hand lane: in and out lanes meet at the turn.
  const right = (p, q) => {
    const l = dist(p, q) || 1;
    return { x: -(q.z - p.z) / l, z: (q.x - p.x) / l };
  };
  const pts = [];
  for (let i = 1; i < raw.length - 1; i++) {
    const r1 = right(raw[i - 1], raw[i]);
    const r2 = right(raw[i], raw[i + 1]);
    const straight = Math.abs(r1.x - r2.x) + Math.abs(r1.z - r2.z) < 0.01;
    pts.push({ x: raw[i].x + (straight ? r1.x : r1.x + r2.x) * LANE, z: raw[i].z + (straight ? r1.z : r1.z + r2.z) * LANE });
  }
  pts.push(to.curb);
  return pts;
}

let THREE;
let root, canvasBox, labelEl, tourBtn;
let renderer, scene, camera, controls, timer, raycaster;
let started = false;
let failed = false;
let visible = false;
let onScreen = true;
let status = null; // latest /api/status
let statusReady;
const firstStatus = new Promise((r) => (statusReady = r));
let top = {}; // store key -> { store, total, avgDiscount, items }
const bots = [];
const shops = new Map(); // store key -> { name, group, lamp, windows, district, loc, door }
let lastStores = {};
let tmp;

// ---------- textures ----------

function canvasTexture(w, h, draw) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  draw(c.getContext('2d'), w, h);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, r);
}

// A store's sign: its logo when there is one (same-origin file in public/logos), else its name.
// Drawn at 1024 px with the GPU's best filtering, so it stays sharp when small or seen at an angle.
function signTexture(store, logoImg) {
  const tex = canvasTexture(1024, 288, (ctx, w, h) => {
    roundRect(ctx, 6, 6, w - 12, h - 12, 40);
    ctx.fillStyle = '#ffffff';
    ctx.fill();
    ctx.lineWidth = 12;
    ctx.strokeStyle = store.color ?? '#555';
    ctx.stroke();
    // The name in the largest bold type that fits `room` px, centred on x.
    const name = (x, room) => {
      ctx.fillStyle = store.color ?? '#222';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      let size = 150;
      do ctx.font = `800 ${(size -= 6)}px system-ui, sans-serif`;
      while (ctx.measureText(store.name).width > room && size > 48);
      ctx.fillText(store.name, x, h / 2 + 6);
    };
    const ratio = logoImg ? logoImg.naturalWidth / logoImg.naturalHeight || 3 : 0;
    if (logoImg && ratio >= 1.8) {
      // A wide logo (a wordmark) fills the plate, keeping its proportions.
      let lh = h - 84;
      let lw = lh * ratio;
      if (lw > w - 110) (lw = w - 110), (lh = lw / ratio);
      ctx.drawImage(logoImg, (w - lw) / 2, (h - lh) / 2, lw, lh);
    } else if (logoImg) {
      // A square-ish logo (Lidl, Hesburger…) would be tiny alone: logo on the left, name beside it.
      const lh = h - 70;
      const lw = Math.min(lh * ratio, 300);
      ctx.drawImage(logoImg, 48, (h - lh) / 2, lw, lh);
      name(48 + lw + (w - 48 - lw - 40) / 2, w - lw - 130);
    } else name(w / 2, w - 100);
  });
  tex.anisotropy = renderer.capabilities.getMaxAnisotropy();
  return tex;
}

// A floating district sign that always faces the camera.
function billboard(text, color) {
  const tex = canvasTexture(512, 128, (ctx, w, h) => {
    roundRect(ctx, 4, 4, w - 8, h - 8, 56);
    ctx.fillStyle = color;
    ctx.fill();
    ctx.fillStyle = '#fff';
    ctx.font = '800 64px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, w / 2, h / 2 + 3);
  });
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthWrite: false }));
  s.scale.set(3.4, 0.85, 1);
  return s;
}

// Product photo for a shop window. Many store image servers allow cross-origin use; when one
// doesn't, the window just stays glass.
const loader = () => (loader.l ??= Object.assign(new THREE.TextureLoader(), { crossOrigin: 'anonymous' }));
function windowPhoto(material, url) {
  if (!/^https:\/\//.test(url ?? '')) return;
  const sized = url.includes('keskofiles.com') ? `${url}${url.includes('?') ? '&' : '?'}w=256` : url;
  loader().load(
    sized,
    (t) => {
      t.colorSpace = THREE.SRGBColorSpace;
      material.map = t;
      material.color.set(0xffffff);
      material.needsUpdate = true;
    },
    undefined,
    () => {},
  );
}

// ---------- the town ----------

function buildStreets() {
  const xs = [STREET_X[0] - 1.5, STREET_X.at(-1) + 1.5];
  const zs = [STREET_Z[0] - 1.5, STREET_Z.at(-1) + 1.5];
  const asphalt = new THREE.Mesh(new THREE.PlaneGeometry(xs[1] - xs[0], zs[1] - zs[0]), new THREE.MeshStandardMaterial({ color: 0x5a5f69, roughness: 0.95 }));
  asphalt.rotation.x = -Math.PI / 2;
  asphalt.receiveShadow = true;
  scene.add(asphalt);

  // Blocks: raised pavement; the district blocks get grass behind the shops.
  const pave = new THREE.MeshStandardMaterial({ color: 0xece5d8, roughness: 0.9 });
  const grass = new THREE.MeshStandardMaterial({ color: 0x9fc48a, roughness: 1 });
  const lotMat = new THREE.MeshStandardMaterial({ color: 0x6d727c, roughness: 0.9 });
  for (let col = 0; col < 3; col++)
    for (let row = 0; row < 2; row++) {
      const b = block(col, row);
      const lot = col === 1 && row === 1;
      const h = lot ? 0.02 : 0.12;
      const slab = new THREE.Mesh(new THREE.BoxGeometry(b.x1 - b.x0, h, b.z1 - b.z0), lot ? lotMat : pave);
      slab.position.set((b.x0 + b.x1) / 2, h / 2, (b.z0 + b.z1) / 2);
      slab.receiveShadow = true;
      scene.add(slab);
      if (col !== 1) {
        const lawn = new THREE.Mesh(new THREE.BoxGeometry(b.x1 - b.x0 - 0.6, 0.02, 1.2), grass);
        lawn.position.set((b.x0 + b.x1) / 2, 0.13, b.z0 + 0.9);
        lawn.receiveShadow = true;
        scene.add(lawn);
      }
    }

  // Dashed centre lines and crosswalks, as instanced meshes (one draw call each).
  const dashes = [];
  for (const [a, b] of EDGES) {
    const p = node(a);
    const q = node(b);
    const len = dist(p, q) - 2 * ROAD_HALF - 0.6;
    const n = Math.floor(len / 1.0);
    for (let i = 0; i < n; i++) {
      const t = (ROAD_HALF + 0.3 + 0.25 + i * 1.0) / dist(p, q);
      dashes.push({ x: p.x + (q.x - p.x) * t, z: p.z + (q.z - p.z) * t, rot: p.z === q.z ? 0 : Math.PI / 2 });
    }
  }
  const stripes = [];
  for (const n of NODES)
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const x = n.x + dx * (ROAD_HALF + 0.35);
      const z = n.z + dz * (ROAD_HALF + 0.35);
      const along = dx === 0; // stripes run along the street being crossed
      if (Math.abs(x) > STREET_X.at(-1) + 1 || Math.abs(z) > STREET_Z.at(-1) + 1) continue;
      for (let i = -3; i <= 3; i++) stripes.push({ x: x + (along ? i * 0.28 : 0), z: z + (along ? 0 : i * 0.28), rot: along ? Math.PI / 2 : 0 });
    }
  const white = new THREE.MeshBasicMaterial({ color: 0xf4f1e8 });
  for (const [list, w, d] of [[dashes, 0.5, 0.07], [stripes, 0.5, 0.14]]) {
    const im = new THREE.InstancedMesh(new THREE.BoxGeometry(w, 0.01, d), white, list.length);
    const o = new THREE.Object3D();
    list.forEach((p, i) => {
      o.position.set(p.x, 0.012, p.z);
      o.rotation.set(0, p.rot, 0);
      o.updateMatrix();
      im.setMatrixAt(i, o.matrix);
    });
    scene.add(im);
  }

  // Street lamps at the crossings, trees along the blocks.
  const poleMat = new THREE.MeshStandardMaterial({ color: 0x2b2f3a, roughness: 0.5 });
  const bulbMat = new THREE.MeshStandardMaterial({ color: 0xfff3c4, emissive: 0xffe9a0, emissiveIntensity: 1 });
  for (const n of NODES.filter((n) => Math.abs(n.x) < STREET_X.at(-1))) {
    const x = n.x + ROAD_HALF + 0.25;
    const z = n.z - ROAD_HALF - 0.25;
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.05, 1.8, 8), poleMat);
    pole.position.set(x, 0.9, z);
    const bulb = new THREE.Mesh(new THREE.SphereGeometry(0.11, 12, 8), bulbMat);
    bulb.position.set(x, 1.85, z);
    pole.castShadow = true;
    scene.add(pole, bulb);
  }
  const trunkMat = new THREE.MeshStandardMaterial({ color: 0x8a6a4a });
  const leafMat = new THREE.MeshStandardMaterial({ color: 0x3f8f5a, roughness: 0.8 });
  const trees = [];
  for (let col = 0; col < 3; col++)
    for (let row = 0; row < 2; row++) {
      const b = block(col, row);
      if (col === 1 && row === 1) continue; // the parking lot
      for (let x = b.x0 + 0.8; x <= b.x1 - 0.7; x += col === 1 ? 2.4 : 2) trees.push([x, b.z0 + 0.6]);
    }
  for (const [x, z] of trees) {
    const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.08, 0.5, 8), trunkMat);
    trunk.position.set(x, 0.37, z);
    const crown = new THREE.Mesh(new THREE.IcosahedronGeometry(0.42, 1), leafMat);
    crown.position.set(x, 0.95, z);
    crown.scale.y = 1.2;
    trunk.castShadow = crown.castShadow = true;
    scene.add(trunk, crown);
  }
}

// HQ building at the back of the middle column, parking lot with four marked spots in front.
function buildPlaza() {
  const b = block(1, 0);
  const hq = new THREE.Mesh(new THREE.BoxGeometry(4.6, 1.9, 2), new THREE.MeshStandardMaterial({ color: 0x0f7b5f, roughness: 0.6 }));
  hq.position.set(0, 1.07, b.z1 - 1.5);
  hq.castShadow = hq.receiveShadow = true;
  const roof = new THREE.Mesh(new THREE.BoxGeometry(4.8, 0.14, 2.2), new THREE.MeshStandardMaterial({ color: 0x0b5c47 }));
  roof.position.set(0, 2.08, b.z1 - 1.5);
  const sign = new THREE.Mesh(
    new THREE.PlaneGeometry(3.6, 0.6),
    new THREE.MeshBasicMaterial({
      map: canvasTexture(768, 128, (ctx, w, h) => {
        ctx.fillStyle = '#fffaf1';
        roundRect(ctx, 2, 2, w - 4, h - 4, 18);
        ctx.fill();
        ctx.fillStyle = '#0f7b5f';
        ctx.font = '800 66px system-ui, sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('iPromotion HQ', w / 2, h / 2 + 3);
      }),
    }),
  );
  sign.position.set(0, 1.55, b.z1 - 0.49);
  const door = new THREE.Mesh(new THREE.PlaneGeometry(0.8, 0.9), new THREE.MeshStandardMaterial({ color: 0x2b2f3a }));
  door.position.set(0, 0.57, b.z1 - 0.49);
  scene.add(hq, roof, sign, door);
  // Spot lines and a colour stripe per bot.
  const line = new THREE.MeshBasicMaterial({ color: 0xf4f1e8 });
  for (const x of [-2.8, -1.4, 0, 1.4, 2.8]) {
    const l = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.01, 1.9), line);
    l.position.set(x, 0.025, LOT_Z);
    scene.add(l);
  }
  for (const d of DISTRICTS) {
    const s = new THREE.Mesh(new THREE.BoxGeometry(1.1, 0.01, 0.12), new THREE.MeshBasicMaterial({ color: d.color }));
    s.position.set(d.spot, 0.025, LOT_Z + 0.9);
    scene.add(s);
  }
}

function buildShop(store, d, index) {
  const b = block(d.col, d.row);
  // Shops line the block's front edge, nearest the middle first, facing the street in front.
  const inner = d.col === 0 ? b.x1 : b.x0;
  const dir = d.col === 0 ? -1 : 1;
  const x = inner + dir * (1 + index * SHOP_GAP);
  const z = b.z1 - 1.05;
  const color = new THREE.Color(store.color ?? '#888');
  const g = new THREE.Group();
  g.position.set(x, 0.12, z);
  const body = new THREE.Mesh(new THREE.BoxGeometry(1.75, 1.45, 1.3), new THREE.MeshStandardMaterial({ color: 0xfffaf2, roughness: 0.8 }));
  body.position.y = 0.725;
  const roof = new THREE.Mesh(new THREE.BoxGeometry(1.85, 0.12, 1.4), new THREE.MeshStandardMaterial({ color: color.clone().multiplyScalar(0.7), roughness: 0.6 }));
  roof.position.y = 1.5;
  const awning = new THREE.Mesh(new THREE.BoxGeometry(1.8, 0.06, 0.45), new THREE.MeshStandardMaterial({ color, roughness: 0.5 }));
  awning.position.set(0, 1.0, 0.85);
  awning.rotation.x = 0.35;
  const door = new THREE.Mesh(new THREE.PlaneGeometry(0.42, 0.72), new THREE.MeshStandardMaterial({ color: 0x2b2f3a, roughness: 0.4 }));
  door.position.set(0, 0.36, 0.651);
  const sign = new THREE.Mesh(new THREE.PlaneGeometry(1.5, 0.42), new THREE.MeshBasicMaterial({ map: signTexture(store) }));
  sign.position.set(0, 1.24, 0.652);
  // The same logo on a plate above the roof, always turned to the camera so it reads straight on.
  const plate = new THREE.Sprite(new THREE.SpriteMaterial({ map: sign.material.map }));
  plate.scale.set(1.85, 0.52, 1);
  plate.position.set(0, 2.05, 0.2);
  if (store.logo) {
    const img = new Image();
    img.onload = () => {
      sign.material.map.dispose();
      sign.material.map = plate.material.map = signTexture(store, img);
      sign.material.needsUpdate = plate.material.needsUpdate = true;
    };
    img.src = store.logo;
  }
  const windows = [-0.55, 0.55].map((wx) => {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(0.46, 0.46), new THREE.MeshStandardMaterial({ color: 0xbfe0ee, roughness: 0.2, metalness: 0.1 }));
    m.position.set(wx, 0.55, 0.652);
    return m;
  });
  const lamp = new THREE.Mesh(new THREE.SphereGeometry(0.07, 16, 12), new THREE.MeshStandardMaterial({ color: 0x5fd39a, emissive: 0x5fd39a, emissiveIntensity: 1 }));
  lamp.position.set(0.8, 1.42, 0.66);
  g.add(body, roof, awning, door, sign, plate, lamp, ...windows);
  g.traverse((m) => m.isMesh && ((m.castShadow = true), (m.receiveShadow = true)));
  g.userData.shop = store.key;
  scene.add(g);
  // The car parks in the near lane of the street in front, a little towards the middle, and the
  // robot walks from the curb to the door.
  const streetZ = STREET_Z[d.row + 1];
  const parkX = x - dir * 0.9;
  shops.set(store.key, {
    key: store.key,
    name: store.name,
    group: g,
    lamp,
    windows,
    district: d,
    loc: { curb: { x: parkX, z: streetZ - LANE }, edge: edgeAlongZ(streetZ, parkX) },
    door: { x, z: b.z1 - 0.2 },
  });
}

function fillWindows() {
  for (const [key, shop] of shops) {
    const items = top[key]?.items ?? [];
    shop.windows.forEach((w, i) => items[i] && windowPhoto(w.material, items[i].image));
  }
}

// Green lamp: last refresh worked; amber: it failed (previous deals still shown).
function setLamps() {
  for (const [key, shop] of shops) {
    const st = status?.stores?.find((s) => s.key === key)?.status;
    const c = st && !st.ok ? 0xf0a24a : 0x5fd39a;
    shop.lamp.material.color.setHex(c);
    shop.lamp.material.emissive.setHex(c);
  }
}

// ---------- robots and cars ----------

function buildBot(color) {
  const white = new THREE.MeshStandardMaterial({ color: 0xf7f5f0, roughness: 0.35, metalness: 0.1 });
  const dark = new THREE.MeshStandardMaterial({ color: 0x1d2230, roughness: 0.3, metalness: 0.3 });
  const accent = new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 0.6, roughness: 0.4 });
  const eyeMat = new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0x9fe8ff, emissiveIntensity: 1.6 });
  const mesh = (geo, mat, x = 0, y = 0, z = 0) => {
    const m = new THREE.Mesh(geo, mat);
    m.position.set(x, y, z);
    m.castShadow = true;
    return m;
  };
  const group = new THREE.Group();
  const body = new THREE.Group();
  group.add(body);
  const hips = mesh(new THREE.BoxGeometry(0.42, 0.16, 0.26), dark, 0, 0.78, 0);
  const torso = new THREE.Group();
  torso.position.y = 0.86;
  torso.add(mesh(new THREE.CapsuleGeometry(0.27, 0.32, 6, 16), white, 0, 0.3, 0));
  torso.add(mesh(new THREE.CircleGeometry(0.1, 24), accent, 0, 0.36, 0.272));
  const head = new THREE.Group();
  head.position.y = 0.82;
  head.add(mesh(new THREE.BoxGeometry(0.56, 0.42, 0.46), white));
  const eyeGeo = new THREE.CapsuleGeometry(0.035, 0.05, 4, 8);
  const eyeL = mesh(eyeGeo, eyeMat, -0.1, 0.01, 0.255);
  const eyeR = mesh(eyeGeo, eyeMat, 0.1, 0.01, 0.255);
  const bulb = mesh(new THREE.SphereGeometry(0.06, 16, 12), accent, 0, 0.39, 0);
  head.add(mesh(new THREE.BoxGeometry(0.46, 0.22, 0.04), dark, 0, 0.01, 0.232), eyeL, eyeR, mesh(new THREE.CylinderGeometry(0.015, 0.015, 0.16), dark, 0, 0.29, 0), bulb);
  torso.add(head);
  const limb = (len, r) => new THREE.CapsuleGeometry(r, len, 4, 12).translate(0, -len / 2 - r, 0); // pivot at the top
  const arm = (side) => {
    const shoulder = new THREE.Group();
    shoulder.position.set(side * 0.36, 0.5, 0);
    shoulder.add(mesh(limb(0.36, 0.07), white));
    const hand = mesh(new THREE.SphereGeometry(0.085, 16, 12), dark, 0, -0.56, 0);
    shoulder.add(hand);
    torso.add(shoulder);
    return { shoulder, hand };
  };
  const leg = (side) => {
    const hip = new THREE.Group();
    hip.position.set(side * 0.13, 0.76, 0);
    hip.add(mesh(limb(0.5, 0.08), dark));
    hip.add(mesh(new THREE.BoxGeometry(0.16, 0.08, 0.26), dark, 0, -0.7, 0.04));
    body.add(hip);
    return hip;
  };
  body.add(hips, torso);
  const armL = arm(-1);
  const armR = arm(1);
  const legL = leg(-1);
  const legR = leg(1);
  // Scanner beam from the right hand (tip in the hand, along the arm).
  const beam = new THREE.Mesh(
    new THREE.ConeGeometry(0.3, 1.4, 24, 1, true).translate(0, -0.7, 0),
    new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0, depthWrite: false, side: THREE.DoubleSide }),
  );
  armR.hand.add(beam);
  return { group, body, torso, head, armL, armR, legL, legR, eyes: [eyeL, eyeR], bulb, beam };
}

// An open-top car in the district's colour; the robot sits in it while driving.
function buildCar(color) {
  const car = new THREE.Group();
  const paint = new THREE.MeshStandardMaterial({ color, roughness: 0.35, metalness: 0.2 });
  const dark = new THREE.MeshStandardMaterial({ color: 0x1d2230, roughness: 0.6 });
  const glass = new THREE.MeshStandardMaterial({ color: 0xbfe0ee, roughness: 0.1, transparent: true, opacity: 0.7 });
  const body = new THREE.Mesh(new THREE.BoxGeometry(0.72, 0.24, 1.3), paint);
  body.position.y = 0.28;
  const nose = new THREE.Mesh(new THREE.BoxGeometry(0.72, 0.1, 0.42), paint);
  nose.position.set(0, 0.44, 0.42);
  const tail = new THREE.Mesh(new THREE.BoxGeometry(0.72, 0.12, 0.28), paint);
  tail.position.set(0, 0.45, -0.5);
  const shield = new THREE.Mesh(new THREE.BoxGeometry(0.64, 0.2, 0.03), glass);
  shield.position.set(0, 0.58, 0.2);
  shield.rotation.x = -0.35;
  const seat = new THREE.Mesh(new THREE.BoxGeometry(0.46, 0.08, 0.36), dark);
  seat.position.set(0, 0.42, -0.12);
  const lightMat = new THREE.MeshStandardMaterial({ color: 0xfff3c4, emissive: 0xfff0a0, emissiveIntensity: 1.2 });
  const tailMat = new THREE.MeshStandardMaterial({ color: 0xff5a5a, emissive: 0xff2020, emissiveIntensity: 0.4 });
  const lights = [-0.24, 0.24].flatMap((x) => {
    const f = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.06, 0.02), lightMat);
    f.position.set(x, 0.34, 0.66);
    const r = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.05, 0.02), tailMat);
    r.position.set(x, 0.36, -0.66);
    return [f, r];
  });
  const wheelGeo = new THREE.CylinderGeometry(0.16, 0.16, 0.12, 18).rotateZ(Math.PI / 2);
  const wheels = [[-0.38, 0.4], [0.38, 0.4], [-0.38, -0.42], [0.38, -0.42]].map(([x, z]) => {
    const w = new THREE.Mesh(wheelGeo, dark);
    w.position.set(x, 0.16, z);
    return w;
  });
  car.add(body, nose, tail, shield, seat, ...lights, ...wheels);
  car.traverse((m) => m.isMesh && (m.castShadow = true));
  car.scale.setScalar(CAR_SCALE);
  return { group: car, wheels, tailMat };
}

// Pose functions, one per state: joint angles for time t. "drive" is seated in the car.
const POSES = {
  idle: (t) => ({ bob: Math.sin(t * 2) * 0.012, lean: 0, headTilt: Math.sin(t * 0.7) * 0.05, headYaw: Math.sin(t * 0.4) * 0.25, armL: [0.05, 0.08], armR: [0.05, -0.08], legL: 0, legR: 0 }),
  walk: (t, b) => {
    const s = Math.sin(b.phase);
    return { bob: Math.abs(Math.cos(b.phase)) * 0.04, lean: 0.06, headTilt: 0, headYaw: 0, armL: [-s * 0.6, 0.08], armR: [s * 0.6, -0.08], legL: s * 0.55, legR: -s * 0.55 };
  },
  drive: (t) => ({ bob: Math.sin(t * 9) * 0.008, lean: 0.05, headTilt: 0, headYaw: Math.sin(t * 0.6) * 0.2, armL: [-1.15, 0.2], armR: [-1.15, -0.2], legL: -1.35, legR: -1.35 }),
  work: (t) => ({ bob: Math.sin(t * 3) * 0.01, lean: 0.1, headTilt: 0.1, headYaw: Math.sin(t * 1.5) * 0.3, armL: [0.1, 0.1], armR: [-1.4 + Math.sin(t * 3) * 0.12, -0.1], legL: 0, legR: 0 }),
  talk: (t) => ({ bob: Math.sin(t * 2) * 0.01, lean: -0.03, headTilt: Math.sin(t * 6) * 0.06, headYaw: 0, armL: [-0.5 + Math.sin(t * 4) * 0.25, 0.35], armR: [0.05, -0.1], legL: 0, legR: 0 }),
  celebrate: (t) => ({ bob: Math.abs(Math.sin(t * 7)) * 0.18, lean: -0.08, headTilt: -0.15, headYaw: 0, armL: [-2.6, 0.4 + Math.sin(t * 10) * 0.2], armR: [-2.6, -0.4 - Math.sin(t * 10) * 0.2], legL: 0, legR: 0 }),
  error: () => ({ bob: -0.06, lean: 0.25, headTilt: 0.45, headYaw: 0, armL: [0.15, 0.02], armR: [0.15, -0.02], legL: 0.05, legR: -0.05 }),
};
const KEYS = Object.keys(POSES);
const SCALARS = ['bob', 'lean', 'headTilt', 'headYaw', 'legL', 'legR'];

// Blend: each state's weight eases toward 1 (the current mode) or 0, and the poses mix by weight.
function applyPose(b, t, dt) {
  for (const k of KEYS) b.weights[k] = damp(b.weights[k], k === b.mode ? 1 : 0, 8, dt);
  const sum = KEYS.reduce((a, k) => a + b.weights[k], 0) || 1;
  const p = { bob: 0, lean: 0, headTilt: 0, headYaw: 0, armL: [0, 0], armR: [0, 0], legL: 0, legR: 0 };
  for (const k of KEYS) {
    const w = b.weights[k];
    if (w < 0.001) continue;
    const q = POSES[k](reduceMotion ? 0 : t + b.offset, b);
    const f = w / sum;
    for (const s of SCALARS) p[s] += q[s] * f;
    for (const a of ['armL', 'armR']) (p[a][0] += q[a][0] * f), (p[a][1] += q[a][1] * f);
  }
  const r = b.rig;
  r.body.position.y = p.bob;
  r.torso.rotation.x = p.lean;
  r.head.rotation.set(p.headTilt, p.headYaw, 0);
  r.armL.shoulder.rotation.set(p.armL[0], 0, p.armL[1]);
  r.armR.shoulder.rotation.set(p.armR[0], 0, p.armR[1]);
  r.legL.rotation.x = p.legL;
  r.legR.rotation.x = p.legR;
  r.beam.material.opacity = damp(r.beam.material.opacity, b.mode === 'work' ? 0.3 + Math.sin(t * 8) * 0.07 : 0, 10, dt);
  const blink = Math.sin((t + b.offset) * 1.3) > 0.985 ? 0.15 : 1;
  for (const e of r.eyes) e.scale.y = damp(e.scale.y, blink, 30, dt);
  r.bulb.material.emissiveIntensity = b.mode === 'work' ? 1 + Math.sin(t * 10) : b.mode === 'error' ? 0.1 : 0.6;
}

function makeBot(d) {
  const rig = buildBot(d.color);
  const car = buildCar(d.color);
  // Home: the bot's spot in the lot, nose to the street; it leaves through the curb in front.
  const home = { spot: { x: d.spot, z: LOT_Z }, loc: { curb: { x: d.spot, z: LANE }, edge: edgeAlongZ(0, d.spot) }, stand: { x: d.spot, z: LOT_Z + 1.35 } };
  car.group.position.set(home.spot.x, 0, home.spot.z);
  car.group.rotation.y = Math.PI;
  scene.add(car.group);
  const b = {
    d, rig, car, home,
    stores: [],
    weights: Object.fromEntries(KEYS.map((k) => [k, k === 'idle' ? 1 : 0])),
    mode: 'idle',
    offset: Math.random() * 10,
    phase: 0,
    inCar: false,
    heading: Math.PI,
    speed: 0,
    loc: home.loc, // where the car is on the street graph (a curb point)
    queue: [], // actions run one after another
    action: null,
    bubble: document.createElement('div'),
    sayUntil: 0,
    busy: null, // 'crawl' | 'tour' | 'show' | 'finish' | null
    target: null,
  };
  b.bubble.className = 's3-bubble';
  b.bubble.hidden = true;
  b.bubble.style.setProperty('--bot', hex(d.color));
  canvasBox.append(b.bubble);
  rig.group.userData.bot = d.segment;
  rig.group.scale.setScalar(BOT_SCALE);
  scene.add(rig.group);
  rig.group.position.set(home.stand.x, groundY(home.stand.x, home.stand.z), home.stand.z);
  return b;
}

// ---------- actions ----------

function say(b, html, seconds = 0) {
  b.bubble.innerHTML = html ? `<span class="s3-who">${esc(b.d.bot)}</span>${html}` : '';
  b.bubble.hidden = !html;
  b.sayUntil = html && seconds ? performance.now() + seconds * 1000 : Infinity;
}

const storeName = (key) => shops.get(key)?.name ?? key;

// Get into the car: walk to the nearer side of it first if the robot is out.
function boardActions(b) {
  if (b.inCar) return [];
  const side = () => {
    const c = b.car.group.position;
    const r = b.rig.group.position;
    const sx = Math.cos(b.heading) * 0.8;
    const sz = -Math.sin(b.heading) * 0.8;
    const a = { x: c.x + sx, z: c.z + sz };
    const o = { x: c.x - sx, z: c.z - sz };
    return dist(r, a) < dist(r, o) ? a : o;
  };
  return [{ type: 'walk', to: side }, { type: 'board' }];
}

function visit(b, key, then = []) {
  const s = shops.get(key);
  if (!s) return;
  b.queue.push(
    ...boardActions(b),
    { type: 'drive', to: s.loc },
    { type: 'alight', at: { x: s.loc.curb.x, z: s.loc.curb.z - 0.6 } }, // on the shop's side
    { type: 'walk', to: () => s.door, face: Math.PI },
    ...then,
  );
}

function driveHome(b, then = []) {
  b.queue.push(...boardActions(b), { type: 'drive', to: b.home.loc, park: b.home.spot }, { type: 'alight', at: b.home.stand, face: 0 }, ...then);
}

function reset(b) {
  b.queue = [];
  b.action = null;
  // Actions queued after a reset start from where things are: in the car, or standing.
  if (b.inCar) b.speed = Math.min(b.speed, 1.5);
}

// Steering: the car always drives forward along its heading and turns toward the next waypoint,
// slowing for corners and braking before the end. A sharp turn from standstill pivots in place.
function driveStep(b, a, dt) {
  const car = b.car.group;
  const pts = a.path;
  const pt = pts[0];
  if (!pt) return true;
  const dx = pt.x - car.position.x;
  const dz = pt.z - car.position.z;
  const d = Math.hypot(dx, dz);
  const last = pts.length === 1;
  if (reduceMotion) {
    car.position.x = pt.x;
    car.position.z = pt.z;
    pts.shift();
    if (pts[0]) b.heading = Math.atan2(pts[0].x - pt.x, pts[0].z - pt.z);
    car.rotation.y = b.heading;
    return !pts.length;
  }
  if (last && d < 0.45) {
    // Final metres: roll straight onto the point.
    const v = Math.max(0.4, Math.min(b.speed, d * 3));
    b.speed = v;
    if (d < 0.03) {
      car.position.x = pt.x;
      car.position.z = pt.z;
      pts.shift();
      b.speed = 0;
      return true;
    }
    const len = Math.min(d, v * dt);
    car.position.x += (dx / d) * len;
    car.position.z += (dz / d) * len;
  } else {
    const want = Math.atan2(dx, dz);
    const diff = wrap(want - b.heading);
    if (Math.abs(diff) > 1.3 && b.speed < 0.6) {
      b.heading += Math.sign(diff) * Math.min(Math.abs(diff), 3.2 * dt); // pivot
      b.speed = 0;
    } else {
      b.heading += Math.sign(diff) * Math.min(Math.abs(diff), 4.5 * dt);
      let left = d;
      for (let i = 1; i < pts.length; i++) left += dist(pts[i - 1], pts[i]);
      let cap = Math.min(4.2, Math.sqrt(2 * 5 * left) + 0.4);
      if (pts.length > 1 && d < 1.8) {
        const turn = Math.abs(wrap(Math.atan2(pts[1].x - pt.x, pts[1].z - pt.z) - Math.atan2(dx, dz)));
        if (turn > 0.5) cap = Math.min(cap, 1.6); // slow for the corner
      }
      if (Math.abs(diff) > 0.6) cap = Math.min(cap, 1.2);
      b.speed = b.speed < cap ? Math.min(cap, b.speed + 6 * dt) : Math.max(cap, b.speed - 9 * dt);
      car.position.x += Math.sin(b.heading) * b.speed * dt;
      car.position.z += Math.cos(b.heading) * b.speed * dt;
      // Corner points: take the next one once close, or once past it.
      if (!last && (d < 0.4 || (a.prevD != null && d > a.prevD && d < 0.9))) {
        pts.shift();
        a.prevD = null;
        return false;
      }
      a.prevD = d;
    }
  }
  car.rotation.y = b.heading;
  for (const w of b.car.wheels) w.rotation.x += (b.speed * dt) / 0.16;
  return false;
}

// Runs the current action a frame at a time; the next one starts when it is done.
function step(b, dt, now) {
  if (!b.action) {
    b.action = b.queue.shift() ?? null;
    if (!b.action) return;
    const a = b.action;
    a.started = now;
    if (a.type === 'drive') {
      // From where the car is: still at its last stop, or somewhere along the streets (or in the lot).
      const car = b.car.group.position;
      const from = dist(car, b.loc.curb) < 0.3 ? b.loc : isLot(car.x, car.z) ? b.home.loc : nearestStreet(car);
      a.path = [...(dist(car, from.curb) > 0.3 ? [from.curb] : []), ...route(from, a.to)];
      if (a.park) a.path.push(a.park);
    }
    if (a.say) say(b, a.say, a.sayFor ?? 0);
  }
  const a = b.action;
  const done = () => (b.action = null);
  const rig = b.rig.group;
  switch (a.type) {
    case 'board':
      b.car.group.add(rig);
      rig.position.set(0, 0.04, -0.14);
      rig.rotation.set(0, 0, 0);
      rig.scale.setScalar(BOT_SCALE / CAR_SCALE);
      b.inCar = true;
      b.mode = 'drive';
      return done();
    case 'alight':
      b.speed = 0;
      scene.attach(rig);
      rig.scale.setScalar(BOT_SCALE);
      rig.position.set(a.at.x, groundY(a.at.x, a.at.z), a.at.z);
      rig.rotation.set(0, a.face ?? b.heading, 0);
      b.inCar = false;
      b.mode = 'idle';
      b.car.tailMat.emissiveIntensity = 0.4;
      return done();
    case 'walk': {
      const to = typeof a.to === 'function' ? a.to() : a.to;
      const dx = to.x - rig.position.x;
      const dz = to.z - rig.position.z;
      const d = Math.hypot(dx, dz);
      if (d < 0.03 || reduceMotion) {
        rig.position.x = to.x;
        rig.position.z = to.z;
        if (a.face != null) rig.rotation.y = a.face;
        b.mode = 'idle';
        return done();
      }
      b.mode = 'walk';
      b.phase += dt * 10;
      const len = Math.min(d, 1.3 * dt);
      rig.position.x += (dx / d) * len;
      rig.position.z += (dz / d) * len;
      rig.position.y = groundY(rig.position.x, rig.position.z);
      rig.rotation.y += wrap(Math.atan2(dx, dz) - rig.rotation.y) * (1 - Math.exp(-12 * dt));
      return;
    }
    case 'pose':
      b.mode = a.mode;
      if (a.ms != null && now - a.started >= a.ms) done();
      return;
    case 'hold': // scanning the shop until the queue is replaced
      b.mode = 'work';
      return;
    case 'call':
      a.fn();
      return done();
    case 'drive': {
      b.mode = 'drive';
      b.car.tailMat.emissiveIntensity = b.speed < 1 ? 1.4 : 0.4; // brake lights
      if (driveStep(b, a, dt)) {
        b.loc = a.to;
        b.car.tailMat.emissiveIntensity = 0.4;
        done();
      }
      return;
    }
  }
}

// ---------- behaviours ----------

function storeInfo(key) {
  const t = top[key];
  if (!t) return `<b>${esc(storeName(key))}</b>`;
  const items = t.items
    .slice(0, 3)
    .map((i) => `<li>${esc(i.name.slice(0, 48))} <span class="s3-price">${i.price != null ? euro(i.price) : ''}</span>${i.discountPct ? ` <span class="s3-pct">-${i.discountPct}%</span>` : ''}</li>`)
    .join('');
  return `<b>${esc(t.store ?? storeName(key))}</b> · ${t.total} deals${t.avgDiscount ? `, avg -${t.avgDiscount}%` : ''}<ul>${items}</ul>`;
}

// Click on a storefront: its robot drives there and reads out the best deals.
function showShop(key) {
  const s = shops.get(key);
  const b = bots.find((x) => x.d === s?.district);
  if (!b) return;
  if (b.busy === 'crawl' || b.busy === 'tour') return say(b, storeInfo(key), 8);
  reset(b);
  b.busy = 'show';
  visit(b, key, [
    { type: 'pose', mode: 'work', ms: 1400, say: `Let's see ${esc(storeName(key))}…`, sayFor: 2 },
    { type: 'call', fn: () => (b.rig.group.rotation.y = 0) },
    { type: 'pose', mode: 'talk', ms: 8000, say: `${storeInfo(key)}<a href="${b.d.page}" data-view-link>See all deals ›</a>`, sayFor: 9 },
  ]);
  driveHome(b, [{ type: 'call', fn: () => ((b.busy = null), (b.mode = 'idle')) }]);
}

function introduce(b) {
  if (b.busy) return;
  reset(b);
  b.queue.push(
    { type: 'pose', mode: 'talk', ms: 5000, say: `I look after ${esc(b.stores.map(storeName).join(', '))}. Click a store and I'll drive there.`, sayFor: 5 },
    { type: 'pose', mode: 'idle' },
  );
}

// "Find all discounts": every robot visits all its stores, then reports the district's total.
function tour() {
  if (!bots.length || bots.some((b) => b.busy === 'crawl' || b.busy === 'tour')) return;
  for (const b of bots) {
    reset(b);
    b.busy = 'tour';
    let found = 0;
    for (const key of b.stores) {
      const t = top[key];
      const best = Math.max(0, ...(t?.items ?? []).map((i) => i.discountPct ?? 0));
      visit(b, key, [
        { type: 'pose', mode: 'work', ms: 1600, say: `${esc(storeName(key))}: <b>${(t?.total ?? 0).toLocaleString('en-GB')}</b> deals${best ? `, up to -${best}%` : ''}`, sayFor: 3 },
        { type: 'call', fn: () => (found += t?.total ?? 0) },
      ]);
    }
    driveHome(b, [
      { type: 'call', fn: () => say(b, `Found <b>${found.toLocaleString('en-GB')}</b> deals in ${b.stores.length} stores!`, 6) },
      { type: 'pose', mode: 'celebrate', ms: 3000 },
      { type: 'call', fn: () => ((b.busy = null), (b.mode = 'idle'), updateButton()) },
    ]);
  }
  updateButton();
}

function updateButton() {
  if (!tourBtn) return;
  const crawl = bots.some((b) => b.busy === 'crawl');
  const touring = bots.some((b) => b.busy === 'tour');
  tourBtn.disabled = crawl || touring || !bots.length || !Object.keys(top).length; // needs the deals to read out
  tourBtn.textContent = crawl ? 'Refreshing…' : touring ? 'Searching…' : 'Find all discounts';
}

// A district finished its refresh: back to the lot, then celebrate or slump.
function finish(b, stores) {
  const failedNames = b.stores.filter((k) => stores[k] && !stores[k].ok).map(storeName);
  const deals = b.stores.reduce((n, k) => n + (stores[k]?.count ?? 0), 0);
  reset(b);
  b.busy = 'finish';
  b.target = null;
  driveHome(b, [
    {
      type: 'call',
      fn: () =>
        failedNames.length
          ? say(b, `Couldn't get ${esc(failedNames.join(', '))} this time. Their previous deals are still shown.<br><small>${deals.toLocaleString('en-GB')} deals in the district.</small>`, 9)
          : say(b, `All done! <b>${deals.toLocaleString('en-GB')}</b> deals in ${b.stores.length} stores.`, 7),
    },
    { type: 'pose', mode: failedNames.length ? 'error' : 'celebrate', ms: failedNames.length ? 4500 : 3200 },
    { type: 'call', fn: () => ((b.busy = null), (b.mode = 'idle'), updateButton()) },
  ]);
}

// ---------- status from the dashboard ----------

// Called by dashboard.js after every /api/status poll.
export function updateStore3d(s) {
  if (!s) return;
  status = s;
  statusReady(s);
  const stores = Object.fromEntries((s.stores ?? []).map((x) => [x.key, x.status]));
  if (!bots.length) {
    lastStores = stores;
    return;
  }
  setLamps();
  const c = s.crawling;
  const running = new Set(c?.running ?? []);
  const scope = new Set(c?.scope ?? []);
  const doneSet = new Set(c?.done ?? []);
  for (const b of bots) {
    const inScope = b.stores.filter((k) => scope.has(k));
    const pending = inScope.filter((k) => !doneSet.has(k));
    const now = b.stores.find((k) => running.has(k));
    const progress = `<br><small>${inScope.length - pending.length} of ${inScope.length} stores done</small>`;
    if (c && pending.length) {
      if (b.busy !== 'crawl') (reset(b), (b.target = null));
      b.busy = 'crawl';
      if (now && b.target !== now) {
        b.target = now;
        reset(b);
        visit(b, now, [{ type: 'hold', say: `Checking ${esc(storeName(now))}…${progress}` }]);
      } else if (!now && b.target !== 'wait') {
        b.target = 'wait';
        reset(b);
        driveHome(b, [{ type: 'pose', mode: 'idle', say: `Waiting for my turn in the refresh…${progress}` }]);
      } else if (now) say(b, `Checking ${esc(storeName(now))}…${progress}`);
    } else if (b.busy === 'crawl') {
      finish(b, stores);
    } else if (!b.busy && b.stores.some((k) => stores[k] && lastStores[k] && (stores[k].crawledAt !== lastStores[k].crawledAt || stores[k].failedAt !== lastStores[k].failedAt))) {
      finish(b, stores); // a quick refresh finished between two polls
    }
  }
  lastStores = stores;
  updateButton();
}

// ---------- setup, render loop, visibility ----------

function frame() {
  timer.update();
  const dt = Math.min(timer.getDelta(), 0.1); // a sleeping tab must not teleport anything
  const t = timer.getElapsed();
  const now = performance.now();
  if (controls.enabled) controls.update(dt);
  const r = canvasBox.getBoundingClientRect();
  for (const b of bots) {
    step(b, dt, now);
    applyPose(b, t, dt);
    if (!b.bubble.hidden && now > b.sayUntil) say(b, '');
    if (!b.bubble.hidden) {
      const p = b.rig.head.getWorldPosition(tmp);
      p.y += 0.4;
      p.project(camera);
      b.bubble.style.transform = `translate(${((p.x + 1) / 2) * r.width}px, ${((1 - p.y) / 2) * r.height}px) translate(-50%, -100%)`;
    }
  }
  renderer.render(scene, camera);
}

function resize() {
  const { width, height } = canvasBox.getBoundingClientRect();
  if (!width || !height) return;
  renderer.setSize(width, height, false);
  camera.aspect = width / height;
  // Narrow screens: higher and wider, so the whole grid fits.
  const narrow = width < 600;
  camera.fov = narrow ? 52 : 44;
  if (narrow !== resize.narrow) {
    resize.narrow = narrow;
    camera.position.set(0, narrow ? 20 : 11.5, narrow ? 12 : 14.5);
    controls?.update();
  }
  camera.updateProjectionMatrix();
}

function setRunning() {
  if (!renderer) return;
  renderer.setAnimationLoop(visible && onScreen && !document.hidden ? frame : null);
}

function pick(e) {
  const r = renderer.domElement.getBoundingClientRect();
  raycaster.setFromCamera(new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1), camera);
  const targets = [...[...shops.values()].map((s) => s.group), ...bots.map((b) => b.rig.group)];
  let o = raycaster.intersectObjects(targets, true)[0]?.object;
  while (o && !o.userData.shop && !o.userData.bot) o = o.parent;
  return o?.userData ?? null;
}

async function init() {
  started = true;
  try {
    THREE = await import('three');
    const { OrbitControls } = await import('three/addons/controls/OrbitControls.js');
    tmp = new THREE.Vector3();
    const quality = !coarse && innerWidth >= 768 && (navigator.hardwareConcurrency ?? 8) > 4;

    renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.05;
    renderer.shadowMap.enabled = quality;
    renderer.shadowMap.type = THREE.PCFShadowMap;
    canvasBox.prepend(renderer.domElement);

    scene = new THREE.Scene();
    scene.background = new THREE.Color(0xf3ecdd); // the page background
    scene.fog = new THREE.Fog(0xf3ecdd, 30, 55);
    camera = new THREE.PerspectiveCamera(40, 2, 0.1, 100);

    scene.add(new THREE.HemisphereLight(0xffffff, 0xd8c8b0, 1.7));
    const sun = new THREE.DirectionalLight(0xffffff, 2.2);
    sun.position.set(8, 16, 9);
    sun.castShadow = quality;
    sun.shadow.mapSize.set(2048, 2048);
    Object.assign(sun.shadow.camera, { left: -20, right: 20, top: 12, bottom: -12, near: 1, far: 50 });
    sun.shadow.bias = -0.0005;
    scene.add(sun);

    buildStreets();
    buildPlaza();
    const s = await firstStatus; // the store list comes from /api/status
    for (const d of DISTRICTS) {
      const list = s.stores.filter((x) => x.segment === d.segment && x.hasDeals);
      list.forEach((store, i) => buildShop(store, d, i));
      const blk = block(d.col, d.row);
      const sign = billboard(d.label, hex(d.color));
      sign.position.set((blk.x0 + blk.x1) / 2, 3.15, blk.z1 - 1.3); // above the district's shops and their logos
      scene.add(sign);
      const b = makeBot(d);
      b.stores = list.map((x) => x.key);
      bots.push(b);
    }
    setLamps();
    lastStores = Object.fromEntries((s.stores ?? []).map((x) => [x.key, x.status]));

    controls = new OrbitControls(camera, renderer.domElement);
    controls.target.set(0, 0, 0.2);
    controls.enableDamping = true;
    controls.enablePan = false;
    controls.enableZoom = false; // the page scrolls with the wheel
    controls.minPolarAngle = 0.35;
    controls.maxPolarAngle = 1.1;
    controls.minAzimuthAngle = -0.7;
    controls.maxAzimuthAngle = 0.7;
    controls.enabled = !coarse; // touch: tap only, so the page still scrolls
    if (coarse) renderer.domElement.style.touchAction = 'pan-y';

    timer = new THREE.Timer();
    timer.connect(document);
    raycaster = new THREE.Raycaster();

    // A click (pointer moved ≤ 5 px) picks a store or a robot; a drag only turns the camera.
    let down = null;
    renderer.domElement.addEventListener('pointerdown', (e) => (down = { x: e.clientX, y: e.clientY }));
    renderer.domElement.addEventListener('pointerup', (e) => {
      if (!down || Math.hypot(e.clientX - down.x, e.clientY - down.y) > 5) return;
      const hit = pick(e);
      if (hit?.shop) showShop(hit.shop);
      else if (hit?.bot) introduce(bots.find((b) => b.d.segment === hit.bot));
    });
    renderer.domElement.addEventListener('pointermove', (e) => {
      if (coarse || e.buttons) return;
      renderer.domElement.style.cursor = pick(e) ? 'pointer' : '';
    });
    tourBtn.addEventListener('click', tour);

    new ResizeObserver(resize).observe(canvasBox);
    new IntersectionObserver(([e]) => ((onScreen = e.isIntersecting), setRunning())).observe(canvasBox);
    document.addEventListener('visibilitychange', setRunning);
    resize();
    root.classList.add('ready');
    labelEl.textContent = `${bots.length} bots · ${shops.size} stores · click a store or a bot, or press Find all discounts`;
    updateStore3d(status); // react to a refresh that is already running
    setRunning();

    const r = await fetch('/api/stores/top?limit=3').then((x) => x.json()).catch(() => null);
    top = r?.stores ?? {};
    fillWindows();
    updateButton();
  } catch (e) {
    console.error('[store3d]', e);
    failed = true;
    root.hidden = true; // no WebGL or the CDN is unreachable: the dashboard works without it
  }
}

// Called by dashboard.js when the Dashboard is shown or hidden.
export function showStore3d() {
  visible = true;
  if (failed) return;
  if (!started) return void init();
  setRunning();
}

export function hideStore3d() {
  visible = false;
  setRunning();
}

// The container sits in index.html above the dashboard tiles: <div id="store3d">.
root = document.getElementById('store3d');
if (root) {
  root.innerHTML = `<div class="s3-canvas"><div class="s3-loading">Opening the stores…</div><button class="btn btn-primary btn-sm s3-tour" disabled>Find all discounts</button></div><p class="s3-label"></p>`;
  canvasBox = root.querySelector('.s3-canvas');
  labelEl = root.querySelector('.s3-label');
  tourBtn = root.querySelector('.s3-tour');
} else failed = true;
