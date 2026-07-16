import { Bounds, Camera, SceneObject, Shape, intersects } from '../core/types';

export class Renderer {
  grid = true;
  private raf = 0;

  constructor(private canvas: HTMLCanvasElement, private ctx = canvas.getContext('2d')!) {
    addEventListener('resize', () => this.resize());
    this.resize();
  }

  resize() {
    const d = devicePixelRatio || 1;
    this.canvas.width = innerWidth * d;
    this.canvas.height = innerHeight * d;
    this.canvas.style.width = `${innerWidth}px`;
    this.canvas.style.height = `${innerHeight}px`;
    this.ctx.setTransform(d, 0, 0, d, 0, 0);
  }

  schedule(cb: () => void) {
    if (this.raf) return;
    this.raf = requestAnimationFrame(() => {
      this.raf = 0;
      cb();
    });
  }

  worldView(cam: Camera, margin = 512): Bounds {
    return {
      x: cam.x - margin,
      y: cam.y - margin,
      w: innerWidth / cam.zoom + margin * 2,
      h: innerHeight / cam.zoom + margin * 2,
    };
  }

  render(cam: Camera, objects: SceneObject[], layers: Set<string>, boardId: string, preview?: SceneObject) {
    const c = this.ctx;
    const d = devicePixelRatio || 1;
    c.setTransform(d, 0, 0, d, 0, 0);
    c.clearRect(0, 0, innerWidth, innerHeight);
    c.fillStyle = '#101216';
    c.fillRect(0, 0, innerWidth, innerHeight);
    if (this.grid) this.drawGrid(cam);

    c.save();
    c.scale(cam.zoom, cam.zoom);
    c.translate(-cam.x, -cam.y);
    const view = this.worldView(cam);
    for (const o of objects) {
      if (o.boardId === boardId && layers.has(o.layerId) && intersects(o.bounds, view)) this.drawObj(o);
    }
    if (preview && preview.boardId === boardId) this.drawObj(preview, true);
    c.restore();
  }

  private drawGrid(cam: Camera) {
    const c = this.ctx;
    let step = 32;
    while (step * cam.zoom < 18) step *= 2;
    while (step * cam.zoom > 72) step /= 2;
    const scaled = step * cam.zoom;
    const ox = -(cam.x * cam.zoom) % scaled;
    const oy = -(cam.y * cam.zoom) % scaled;
    c.strokeStyle = '#242933';
    c.lineWidth = 1;
    c.beginPath();
    for (let x = ox; x < innerWidth; x += scaled) {
      c.moveTo(Math.round(x) + 0.5, 0);
      c.lineTo(Math.round(x) + 0.5, innerHeight);
    }
    for (let y = oy; y < innerHeight; y += scaled) {
      c.moveTo(0, Math.round(y) + 0.5);
      c.lineTo(innerWidth, Math.round(y) + 0.5);
    }
    c.stroke();
  }

  private drawObj(o: SceneObject, preview = false) {
    const c = this.ctx;
    c.save();
    c.globalCompositeOperation = 'source-over';
    c.globalAlpha = preview ? 0.78 : 1;
    if (o.type === 'stroke') {
      c.strokeStyle = o.color;
      c.globalAlpha = o.highlighter ? 0.35 : c.globalAlpha;
      c.lineWidth = o.width;
      c.lineCap = c.lineJoin = 'round';
      c.beginPath();
      o.points.forEach((p, i) => (i ? c.lineTo(p.x, p.y) : c.moveTo(p.x, p.y)));
      c.stroke();
    } else if (o.type === 'rect' || o.type === 'ellipse' || o.type === 'arrow') {
      this.drawShape(o);
    } else if (o.type === 'text') {
      c.fillStyle = o.color;
      c.font = `${o.fontSize}px Inter, sans-serif`;
      c.fillText(o.text, o.bounds.x, o.bounds.y);
    }
    if (o.selected) {
      c.strokeStyle = '#66e3ff';
      c.setLineDash([6, 4]);
      c.strokeRect(o.bounds.x - 4, o.bounds.y - 4, o.bounds.w + 8, o.bounds.h + 8);
    }
    c.restore();
  }

  private drawShape(o: Shape) {
    const c = this.ctx;
    c.strokeStyle = o.color;
    c.lineWidth = o.width;
    c.lineCap = c.lineJoin = 'round';
    if (o.type === 'rect') {
      c.strokeRect(o.bounds.x, o.bounds.y, o.bounds.w, o.bounds.h);
      return;
    }
    if (o.type === 'ellipse') {
      c.beginPath();
      c.ellipse(o.bounds.x + o.bounds.w / 2, o.bounds.y + o.bounds.h / 2, Math.abs(o.bounds.w / 2), Math.abs(o.bounds.h / 2), 0, 0, Math.PI * 2);
      c.stroke();
      return;
    }
    c.beginPath();
    c.moveTo(o.from.x, o.from.y);
    c.lineTo(o.to.x, o.to.y);
    const angle = Math.atan2(o.to.y - o.from.y, o.to.x - o.from.x);
    const head = Math.max(12, o.width * 4);
    c.lineTo(o.to.x - head * Math.cos(angle - Math.PI / 6), o.to.y - head * Math.sin(angle - Math.PI / 6));
    c.moveTo(o.to.x, o.to.y);
    c.lineTo(o.to.x - head * Math.cos(angle + Math.PI / 6), o.to.y - head * Math.sin(angle + Math.PI / 6));
    c.stroke();
  }
}
