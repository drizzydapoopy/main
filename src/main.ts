import './style.css';
import { QuadTree } from './core/quadtree';
import { Board, Camera, CHUNK_SIZE, Chunk, Layer, Point, SceneObject, Shape, Stroke, Tool, boundsOfPoints, chunkId, chunksForBounds, uid } from './core/types';
import { Renderer } from './render/renderer';
import { BeansDB } from './storage/db';

type ChunkMap = Map<string, Chunk>;
const DRAW_TOOLS = new Set<Tool>(['pen', 'highlighter']);
const SHAPE_TOOLS = new Set<Tool>(['rectangle', 'ellipse', 'arrow']);

class App {
  db = new BeansDB();
  canvas = document.createElement('canvas');
  renderer = new Renderer(this.canvas);
  camera: Camera = { x: -innerWidth / 2, y: -innerHeight / 2, zoom: 1, targetZoom: 1 };
  tool: Tool = 'pen';
  previousTool: Tool = 'pen';
  board!: Board;
  layers: (Layer & { boardId: string })[] = [];
  chunks: ChunkMap = new Map();
  quadtree = new QuadTree({ x: -1e7, y: -1e7, w: 2e7, h: 2e7 });
  objects: SceneObject[] = [];
  preview?: SceneObject;
  drawing = false;
  panning = false;
  activePointerId?: number;
  panButton?: number;
  last = { x: 0, y: 0 };
  rawPoints: Point[] = [];
  smoothPoints: Point[] = [];
  shapeStart?: Point;
  undo: SceneObject[][] = [];
  redo: SceneObject[][] = [];
  stabilization = 45;
  worker = new Worker(new URL('./workers/simplify.worker.ts', import.meta.url), { type: 'module' });
  ui = document.createElement('div');

  async start() {
    document.querySelector('#app')!.append(this.canvas, this.ui);
    this.board = await this.db.ensureDefaultBoard();
    await this.loadBoard(this.board.id);
    this.bind();
    this.buildUI();
    this.loop();
    setInterval(() => void this.saveDirty(), 2000);
  }

  async loadBoard(id: string) {
    if (this.board) await this.saveDirty();
    this.chunks.clear();
    this.quadtree.clear();
    this.objects = [];
    this.preview = undefined;
    this.undo = [];
    this.redo = [];
    this.board = (await this.db.get<Board>('boards', id))!;
    this.board.recent = Date.now();
    await this.db.put('boards', this.board);
    this.layers = (await this.db.all<Layer & { boardId: string }>('layers')).filter((l) => l.boardId === id).sort((a, b) => a.order - b.order);
    await this.streamVisibleChunks();
  }

  visibleLayers() {
    return new Set(this.layers.filter((l) => l.visible).map((l) => l.id));
  }

  async streamVisibleChunks() {
    const cells = chunksForBounds(this.renderer.worldView(this.camera, CHUNK_SIZE));
    const needed = new Set(cells.map((c) => chunkId(this.board.id, c.cx, c.cy)));
    for (const [id, chunk] of [...this.chunks.entries()]) {
      if (!needed.has(id)) {
        if (chunk.dirty) await this.persistChunk(chunk);
        this.chunks.delete(id);
      }
    }
    const missing = cells.filter((c) => !this.chunks.has(chunkId(this.board.id, c.cx, c.cy)));
    const loaded = await this.db.chunks(this.board.id, missing);
    for (const chunk of loaded) this.chunks.set(chunk.id, chunk);
    this.rebuildIndexFromLoadedChunks();
  }

  rebuildIndexFromLoadedChunks() {
    this.quadtree.clear();
    const byId = new Map<string, SceneObject>();
    for (const chunk of this.chunks.values()) for (const o of chunk.objects) if (o.boardId === this.board.id) byId.set(o.id, o);
    this.objects = [...byId.values()];
    for (const o of this.objects) this.quadtree.insert(o);
  }

  loop = async () => {
    this.camera.zoom += (this.camera.targetZoom - this.camera.zoom) * 0.18;
    await this.streamVisibleChunks();
    this.renderer.render(this.camera, this.objects, this.visibleLayers(), this.board.id, this.preview);
    requestAnimationFrame(this.loop);
  };

  screen(e: PointerEvent | WheelEvent): Point {
    return { x: this.camera.x + e.clientX / this.camera.zoom, y: this.camera.y + e.clientY / this.camera.zoom, p: 'pressure' in e && e.pressure > 0 ? e.pressure : 0.5, t: performance.now() };
  }

