import type { AETemplateLayer, TemplateField } from './project-types';

const imageCache = new Map<string, HTMLImageElement>();
const multiTitleFrameCache = new Map<string, HTMLCanvasElement>();

function getCachedImage(src?: string) {
  if (!src || typeof Image === 'undefined') return null;
  const cached = imageCache.get(src);
  if (cached) return cached.complete ? cached : null;
  const img = new Image();
  img.src = src;
  imageCache.set(src, img);
  return null;
}

export async function preloadTemplateImages(layers: any[]) {
  const promises: Promise<void>[] = [];
  for (const layer of layers) {
    if (layer.type !== 'ae_template') continue;
    const srcs: string[] = [];
    if (layer.templateKind === 'vector_subtitle' && layer.vectorModel?.imageSrc) srcs.push(layer.vectorModel.imageSrc);
    if (layer.templateKind === 'multi_png_title' && layer.multiTitleModel?.pairs) {
      layer.multiTitleModel.pairs.forEach((p: any) => p.imageSrc && srcs.push(p.imageSrc));
    }
    if (layer.lottieData?.assets) {
      layer.lottieData.assets.forEach((asset: any) => {
        if (asset.p && typeof asset.p === 'string' && (asset.p.startsWith('http') || asset.p.startsWith('data:'))) {
           // If 'p' is a full URL or data URI
           srcs.push(asset.p);
        } else if (asset.u && asset.p && typeof asset.p === 'string') {
           // If 'u' is the path and 'p' is the filename
           srcs.push(asset.u + asset.p);
        }
      });
    }
    for (const src of srcs) {
      if (!src || typeof Image === 'undefined') continue;
      const cached = imageCache.get(src);
      if (cached && cached.complete) continue;
      
      const p = new Promise<void>(resolve => {
        const img = cached || new Image();
        img.onload = () => resolve();
        img.onerror = () => resolve();
        if (!cached) {
          img.src = src;
          imageCache.set(src, img);
        }
        setTimeout(resolve, 2000);
      });
      promises.push(p);
    }
  }
  await Promise.all(promises);
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

function maxSecondsKeyframeTime(kfs: any): number {
  if (!Array.isArray(kfs)) return 0;
  return kfs.reduce((max, kf) => {
    const t = Number(kf?.t);
    return Number.isFinite(t) ? Math.max(max, t) : max;
  }, 0);
}

function maxLottieKeyframeFrame(value: any): number {
  if (!value || typeof value !== 'object') return 0;
  let max = 0;
  if (Array.isArray(value)) {
    value.forEach(item => {
      max = Math.max(max, maxLottieKeyframeFrame(item));
    });
    return max;
  }
  const k = value.k;
  if (Array.isArray(k) && k.length && typeof k[0] === 'object' && 't' in k[0]) {
    k.forEach((kf: any) => {
      const t = Number(kf?.t);
      if (Number.isFinite(t)) max = Math.max(max, t);
    });
  }
  Object.keys(value).forEach(key => {
    if (key === 'p' && typeof value[key] === 'string') return;
    max = Math.max(max, maxLottieKeyframeFrame(value[key]));
  });
  return max;
}

function maxLottieShapeKeyframeFrame(lottieData: any): number {
  const layers = Array.isArray(lottieData?.layers) ? lottieData.layers : [];
  return layers.reduce((max, layer) => {
    if (layer?.ty !== 4 || layer.hd) return max;
    return Math.max(max, maxLottieKeyframeFrame(layer?.ks), maxLottieKeyframeFrame(layer?.shapes));
  }, 0);
}

export function getMultiPngTitleAnimationEnd(template: AETemplateLayer, fps = 30) {
  const model = template.multiTitleModel || {};
  const pairs = Array.isArray(model.pairs) ? model.pairs : [];
  let end = 0;
  pairs.forEach((pair: any) => {
    end = Math.max(
      end,
      maxSecondsKeyframeTime(pair.imageOpacity),
      maxSecondsKeyframeTime(pair.textOpacity),
      maxSecondsKeyframeTime(pair.imageScaleX)
    );
    (pair.imageOpacityTracks || []).forEach((track: any) => {
      end = Math.max(end, maxSecondsKeyframeTime(track));
    });
    (pair.imageScaleXTracks || []).forEach((track: any) => {
      end = Math.max(end, maxSecondsKeyframeTime(track));
    });
  });
  const lottieFr = Math.max(1, Number(template.lottieData?.fr || fps || 30));
  end = Math.max(end, maxLottieShapeKeyframeFrame(template.lottieData) / lottieFr);
  return Math.max(0, Math.ceil(end * Math.max(1, fps)) / Math.max(1, fps));
}

function multiTitleCacheSignature(template: AETemplateLayer, w: number, h: number, fps: number) {
  const fields = (template.fields || []).map((field: any) => ({
    bindingKey: field.bindingKey,
    value: field.value,
    fontSize: field.fontSize,
    fontFamily: field.fontFamily,
    fontWeight: field.fontWeight,
    color: field.color,
    strokeColor: field.strokeColor,
    strokeWidth: field.strokeWidth,
    paddingX: field.paddingX,
    renderMode: field.renderMode,
    useOverlay: field.useOverlay,
  }));
  return JSON.stringify({
    id: template.id,
    w,
    h,
    fps,
    fields,
    pairs: (template.multiTitleModel?.pairs || []).map((pair: any) => ({
      bindingKey: pair.bindingKey,
      baseText: pair.baseText,
      baseWidth: pair.baseWidth,
      baseHeight: pair.baseHeight,
      left: pair.left,
      top: pair.top,
      imageOpacity: pair.imageOpacity,
      textOpacity: pair.textOpacity,
      imageScaleX: pair.imageScaleX,
    })),
  });
}

function normalizeScaleValue(value: number) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 1;
  return Math.abs(n) > 10 ? n / 100 : n;
}

