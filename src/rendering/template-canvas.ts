import type { AETemplateLayer, TemplateField } from './project-types';

const imageCache = new Map<string, HTMLImageElement>();

function getCachedImage(src?: string) {
  if (!src || typeof Image === 'undefined') return null;
  const cached = imageCache.get(src);
  if (cached) return cached.complete ? cached : null;
  const img = new Image();
  img.src = src;
  imageCache.set(src, img);
  return null;
}

function sampleKeyframes(kfs: Array<{ t: number; v: number }> | undefined, time: number, fallback: number) {
  if (!Array.isArray(kfs) || !kfs.length) return fallback;
  const arr = [...kfs].sort((a, b) => a.t - b.t);
  if (time <= arr[0].t) return Number(arr[0].v);
  if (time >= arr[arr.length - 1].t) return Number(arr[arr.length - 1].v);
  for (let i = 0; i < arr.length - 1; i++) {
    const a = arr[i];
    const b = arr[i + 1];
    if (time >= a.t && time <= b.t) {
      const p = (time - a.t) / Math.max(0.0001, b.t - a.t);
      return Number(a.v) + (Number(b.v) - Number(a.v)) * p;
    }
  }
  return fallback;
}

function drawField(ctx: CanvasRenderingContext2D, field: TemplateField, boxW: number, boxH: number, alpha = 1) {
  const x = field.x ?? 0;
  const y = field.y ?? 0;
  const w = field.w ?? boxW;
  const h = field.h ?? boxH;
  const fontSize = field.fontSize ?? 40;
  const fontFamily = field.fontFamily || "Pretendard, 'Noto Sans KR', sans-serif";
  const textAlign = field.textAlign || 'center';
  const fill = field.color || '#ffffff';
  const stroke = field.strokeColor;
  const strokeWidth = field.strokeWidth ?? 0;

  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.font = `700 ${fontSize}px ${fontFamily}`;
  ctx.textAlign = textAlign as CanvasTextAlign;
  ctx.textBaseline = 'middle';
  ctx.fillStyle = fill;
  if (stroke && strokeWidth > 0) {
    ctx.lineWidth = strokeWidth;
    ctx.strokeStyle = stroke;
    ctx.lineJoin = 'round';
  }
  const tx = textAlign === 'left' ? x : textAlign === 'right' ? x + w : x + w / 2;
  const ty = y + h / 2;
  if (stroke && strokeWidth > 0) ctx.strokeText(field.value || '', tx, ty);
  ctx.fillText(field.value || '', tx, ty);
  ctx.restore();
}

function drawThreeSlice(ctx: CanvasRenderingContext2D, img: HTMLImageElement | null, crop: any, dx: number, dy: number, dw: number, dh: number, alpha = 1) {
  ctx.save();
  ctx.globalAlpha = alpha;
  if (!img) {
    const grad = ctx.createLinearGradient(dx, dy, dx + dw, dy);
    grad.addColorStop(0, '#0f8a86');
    grad.addColorStop(0.5, '#31c5be');
    grad.addColorStop(1, '#0f8a86');
    ctx.fillStyle = grad;
    ctx.fillRect(dx, dy, dw, dh);
    ctx.restore();
    return;
  }
  const sx = Number(crop?.x || 0);
  const sy = Number(crop?.y || 0);
  const sw = Math.max(1, Number(crop?.w || img.width));
  const sh = Math.max(1, Number(crop?.h || img.height));
  const cap = Math.max(8, Math.min(sw * 0.28, sw * 0.5));
  const mid = Math.max(1, sw - cap * 2);
  const dCap = Math.min(dw / 2, cap * (dh / sh));
  const dMid = Math.max(1, dw - dCap * 2);

  ctx.drawImage(img, sx, sy, cap, sh, dx, dy, dCap, dh);
  ctx.drawImage(img, sx + cap, sy, mid, sh, dx + dCap, dy, dMid, dh);
  ctx.drawImage(img, sx + cap + mid, sy, cap, sh, dx + dCap + dMid, dy, dCap, dh);
  ctx.restore();
}