  bind() {
    this.canvas.oncontextmenu = (e) => e.preventDefault();
    this.canvas.addEventListener('pointerdown', (e) => this.pointerDown(e));
    this.canvas.addEventListener('pointermove', (e) => this.pointerMove(e));
    this.canvas.addEventListener('pointerup', (e) => this.pointerUp(e));
    this.canvas.addEventListener('pointercancel', (e) => this.pointerUp(e));
    addEventListener('wheel', (e: WheelEvent) => this.wheel(e), { passive: false });
    addEventListener('keydown', (e: KeyboardEvent) => this.keyDown(e));
    addEventListener('keyup', (e: KeyboardEvent) => this.keyUp(e));
    document.addEventListener('paste', (e) => this.paste(e));
    document.addEventListener('drop', (e) => {
      e.preventDefault();
      this.importFiles(e.dataTransfer?.files);
    });
    document.addEventListener('dragover', (e) => e.preventDefault());
  }

  pointerDown(e: PointerEvent) {
    if (this.activePointerId !== undefined) return;
    this.canvas.setPointerCapture(e.pointerId);
    this.activePointerId = e.pointerId;
    this.last = { x: e.clientX, y: e.clientY };
    if (e.button === 1 || e.button === 2 || this.tool === 'hand') {
      this.panning = true;
      this.panButton = e.button;
      return;
    }
    if (DRAW_TOOLS.has(this.tool) || this.tool === 'eraser') {
      this.drawing = true;
      const p = this.screen(e);
      this.rawPoints = [p];
      this.smoothPoints = [p];
      this.updateLiveStroke();
      return;
    }
    if (SHAPE_TOOLS.has(this.tool)) {
      this.drawing = true;
      this.shapeStart = this.screen(e);
      this.updateShapePreview(this.shapeStart, this.shapeStart);
    }
  }

  pointerMove(e: PointerEvent) {
    if (e.pointerId !== this.activePointerId) return;
    if (this.panning) {
      this.camera.x -= (e.clientX - this.last.x) / this.camera.zoom;
      this.camera.y -= (e.clientY - this.last.y) / this.camera.zoom;
      this.last = { x: e.clientX, y: e.clientY };
      return;
    }
    if (!this.drawing) return;
    const events = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
    for (const ev of events) this.addInputPoint(this.screen(ev));
    if (DRAW_TOOLS.has(this.tool) || this.tool === 'eraser') this.updateLiveStroke();
    if (SHAPE_TOOLS.has(this.tool) && this.shapeStart) this.updateShapePreview(this.shapeStart, this.screen(e));
  }

  pointerUp(e: PointerEvent) {
    if (e.pointerId !== this.activePointerId) return;
    this.canvas.releasePointerCapture(e.pointerId);
    if (this.panning) {
      this.panning = false;
      this.activePointerId = undefined;
      this.panButton = undefined;
      return;
    }
    if (!this.drawing) {
      this.activePointerId = undefined;
      return;
    }
    if (DRAW_TOOLS.has(this.tool)) this.finishStroke(this.tool === 'highlighter');
    else if (this.tool === 'eraser') this.eraseObjects(this.rawPoints);
    else if (SHAPE_TOOLS.has(this.tool) && this.preview && (this.preview.bounds.w > 2 || this.preview.bounds.h > 2)) this.addObject(this.preview);
    this.drawing = false;
    this.activePointerId = undefined;
    this.rawPoints = [];
    this.smoothPoints = [];
    this.shapeStart = undefined;
    this.preview = undefined;
  }

  wheel(e: WheelEvent) {
    e.preventDefault();
    if (e.ctrlKey) {
      const before = this.screen(e);
      this.camera.targetZoom = Math.min(8, Math.max(0.08, this.camera.targetZoom * (e.deltaY < 0 ? 1.15 : 0.87)));
      const after = this.screen(e);
      this.camera.x += before.x - after.x;
      this.camera.y += before.y - after.y;
    } else if (e.shiftKey) this.camera.x += e.deltaY / this.camera.zoom;
    else this.camera.y += e.deltaY / this.camera.zoom;
  }

  keyDown(e: KeyboardEvent) {
    if (e.code === 'Space' && !this.panning) {
      e.preventDefault();
      if (this.tool !== 'hand') this.previousTool = this.tool;
      this.tool = 'hand';
      this.buildUI();
      return;
    }
    if (e.ctrlKey && e.key.toLowerCase() === 'z' && !e.shiftKey) return this.restore(this.undo, this.redo);
    if ((e.ctrlKey && e.key.toLowerCase() === 'y') || (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === 'z')) return this.restore(this.redo, this.undo);
    const m: Partial<Record<string, Tool>> = { p: 'pen', h: 'hand', e: 'eraser', r: 'rectangle', o: 'ellipse', a: 'arrow', t: 'text', l: 'lasso' };
    const next = m[e.key.toLowerCase()];
    if (next) {
      this.tool = next;
      this.buildUI();
    }
  }