function drawField(ctx: CanvasRenderingContext2D, field: TemplateField, boxW: number, boxH: number, alpha = 1) {
  const x = field.x ?? 0;
  const y = field.y ?? 0;
  const hasSize = typeof field.w === 'number' && typeof field.h === 'number';
  const w = hasSize ? field.w! : 0;
  const h = hasSize ? field.h! : 0;
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
  ctx.textBaseline = hasSize ? 'middle' : 'alphabetic'; // Use middle inside a bounding box, alphabetic for direct baseline coordinates
  ctx.fillStyle = fill;
  if (stroke && strokeWidth > 0) {
    ctx.lineWidth = strokeWidth;
    ctx.strokeStyle = stroke;
    ctx.lineJoin = 'round';
  }
  const tx = hasSize ? (textAlign === 'left' ? x : textAlign === 'right' ? x + w : x + w / 2) : x;
  const ty = hasSize ? y + h / 2 : y;
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

export function drawData9Template(ctx: CanvasRenderingContext2D, template: AETemplateLayer, pixelW: number, pixelH: number, time: number, options: { drawBackgrounds?: boolean; overlayTextOnly?: boolean } = {}) {
  const model = template.multiTitleModel || {};
  const fields = template.fields || [];
  const fieldMap = new Map((fields as any[]).map((field: any) => [field.bindingKey, field]));
  const pairs = Array.isArray(model.pairs) ? model.pairs : [];
  const templateW = Math.max(1, Number(template.templateW || pixelW));
  const templateH = Math.max(1, Number(template.templateH || pixelH));
  const sx = pixelW / templateW;
  const sy = pixelH / templateH;
  pairs.forEach((pair: any, index: number) => {
    const field: any = fieldMap.get(pair.bindingKey) || fields[index] || {};
    if (options.overlayTextOnly && !(field.useOverlay || field.renderMode === 'overlay')) return;
    const img = getCachedImage(pair.imageSrc);
    const fontSize = Number(field.fontSize || pair.fontSize || 40) * sx;
    const fontFamily = field.fontFamily || pair.fontFamily || "Pretendard, 'Noto Sans KR', sans-serif";
    const textAlign = field.textAlign || pair.textAlign || 'center';
    const text = String(field.value ?? pair.baseText ?? '');
    ctx.save();
    ctx.font = `700 ${fontSize}px ${fontFamily}`;
    const textWidth = ctx.measureText(text || ' ').width;
    const baseW = Math.max(1, Number(pair.baseWidth || 240) * sx);
    const baseH = Math.max(2, Number(pair.baseHeight || 60) * sy);
    const baseLeft = Number(pair.left ?? (Number(pair.centerX || templateW / 2) - Number(pair.baseWidth || 240) / 2)) * sx;
    const baseTop = Number(pair.top ?? (Number(pair.centerY || templateH / 2) - Number(pair.baseHeight || 60) / 2)) * sy;
    const baseTextX = Number(pair.textXInBar ?? Number(pair.baseWidth || 240) / 2) * sx;
    const baseTextY = Number(pair.textYInBar ?? Number(pair.baseHeight || 60) / 2) * sy;
    const paddingX = Math.max(1, Number(field.paddingX ?? pair.paddingX ?? 32) * sx);
    const textLeft = textAlign === 'right' ? baseTextX - textWidth : textAlign === 'center' ? baseTextX - textWidth / 2 : baseTextX;
    const textRight = textAlign === 'right' ? baseTextX : textAlign === 'center' ? baseTextX + textWidth / 2 : baseTextX + textWidth;
    const extraLeft = Math.max(0, paddingX - textLeft);
    const extraRight = Math.max(0, paddingX - (baseW - textRight));
    const targetW = Math.max(baseW + extraLeft + extraRight, textWidth + paddingX * 2);
    const x = baseLeft - extraLeft;
    const y = baseTop;
    const scaleX = normalizeScaleValue(sampleKeyframes(pair.imageScaleX, time, 1));
    const imageAlpha = sampleKeyframes(pair.imageOpacity, time, 1);
    const textAlpha = sampleKeyframes(pair.textOpacity, time, 1);
    const originX = x + (Number(pair.scaleOriginXInBar ?? Number(pair.baseWidth || 240) / 2) * sx) + extraLeft;
    const originY = y + (Number(pair.scaleOriginYInBar ?? Number(pair.baseHeight || 60) / 2) * sy);

    if (options.drawBackgrounds !== false && imageAlpha > 0.001) {
      ctx.save();
      ctx.translate(originX, originY);
      ctx.scale(scaleX, 1);
      ctx.translate(-originX, -originY);
      drawThreeSlice(ctx, img, pair.sourceCrop, x, y, targetW, baseH, imageAlpha);
      ctx.restore();
    }

    if (textAlpha <= 0.001) {
      ctx.restore();
      return;
    }
    ctx.save();
    ctx.globalAlpha = textAlpha;
    ctx.font = `${field.fontWeight || '700'} ${fontSize}px ${fontFamily}`;
    ctx.textAlign = textAlign as CanvasTextAlign;
    ctx.textBaseline = typeof pair.textYInBar === 'number' ? 'alphabetic' : 'middle';
    ctx.fillStyle = field.color || pair.color || '#ffffff';
    const strokeWidth = typeof field.strokeWidth === 'number' ? field.strokeWidth * sx : Number(pair.strokeWidth || 0) * sx;
    const strokeColor = field.strokeColor || pair.strokeColor;
    const tx = x + baseTextX + extraLeft;
    const ty = y + baseTextY;
    if (strokeColor && strokeWidth > 0) {
      ctx.lineWidth = strokeWidth;
      ctx.strokeStyle = strokeColor;
      ctx.lineJoin = 'round';
      ctx.strokeText(text || ' ', tx, ty);
    }
    ctx.fillText(text || ' ', tx, ty);
    ctx.restore();
    ctx.restore();
  });
}

function readLottieValue(prop: any, frame: number, fallback: any) {
  const key = prop?.k;
  if (Array.isArray(key) && key.length && typeof key[0] === 'object' && ('t' in key[0])) {
    const frames = key;
    if (frame <= Number(frames[0].t || 0)) return frames[0].s ?? fallback;
    for (let i = 0; i < frames.length - 1; i++) {
      const a = frames[i];
      const b = frames[i + 1];
      const at = Number(a.t || 0);
      const bt = Number(b.t || at);
      if (frame >= at && frame <= bt) {
        const av = a.s ?? fallback;
        const bv = b.s ?? av;
        const p = (frame - at) / Math.max(0.0001, bt - at);
        if (Array.isArray(av) && Array.isArray(bv)) return av.map((v, idx) => Number(v || 0) + (Number(bv[idx] ?? v) - Number(v || 0)) * p);
        return Number(av || 0) + (Number(bv ?? av) - Number(av || 0)) * p;
      }
    }
    return frames[frames.length - 1].s ?? fallback;
  }
  return typeof key === 'undefined' ? fallback : key;
}

function toRgba(color: any, opacity = 100) {
  const c = Array.isArray(color) ? color : [1, 1, 1, 1];
  const a = Math.max(0, Math.min(1, Number(c[3] ?? 1) * Number(opacity ?? 100) / 100));
  return `rgba(${Math.round(Number(c[0] ?? 1) * 255)},${Math.round(Number(c[1] ?? 1) * 255)},${Math.round(Number(c[2] ?? 1) * 255)},${a})`;
}

function applyLottieTransform(ctx: CanvasRenderingContext2D, tr: any, frame: number) {
  const p = readLottieValue(tr?.p, frame, [0, 0]);
  const a = readLottieValue(tr?.a, frame, [0, 0]);
  const s = readLottieValue(tr?.s, frame, [100, 100]);
  const r = readLottieValue(tr?.r, frame, 0);
  ctx.translate(Number(p?.[0] || 0), Number(p?.[1] || 0));
  ctx.rotate((Number(r || 0) * Math.PI) / 180);
  ctx.scale(Number(s?.[0] ?? 100) / 100, Number(s?.[1] ?? 100) / 100);
  ctx.translate(-Number(a?.[0] || 0), -Number(a?.[1] || 0));
}

function drawBezierPath(ctx: CanvasRenderingContext2D, shape: any) {
  const data = shape?.v ? shape : shape?.ks?.k;
  const v = data?.v;
  if (!Array.isArray(v) || !v.length) return;
  const iPts = data.i || [];
  const oPts = data.o || [];
  ctx.beginPath();
  ctx.moveTo(Number(v[0][0] || 0), Number(v[0][1] || 0));
  for (let idx = 1; idx < v.length; idx++) {
    const prev = v[idx - 1];
    const cur = v[idx];
    const out = oPts[idx - 1] || [0, 0];
    const inn = iPts[idx] || [0, 0];
    ctx.bezierCurveTo(
      Number(prev[0] || 0) + Number(out[0] || 0),
      Number(prev[1] || 0) + Number(out[1] || 0),
      Number(cur[0] || 0) + Number(inn[0] || 0),
      Number(cur[1] || 0) + Number(inn[1] || 0),
      Number(cur[0] || 0),
      Number(cur[1] || 0)
    );
  }
  if (data.c) {
    const last = v[v.length - 1];
    const first = v[0];
    const out = oPts[v.length - 1] || [0, 0];
    const inn = iPts[0] || [0, 0];
    ctx.bezierCurveTo(
      Number(last[0] || 0) + Number(out[0] || 0),
      Number(last[1] || 0) + Number(out[1] || 0),
      Number(first[0] || 0) + Number(inn[0] || 0),
      Number(first[1] || 0) + Number(inn[1] || 0),
      Number(first[0] || 0),
      Number(first[1] || 0)
    );
    ctx.closePath();
  }
}

function drawPolystar(ctx: CanvasRenderingContext2D, item: any, frame: number) {
  const points = Math.max(3, Math.round(Number(readLottieValue(item.pt, frame, 5))));
  const pos = readLottieValue(item.p, frame, [0, 0]);
  const outer = Number(readLottieValue(item.or, frame, 20));
  const inner = Number(readLottieValue(item.ir, frame, outer * 0.5));
  const rot = (Number(readLottieValue(item.r, frame, 0)) - 90) * Math.PI / 180;
  const star = Number(item.sy || 1) === 1;
  ctx.beginPath();
  const steps = star ? points * 2 : points;
  for (let idx = 0; idx < steps; idx++) {
    const radius = star && idx % 2 ? inner : outer;
    const ang = rot + (idx / steps) * Math.PI * 2;
    const x = Number(pos?.[0] || 0) + Math.cos(ang) * radius;
    const y = Number(pos?.[1] || 0) + Math.sin(ang) * radius;
    if (idx === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  }
  ctx.closePath();
}

function paintCurrentPath(ctx: CanvasRenderingContext2D, fill: any, stroke: any, frame: number) {
  if (fill) {
    ctx.fillStyle = toRgba(readLottieValue(fill.c, frame, [1, 1, 1, 1]), readLottieValue(fill.o, frame, 100));
    ctx.fill();
  }
  if (stroke) {
    ctx.strokeStyle = toRgba(readLottieValue(stroke.c, frame, [1, 1, 1, 1]), readLottieValue(stroke.o, frame, 100));
    ctx.lineWidth = Math.max(0.1, Number(readLottieValue(stroke.w, frame, 1)));
    ctx.stroke();
  }
}

function drawShapeGroup(ctx: CanvasRenderingContext2D, group: any, frame: number) {
  const items = group?.it || [];
  const tr = items.find((item: any) => item.ty === 'tr');
  const fill = [...items].reverse().find((item: any) => item.ty === 'fl');
  const stroke = [...items].reverse().find((item: any) => item.ty === 'st');
  ctx.save();
  if (tr) applyLottieTransform(ctx, tr, frame);
  items.forEach((item: any) => {
    if (item.hd) return;
    if (item.ty === 'rc') {
      const size = readLottieValue(item.s, frame, [0, 0]);
      const pos = readLottieValue(item.p, frame, [0, 0]);
      ctx.beginPath();
      ctx.rect(Number(pos?.[0] || 0) - Number(size?.[0] || 0) / 2, Number(pos?.[1] || 0) - Number(size?.[1] || 0) / 2, Number(size?.[0] || 0), Number(size?.[1] || 0));
      paintCurrentPath(ctx, fill, stroke, frame);
    } else if (item.ty === 'el') {
      const size = readLottieValue(item.s, frame, [0, 0]);
      const pos = readLottieValue(item.p, frame, [0, 0]);
      ctx.beginPath();
      ctx.ellipse(Number(pos?.[0] || 0), Number(pos?.[1] || 0), Math.abs(Number(size?.[0] || 0) / 2), Math.abs(Number(size?.[1] || 0) / 2), 0, 0, Math.PI * 2);
      paintCurrentPath(ctx, fill, stroke, frame);
    } else if (item.ty === 'sh') {
      drawBezierPath(ctx, readLottieValue(item.ks, frame, item.ks?.k));
      paintCurrentPath(ctx, fill, stroke, frame);
    } else if (item.ty === 'sr') {
      drawPolystar(ctx, item, frame);
      paintCurrentPath(ctx, fill, stroke, frame);
    } else if (item.ty === 'gr') {
      drawShapeGroup(ctx, item, frame);
    }
  });
  ctx.restore();
}

export function rasterizeLottieShapesToCanvas(lottieData: any, time: number, scale = 1, targetW?: number, targetH?: number) {
  const sourceW = Math.max(1, Number(lottieData?.w || 1000));
  const sourceH = Math.max(1, Number(lottieData?.h || 1000));
  const w = Math.max(2, Math.round(Number(targetW || sourceW * scale)));
  const h = Math.max(2, Math.round(Number(targetH || sourceH * scale)));
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) return canvas;
  const frame = Math.max(0, time * Math.max(1, Number(lottieData?.fr || 30)));
  ctx.scale(w / sourceW, h / sourceH);
  (lottieData?.layers || []).slice().reverse().forEach((layer: any) => {
    if (layer?.ty !== 4 || layer.hd || frame < Number(layer.ip || 0) || frame >= Number(layer.op || Infinity)) return;
    const opacity = Number(readLottieValue(layer.ks?.o, frame, 100)) / 100;
    if (opacity <= 0.001) return;
    ctx.save();
    ctx.globalAlpha *= Math.max(0, Math.min(1, opacity));
    applyLottieTransform(ctx, layer.ks, frame);
    (layer.shapes || []).forEach((shape: any) => {
      if (shape?.ty === 'gr') drawShapeGroup(ctx, shape, frame);
      else drawShapeGroup(ctx, { it: [shape] }, frame);
    });
    ctx.restore();
  });
  return canvas;
}

export function rasterizeTemplateToCanvas(template: AETemplateLayer, time: number, scale = 1, options: { drawBackgrounds?: boolean; overlayTextOnly?: boolean } = {}) {
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
    drawData9Template(ctx, template, w, h, time, options);
  } else {
    // For generic Lottie, we skip the background box to allow transparency.
    // Fields are scaled from percentage to pixels.
    const nativeW = template.templateW || 1000;
    const renderScale = w / nativeW;
    (template.fields || []).forEach(field => {
      const scaledField = {
        ...field,
        x: typeof field.x === 'number' ? (field.x / 100) * w : undefined,
        y: typeof field.y === 'number' ? (field.y / 100) * h : undefined,
        w: typeof field.w === 'number' ? (field.w / 100) * w : undefined,
        h: typeof field.h === 'number' ? (field.h / 100) * h : undefined,
        fontSize: typeof field.fontSize === 'number' ? field.fontSize * renderScale : undefined,
      };
      drawField(ctx, scaledField, w, h, 1);
    });
  }
  return canvas;
}