export function drawData8Template(ctx: CanvasRenderingContext2D, template: AETemplateLayer, pixelW: number, pixelH: number, time: number) {
  const model = template.vectorModel || {};
  const field = (template.fields || [])[0] || {};
  const img = getCachedImage(model.imageSrc);
  const drawH = Math.max(2, Number(model.baseBarHeight || pixelH));
  const drawY = (pixelH - drawH) / 2;
  const scaleX = sampleKeyframes(model.imageScaleX, time, 100) / 100;
  const imageAlpha = sampleKeyframes(model.imageOpacity, time, 1);
  const textAlpha = sampleKeyframes(model.textOpacity, time, 1);
  const animW = Math.max(1, pixelW * scaleX);
  const dx = (pixelW - animW) / 2;

  drawThreeSlice(ctx, img, model.sourceCrop, dx, drawY, animW, drawH, imageAlpha);
  drawField(ctx, {
    ...field,
    x: dx + Number(model.paddingX || 32),
    y: drawY,
    w: Math.max(1, animW - Number(model.paddingX || 32) * 2),
    h: drawH,
    textAlign: field.textAlign || model.textAlign || 'center',
    fontFamily: field.fontFamily || model.fontFamily,
    fontSize: field.fontSize || model.fontSize,
    color: field.color || model.color,
    strokeColor: field.strokeColor || model.strokeColor,
    strokeWidth: typeof field.strokeWidth === 'number' ? field.strokeWidth : model.strokeWidth,
  }, pixelW, pixelH, textAlpha);
}

export function drawData9Template(ctx: CanvasRenderingContext2D, template: AETemplateLayer, pixelW: number, pixelH: number, time: number) {
  const model = template.multiTitleModel || {};
  const fields = template.fields || [];
  const pairs = Array.isArray(model.pairs) ? model.pairs : [];
  const templateW = Math.max(1, Number(template.templateW || pixelW));
  const templateH = Math.max(1, Number(template.templateH || pixelH));
  pairs.forEach((pair: any, index: number) => {
    const field = fields[index] || {};
    const img = getCachedImage(pair.imageSrc);
    const centerX = (Number(pair.centerX || templateW / 2) / templateW) * pixelW;
    const centerY = (Number(pair.centerY || templateH / 2) / templateH) * pixelH;
    const targetH = Math.max(2, (Number(pair.baseHeight || 60) / templateH) * pixelH);
    const fontSize = field.fontSize || pair.fontSize || 40;
    ctx.save();
    ctx.font = `700 ${fontSize}px ${field.fontFamily || pair.fontFamily || "Pretendard, 'Noto Sans KR', sans-serif"}`;
    const measure = ctx.measureText(field.value || pair.baseText || '');
    const contentW = measure.width + Math.max(24, Number(pair.paddingX || 32) * 2);
    const baseW = (Number(pair.baseWidth || 240) / templateW) * pixelW;
    const scaleX = sampleKeyframes(pair.imageScaleX, time, 100) / 100;
    const imageAlpha = sampleKeyframes(pair.imageOpacity, time, 1);
    const textAlpha = sampleKeyframes(pair.textOpacity, time, 1);
    const targetW = Math.max(baseW, contentW) * scaleX;
    const x = centerX - targetW / 2;
    const y = centerY - targetH / 2;
    drawThreeSlice(ctx, img, pair.sourceCrop, x, y, targetW, targetH, imageAlpha);
    drawField(ctx, {
      ...field,
      x,
      y,
      w: targetW,
      h: targetH,
      textAlign: field.textAlign || pair.textAlign || 'center',
      fontFamily: field.fontFamily || pair.fontFamily,
      fontSize,
      color: field.color || pair.color,
      strokeColor: field.strokeColor || pair.strokeColor,
      strokeWidth: typeof field.strokeWidth === 'number' ? field.strokeWidth : pair.strokeWidth,
    }, pixelW, pixelH, textAlpha);
    ctx.restore();
  });
}

export function rasterizeTemplateToCanvas(template: AETemplateLayer, time: number, scale = 1) {
  const w = Math.max(2, Math.round((template.width || template.templateW || 1000) * scale));
  const h = Math.max(2, Math.round((template.height || template.templateH || 200) * scale));
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) return canvas;
  ctx.clearRect(0, 0, w, h);
  if (template.templateKind === 'vector_subtitle') {
    drawData8Template(ctx, template, w, h, time);
  } else if (template.templateKind === 'multi_png_title') {
    drawData9Template(ctx, template, w, h, time);
  } else {
    ctx.fillStyle = 'rgba(17,17,17,0.75)';
    ctx.fillRect(0, 0, w, h);
    (template.fields || []).forEach(field => drawField(ctx, field, w, h, 1));
  }
  return canvas;
}