  keyUp(e: KeyboardEvent) {
    if (e.code === 'Space') {
      this.tool = this.previousTool;
      this.buildUI();
    }
  }

  addInputPoint(p: Point) {
    this.rawPoints.push(p);
    if (this.stabilization <= 0) {
      this.smoothPoints.push(p);
      return;
    }
    const alpha = Math.max(0.06, 1 - this.stabilization / 100 * 0.92);
    const last = this.smoothPoints[this.smoothPoints.length - 1] ?? p;
    const smoothed = { ...p, x: last.x + (p.x - last.x) * alpha, y: last.y + (p.y - last.y) * alpha };
    this.smoothPoints.push(smoothed);
  }

  updateLiveStroke() {
    const points = this.stabilization === 0 ? this.rawPoints : this.smoothPoints;
    if (points.length < 1) return;
    this.preview = {
      id: 'preview', boardId: this.board.id, layerId: this.layers[0].id, type: 'stroke', points,
      color: this.tool === 'eraser' ? '#ff6b6b' : this.tool === 'highlighter' ? '#ffd54a' : '#f7f7f7',
      width: this.tool === 'eraser' ? 18 : this.tool === 'highlighter' ? 18 : Math.max(1.5, 2 + points[points.length - 1].p * 3),
      highlighter: this.tool === 'highlighter', bounds: boundsOfPoints(points, 24), rotation: 0, z: Date.now(), created: Date.now(), updated: Date.now(),
    } as Stroke;
  }

  finishStroke(highlighter = false) {
    const points = this.stabilization === 0 ? [...this.rawPoints] : [...this.smoothPoints];
    if (points.length < 2) return;
    const boardId = this.board.id;
    const layerId = this.layers[0].id;
    this.worker.onmessage = (ev) => {
      const simplified = ev.data as Point[];
      if (simplified.length < 2 || this.board.id !== boardId) return;
      this.addObject({
        id: uid(), boardId, layerId, type: 'stroke', points: simplified,
        color: highlighter ? '#ffd54a' : '#f7f7f7', width: highlighter ? 18 : 3, highlighter,
        bounds: boundsOfPoints(simplified, 24), rotation: 0, z: Date.now(), created: Date.now(), updated: Date.now(),
      });
    };
    this.worker.postMessage({ points, stabilization: this.stabilization });
  }

  updateShapePreview(from: Point, to: Point) {
    const type = this.tool === 'rectangle' ? 'rect' : this.tool;
    const bounds = { x: Math.min(from.x, to.x), y: Math.min(from.y, to.y), w: Math.abs(to.x - from.x), h: Math.abs(to.y - from.y) };
    this.preview = { id: 'preview', boardId: this.board.id, layerId: this.layers[0].id, type, color: '#f7f7f7', fill: 'transparent', width: 3, from, to, bounds, rotation: 0, z: Date.now(), created: Date.now(), updated: Date.now() } as Shape;
  }

  addObject(o: SceneObject, recordUndo = true) {
    if (recordUndo) {
      this.undo.push([...this.objects]);
      this.redo = [];
    }
    o.boardId = this.board.id;
    for (const c of chunksForBounds(o.bounds)) {
      const id = chunkId(this.board.id, c.cx, c.cy);
      const chunk = this.chunks.get(id) ?? { id, boardId: this.board.id, cx: c.cx, cy: c.cy, objects: [], loadedAt: Date.now(), dirty: true };
      chunk.objects = chunk.objects.filter((existing) => existing.id !== o.id);
      chunk.objects.push(o);
      chunk.dirty = true;
      this.chunks.set(id, chunk);
    }
    this.rebuildIndexFromLoadedChunks();
  }

  eraseObjects(path: Point[]) {
    const hits = new Set<string>();
    const bounds = boundsOfPoints(path, 24);
    for (const o of this.quadtree.query(bounds)) {
      if (o.boardId !== this.board.id) continue;
      if (o.type === 'stroke' && this.strokeTouched(o, path, 14)) hits.add(o.id);
    }
    if (!hits.size) return;
    this.undo.push([...this.objects]);
    this.redo = [];
    for (const id of hits) this.removeObject(id);
    this.rebuildIndexFromLoadedChunks();
  }

  strokeTouched(stroke: Stroke, path: Point[], radius: number) {
    for (let i = 1; i < stroke.points.length; i++) for (const p of path) if (this.pointSegmentDistance(p, stroke.points[i - 1], stroke.points[i]) <= radius + stroke.width / 2) return true;
    return false;
  }