export function rasterizeCachedMultiPngTitleCanvas(template: AETemplateLayer, time: number, scale = 1, fps = 30, options: { includeLottieShapes?: boolean } = {}) {
  const w = Math.max(2, Math.round((template.width || template.templateW || 1000) * scale));
  const h = Math.max(2, Math.round((template.height || template.templateH || 200) * scale));
  const safeFps = Math.max(1, Number(fps || 30));
  const firstFrameWindow = Math.max(0.0005, 1 / safeFps);
  const includeLottieShapes = options.includeLottieShapes !== false;
  const endTime = getMultiPngTitleAnimationEnd(template, safeFps);
  const effectiveTime = time < firstFrameWindow ? 0 : (endTime > 0 && time > endTime ? endTime : time);
  const frameIndex = time < firstFrameWindow ? -1 : Math.max(0, Math.round(effectiveTime * safeFps));
  const signature = multiTitleCacheSignature(template, w, h, safeFps);
  const cacheKey = `${signature}:shapes=${includeLottieShapes ? 1 : 0}:${frameIndex}`;
  const cached = multiTitleFrameCache.get(cacheKey);
  if (cached) return cached;

  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) return canvas;
  ctx.clearRect(0, 0, w, h);
  if (frameIndex >= 0) {
    const overlayCanvas = rasterizeTemplateToCanvas(template, effectiveTime, scale);
    ctx.drawImage(overlayCanvas, 0, 0);
    if (includeLottieShapes && template.lottieData) {
      const shapeCanvas = rasterizeLottieShapesToCanvas(template.lottieData, effectiveTime, scale, w, h);
      ctx.drawImage(shapeCanvas, 0, 0);
    }
  }
  (canvas as any).__hmTemplateCacheKey = cacheKey;
  multiTitleFrameCache.set(cacheKey, canvas);
  return canvas;
}