  pointSegmentDistance(p: Point, a: Point, b: Point) {
    const dx = b.x - a.x, dy = b.y - a.y, len = dx * dx + dy * dy || 1;
    const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len));
    return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
  }

  removeObject(id: string) {
    for (const chunk of this.chunks.values()) {
      const next = chunk.objects.filter((o) => o.id !== id);
      if (next.length !== chunk.objects.length) {
        chunk.objects = next;
        chunk.dirty = true;
      }
    }
  }

  reindexObjectsIntoChunks(objects: SceneObject[]) {
    for (const chunk of this.chunks.values()) {
      chunk.objects = [];
      chunk.dirty = true;
    }
    for (const o of objects.filter((obj) => obj.boardId === this.board.id)) this.addObject(o, false);
    this.rebuildIndexFromLoadedChunks();
  }

  restore(from: SceneObject[][], to: SceneObject[][]) {
    const state = from.pop();
    if (!state) return;
    to.push([...this.objects]);
    this.reindexObjectsIntoChunks(state);
  }

  async persistChunk(chunk: Chunk) {
    chunk.objects = chunk.objects.filter((o) => o.boardId === this.board.id);
    chunk.dirty = false;
    await this.db.put('chunks', chunk);
  }

  async saveDirty() {
    for (const chunk of this.chunks.values()) if (chunk.dirty) await this.persistChunk(chunk);
    if (this.board) {
      this.board.updated = Date.now();
      await this.db.put('boards', this.board);
    }
  }

  buildUI() {
    this.ui.className = 'ui';
    this.ui.innerHTML = `<aside><h1>🫘 BeansBoard</h1><button id="new">New board</button><input id="search" placeholder="Search"><div id="boards"></div><h2>Layers</h2><div id="layers"></div></aside><nav>${['pen', 'highlighter', 'eraser', 'rectangle', 'ellipse', 'arrow', 'text', 'lasso', 'hand'].map((t) => `<button class="${this.tool === t ? 'on' : ''}" data-tool="${t}">${t}</button>`).join('')}<button id="grid">Grid</button><label>Stabilize <input id="stab" type="range" min="0" max="100" value="${this.stabilization}"></label></nav>`;
    this.ui.querySelectorAll('[data-tool]').forEach((b) => b.addEventListener('click', () => { this.tool = (b as HTMLElement).dataset.tool as Tool; this.buildUI(); }));
    this.ui.querySelector('#grid')!.addEventListener('click', () => { this.renderer.grid = !this.renderer.grid; });
    (this.ui.querySelector('#stab') as HTMLInputElement).oninput = (e) => { this.stabilization = +(e.target as HTMLInputElement).value; };
    this.renderBoardList();
    this.ui.querySelector('#new')!.addEventListener('click', async () => {
      const now = Date.now(), id = uid();
      await this.db.put('boards', { id, name: 'Untitled Board', created: now, updated: now, favorite: false, folder: 'General', subject: '', chapter: '', recent: now });
      await this.db.put('layers', { id: uid(), boardId: id, name: 'Layer 1', visible: true, locked: false, order: 0 });
      await this.loadBoard(id);
      this.buildUI();
    });
    const le = this.ui.querySelector('#layers')!;
    le.innerHTML = this.layers.map((l) => `<label><input type="checkbox" ${l.visible ? 'checked' : ''} data-l="${l.id}"> ${l.name}</label>`).join('');
    le.querySelectorAll('input').forEach((i) => ((i as HTMLInputElement).onchange = () => { const l = this.layers.find((layer) => layer.id === (i as HTMLInputElement).dataset.l)!; l.visible = (i as HTMLInputElement).checked; void this.db.put('layers', l); }));
  }

  async renderBoardList() {
    const boards = await this.db.all<Board>('boards');
    const el = this.ui.querySelector('#boards')!;
    el.innerHTML = boards.sort((a, b) => b.updated - a.updated).map((b) => `<button data-b="${b.id}">${b.favorite ? '★' : '☆'} ${b.name}</button>`).join('');
    el.querySelectorAll('button').forEach((x) => x.addEventListener('click', async () => { await this.loadBoard((x as HTMLElement).dataset.b!); this.buildUI(); }));
  }

  paste(e: ClipboardEvent) { this.importFiles(e.clipboardData?.files); }
  importFiles(files?: FileList | null) {
    if (!files) return;
    [...files].forEach((f) => {
      const rd = new FileReader();
      rd.onload = () => {
        const p = this.screen({ clientX: innerWidth / 2, clientY: innerHeight / 2, pressure: 0.5 } as PointerEvent);
        this.addObject({ id: uid(), boardId: this.board.id, layerId: this.layers[0].id, type: 'text', text: `Imported ${f.name} (${f.type || 'file'})`, color: '#9ee7ff', fontSize: 24, bounds: { x: p.x, y: p.y, w: 360, h: 36 }, rotation: 0, z: Date.now(), created: Date.now(), updated: Date.now() } as SceneObject);
      };
      rd.readAsDataURL(f);
    });
  }
}

new App().start();
