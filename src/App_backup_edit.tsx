import { useState, useRef, useEffect, useCallback, useMemo } from "react";
// ── Interpolation ─────────────────────────────────────────────────────────────
const lerp = (kfs, time, fallback) => {
  if (!kfs || !kfs.length) return fallback;
  const s = [...kfs].sort((a, b) => a.t - b.t);
  if (time <= s[0].t) return s[0].v;
  if (time >= s[s.length - 1].t) return s[s.length - 1].v;
  for (let i = 0; i < s.length - 1; i++) {
    const a = s[i], b = s[i + 1];
    if (time >= a.t && time <= b.t) {
      const p = (time - a.t) / Math.max(0.0001, b.t - a.t);
      return a.v + (b.v - a.v) * p;
    }
  }
  return fallback;
};
const clamp = (v, mn, mx) => Math.max(mn, Math.min(mx, v));
const fmt = s => [Math.floor(s / 3600), Math.floor((s % 3600) / 60), Math.floor(s % 60), Math.floor((s % 1) * 30)]
  .map(n => String(n).padStart(2, "0")).join(":");
const uid = () => Math.random().toString(36).slice(2);
const KEYFRAME_PROPS = ["x", "y", "scale", "rotation", "opacity"];
const hasKeyframeAt = (item, prop, time) => !!(item?.kf?.[prop] || []).find(k => Math.abs(k.t - time) < 0.001);
const upsertKeyframe = (item, prop, time, value) => {
  const next = { ...(item.kf || {}) };
  const arr = [...(next[prop] || [])];
  const idx = arr.findIndex(k => Math.abs(k.t - time) < 0.001);
  const kf = { t: time, v: value };
  if (idx >= 0) arr[idx] = kf; else arr.push(kf);
  arr.sort((a, b) => a.t - b.t);
  next[prop] = arr;
  return next;
};
const removeKeyframe = (item, prop, time) => {
  const next = { ...(item.kf || {}) };
  next[prop] = [...(next[prop] || [])].filter(k => Math.abs(k.t - time) >= 0.001);
  return next;
};
const collectKeyframeTimes = item => {
  const times = new Set();
  KEYFRAME_PROPS.forEach(prop => ((item?.kf?.[prop] || []).forEach(k => times.add(Number(k.t.toFixed(3))))));
  return [...times].sort((a, b) => a - b);
};
// ── AE Template Registry / Package Helpers ───────────────────────────────────
const SAMPLE_TEMPLATE_DEF = {
  w: 1000, h: 170,
  layers: [
    { t: "path", d: "M0 30 H420 Q470 30 510 85 Q470 140 420 140 H0 Z", fill: "#0E8D95", stroke: "#37F5F6", sw: 3 },
    { t: "path", d: "M430 30 H965 L930 62 H555 Q520 62 490 95 Q520 140 560 140 H875 Q930 140 965 95 L1000 62 V30 Z", fill: "#2B353D", stroke: "#37F5F6", sw: 3 },
    { t: "line", x1: 45, y1: 54, x2: 370, y2: 54, stroke: "#7FFDFD", sw: 3, opacity: 0.85 },
    { t: "line", x1: 425, y1: 44, x2: 975, y2: 44, stroke: "#37F5F6", sw: 3, opacity: 0.9 },
    { t: "field", label: "Sub_텍스트", x: 48, y: 34, w: 320, h: 22, fs: 26, fw: "500", fill: "#F3F9FA", align: "left" },
    { t: "field", label: "Main_텍스트 상", x: 48, y: 78, w: 440, h: 42, fs: 48, fw: "700", fill: "#FFFFFF", align: "left" },
    { t: "field", label: "Main_텍스트 하", x: 645, y: 68, w: 300, h: 36, fs: 40, fw: "700", fill: "#FFFFFF", align: "center" },
  ]
};
const AE_TEMPLATES = {
  "TopTitle_F_04_AGL & NAVIADs": SAMPLE_TEMPLATE_DEF,
};
const DEFAULT_FIELDS = [
  { id: "subText", label: "Sub_텍스트", value: "부산 수영구 망미동" },
  { id: "mainTop", label: "Main_텍스트 상", value: "Reconstruction Project" },
  { id: "mainBottom", label: "Main_텍스트 하", value: "SHUAIBA AIR BASE" },
];
const defaultMetaForComp = compName => ({
  name: compName,
  mainCompName: compName,
  editableFields: DEFAULT_FIELDS.map(f => ({ ...f })),
  allowFontChange: true,
  allowColorChange: true,
});
const packageBaseName = name => name
  .replace(/\.meta\.json$/i, "")
  .replace(/\.web\.json$/i, "")
  .replace(/\.[^.]+$/i, "");
const getLottieDuration = data => {
  const fr = Math.max(1, Number(data?.fr || 30));
  const ip = Number(data?.ip || 0);
  const op = Number(data?.op || ip + fr * 5);
  return Math.max(0.1, (op - ip) / fr);
};
const getLottieDimensions = data => ({
  w: Math.max(1, Number(data?.w || 1000)),
  h: Math.max(1, Number(data?.h || 170)),
});
const getLottieTextDoc = layer => {
  const keyframes = Array.isArray(layer?.t?.d?.k) ? layer.t.d.k : [];
  return keyframes.find(k => k?.s && typeof k.s === "object")?.s || null;
};

const getLottieTextValue = layer => getLottieTextDoc(layer)?.t || "";

const lottieColorToHex = color => {
  if (!Array.isArray(color) || color.length < 3) return "#ffffff";
  const toHex = value => Math.max(0, Math.min(255, Math.round(Number(value || 0) * 255))).toString(16).padStart(2, "0");
  return `#${toHex(color[0])}${toHex(color[1])}${toHex(color[2])}`;
};

const hexToLottieColor = hex => {
  const normalized = String(hex || "#ffffff").replace("#", "");
  const safe = normalized.length === 3 ? normalized.split("").map(ch => ch + ch).join("") : normalized.padEnd(6, "f").slice(0, 6);
  return [parseInt(safe.slice(0, 2), 16) / 255, parseInt(safe.slice(2, 4), 16) / 255, parseInt(safe.slice(4, 6), 16) / 255];
};

const lottieJustifyToAlign = justify => justify === 2 ? "center" : justify === 1 ? "right" : "left";
const alignToLottieJustify = align => align === "center" ? 2 : align === "right" ? 1 : 0;

const readTransformValue = (prop, fallback) => {
  const key = prop?.k;
  if (Array.isArray(key) && key.length && typeof key[0] === "number") return key;
  if (Array.isArray(key) && key.length && typeof key[0] === "object") {
    const last = key[key.length - 1];
    if (Array.isArray(last?.s)) return last.s;
  }
  return fallback;
};

const measureTextLineWidth = (text, textDoc, charMap) => {
  const baseSize = 33;
  const scale = Number(textDoc?.s || 72) / baseSize;
  return Array.from(text || "").reduce((sum, ch) => sum + ((charMap.get(ch) || baseSize * 0.6) * scale), 0);
};

const WEB_FONT_OPTIONS = [
  { key: "overlay:Pretendard, 'Noto Sans KR', sans-serif", value: "Pretendard, 'Noto Sans KR', sans-serif", mode: "overlay", label: "Pretendard" },
  { key: "overlay:'Noto Sans KR', 'Malgun Gothic', sans-serif", value: "'Noto Sans KR', 'Malgun Gothic', sans-serif", mode: "overlay", label: "Noto Sans KR" },
  { key: "overlay:'Malgun Gothic', sans-serif", value: "'Malgun Gothic', sans-serif", mode: "overlay", label: "맑은 고딕" },
  { key: "overlay:Arial, sans-serif", value: "Arial, sans-serif", mode: "overlay", label: "Arial" },
  { key: "overlay:Georgia, serif", value: "Georgia, serif", mode: "overlay", label: "Georgia" },
];

const getGlyphChars = data => new Set((data?.chars || []).map(ch => ch.ch).filter(Boolean));

const hasGlyphSupport = (text, glyphChars) => {
  const set = glyphChars instanceof Set ? glyphChars : new Set(glyphChars || []);
  if (!set.size) return false;
  return Array.from(String(text || "")).every(ch => ch === "\n" || ch === "\r" || ch === " " || set.has(ch));
};

const estimateTextLayerBounds = (layer, data, charMap = null) => {
  const sourceW = Math.max(1, Number(data?.w || 1));
  const sourceH = Math.max(1, Number(data?.h || 1));
  const textDoc = getLottieTextDoc(layer);
  if (!textDoc) return null;
  const localCharMap = charMap || new Map((data?.chars || []).map(ch => [ch.ch, Number(ch.w || 0)]));
  const pos = readTransformValue(layer?.ks?.p, [0, 0, 0]);
  const anc = readTransformValue(layer?.ks?.a, [0, 0, 0]);
  const scl = readTransformValue(layer?.ks?.s, [100, 100, 100]);
  const sx = Number(scl?.[0] || 100) / 100;
  const sy = Number(scl?.[1] || 100) / 100;
  const lines = String(textDoc.t || "").replace(/\r/g, "").split("\n");
  const lineHeight = Number(textDoc.lh || textDoc.s || 72);
  const width = Math.max(...lines.map(line => measureTextLineWidth(line, textDoc, localCharMap)), 1) + Number(textDoc.sw || 0) * 4;
  const height = Math.max(1, lines.length) * lineHeight + Number(textDoc.sw || 0) * 4;
  const rawX = Number(pos?.[0] || 0) - Number(anc?.[0] || 0) * sx - 12;
  const rawY = Number(pos?.[1] || 0) - Number(anc?.[1] || 0) * sy - lineHeight * sy - 12;
  return {
    x: clamp(rawX, 0, sourceW),
    y: clamp(rawY, 0, sourceH),
    w: Math.max(1, Math.min(width * sx + 24, sourceW - clamp(rawX, 0, sourceW))),
    h: Math.max(1, Math.min(height * sy + 24, sourceH - clamp(rawY, 0, sourceH))),
  };
};

const normalizeFieldToCrop = (field, cropBounds, sourceW, sourceH) => {
  if (!cropBounds || typeof field?.x === "undefined") return field;
  const absX = (Number(field.x || 0) / 100) * sourceW;
  const absY = (Number(field.y || 0) / 100) * sourceH;
  if (field?.useCropAnchor) {
    return {
      ...field,
      x: Number(field.x || 0),
      y: Number(field.y || 0),
      w: 100,
      h: 100,
    };
  }
  const absW = (Number(field.w || 0) / 100) * sourceW;
  const absH = (Number(field.h || 0) / 100) * sourceH;
  return {
    ...field,
    x: ((absX - cropBounds.x) / Math.max(1, cropBounds.w)) * 100,
    y: ((absY - cropBounds.y) / Math.max(1, cropBounds.h)) * 100,
    w: (absW / Math.max(1, cropBounds.w)) * 100,
    h: (absH / Math.max(1, cropBounds.h)) * 100,
  };
};

const shouldUseOverlayForField = (field, glyphChars = []) => {
  if (!field) return false;
  if (field.renderMode === "overlay" || field.fontMode === "overlay") return true;
  return !hasGlyphSupport(field.value || "", glyphChars);
};

const createDefaultTemplateField = index => ({
  id: uid(),
  label: `텍스트 ${index}`,
  value: `텍스트 ${index}`,
  renderMode: "overlay",
  fontMode: "overlay",
  fontFamily: "Pretendard, 'Noto Sans KR', sans-serif",
  fontSize: 48,
  color: "#ffffff",
  strokeColor: "#0a4a4d",
  strokeWidth: 0,
  textAlign: "center",
  strokeMode: "outside",
  lineHeight: 1.1,
  x: 10,
  y: 34,
  w: 80,
  h: 16,
});

const measureCanvasTextWidth = (text, fontFamily, fontSize, fontWeight = "700", letterSpacing = 0) => {
  if (typeof document === "undefined") return String(text || "").length * Number(fontSize || 72) * 0.9;
  const canvas = measureCanvasTextWidth._canvas || (measureCanvasTextWidth._canvas = document.createElement("canvas"));
  const ctx = canvas.getContext("2d");
  if (!ctx) return String(text || "").length * Number(fontSize || 72) * 0.9;
  ctx.font = `${fontWeight} ${Number(fontSize || 72)}px ${fontFamily || "sans-serif"}`;
  const lines = String(text || "").split("\n");
  const spacing = Number(letterSpacing || 0);
  return Math.max(...lines.map(line => ctx.measureText(line || " ").width + Math.max(0, line.length - 1) * spacing), 0);
};

const getLayerScalePair = layer => {
  const key = layer?.ks?.s?.k;
  if (Array.isArray(key) && key.length && typeof key[0] === "number") return [Number(key[0] || 100), Number(key[1] || 100)];
  if (Array.isArray(key) && key.length && typeof key[0] === "object") {
    const last = key[key.length - 1];
    if (Array.isArray(last?.s)) return [Number(last.s[0] || 100), Number(last.s[1] || 100)];
  }
  return [100, 100];
};

const scaleLayerX = (layer, factor) => {
  if (!layer?.ks?.s) return;
  const key = layer.ks.s.k;
  if (Array.isArray(key) && key.length && typeof key[0] === "number") {
    layer.ks.s.k = [Number(key[0] || 100) * factor, Number(key[1] || 100), ...(key.length > 2 ? [key[2]] : [])];
    return;
  }
  if (Array.isArray(key) && key.length && typeof key[0] === "object") {
    layer.ks.s.k = key.map(frame => ({
      ...frame,
      s: Array.isArray(frame?.s) ? [Number(frame.s[0] || 100) * factor, Number(frame.s[1] || 100), ...(frame.s.length > 2 ? [frame.s[2]] : [])] : frame.s,
      e: Array.isArray(frame?.e) ? [Number(frame.e[0] || 100) * factor, Number(frame.e[1] || 100), ...(frame.e.length > 2 ? [frame.e[2]] : [])] : frame.e,
    }));
  }
};
const getLayerTimingSec = (layer, data) => {
  const fr = Math.max(1, Number(data?.fr || 30));
  return { ip: Number(layer?.ip ?? data?.ip ?? 0) / fr, op: Number(layer?.op ?? data?.op ?? 0) / fr };
};
const getScaleFactors = layer => {
  const scl = readTransformValue(layer?.ks?.s, [100, 100, 100]);
  return [Number(scl?.[0] || 100) / 100, Number(scl?.[1] || 100) / 100];
};
const getLayerOpacityKeyframesSec = (layer, data) => {
  const fr = Math.max(1, Number(data?.fr || 30));
  const key = layer?.ks?.o?.k;
  if (Array.isArray(key) && key.length && typeof key[0] === "object") {
    return key.map(frame => ({ t: Number(frame.t || 0) / fr, v: Number((frame.s && frame.s[0]) ?? 100) / 100 }));
  }
  const value = Array.isArray(key) ? Number(key[0] || 100) / 100 : Number(key ?? 100) / 100;
  return [{ t: 0, v: value }];
};
const estimateLayerTextWidthPx = (layer, data) => {
  const doc = getLottieTextDoc(layer) || {};
  const fontList = data?.fonts?.list || [];
  const fontMeta = fontList.find(font => font.fName === doc.f) || {};
  const fontFamily = fontMeta.fFamily ? `'${fontMeta.fFamily}', 'Noto Sans KR', sans-serif` : "Pretendard, 'Noto Sans KR', sans-serif";
  const [sx] = getScaleFactors(layer);
  const fontSize = Number(doc.s || 72) * sx;
  return measureCanvasTextWidth(String(doc.t || '').replace(/\r/g, ''), fontFamily, fontSize, '700', Number(doc.tr || 0));
};
const collectResizeTargets = data => {
  if (!data) return [];
  const assetMap = new Map((data?.assets || []).map(asset => [asset.id, asset]));
  const textLayers = (data?.layers || []).filter(layer => layer?.ty === 5);
  const imageLayers = (data?.layers || []).filter(layer => layer?.ty === 2 && assetMap.get(layer.refId));
  const fontList = data?.fonts?.list || [];
  const texts = textLayers.map(layer => {
    const doc = getLottieTextDoc(layer) || {};
    const fontMeta = fontList.find(font => font.fName === doc.f) || {};
    const fontFamily = fontMeta.fFamily ? `'${fontMeta.fFamily}', 'Noto Sans KR', sans-serif` : "Pretendard, 'Noto Sans KR', sans-serif";
    const pos = readTransformValue(layer?.ks?.p, [0,0,0]);
    const [sx, sy] = getScaleFactors(layer);
    const timing = getLayerTimingSec(layer, data);
    const bindingKey = `__main__::${layer.nm || ''}`;
    return {
      bindingKey,
      x: Number(pos?.[0] || 0),
      y: Number(pos?.[1] || 0),
      ip: timing.ip,
      op: timing.op,
      fontFamily,
      fontSize: Number(doc.s || 72) * sx,
      lineHeight: Number(doc.lh || doc.s || 72) * sy,
      baseText: String(doc.t || '').replace(/\r/g, ''),
      baseWidth: measureCanvasTextWidth(String(doc.t || '').replace(/\r/g, ''), fontFamily, Number(doc.s || 72) * sx, '700', Number(doc.tr || 0)),
    };
  });
  return imageLayers.map((layer, index) => {
    const asset = assetMap.get(layer.refId);
    const pos = readTransformValue(layer?.ks?.p, [0,0,0]);
    const [sx, sy] = getLayerScalePair(layer);
    const origW = Number(asset.w || 0) * (Number(sx || 100) / 100);
    const origH = Number(asset.h || 0) * (Number(sy || 100) / 100);
    const timing = getLayerTimingSec(layer, data);
    const baseScaleX = Number(sx || 100);
    const nearest = texts.map(txt => {
      const overlap = Math.max(0, Math.min(txt.op, timing.op) - Math.max(txt.ip, timing.ip));
      const timingPenalty = Math.abs(txt.ip - timing.ip) + Math.abs(txt.op - timing.op) - overlap * 2;
      const spatialPenalty = Math.abs(txt.y - Number(pos?.[1] || 0)) + Math.abs(txt.x - Number(pos?.[0] || 0)) * 0.15;
      return { txt, score: timingPenalty * 1000 + spatialPenalty };
    }).sort((a,b)=>a.score-b.score)[0]?.txt;
    return { layerIndex: (data?.layers || []).indexOf(layer), bindingKey: nearest?.bindingKey, baseScaleX, origW, origH, posX: Number(pos?.[0]||0), posY:Number(pos?.[1]||0) };
  }).filter(t => t.bindingKey);
};

const autoFitLottieBackground = (data, sourceData, fields = []) => {
  if (!data || !sourceData) return data;
  const bindingMap = new Map((fields || []).filter(f => f.bindingKey).map(f => [f.bindingKey, f]));
  const targets = collectResizeTargets(sourceData);
  targets.forEach(target => {
    const layer = data?.layers?.[target.layerIndex];
    const field = bindingMap.get(target.bindingKey);
    if (!layer || !field) return;
    const fontFamily = field.fontFamily || "Pretendard, 'Noto Sans KR', sans-serif";
    const fontSize = Number(field.fontSize || 72);
    const newWidth = measureCanvasTextWidth(String(field.value || '').replace(/\r/g, ''), fontFamily, fontSize, field.fontWeight || '700', Number(field.letterSpacing || 0));
    const extra = Math.max(0, newWidth - target.origW * 0.55);
    const desiredWidth = Math.max(target.origW, target.origW + extra);
    const factor = Math.max(1, desiredWidth / Math.max(1, target.origW));
    scaleLayerX(layer, factor);
  });
  return data;
};


const extractVectorSubtitleModel = data => null;

const computeVectorSubtitleMetrics = (model, field = {}) => {
  const text = String(field?.value || '');
  const fontFamily = field?.fontFamily || "Pretendard, 'Noto Sans KR', sans-serif";
  const fontSize = Number(field?.fontSize || model?.fontSize || 28);
  const barHeight = Math.max(Number(model?.baseBarHeight || 30), Math.ceil(fontSize * 1.18));
  const textWidth = measureCanvasTextWidth(text, fontFamily, fontSize, field?.fontWeight || '700', field?.letterSpacing || 0);
  const paddingX = Math.max(56, fontSize * 1.6);
  const barWidth = Math.max(Number(model?.baseBarWidth || 560), textWidth + paddingX * 2);
  return { text, fontFamily, fontSize, barWidth, barHeight, paddingX };
};

const resizeVectorGraphic = graphic => {
  if (graphic?.type !== 'ae_template' || graphic?.templateKind !== 'vector_subtitle' || !graphic?.vectorModel) return graphic;
  const field = (graphic.fields || [])[0] || {};
  const { barWidth, barHeight } = computeVectorSubtitleMetrics(graphic.vectorModel, field);
  const ratio = Number(graphic.templatePixelRatio || (graphic.width / Math.max(1, graphic.templateW || barWidth)) || 1);
  return { ...graphic, width: Math.round(barWidth * ratio), height: Math.round(barHeight * ratio), templateW: barWidth, templateH: barHeight };
};

const computeLottieVisibleBounds = data => {
  const sourceW = Math.max(1, Number(data?.w || 1));
  const sourceH = Math.max(1, Number(data?.h || 1));
  const assetMap = new Map((data?.assets || []).map(asset => [asset.id, asset]));
  const charMap = new Map((data?.chars || []).map(ch => [ch.ch, Number(ch.w || 0)]));
  const imageBoxes = [];
  const textBoxes = [];

  const pushBox = (target, box) => {
    if (!box || !isFinite(box.x) || !isFinite(box.y) || !isFinite(box.w) || !isFinite(box.h) || box.w <= 0 || box.h <= 0) return;
    target.push(box);
  };

  (data?.layers || []).forEach(layer => {
    const pos = readTransformValue(layer?.ks?.p, [0, 0, 0]);
    const anc = readTransformValue(layer?.ks?.a, [0, 0, 0]);
    const scl = readTransformValue(layer?.ks?.s, [100, 100, 100]);
    const sx = Number(scl?.[0] || 100) / 100;
    const sy = Number(scl?.[1] || 100) / 100;

    if (layer?.ty === 2) {
      const asset = assetMap.get(layer.refId);
      if (!asset) return;
      pushBox(imageBoxes, {
        x: Number(pos?.[0] || 0) - Number(anc?.[0] || 0) * sx,
        y: Number(pos?.[1] || 0) - Number(anc?.[1] || 0) * sy,
        w: Number(asset.w || 0) * sx,
        h: Number(asset.h || 0) * sy,
      });
      return;
    }

    if (layer?.ty === 5) {
      pushBox(textBoxes, estimateTextLayerBounds(layer, data, charMap));
    }
  });

  const boxes = imageBoxes.length ? imageBoxes : [...imageBoxes, ...textBoxes];
  if (!boxes.length) return { x: 0, y: 0, w: sourceW, h: sourceH, sourceW, sourceH };
  const minX = Math.max(0, Math.min(...boxes.map(box => box.x)));
  const minY = Math.max(0, Math.min(...boxes.map(box => box.y)));
  const maxX = Math.min(sourceW, Math.max(...boxes.map(box => box.x + box.w)));
  const maxY = Math.min(sourceH, Math.max(...boxes.map(box => box.y + box.h)));
  return { x: minX, y: minY, w: Math.max(1, maxX - minX), h: Math.max(1, maxY - minY), sourceW, sourceH };
};
const extractLottieTextFields = (data, metaFields = null) => {
  const detected = [];
  const sourceW = Math.max(1, Number(data?.w || 1));
  const sourceH = Math.max(1, Number(data?.h || 1));
  const charMap = new Map((data?.chars || []).map(ch => [ch.ch, Number(ch.w || 0)]));
  const fontList = data?.fonts?.list || [];
  const fontMap = new Map(fontList.map(font => [font.fName, font]));
  const visit = (layers, scope) => {
    if (!Array.isArray(layers)) return;
    layers.forEach(layer => {
      if (layer?.ty !== 5 || !layer?.t?.d?.k) return;
      const layerName = layer.nm || `Text ${detected.length + 1}`;
      const doc = getLottieTextDoc(layer) || {};
      const box = estimateTextLayerBounds(layer, data, charMap);
      const fontMeta = fontMap.get(doc.f || "") || {};
      detected.push({
        id: uid(),
        label: layerName,
        value: getLottieTextValue(layer),
        bindingKey: `${scope}::${layerName}`,
        order: detected.length,
        renderMode: "internal",
        fontMode: "internal",
        fontKey: doc.f || "",
        fontFamily: fontMeta.fFamily ? `'${fontMeta.fFamily}', 'Noto Sans KR', sans-serif` : "Pretendard, 'Noto Sans KR', sans-serif",
        sourceScaleX: Number(getScaleFactors(layer)[0] || 1),
        sourceScaleY: Number(getScaleFactors(layer)[1] || 1),
        fontSize: Number(doc.s || 72) * Number(getScaleFactors(layer)[0] || 1),
        color: lottieColorToHex(doc.fc || [1, 1, 1]),
        strokeColor: lottieColorToHex(doc.sc || [0, 0, 0]),
        strokeWidth: Number(doc.sw || 0),
        textAlign: lottieJustifyToAlign(doc.j),
        strokeMode: doc.of ? "center" : "outside",
        lineHeight: Number(doc.lh || doc.s || 72) * Number(getScaleFactors(layer)[1] || 1),
        animOpacity: getLayerOpacityKeyframesSec(layer, data),
        x: (Number(readTransformValue(layer?.ks?.p, [0, 0, 0])?.[0] || 0) / sourceW) * 100,
        y: (Number(readTransformValue(layer?.ks?.p, [0, 0, 0])?.[1] || 0) / sourceH) * 100,
        w: 100,
        h: 100,
        useCropAnchor: true,
        boxHint: box,
      });
    });
  };
  visit(data?.layers, "__main__");
  (data?.assets || []).forEach((asset, index) => visit(asset?.layers, asset?.id || `asset_${index}`));

  if (!Array.isArray(metaFields) || !metaFields.length) return detected;

  const detectedByBinding = new Map(detected.map(f => [f.bindingKey, f]));
  const detectedByLabel = new Map(detected.map(f => [f.label, f]));

  return detected.map(field => {
    const meta = metaFields.find(m => m.bindingKey === field.bindingKey || m.label === field.label);
    return meta ? { ...field, ...meta, id: meta.id || field.id } : field;
  }).concat(
    metaFields
      .filter(meta => !detectedByBinding.has(meta.bindingKey) && !detectedByLabel.has(meta.label))
      .map((meta, index) => ({
        ...createDefaultTemplateField(detected.length + index + 1),
        ...meta,
        id: meta.id || uid(),
        renderMode: meta.renderMode || "overlay",
      }))
  );
};

const applyLottieTextFields = (sourceData, fields = []) => {
  if (!sourceData) return null;
  const glyphChars = getGlyphChars(sourceData);
  const bindingMap = new Map((fields || []).filter(f => f.bindingKey).map(f => [f.bindingKey, f]));
  if (!bindingMap.size) return sourceData;

  const cloned = JSON.parse(JSON.stringify(sourceData));
  const applyToLayers = (layers, scope) => {
    if (!Array.isArray(layers)) return;
    layers.forEach(layer => {
      if (layer?.ty !== 5 || !Array.isArray(layer?.t?.d?.k)) return;
      const layerName = layer.nm || "";
      const bindingKey = `${scope}::${layerName}`;
      if (!bindingMap.has(bindingKey)) return;
      const field = bindingMap.get(bindingKey);
      const useOverlay = shouldUseOverlayForField(field, glyphChars);
      layer.t.d.k = layer.t.d.k.map(kf => {
        if (kf?.s && typeof kf.s === "object") {
          if (useOverlay) {
            kf.s.t = "";
          } else {
            kf.s.t = field.value ?? "";
            if (field.fontKey) kf.s.f = field.fontKey;
            if (field.fontSize) kf.s.s = Number(field.fontSize) / Math.max(0.0001, Number(field.sourceScaleX || 1));
            if (field.color) kf.s.fc = hexToLottieColor(field.color);
            if (field.strokeColor) kf.s.sc = hexToLottieColor(field.strokeColor);
            if (typeof field.strokeWidth !== "undefined") kf.s.sw = Number(field.strokeWidth || 0) / Math.max(0.0001, Number(field.sourceScaleX || 1));
            if (field.textAlign) kf.s.j = alignToLottieJustify(field.textAlign);
            if (field.strokeMode) kf.s.of = field.strokeMode !== "outside";
            if (field.lineHeight) kf.s.lh = Number(field.lineHeight) / Math.max(0.0001, Number(field.sourceScaleY || 1));
          }
        }
        return kf;
      });
    });
  };

  applyToLayers(cloned.layers, "__main__");
  (cloned.assets || []).forEach((asset, index) => applyToLayers(asset?.layers, asset?.id || `asset_${index}`));
  autoFitLottieBackground(cloned, sourceData, fields);
  return cloned;
};

// ── SVG Template Renderer ─────────────────────────────────────────────────────
function AETemplateSVG({ compName, fields = [], fontFamily = "sans-serif", webDef = null }) {
  const def = webDef || AE_TEMPLATES[compName];
  if (!def) return (
    <div style={{ width: "100%", height: "100%", background: "rgba(34,197,94,0.08)", border: "1px dashed rgba(34,197,94,0.4)", display: "flex", alignItems: "center", justifyContent: "center", color: "#22c55e", fontSize: 11 }}>
      AE 템플릿 (웹 정의 미등록)
    </div>
  );
  const fieldMap = new Map(fields.map(f => [f.label, f.value]));
  return (
    <svg viewBox={`0 0 ${def.w} ${def.h}`} style={{ width: "100%", height: "100%", overflow: "visible" }} preserveAspectRatio="xMidYMid meet">
      {def.layers.map((l, i) => {
        if (l.t === "path") return <path key={i} d={l.d} fill={l.fill} stroke={l.stroke} strokeWidth={l.sw} opacity={l.opacity ?? 1} />;
        if (l.t === "line") return <line key={i} x1={l.x1} y1={l.y1} x2={l.x2} y2={l.y2} stroke={l.stroke} strokeWidth={l.sw} opacity={l.opacity ?? 1} />;
        const text = fieldMap.get(l.label) || l.label;
        const tx = l.align === "left" ? l.x : l.align === "right" ? l.x + l.w : l.x + l.w / 2;
        const anchor = l.align === "left" ? "start" : l.align === "right" ? "end" : "middle";
        return (
          <text key={i} x={tx} y={l.y + l.fs} fill={l.fill} fontSize={l.fs} fontWeight={l.fw} textAnchor={anchor}
            style={{ fontFamily }}>
            {text}
          </text>
        );
      })}
    </svg>
  );
}

function VectorSubtitleTemplate({ model, fields = [], time = 999, selected = false }) {
  const canvasRef = useRef(null);
  const field = fields?.[0] || {};
  const { text, fontFamily, fontSize, barWidth, barHeight, paddingX } = computeVectorSubtitleMetrics(model, field);
  const strokeWidth = Number(field?.strokeWidth ?? model?.strokeWidth ?? 0);
  const textAlign = field?.textAlign || model?.textAlign || 'center';
  const textAnchor = textAlign === 'left' ? 'start' : textAlign === 'right' ? 'end' : 'middle';
  const reveal = model?.barAnimEnd > model?.barAnimStart ? clamp((time - model.barAnimStart) / Math.max(0.001, model.barAnimEnd - model.barAnimStart), 0, 1) : 1;
  const textOpacity = model?.textAnimEnd > model?.textAnimStart ? clamp((time - model.textAnimStart) / Math.max(0.001, model.textAnimEnd - model.textAnimStart), 0, 1) : 1;
  const textX = textAlign === 'left' ? paddingX : textAlign === 'right' ? barWidth - paddingX : barWidth / 2;
  const textY = barHeight / 2 + fontSize * 0.02;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !model?.imageSrc) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const img = new Image();
    img.onload = () => {
      const destW = Math.max(1, Math.round(barWidth));
      const destH = Math.max(1, Math.round(barHeight));
      canvas.width = destW;
      canvas.height = destH;
      ctx.clearRect(0, 0, destW, destH);
      const srcW = img.width;
      const srcH = img.height;
      const cap = Math.min(Math.round(srcW * 0.12), Math.floor(srcW / 3));
      const leftW = Math.min(cap, Math.floor(destW / 2));
      const rightW = Math.min(cap, Math.floor(destW / 2));
      const centerSrcW = Math.max(1, srcW - cap * 2);
      const centerDestW = Math.max(1, destW - leftW - rightW);
      ctx.drawImage(img, 0, 0, cap, srcH, 0, 0, leftW, destH);
      ctx.drawImage(img, cap, 0, centerSrcW, srcH, leftW, 0, centerDestW, destH);
      ctx.drawImage(img, srcW - cap, 0, cap, srcH, leftW + centerDestW, 0, rightW, destH);
    };
    img.src = model.imageSrc;
  }, [model?.imageSrc, barWidth, barHeight]);

  return (
    <svg viewBox={`0 0 ${barWidth} ${barHeight}`} style={{ width: '100%', height: '100%', overflow: 'visible' }} preserveAspectRatio="none">
      <foreignObject x="0" y="0" width={barWidth} height={barHeight} transform={`translate(${barWidth / 2} ${barHeight / 2}) scale(${reveal} 1) translate(${-barWidth / 2} ${-barHeight / 2})`}>
        <div xmlns="http://www.w3.org/1999/xhtml" style={{ width: '100%', height: '100%', position: 'relative' }}>
          <canvas ref={canvasRef} style={{ width: '100%', height: '100%', display: 'block' }} />
        </div>
      </foreignObject>
      <text x={textX} y={textY} textAnchor={textAnchor} dominantBaseline="middle" fill={field?.color || '#ffffff'} stroke={field?.strokeColor || '#0a4a4d'} strokeWidth={strokeWidth} paintOrder="stroke fill" fontSize={fontSize} fontWeight={field?.fontWeight || '700'} fontFamily={fontFamily} opacity={textOpacity}>{text || ' '}</text>
      {selected && <rect x="1" y="1" width={barWidth - 2} height={barHeight - 2} fill="none" stroke="#22c55e" strokeDasharray="6 4" strokeWidth="2" />}
    </svg>
  );
}
function LottieTemplatePlayer({ animationData, progress = 0, mode = "scrub" }) {
  const hostRef = useRef(null);
  const animRef = useRef(null);
  useEffect(() => {
    let disposed = false;
    let localAnim = null;
    const mount = async () => {
      if (!hostRef.current || !animationData) return;
      hostRef.current.innerHTML = "";
      const mod = await import("lottie-web");
      const lottie = mod.default || mod;
      if (disposed || !hostRef.current) return;
      localAnim = lottie.loadAnimation({
        container: hostRef.current,
        renderer: "svg",
        loop: mode === "loop",
        autoplay: mode === "loop",
        animationData,
        rendererSettings: {
          preserveAspectRatio: "xMidYMid meet",
          progressiveLoad: true,
        },
      });
      animRef.current = localAnim;
      localAnim.addEventListener("DOMLoaded", () => {
        if (disposed || !localAnim || mode === "loop") return;
        const totalFrames = Math.max(1, Number(localAnim.totalFrames || 1));
        const frame = clamp(progress, 0, 1) * Math.max(0, totalFrames - 0.001);
        localAnim.goToAndStop(frame, true);
      });
    };
    mount().catch(err => console.error("Failed to load Lottie template", err));
    return () => {
      disposed = true;
      if (localAnim) {
        try { localAnim.destroy(); } catch {}
      }
      animRef.current = null;
      if (hostRef.current) hostRef.current.innerHTML = "";
    };
  }, [animationData, mode]);
  useEffect(() => {
    if (mode === "loop") return;
    const anim = animRef.current;
    if (!anim) return;
    const totalFrames = Math.max(1, Number(anim.totalFrames || 1));
    const frame = clamp(progress, 0, 1) * Math.max(0, totalFrames - 0.001);
    try { anim.goToAndStop(frame, true); } catch {}
  }, [progress, mode]);
  return <div ref={hostRef} style={{ width: "100%", height: "100%", overflow: "hidden" }} />;
}
function TemplateTextOverlayField({ field, time = 999 }) {
  const clipId = useMemo(() => `txt-clip-${field.id}`, [field.id]);
  const lines = String(field?.value || "").split("\n");
  const fontSize = Number(field?.fontSize || 72);
  const lineHeight = Number(field?.lineHeight || 1.1);
  const textAlign = field?.textAlign || "center";
  const fillColor = field?.color || "#ffffff";
  const strokeColor = field?.strokeColor || "#0a4a4d";
  const strokeWidth = Math.max(0, Number(field?.strokeWidth || 0));
  const strokeMode = field?.strokeMode || "outside";
  const anchorMode = !!field?.useCropAnchor;
  const rawX = Number(field?.x ?? 10);
  const rawY = Number(field?.y ?? 34);
  const rawW = Number(field?.w ?? 80);
  const rawH = Number(field?.h ?? 16);
  const safeBox = anchorMode ? { x: 0, y: 0, w: 100, h: 100 } : {
    x: isFinite(rawX) && rawX >= 0 && rawX <= 100 ? rawX : 4,
    y: isFinite(rawY) && rawY >= 0 && rawY <= 100 ? rawY : 10,
    w: isFinite(rawW) && rawW > 0 && rawW <= 100 ? rawW : 92,
    h: isFinite(rawH) && rawH > 0 && rawH <= 100 ? rawH : 80,
  };
  if (safeBox.x + safeBox.w > 100) safeBox.w = Math.max(1, 100 - safeBox.x);
  if (safeBox.y + safeBox.h > 100) safeBox.h = Math.max(1, 100 - safeBox.y);
  const anchorX = anchorMode ? clamp(rawX, 0, 100) : (textAlign === "left" ? 0 : textAlign === "right" ? 100 : 50);
  const anchorY = anchorMode ? clamp(rawY, 0, 100) : 50;
  const textAnchor = textAlign === "left" ? "start" : textAlign === "right" ? "end" : "middle";
  const baselineShift = -((Math.max(1, lines.length) - 1) * fontSize * lineHeight) / 2;
  const animOpacity = Array.isArray(field?.animOpacity) ? clamp(lerp(field.animOpacity, time, field.animOpacity[field.animOpacity.length - 1]?.v ?? 1), 0, 1) : 1;
  const renderText = extraProps => (
    <text
      x={`${anchorX}%`}
      y={`${anchorY}%`}
      textAnchor={textAnchor}
      fontSize={fontSize}
      fontWeight={field?.fontWeight || "700"}
      fontFamily={field?.fontFamily || "Pretendard, 'Noto Sans KR', sans-serif"}
      dominantBaseline="middle"
      transform={`translate(0 ${baselineShift})`}
      style={{ letterSpacing: `${Number(field?.letterSpacing || 0)}px` }}
      {...extraProps}
    >
      {lines.map((line, idx) => (
        <tspan key={idx} x={`${anchorX}%`} dy={idx === 0 ? 0 : fontSize * lineHeight}>{line || " "}</tspan>
      ))}
    </text>
  );
  return (
    <div style={{ position: "absolute", left: `${safeBox.x}%`, top: `${safeBox.y}%`, width: `${safeBox.w}%`, height: `${safeBox.h}%`, overflow: "visible", pointerEvents: "none", opacity: animOpacity }}>
      <svg width="100%" height="100%" style={{ overflow: "visible" }}>
        {strokeWidth > 0 && strokeMode === "inside" && (
          <defs>
            <clipPath id={clipId}>{renderText({ fill: "#fff", stroke: "none" })}</clipPath>
          </defs>
        )}
        {strokeWidth > 0 && strokeMode === "outside" && renderText({
          fill: fillColor,
          stroke: strokeColor,
          strokeWidth,
          strokeLinejoin: "round",
          paintOrder: "stroke fill",
        })}
        {strokeWidth > 0 && strokeMode === "center" && renderText({
          fill: fillColor,
          stroke: strokeColor,
          strokeWidth,
          strokeLinejoin: "round",
        })}
        {strokeWidth > 0 && strokeMode === "inside" && (
          <>
            <g clipPath={`url(#${clipId})`}>
              {renderText({ fill: "none", stroke: strokeColor, strokeWidth: Math.max(1, strokeWidth * 2), strokeLinejoin: "round" })}
            </g>
            {renderText({ fill: fillColor, stroke: "none" })}
          </>
        )}
        {(strokeWidth <= 0) && renderText({ fill: fillColor, stroke: "none" })}
      </svg>
    </div>
  );
}
function TemplateTextOverlay({ fields = [], time = 999 }) {
  if (!fields?.length) return null;
  return (
    <div style={{ position: "absolute", inset: 0, pointerEvents: "none", overflow: "visible" }}>
      {fields.map(field => <TemplateTextOverlayField key={field.id} field={field} time={time} />)}
    </div>
  );
}
function CroppedTemplateStage({ sourceW, sourceH, cropBounds, children }) {
  const crop = cropBounds || { x: 0, y: 0, w: sourceW || 1, h: sourceH || 1 };
  const widthPct = ((sourceW || crop.w) / crop.w) * 100;
  const heightPct = ((sourceH || crop.h) / crop.h) * 100;
  const leftPct = -(crop.x / crop.w) * 100;
  const topPct = -(crop.y / crop.h) * 100;
  return (
    <div style={{ position: "relative", width: "100%", height: "100%", overflow: "hidden" }}>
      <div style={{ position: "absolute", left: `${leftPct}%`, top: `${topPct}%`, width: `${widthPct}%`, height: `${heightPct}%` }}>
        {children}
      </div>
    </div>
  );
}

function TemplateThumbnail({ template, fields = null, fontFamily = "Pretendard, 'Noto Sans KR', sans-serif" }) {
  const resolvedFields = fields || template?.fields || [];
  const normalizedFields = useMemo(() => (resolvedFields || []).map(field => ({
    ...field,
    useOverlay: shouldUseOverlayForField(field, template?.glyphChars || []),
  })), [resolvedFields, template?.glyphChars]);
  const resolvedLottieData = useMemo(() => applyLottieTextFields(template?.lottieData, normalizedFields), [template?.lottieData, normalizedFields]);
  if (template?.previewUrl) {
    return <img src={template.previewUrl} alt={template.name || template.compName || "template"} style={{ width: "100%", height: "100%", objectFit: "contain", display: "block" }} />;
  }
  if (template?.templateKind === "vector_subtitle" && template?.vectorModel) {
    return <VectorSubtitleTemplate model={template.vectorModel} fields={normalizedFields} time={999} />;
  }
  if (resolvedLottieData) {
    const overlayFields = normalizedFields.filter(field => field.useOverlay);
    return (
      <CroppedTemplateStage sourceW={template?.templateW} sourceH={template?.templateH} cropBounds={template?.cropBounds}>
        <LottieTemplatePlayer animationData={resolvedLottieData} mode="loop" />
        {overlayFields.length > 0 && <TemplateTextOverlay fields={overlayFields} time={999} />}
      </CroppedTemplateStage>
    );
  }
  return <AETemplateSVG compName={template?.compName} fields={normalizedFields} fontFamily={fontFamily} webDef={template?.webDef || null} />;
}
// ── Graphic on Canvas ─────────────────────────────────────────────────────────
function GraphicEl({ g, time, selected, editing, onEdit, onEndEdit, onChange }) {
  const visible = time >= g.ts && time < g.ts + g.dur;
  if (!visible) return null;
  const ct = time - g.ts;
  const x = lerp(g.kf?.x, ct, g.x);
  const y = lerp(g.kf?.y, ct, g.y);
  const sc = lerp(g.kf?.scale, ct, g.scale);
  const op = lerp(g.kf?.opacity, ct, g.opacity);
  const rot = lerp(g.kf?.rotation, ct, g.rotation ?? 0);
  const base = {
    position: "absolute",
    left: `${x}%`, top: `${y}%`,
    width: g.width, height: g.height,
    opacity: op,
    transform: `translate(-50%,-50%) scale(${sc / 100}) rotate(${rot}deg)`,
    transformOrigin: "center center",
    pointerEvents: "none",
    outline: "none",
    overflow: "visible",
    zIndex: selected ? 100 : 1,
  };
  if (g.type === "ae_template") {
    const templateDur = Math.max(0.1, Number(g.templateDuration || g.dur || 5));
    const progress = clamp(ct / templateDur, 0, 1);
    const normalizedFields = (g.fields || []).map(field => ({
      ...field,
      useOverlay: shouldUseOverlayForField(field, g.glyphChars || []),
    }));
    const resolvedLottieData = useMemo(() => applyLottieTextFields(g.lottieData, normalizedFields), [g.lottieData, normalizedFields]);
    const overlayFields = normalizedFields.filter(field => field.useOverlay);
    return (
      <div style={{ ...base, border: selected ? "2px solid #22c55e" : "none", boxShadow: selected ? "0 0 0 1px rgba(34,197,94,0.35)" : "none" }}>
        {g.templateKind === "vector_subtitle" && g.vectorModel ? (
          <VectorSubtitleTemplate model={g.vectorModel} fields={normalizedFields} time={ct} selected={selected} />
        ) : resolvedLottieData ? (
          <CroppedTemplateStage sourceW={g.templateW} sourceH={g.templateH} cropBounds={g.cropBounds}>
            <LottieTemplatePlayer animationData={resolvedLottieData} progress={progress} />
            {overlayFields.length > 0 && <TemplateTextOverlay fields={overlayFields} time={999} />}
          </CroppedTemplateStage>
        ) : (
          <AETemplateSVG compName={g.compName} fields={normalizedFields} fontFamily={g.fontFamily} webDef={g.webDef || null} />
        )}
        {selected && (
          <div style={{ position: "absolute", top: -18, left: 0, background: "rgba(34,197,94,0.85)", color: "#000", fontSize: 9, fontWeight: 700, padding: "1px 6px", borderRadius: 3, whiteSpace: "nowrap" }}>
            {(g.templateKind === "vector_subtitle") ? "Vector Subtitle" : g.lottieData ? "Lottie Template" : "AE Template"} · {g.compName}
          </div>
        )}
      </div>
    );
  }
  if (g.type === "text") {
    if (editing) {
      return (
        <div style={{ ...base, pointerEvents: "auto" }}>
          <div
            contentEditable suppressContentEditableWarning
            style={{ width: "100%", height: "100%", color: g.color, fontSize: g.fontSize, fontFamily: g.fontFamily || "sans-serif", fontWeight: g.fontWeight || "700", textAlign: g.textAlign || "center", display: "flex", alignItems: "center", justifyContent: g.textAlign === "left" ? "flex-start" : g.textAlign === "right" ? "flex-end" : "center", padding: "4px 8px", border: "2px solid #f97316", outline: "none", background: "rgba(0,0,0,0.3)", whiteSpace: "pre-wrap", wordBreak: "break-word", boxSizing: "border-box" }}
            onBlur={e => { onChange(e.currentTarget.textContent || ""); onEndEdit(); }}
            onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); e.currentTarget.blur(); } }}
            ref={el => { if (el && document.activeElement !== el) { el.focus(); const r = document.createRange(); r.selectNodeContents(el); const s = window.getSelection(); s?.removeAllRanges(); s?.addRange(r); } }}
          >{g.content}</div>
        </div>
      );
    }
    return (
      <div style={{ ...base, color: g.color, fontSize: g.fontSize, fontFamily: g.fontFamily || "sans-serif", fontWeight: g.fontWeight || "700", textAlign: g.textAlign || "center", display: "flex", alignItems: "center", justifyContent: g.textAlign === "left" ? "flex-start" : g.textAlign === "right" ? "flex-end" : "center", padding: "4px 8px", whiteSpace: "pre-wrap", wordBreak: "break-word", border: selected ? "1px solid #f97316" : "none" }}>
        {g.content}
      </div>
    );
  }
  if (g.type === "rectangle") {
    return <div style={{ ...base, background: g.color, borderRadius: 4, border: selected ? "2px solid #f97316" : "none" }} />;
  }
  if (g.type === "circle") {
    return <div style={{ ...base, background: g.color, borderRadius: "9999px", border: selected ? "2px solid #f97316" : "none" }} />;
  }
  return null;
}
// ── Transform Handles ─────────────────────────────────────────────────────────
function TransformHandles({ g, time, stageRef, onBeginInteract }) {
  if (!g) return null;
  const ct = time - g.ts;
  const x = lerp(g.kf?.x, ct, g.x);
  const y = lerp(g.kf?.y, ct, g.y);
  const sc = lerp(g.kf?.scale, ct, g.scale);
  const rot = lerp(g.kf?.rotation, ct, g.rotation ?? 0);
  const corners = [
    { key: "nw", cx: -1, cy: -1, cursor: "nwse-resize" },
    { key: "ne", cx: 1, cy: -1, cursor: "nesw-resize" },
    { key: "sw", cx: -1, cy: 1, cursor: "nesw-resize" },
    { key: "se", cx: 1, cy: 1, cursor: "nwse-resize" },
  ];
  return (
    <div style={{ position: "absolute", left: `${x}%`, top: `${y}%`, width: g.width, height: g.height, transform: `translate(-50%,-50%) scale(${sc / 100}) rotate(${rot}deg)`, transformOrigin: "center center", pointerEvents: "none", zIndex: 200 }}>
      {/* border */}
      <div onMouseDown={e => onBeginInteract(e, g, "move")} style={{ position: "absolute", inset: 0, border: "2px solid #f97316", boxShadow: "0 0 0 1px rgba(249,115,22,0.2)", cursor: "move", pointerEvents: "auto" }} />
      {/* corner handles */}
      {corners.map(({ key, cx, cy, cursor }) => (
        <div key={key}
          onMouseDown={e => onBeginInteract(e, g, "scale")}
          style={{ position: "absolute", width: 14, height: 14, background: "#f97316", border: "2px solid #000", borderRadius: "50%", cursor, pointerEvents: "auto", left: cx > 0 ? "100%" : 0, top: cy > 0 ? "100%" : 0, transform: `translate(${cx > 0 ? "-50%" : "-50%"}, ${cy > 0 ? "-50%" : "-50%"})` }} />
      ))}
      {/* rotate handle */}
      <div style={{ position: "absolute", left: "50%", top: 0, width: 1, height: 24, background: "rgba(249,115,22,0.7)", transform: "translate(-50%, -100%)", pointerEvents: "none" }} />
      <div
        onMouseDown={e => onBeginInteract(e, g, "rotate")}
        style={{ position: "absolute", left: "50%", top: -34, width: 18, height: 18, background: "#38bdf8", border: "2px solid #000", borderRadius: "50%", cursor: "grab", pointerEvents: "auto", transform: "translateX(-50%)" }} />
    </div>
  );
}
// ── Slider ────────────────────────────────────────────────────────────────────
function Slider({ value, min, max, step, onChange, onCommit, style }) {
  return (
    <input type="range" min={min} max={max} step={step} value={value}
      onChange={e => onChange(Number(e.target.value))}
      onMouseUp={onCommit} onTouchEnd={onCommit}
      style={{ width: "100%", accentColor: "#f97316", cursor: "pointer", ...style }} />
  );
}
// ── Color Swatch ──────────────────────────────────────────────────────────────
function ColorPicker({ value, onChange }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
      <input type="color" value={value || "#ffffff"} onChange={e => onChange(e.target.value)}
        style={{ width: 32, height: 28, border: "1px solid #3f3f46", borderRadius: 4, cursor: "pointer", padding: 2, background: "#18181b" }} />
      <input type="text" value={value || "#ffffff"} onChange={e => onChange(e.target.value)}
        style={{ flex: 1, background: "#18181b", border: "1px solid #3f3f46", borderRadius: 4, color: "#fff", fontSize: 11, padding: "3px 6px", outline: "none", fontFamily: "monospace" }} />
    </div>
  );
}
// ── PropRow ───────────────────────────────────────────────────────────────────
function PropRow({ label, value, min, max, step, unit = "", onChange, onCommit }) {
  return (
    <div style={{ marginBottom: 8 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, marginBottom: 3 }}>
        <span style={{ fontSize: 10, color: "#71717a", textTransform: "uppercase", letterSpacing: "0.08em" }}>{label}</span>
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <input type="number" value={typeof value === "number" ? value : 0} min={min} max={max} step={step}
            onChange={e => onChange(clamp(Number(e.target.value), min, max))}
            onBlur={onCommit}
            style={{ width: 76, background: "#18181b", border: "1px solid #3f3f46", borderRadius: 4, color: "#fff", fontSize: 10, padding: "2px 6px", outline: "none", fontFamily: "monospace" }} />
          <span style={{ fontSize: 10, color: "#a1a1aa", fontFamily: "monospace" }}>{unit}</span>
        </div>
      </div>
      <Slider value={value} min={min} max={max} step={step} onChange={onChange} onCommit={onCommit} />
    </div>
  );
}
function AnimPropRow({ label, value, min, max, step, unit = "", onChange, onCommit, keyframed, onToggleKeyframe }) {
  return (
    <div style={{ marginBottom: 8 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, marginBottom: 3 }}>
        <span style={{ fontSize: 10, color: "#71717a", textTransform: "uppercase", letterSpacing: "0.08em" }}>{label}</span>
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <button onClick={onToggleKeyframe} style={{ background: keyframed ? "#f97316" : "#18181b", color: keyframed ? "#000" : "#a1a1aa", border: `1px solid ${keyframed ? "#f97316" : "#3f3f46"}`, borderRadius: 4, padding: "1px 6px", fontSize: 10, cursor: "pointer", fontWeight: 700 }}>◆</button>
          <input type="number" value={typeof value === "number" ? value : 0} min={min} max={max} step={step}
            onChange={e => onChange(clamp(Number(e.target.value), min, max))}
            onBlur={onCommit}
            style={{ width: 68, background: "#18181b", border: "1px solid #3f3f46", borderRadius: 4, color: "#fff", fontSize: 10, padding: "2px 6px", outline: "none", fontFamily: "monospace" }} />
          <span style={{ fontSize: 10, color: "#a1a1aa", fontFamily: "monospace" }}>{unit}</span>
        </div>
      </div>
      <Slider value={value} min={min} max={max} step={step} onChange={onChange} onCommit={onCommit} />
    </div>
  );
}
// ── Main App ──────────────────────────────────────────────────────────────────
export default function VibeEdit() {
  // ── State ──────────────────────────────────────────────────────────────
  const [clips, setClips] = useState([]);
  const [graphics, setGraphics] = useState([]);
  const [time, setTime] = useState(0);
  const [totalDur, setTotalDur] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [selClipId, setSelClipId] = useState(null);
  const [selGfxId, setSelGfxId] = useState(null);
  const [editingGfxId, setEditingGfxId] = useState(null);
  const [tool, setTool] = useState("select"); // select | razor | text | rect | circle | ae
  const [zoom, setZoom] = useState(1);
  const [comp, setComp] = useState({ w: 1920, h: 1080, fps: 30, bg: "#000000" });
  const [showCompSettings, setShowCompSettings] = useState(false);
  const [showAEPanel, setShowAEPanel] = useState(false);
  const [importedAE, setImportedAE] = useState([]);
  const [editingTemplateId, setEditingTemplateId] = useState(null);
  const [history, setHistory] = useState([]);
  const [redo, setRedo] = useState([]);
  const [interact, setInteract] = useState(null);
  const [timelineDrag, setTimelineDrag] = useState(null);
  const [timelineResize, setTimelineResize] = useState(null);
  const [dragStart, setDragStart] = useState({ x: 0, ts: 0, dur: 0 });
  const [renderStatus, setRenderStatus] = useState("idle"); // idle | queued | rendering | done
  const [renderQueue, setRenderQueue] = useState([]);
  const videoRefs = useRef({});
  const stageRef = useRef(null);
  const fileRef = useRef(null);
  const aeFileRef = useRef(null);
  const rafRef = useRef(null);
  const playStartRef = useRef({ wallTime: 0, editTime: 0 });
  // ── History ────────────────────────────────────────────────────────────
  const snap = useCallback(() => {
    setHistory(h => [...h, { clips, graphics }].slice(-40));
    setRedo([]);
  }, [clips, graphics]);
  const undoFn = () => setHistory(h => {
    if (!h.length) return h;
    const prev = h[h.length - 1];
    setRedo(r => [...r, { clips, graphics }]);
    setClips(prev.clips); setGraphics(prev.graphics);
    return h.slice(0, -1);
  });
  const redoFn = () => setRedo(r => {
    if (!r.length) return r;
    const next = r[r.length - 1];
    setHistory(h => [...h, { clips, graphics }]);
    setClips(next.clips); setGraphics(next.graphics);
    return r.slice(0, -1);
  });
  // ── Video Sync ─────────────────────────────────────────────────────────
  useEffect(() => {
    const visibleClips = clips.filter(c => time >= c.ts && time < c.ts + c.dur);
    Object.entries(videoRefs.current || {}).forEach(([id, vid]) => {
      if (!vid) return;
      const clip = visibleClips.find(c => c.id === id);
      if (!clip) {
        try { vid.pause(); } catch {}
        return;
      }
      const ct = Math.max(0, time - clip.ts + clip.startT);
      vid.muted = true;
      vid.playsInline = true;
      if (vid.getAttribute("data-cid") !== clip.id) {
        vid.src = clip.url;
        vid.setAttribute("data-cid", clip.id);
        vid.load();
        const applyTime = () => {
          try { vid.currentTime = ct; } catch {}
          if (playing) vid.play().catch(() => {});
        };
        if (vid.readyState >= 1) applyTime();
        else vid.onloadedmetadata = applyTime;
      } else if (Math.abs((vid.currentTime || 0) - ct) > 0.15) {
        try { vid.currentTime = ct; } catch {}
      }
      if (playing && vid.paused) vid.play().catch(() => {});
      else if (!playing && !vid.paused) vid.pause();
    });
  }, [time, clips, playing]);
  // ── Playback RAF ────────────────────────────────────────────────────────
  useEffect(() => {
    if (!playing) { cancelAnimationFrame(rafRef.current); return; }
    playStartRef.current = { wallTime: performance.now(), editTime: time };
    const tick = () => {
      const elapsed = (performance.now() - playStartRef.current.wallTime) / 1000;
      const t = Math.min(totalDur, playStartRef.current.editTime + elapsed);
      setTime(t);
      if (t >= totalDur) { setPlaying(false); return; }
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafRef.current);
  }, [playing]);
  // ── Keyboard ───────────────────────────────────────────────────────────
  useEffect(() => {
    const onKey = e => {
      const tag = (e.target && e.target.tagName) ? String(e.target.tagName).toUpperCase() : "";
      if (["INPUT", "TEXTAREA", "SELECT", "OPTION"].includes(tag) || e.target?.isContentEditable) return;
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") { e.preventDefault(); e.shiftKey ? redoFn() : undoFn(); return; }
      if (e.key === "Delete" || e.key === "Backspace") { e.preventDefault(); deleteSelected(); return; }
      if (e.key === " ") { e.preventDefault(); setPlaying(p => !p); }
      if (e.key === "v" || e.key === "V") setTool("select");
      if (e.key === "c" || e.key === "C") setTool("razor");
      if (e.key === "t" || e.key === "T") setTool("text");
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [selGfxId, selClipId, clips, graphics]);
  // ── Canvas Interaction Mouse ────────────────────────────────────────────
  useEffect(() => {
    if (!interact) return;
    const onMove = e => {
      const rect = stageRef.current?.getBoundingClientRect();
      if (!rect) return;
      const item = interact.kind === "clip" ? clips.find(c => c.id === interact.gid) : graphics.find(g => g.id === interact.gid);
      if (!item) return;
      if (interact.mode === "move") {
        const dx = ((e.clientX - interact.px) / rect.width) * 100;
        const dy = ((e.clientY - interact.py) / rect.height) * 100;
        if (interact.kind === "clip") setClips(cs => cs.map(c => c.id === interact.gid ? { ...c, x: clamp(interact.sx + dx, 0, 100), y: clamp(interact.sy + dy, 0, 100) } : c));
        else setGraphics(gs => gs.map(gg => gg.id === interact.gid ? { ...gg, x: clamp(interact.sx + dx, 0, 100), y: clamp(interact.sy + dy, 0, 100) } : gg));
      } else if (interact.mode === "scale") {
        const cx = rect.left + rect.width * (interact.sx / 100);
        const cy = rect.top + rect.height * (interact.sy / 100);
        const d = Math.max(1, Math.hypot(e.clientX - cx, e.clientY - cy));
        const ns = clamp(interact.ss * (d / interact.sd), 10, 500);
        if (interact.kind === "clip") setClips(cs => cs.map(c => c.id === interact.gid ? { ...c, scale: ns } : c));
        else setGraphics(gs => gs.map(gg => gg.id === interact.gid ? { ...gg, scale: ns } : gg));
      } else if (interact.mode === "rotate") {
        const cx = rect.left + rect.width * (interact.sx / 100);
        const cy = rect.top + rect.height * (interact.sy / 100);
        const ang = Math.atan2(e.clientY - cy, e.clientX - cx);
        let delta = (ang - interact.sa) * 180 / Math.PI;
        let next = interact.sr + delta;
        while (next > 180) next -= 360;
        while (next < -180) next += 360;
        if (interact.kind === "clip") setClips(cs => cs.map(c => c.id === interact.gid ? { ...c, rotation: next } : c));
        else setGraphics(gs => gs.map(gg => gg.id === interact.gid ? { ...gg, rotation: next } : gg));
      }
    };
    const onUp = () => { snap(); setInteract(null); };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => { window.removeEventListener("mousemove", onMove); window.removeEventListener("mouseup", onUp); };
  }, [interact, graphics, clips]);
  // ── Timeline Drag/Resize Mouse ──────────────────────────────────────────
  useEffect(() => {
    if (!timelineDrag && !timelineResize) return;
    const onMove = e => {
      const dx = (e.clientX - dragStart.x) / (20 * zoom);
      if (timelineDrag) {
        const ns = Math.max(0, dragStart.ts + dx);
        setClips(cs => cs.map(c => c.id === timelineDrag ? { ...c, ts: ns } : c));
        setGraphics(gs => gs.map(g => g.id === timelineDrag ? { ...g, ts: ns } : g));
      } else if (timelineResize) {
        const { id, side } = timelineResize;
        setClips(cs => cs.map(c => {
          if (c.id !== id) return c;
          if (side === "right") return { ...c, dur: Math.max(0.1, dragStart.dur + dx) };
          const ns = Math.max(0, dragStart.ts + dx);
          return { ...c, ts: ns, dur: Math.max(0.1, dragStart.dur - (ns - dragStart.ts)) };
        }));
        setGraphics(gs => gs.map(g => {
          if (g.id !== id) return g;
          if (side === "right") return { ...g, dur: Math.max(0.1, dragStart.dur + dx) };
          const ns = Math.max(0, dragStart.ts + dx);
          return { ...g, ts: ns, dur: Math.max(0.1, dragStart.dur - (ns - dragStart.ts)) };
        }));
      }
    };
    const onUp = () => {
      snap();
      setTimelineDrag(null); setTimelineResize(null);
      const allItems = [...clips, ...graphics];
      const newTotal = Math.max(0, ...allItems.map(i => i.ts + i.dur));
      setTotalDur(newTotal);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => { window.removeEventListener("mousemove", onMove); window.removeEventListener("mouseup", onUp); };
  }, [timelineDrag, timelineResize, dragStart, zoom, clips, graphics]);
  // ── Helpers ────────────────────────────────────────────────────────────
  const beginInteract = useCallback((e, g, mode, kind = "graphic") => {
    e.stopPropagation();
    const rect = stageRef.current?.getBoundingClientRect();
    if (!rect) return;
    const ct = time - g.ts;
    const sx = lerp(g.kf?.x, ct, g.x);
    const sy = lerp(g.kf?.y, ct, g.y);
    const ss = lerp(g.kf?.scale, ct, g.scale);
    const sr = lerp(g.kf?.rotation, ct, g.rotation ?? 0);
    const cx = rect.left + rect.width * (sx / 100);
    const cy = rect.top + rect.height * (sy / 100);
    const sd = Math.max(1, Math.hypot(e.clientX - cx, e.clientY - cy));
    const sa = Math.atan2(e.clientY - cy, e.clientX - cx);
    if (kind === "clip") { setSelClipId(g.id); setSelGfxId(null); }
    else { setSelGfxId(g.id); setSelClipId(null); }
    setInteract({ mode, kind, gid: g.id, px: e.clientX, py: e.clientY, sx, sy, ss, sr, sd, sa });
  }, [time]);
  const handleCanvasDown = e => {
    if (editingGfxId) return;
    const rect = stageRef.current?.getBoundingClientRect();
    if (!rect) return;
    const xp = ((e.clientX - rect.left) / rect.width) * 100;
    const yp = ((e.clientY - rect.top) / rect.height) * 100;
    // hit-test graphics in reverse order
    const hit = [...graphics].reverse().find(g => {
      if (time < g.ts || time >= g.ts + g.dur) return false;
      const ct = time - g.ts;
      const gx = lerp(g.kf?.x, ct, g.x);
      const gy = lerp(g.kf?.y, ct, g.y);
      const gs = lerp(g.kf?.scale, ct, g.scale) / 100;
      const hw = (g.width * gs / rect.width) * 100 / 2;
      const hh = (g.height * gs / rect.height) * 100 / 2;
      return xp >= gx - hw && xp <= gx + hw && yp >= gy - hh && yp <= gy + hh;
    });
    if (hit) {
      setSelGfxId(hit.id); setSelClipId(null);
      if ((hit.type === "text") && e.detail >= 2) { setEditingGfxId(hit.id); return; }
      if (tool === "select") beginInteract(e, hit, "move");
      return;
    }
    if (tool === "text" || tool === "rect" || tool === "circle") {
      if (tool === "text") {
        snap();
        const g = { id: uid(), type: "text", content: "텍스트", ts: time, dur: 5, x: xp, y: yp, width: 280, height: 72, opacity: 1, scale: 100, rotation: 0, color: "#ffffff", fontSize: 36, fontFamily: "Pretendard, 'Noto Sans KR', sans-serif", fontWeight: "700", textAlign: "center", track: 2 };
        setGraphics(gs => [...gs, g]); setSelGfxId(g.id); setTool("select");
      } else if (tool === "rect") {
        snap();
        const g = { id: uid(), type: "rectangle", content: "", ts: time, dur: 5, x: xp, y: yp, width: 200, height: 100, opacity: 1, scale: 100, rotation: 0, color: "#3b82f6", track: 2 };
        setGraphics(gs => [...gs, g]); setSelGfxId(g.id); setTool("select");
      } else if (tool === "circle") {
        snap();
        const g = { id: uid(), type: "circle", content: "", ts: time, dur: 5, x: xp, y: yp, width: 120, height: 120, opacity: 1, scale: 100, rotation: 0, color: "#ec4899", track: 2 };
        setGraphics(gs => [...gs, g]); setSelGfxId(g.id); setTool("select");
      }
      return;
    }
    const clipHit = [...visibleClips].sort((a, b) => b.track - a.track).find(c => {
      const cx = lerp(c.kf?.x, time - c.ts, c.x);
      const cy = lerp(c.kf?.y, time - c.ts, c.y);
      const cs = lerp(c.kf?.scale, time - c.ts, c.scale) / 100;
      const hw = (((c.sourceW || comp.w) / comp.w) * 100 / 2) * cs;
      const hh = (((c.sourceH || comp.h) / comp.h) * 100 / 2) * cs;
      return xp >= cx - hw && xp <= cx + hw && yp >= cy - hh && yp <= cy + hh;
    });
    if (clipHit) {
      setSelClipId(clipHit.id); setSelGfxId(null);
      if (tool === "select") beginInteract(e, clipHit, "move", "clip");
      return;
    }
    setSelGfxId(null); setSelClipId(null);
  };
  const handleFileUpload = async e => {
    const files = Array.from(e.target.files ?? []); if (!files.length) return;
    if (fileRef.current) fileRef.current.value = "";
    const startAt = time;
    const newClips = [];
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      const url = URL.createObjectURL(file);
      const meta = await new Promise(res => {
        const v = document.createElement("video"); v.src = url; v.preload = "metadata";
        v.onloadedmetadata = () => res({ dur: v.duration || 5, w: v.videoWidth || 1920, h: v.videoHeight || 1080 });
        v.onerror = () => res({ dur: 5, w: 1920, h: 1080 });
      });
      const dur = meta.dur;
      if (newClips.length === 0 && clips.length === 0) {
        setComp(c => ({ ...c, w: meta.w, h: meta.h }));
      }
      const occupied = new Set([...clips, ...newClips].filter(c => startAt >= c.ts && startAt < c.ts + c.dur).map(c => c.track));
      let track = 1;
      while (occupied.has(track) && track < 3) track += 1;
      const clip = { id: uid(), file, url, name: file.name, dur, ts: startAt, startT: 0, endT: dur, opacity: 1, scale: 100, x: 50, y: 50, rotation: 0, track, sourceW: meta.w, sourceH: meta.h };
      newClips.push(clip);
    }
    snap();
    setClips(cs => [...cs, ...newClips]);
    const nextTotal = Math.max(totalDur, ...newClips.map(c => c.ts + c.dur));
    setTotalDur(nextTotal);
  };
  const handleAEImport = async e => {
    const files = Array.from(e.target.files ?? []); if (!files.length) return;
    if (aeFileRef.current) aeFileRef.current.value = "";
    const groups = new Map();
    files.forEach(file => {
      const base = packageBaseName(file.name);
      const cur = groups.get(base) || { aep: null, lottie: null, meta: null, preview: null };
      if (/\.meta\.json$/i.test(file.name)) cur.meta = file;
      else if (/\.aep$/i.test(file.name)) cur.aep = file;
      else if (/\.json$/i.test(file.name)) cur.lottie = file;
      else if (/\.(png|jpg|jpeg|webp)$/i.test(file.name)) cur.preview = file;
      groups.set(base, cur);
    });
    const newTemplates = [];
    for (const [base, pkg] of groups.entries()) {
      if (pkg.lottie) {
        try {
          const lottieData = JSON.parse(await pkg.lottie.text());
          const meta = pkg.meta ? JSON.parse(await pkg.meta.text()) : null;
          const dims = getLottieDimensions(lottieData);
          const cropBounds = { x: 0, y: 0, w: dims.w, h: dims.h, sourceW: dims.w, sourceH: dims.h };
          const templateDuration = getLottieDuration(lottieData);
          const glyphChars = [...getGlyphChars(lottieData)];
          const vectorModel = null;
          const detectedFields = extractLottieTextFields(lottieData, meta?.editableFields).map(field => normalizeFieldToCrop(field, cropBounds, dims.w, dims.h));
          const internalFontOptions = (lottieData?.fonts?.list || []).map(font => ({
            key: `internal:${font.fName}`,
            value: font.fName,
            mode: "internal",
            label: `${font.fFamily || font.fName}${font.fStyle ? ` (${font.fStyle})` : ""}`,
          }));
          const fontOptions = [...internalFontOptions, ...WEB_FONT_OPTIONS];
          newTemplates.push({
            id: uid(),
            name: meta?.name || base,
            file: pkg.lottie,
            compName: meta?.mainCompName || base,
            fields: detectedFields.length ? detectedFields : [createDefaultTemplateField(1)],
            previewUrl: pkg.preview ? URL.createObjectURL(pkg.preview) : null,
            webDef: null,
            allowFontChange: true,
            allowColorChange: true,
            templateKind: "lottie",
            textBindingMode: detectedFields.length ? "internal" : "overlay",
            fontOptions,
            glyphChars,
            vectorModel,
            lottieData,
            templateDuration,
            cropBounds,
            templateW: dims.w,
            templateH: dims.h,
          });
        } catch (err) {
          console.error(`Failed to import Lottie template: ${base}`, err);
          alert(`${base} JSON 파일을 읽지 못했습니다.`);
        }
        continue;
      }
      if (!pkg.aep) continue;
      newTemplates.push({
        id: uid(),
        name: base,
        file: pkg.aep,
        compName: base,
        fields: [{ id: uid(), label: "텍스트 1", value: "텍스트 1" }],
        previewUrl: pkg.preview ? URL.createObjectURL(pkg.preview) : null,
        webDef: null,
        allowFontChange: true,
        allowColorChange: true,
        templateKind: "svg",
      });
    }
    setImportedAE(ae => [...ae, ...newTemplates]);
  };
  const updateTemplateAsset = (id, updates) => setImportedAE(list => list.map(t => t.id === id ? { ...t, ...updates } : t));
  const updateTemplateFieldDef = (templateId, fieldId, updates) => setImportedAE(list => list.map(t => t.id !== templateId ? t : { ...t, fields: (t.fields || []).map(f => f.id === fieldId ? { ...f, ...updates } : f) }));
  const addTemplateFieldDef = templateId => setImportedAE(list => list.map(t => t.id !== templateId ? t : { ...t, fields: [...(t.fields || []), createDefaultTemplateField((t.fields || []).length + 1)] }));
  const removeTemplateFieldDef = (templateId, fieldId) => setImportedAE(list => list.map(t => t.id !== templateId ? t : { ...t, fields: (t.fields || []).filter(f => f.id !== fieldId) }));
  const addAETemplate = (template) => {
    snap();
    const naturalW = Math.max(1, Number(template.templateKind === "vector_subtitle" ? (template.vectorModel?.baseBarWidth || template.templateW || 1000) : (template.templateW || 1000)));
    const naturalH = Math.max(1, Number(template.templateKind === "vector_subtitle" ? (template.vectorModel?.baseBarHeight || template.templateH || 170) : (template.templateH || 170)));
    const cropBounds = template.cropBounds || { x: 0, y: 0, w: naturalW, h: naturalH };
    const visibleW = Math.max(1, Number(cropBounds.w || naturalW));
    const visibleH = Math.max(1, Number(cropBounds.h || naturalH));
    const fitScale = Math.min(1, 800 / visibleW);
    const g = {
      id: uid(), type: "ae_template", content: "",
      compName: template.compName, fields: (template.fields || []).map(f => ({ ...f })),
      templateId: template.id, sourceName: template.name,
      ts: time,
      dur: Math.max(5, Number(template.templateDuration || 5)),
      x: 50, y: 74,
      width: Math.round(visibleW * fitScale),
      height: Math.round(visibleH * fitScale),
      templatePixelRatio: fitScale,
      opacity: 1, scale: 100, rotation: 0, track: 2,
      fontFamily: "Pretendard, 'Noto Sans KR', sans-serif",
      webDef: template.webDef || null,
      lottieData: template.lottieData || null,
      vectorModel: template.vectorModel || null,
      templateKind: template.templateKind || "svg",
      textBindingMode: template.textBindingMode || "overlay",
      fontOptions: template.fontOptions || [],
      glyphChars: template.glyphChars || [],
      cropBounds,
      templateDuration: Number(template.templateDuration || 0),
      templateW: naturalW,
      templateH: naturalH,
    };
    setGraphics(gs => [...gs, g]);
    setSelGfxId(g.id); setShowAEPanel(false); setTool("select");
  };
  const selGfx = graphics.find(g => g.id === selGfxId);
  const selClip = clips.find(c => c.id === selClipId);
  const visibleClips = clips.filter(c => time >= c.ts && time < c.ts + c.dur).sort((a, b) => a.track - b.track);
  const previewClip = visibleClips[0] ?? (time === 0 ? clips[0] : null);
  const editingTemplate = importedAE.find(t => t.id === editingTemplateId) || null;
  const updateGfx = (id, updates) => setGraphics(gs => gs.map(g => g.id === id ? { ...g, ...updates } : g));
  const updateClip = (id, updates) => setClips(cs => cs.map(c => c.id === id ? { ...c, ...updates } : c));
  const updateField = (gid, fid, val) => setGraphics(gs => gs.map(g => g.id === gid ? resizeVectorGraphic({ ...g, fields: (g.fields || []).map(f => f.id === fid ? { ...f, value: val } : f) }) : g));
  const updateFieldProps = (gid, fid, updates) => setGraphics(gs => gs.map(g => g.id === gid ? resizeVectorGraphic({ ...g, fields: (g.fields || []).map(f => f.id === fid ? { ...f, ...updates } : f) }) : g));
  const toggleGraphicKeyframe = (graphic, prop) => {
    const localTime = clamp(time - graphic.ts, 0, graphic.dur);
    const currentValue = prop === "opacity" ? graphic.opacity : prop === "rotation" ? (graphic.rotation || 0) : graphic[prop];
    const nextKf = hasKeyframeAt(graphic, prop, localTime) ? removeKeyframe(graphic, prop, localTime) : upsertKeyframe(graphic, prop, localTime, currentValue);
    setGraphics(gs => gs.map(g => g.id === graphic.id ? { ...g, kf: nextKf } : g));
    snap();
  };
  const toggleClipKeyframe = (clip, prop) => {
    const localTime = clamp(time - clip.ts, 0, clip.dur);
    const currentValue = prop === "opacity" ? clip.opacity : prop === "rotation" ? (clip.rotation || 0) : clip[prop];
    const nextKf = hasKeyframeAt(clip, prop, localTime) ? removeKeyframe(clip, prop, localTime) : upsertKeyframe(clip, prop, localTime, currentValue);
    setClips(cs => cs.map(c => c.id === clip.id ? { ...c, kf: nextKf } : c));
    snap();
  };
  const deleteSelected = () => { if (selGfxId) { snap(); setGraphics(gs => gs.filter(g => g.id !== selGfxId)); setSelGfxId(null); } if (selClipId) { snap(); setClips(cs => { const nc = cs.filter(c => c.id !== selClipId); const nd = nc.reduce((m, c) => Math.max(m, c.ts + c.dur), 0); setTotalDur(nd); return nc; }); setSelClipId(null); } };
  const createGraphicAtPoint = (kind, clientX, clientY) => {
    const rect = stageRef.current?.getBoundingClientRect();
    if (!rect) return;
    const xp = ((clientX - rect.left) / rect.width) * 100;
    const yp = ((clientY - rect.top) / rect.height) * 100;
    snap();
    let g = null;
    if (kind === "text") {
      g = { id: uid(), type: "text", content: "텍스트", ts: time, dur: 5, x: xp, y: yp, width: 280, height: 72, opacity: 1, scale: 100, rotation: 0, color: "#ffffff", fontSize: 36, fontFamily: "Pretendard, 'Noto Sans KR', sans-serif", fontWeight: "700", textAlign: "center", track: 2 };
    } else if (kind === "rect") {
      g = { id: uid(), type: "rectangle", content: "", ts: time, dur: 5, x: xp, y: yp, width: 200, height: 100, opacity: 1, scale: 100, rotation: 0, color: "#3b82f6", track: 2 };
    } else if (kind === "circle") {
      g = { id: uid(), type: "circle", content: "", ts: time, dur: 5, x: xp, y: yp, width: 120, height: 120, opacity: 1, scale: 100, rotation: 0, color: "#ec4899", track: 2 };
    }
    if (g) {
      setGraphics(gs => [...gs, g]);
      setSelGfxId(g.id); setSelClipId(null); setTool("select");
    }
  };
  const handleRender = () => {
    if (!clips.length) return;
    const job = { id: uid(), name: `render_${Date.now()}.mp4`, status: "queued", progress: 0 };
    setRenderQueue(q => [job, ...q]);
    setRenderStatus("queued");
    // Simulate server render polling
    let prog = 0;
    const iv = setInterval(() => {
      prog += Math.random() * 12 + 3;
      if (prog >= 100) { prog = 100; clearInterval(iv); setRenderQueue(q => q.map(r => r.id === job.id ? { ...r, status: "완료", progress: 100, downloadUrl: "#" } : r)); setRenderStatus("done"); }
      else setRenderQueue(q => q.map(r => r.id === job.id ? { ...r, status: "렌더링 중", progress: Math.floor(prog) } : r));
    }, 600);
  };
  // ── Timeline click ─────────────────────────────────────────────────────
  const handleTimelineClick = e => {
    if (timelineDrag || timelineResize) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const t = (e.clientX - rect.left) / (20 * zoom);
    setTime(clamp(t, 0, totalDur || 1));
  };
  // ── Split ──────────────────────────────────────────────────────────────
  const handleSplit = (clipId) => {
    const idx = clips.findIndex(c => c.id === clipId); if (idx === -1) return;
    const clip = clips[idx];
    const sp = time - clip.ts;
    if (sp <= 0 || sp >= clip.dur) return;
    snap();
    const a = { ...clip, id: uid(), dur: sp, endT: clip.startT + sp };
    const b = { ...clip, id: uid(), dur: clip.dur - sp, ts: time, startT: clip.startT + sp };
    setClips(cs => { const nc = [...cs]; nc.splice(idx, 1, a, b); return nc; });
  };
  // ── Colors ─────────────────────────────────────────────────────────────
  const BG = "#0a0a0a", PANEL = "#111111", BORDER = "#27272a", ACCENT = "#f97316", ACCENT2 = "#22c55e";
  const txt = c => ({ color: c || "#a1a1aa" });
  const panel = (extra = {}) => ({ background: PANEL, border: `1px solid ${BORDER}`, ...extra });
  const btn = (active, color = ACCENT) => ({
    background: active ? `${color}18` : "transparent", color: active ? color : "#71717a",
    border: `1px solid ${active ? color + "55" : BORDER}`, borderRadius: 6, padding: "5px 10px", fontSize: 11, cursor: "pointer", fontWeight: 600, transition: "all 0.15s"
  });
  // ── RENDER ─────────────────────────────────────────────────────────────
  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100vh", width: "100vw", background: BG, color: "#e4e4e7", fontFamily: "'Inter', 'Noto Sans KR', sans-serif", fontSize: 12, overflow: "hidden", userSelect: "none" }}>
      {/* ── HEADER ── */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", height: 40, padding: "0 16px", borderBottom: `1px solid ${BORDER}`, background: "#0f0f0f", flexShrink: 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 20 }}>
          <span style={{ fontWeight: 900, fontSize: 14, color: ACCENT, letterSpacing: "-0.04em" }}>VibeEdit</span>
          {["파일", "편집", "시퀀스", "클립", "그래픽"].map(l => (
            <button key={l} style={{ background: "none", border: "none", color: "#71717a", fontSize: 11, cursor: "pointer", padding: "2px 0" }}>{l}</button>
          ))}
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <button onClick={() => setShowCompSettings(true)} style={{ ...btn(false), fontSize: 11 }}>컴포지션 설정</button>
          <button onClick={handleRender} style={{ background: ACCENT, color: "#000", border: "none", borderRadius: 6, padding: "5px 16px", fontSize: 11, fontWeight: 700, cursor: "pointer" }}>
            ▶ Render
          </button>
        </div>
      </div>
      {/* ── MAIN ── */}
      <div style={{ display: "flex", flex: 1, overflow: "hidden" }}>
        {/* ── LEFT TOOLBAR ── */}
        <div style={{ width: 44, display: "flex", flexDirection: "column", alignItems: "center", borderRight: `1px solid ${BORDER}`, background: "#0f0f0f", padding: "10px 0", gap: 6, flexShrink: 0 }}>
          {[
            { t: "select", label: "↖", tip: "선택 (V)" },
            { t: "razor", label: "✂", tip: "자르기 (C)" },
            { t: "text", label: "T", tip: "텍스트 (T)" },
            { t: "rect", label: "▬", tip: "사각형" },
            { t: "circle", label: "●", tip: "원" },
          ].map(({ t, label, tip }) => (
            <button key={t} title={tip} onClick={() => setTool(t)}
              style={{ width: 34, height: 34, borderRadius: 6, border: `1px solid ${tool === t ? ACCENT + "88" : BORDER}`, background: tool === t ? ACCENT + "18" : "transparent", color: tool === t ? ACCENT : "#71717a", fontSize: t === "text" ? 14 : 16, cursor: "pointer", fontWeight: 700 }}>
              {label}
            </button>
          ))}
          <div style={{ height: 1, width: 28, background: BORDER, margin: "4px 0" }} />
          <button title="AE 템플릿" onClick={() => setShowAEPanel(v => !v)}
            style={{ width: 34, height: 34, borderRadius: 6, border: `1px solid ${showAEPanel ? ACCENT2 + "88" : BORDER}`, background: showAEPanel ? ACCENT2 + "18" : "transparent", color: showAEPanel ? ACCENT2 : "#71717a", fontSize: 10, fontWeight: 800, cursor: "pointer" }}>
            AE
          </button>
          <button title="삭제 (선택된 항목)" onClick={deleteSelected}
            style={{ width: 34, height: 34, borderRadius: 6, border: `1px solid ${BORDER}`, background: "transparent", color: "#71717a", fontSize: 14, cursor: "pointer" }}>
            🗑
          </button>
        </div>
        {/* ── ASSET PANEL ── */}
        <div style={{ width: 220, borderRight: `1px solid ${BORDER}`, background: "#0d0d0d", display: "flex", flexDirection: "column", flexShrink: 0, overflow: "hidden" }}>
          <div style={{ padding: "10px 12px 6px", borderBottom: `1px solid ${BORDER}` }}>
            <div style={{ fontSize: 10, fontWeight: 700, color: "#52525b", textTransform: "uppercase", letterSpacing: "0.1em" }}>프로젝트</div>
          </div>
          <div style={{ flex: 1, overflowY: "auto", padding: 10 }}>
            {/* Video Assets */}
            <div style={{ marginBottom: 12 }}>
              <div style={{ fontSize: 10, color: ACCENT, fontWeight: 700, marginBottom: 6, display: "flex", justifyContent: "space-between" }}>
                <span>📁 원본 푸티지</span>
                <button onClick={() => fileRef.current?.click()} style={{ background: "none", border: "none", color: "#71717a", fontSize: 11, cursor: "pointer" }}>+</button>
              </div>
              {clips.map(c => (
                <div key={c.id} onClick={() => { setSelClipId(c.id); setSelGfxId(null); }}
                  style={{ padding: "4px 8px", borderRadius: 4, marginBottom: 2, background: selClipId === c.id ? ACCENT + "18" : "transparent", color: selClipId === c.id ? ACCENT : "#a1a1aa", cursor: "pointer", fontSize: 11, display: "flex", gap: 6, alignItems: "center" }}>
                  <span>🎬</span><span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1 }}>{c.name}</span>
                </div>
              ))}
              <button onClick={() => fileRef.current?.click()}
                style={{ width: "100%", padding: "4px 8px", borderRadius: 4, background: "transparent", border: `1px dashed ${BORDER}`, color: "#52525b", fontSize: 11, cursor: "pointer", marginTop: 2 }}>
                + 영상 추가
              </button>
              <input ref={fileRef} type="file" accept="video/*" multiple className="hidden" style={{ display: "none" }} onChange={handleFileUpload} />
            </div>
            <div style={{ height: 1, background: BORDER, margin: "8px 0" }} />
            {/* AE Templates */}
            <div style={{ marginBottom: 12 }}>
              <div style={{ fontSize: 10, color: ACCENT2, fontWeight: 700, marginBottom: 6, display: "flex", justifyContent: "space-between" }}>
                <span>🎨 자막 템플릿</span>
                <button onClick={() => aeFileRef.current?.click()} style={{ background: "none", border: "none", color: "#71717a", fontSize: 11, cursor: "pointer" }}>AEP+</button>
              </div>
              {/* Built-in template */}
              <div onClick={() => { snap(); addAETemplate({ id: "builtin", name: "TopTitle_F_04", compName: "TopTitle_F_04_AGL & NAVIADs", fields: DEFAULT_FIELDS.map(f => ({ ...f })) }); }}
                style={{ padding: "6px 8px", borderRadius: 4, background: "#0a1a0a", border: `1px dashed ${ACCENT2}44`, cursor: "pointer", marginBottom: 4 }}>
                <div style={{ fontSize: 10, color: ACCENT2, fontWeight: 700 }}>TopTitle_F_04</div>
                <div style={{ fontSize: 9, color: "#52525b" }}>AGL &amp; NAVIADs</div>
              </div>
              {importedAE.map(t => (
                <div key={t.id}
                  style={{ padding: "6px 8px", borderRadius: 4, background: "#0a1a0a", border: `1px dashed ${ACCENT2}44`, marginBottom: 4 }}>
                  <div onClick={() => addAETemplate(t)} style={{ cursor: "pointer" }}>
                    <div style={{ width: "100%", height: 58, background: "#000", borderRadius: 4, overflow: "hidden", marginBottom: 6, display: "flex", alignItems: "center", justifyContent: "center" }}>
                      <TemplateThumbnail template={t} fontFamily="Pretendard, 'Noto Sans KR', sans-serif" />
                    </div>
                    <div style={{ fontSize: 10, color: ACCENT2, fontWeight: 700 }}>{t.name}</div>
                    <div style={{ fontSize: 9, color: "#52525b" }}>{t.compName || "메인 컴프 미설정"}</div>
                  </div>
                  <div style={{ display: "flex", gap: 6, marginTop: 6 }}>
                    <button onClick={() => addAETemplate(t)} style={{ flex: 1, padding: "4px 6px", background: ACCENT2, color: "#000", border: "none", borderRadius: 4, fontSize: 10, fontWeight: 700, cursor: "pointer" }}>삽입</button>
                    <button onClick={() => setEditingTemplateId(t.id)} style={{ padding: "4px 8px", background: "#18181b", color: ACCENT2, border: `1px solid ${ACCENT2}55`, borderRadius: 4, fontSize: 10, cursor: "pointer" }}>설정</button>
                  </div>
                </div>
              ))}
              <button onClick={() => aeFileRef.current?.click()}
                style={{ width: "100%", padding: "4px 8px", borderRadius: 4, background: "transparent", border: `1px dashed ${BORDER}`, color: "#52525b", fontSize: 11, cursor: "pointer" }}>
                + Lottie JSON + PNG 불러오기
              </button>
              <input ref={aeFileRef} type="file" accept=".json,.aep,.png,.jpg,.jpeg,.webp" multiple style={{ display: "none" }} onChange={handleAEImport} />
            </div>
            <div style={{ height: 1, background: BORDER, margin: "8px 0" }} />
            {/* Render Queue */}
            <div>
              <div style={{ fontSize: 10, color: "#38bdf8", fontWeight: 700, marginBottom: 6 }}>🖥 렌더 큐 ({renderQueue.length})</div>
              {renderQueue.length === 0 ? (
                <div style={{ fontSize: 10, color: "#3f3f46", padding: "4px 0" }}>렌더 작업 없음</div>
              ) : renderQueue.slice(0, 4).map(r => (
                <div key={r.id} style={{ marginBottom: 6, padding: "6px 8px", background: "#0a1218", borderRadius: 4, border: `1px solid ${BORDER}` }}>
                  <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 3 }}>
                    <span style={{ fontSize: 10, color: "#e4e4e7", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1 }}>{r.name}</span>
                    <span style={{ fontSize: 9, color: r.status === "완료" ? ACCENT2 : "#38bdf8", marginLeft: 4 }}>{r.progress}%</span>
                  </div>
                  <div style={{ height: 3, background: "#27272a", borderRadius: 2 }}>
                    <div style={{ height: "100%", width: `${r.progress}%`, background: r.status === "완료" ? ACCENT2 : "#38bdf8", borderRadius: 2, transition: "width 0.3s" }} />
                  </div>
                  {r.downloadUrl && r.status === "완료" && (
                    <a href={r.downloadUrl} style={{ display: "block", marginTop: 4, textAlign: "center", padding: "3px", background: ACCENT2, color: "#000", fontSize: 10, fontWeight: 700, borderRadius: 3, textDecoration: "none" }}>다운로드</a>
                  )}
                </div>
              ))}
            </div>
          </div>
        </div>
        {/* ── CENTER: PREVIEW + TIMELINE ── */}
        <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden", minWidth: 0 }}>
          {/* Preview */}
          <div style={{ flex: "0 0 auto", position: "relative", background: "#050505", borderBottom: `1px solid ${BORDER}`, display: "flex", alignItems: "center", justifyContent: "center", overflow: "hidden", minHeight: 0 }}
            onMouseDown={handleCanvasDown}>
            <div ref={stageRef} style={{ position: "relative", aspectRatio: `${comp.w}/${comp.h}`, background: comp.bg, maxWidth: "100%", maxHeight: "56vh", width: "100%" }}>
              {previewClip ? (
                <>
                  {visibleClips.map(clip => {
                    const clipScale = lerp(clip.kf?.scale, time - clip.ts, clip.scale) / 100;
                    const clipLeft = lerp(clip.kf?.x, time - clip.ts, clip.x);
                    const clipTop = lerp(clip.kf?.y, time - clip.ts, clip.y);
                    const clipRot = lerp(clip.kf?.rotation, time - clip.ts, clip.rotation ?? 0);
                    const clipOpacity = lerp(clip.kf?.opacity, time - clip.ts, clip.opacity);
                    const clipW = ((clip.sourceW || comp.w) / comp.w) * 100;
                    const clipH = ((clip.sourceH || comp.h) / comp.h) * 100;
                    return (
                      <div key={clip.id} style={{ position: "absolute", left: `${clipLeft}%`, top: `${clipTop}%`, width: `${clipW}%`, height: `${clipH}%`, transform: `translate(-50%,-50%) scale(${clipScale}) rotate(${clipRot}deg)`, transformOrigin: "center center", zIndex: clip.track }}>
                        <video
                          ref={el => { if (el) videoRefs.current[clip.id] = el; else delete videoRefs.current[clip.id]; }}
                          playsInline
                          muted
                          style={{ width: "100%", height: "100%", objectFit: "contain", opacity: clipOpacity, pointerEvents: "none", display: "block" }}
                        />
                        <div
                          onMouseDown={ev => {
                            ev.stopPropagation();
                            if (tool === "text" || tool === "rect" || tool === "circle") {
                              createGraphicAtPoint(tool, ev.clientX, ev.clientY);
                              return;
                            }
                            setSelClipId(clip.id); setSelGfxId(null);
                            if (tool === "select") beginInteract(ev, clip, "move", "clip");
                          }}
                          style={{ position: "absolute", inset: 0, cursor: tool === "select" ? "move" : "crosshair", background: "transparent" }}
                        />
                      </div>
                    );
                  })}
                  {selClip && visibleClips.some(c => c.id === selClip.id) && (() => {
                    const clipScale = lerp(selClip.kf?.scale, time - selClip.ts, selClip.scale) / 100;
                    const clipLeft = lerp(selClip.kf?.x, time - selClip.ts, selClip.x);
                    const clipTop = lerp(selClip.kf?.y, time - selClip.ts, selClip.y);
                    const clipRot = lerp(selClip.kf?.rotation, time - selClip.ts, selClip.rotation ?? 0);
                    const clipW = ((selClip.sourceW || comp.w) / comp.w) * 100;
                    const clipH = ((selClip.sourceH || comp.h) / comp.h) * 100;
                    return (
                      <div style={{ position: "absolute", left: `${clipLeft}%`, top: `${clipTop}%`, width: `${clipW}%`, height: `${clipH}%`, transform: `translate(-50%,-50%) scale(${clipScale}) rotate(${clipRot}deg)`, transformOrigin: "center center", pointerEvents: "none", zIndex: 90, boxSizing: "border-box", outline: `1px solid ${ACCENT}` }}>
                        <div style={{ position: "absolute", top: 6, left: 6, background: "rgba(249,115,22,0.85)", color: "#000", fontSize: 10, fontWeight: 700, padding: "2px 8px", borderRadius: 4 }}>{selClip.name}</div>
                      </div>
                    );
                  })()}
                  <div style={{ position: "absolute", inset: 0 }}>
                    {graphics.map(g => (
                      <GraphicEl key={g.id} g={g} time={time}
                        selected={selGfxId === g.id}
                        editing={editingGfxId === g.id}
                        onEdit={() => setEditingGfxId(g.id)}
                        onEndEdit={() => setEditingGfxId(null)}
                        onChange={content => { updateGfx(g.id, { content }); snap(); }}
                      />
                    ))}
                    {selGfx && !editingGfxId && <TransformHandles g={selGfx} time={time} stageRef={stageRef} onBeginInteract={beginInteract} />}
                  </div>
                </>
              ) : (
                <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", height: "100%", color: "#27272a" }}>
                  <div style={{ fontSize: 40, marginBottom: 8 }}>🎬</div>
                  <div style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: "0.1em" }}>영상을 드래그하거나 추가하세요</div>
                </div>
              )}
              {/* Graphics on empty canvas too */}
              {!previewClip && (
                <div style={{ position: "absolute", inset: 0 }}>
                  {graphics.map(g => (
                    <GraphicEl key={g.id} g={g} time={time}
                      selected={selGfxId === g.id}
                      editing={editingGfxId === g.id}
                      onEdit={() => setEditingGfxId(g.id)}
                      onEndEdit={() => setEditingGfxId(null)}
                      onChange={content => { updateGfx(g.id, { content }); snap(); }}
                    />
                  ))}
                  {selGfx && !editingGfxId && <TransformHandles g={selGfx} time={time} stageRef={stageRef} onBeginInteract={beginInteract} />}
                </div>
              )}
              <div style={{ position: "absolute", inset: 0, border: "2px solid rgba(56,189,248,0.7)", boxSizing: "border-box", pointerEvents: "none" }} />
              <div style={{ position: "absolute", left: "50%", top: 0, bottom: 0, width: 1, background: "rgba(56,189,248,0.22)", pointerEvents: "none" }} />
              <div style={{ position: "absolute", top: "50%", left: 0, right: 0, height: 1, background: "rgba(56,189,248,0.22)", pointerEvents: "none" }} />
              {/* Overlay info */}
              <div style={{ position: "absolute", top: 8, left: 8, display: "flex", gap: 6, pointerEvents: "none" }}>
                <div style={{ background: "rgba(0,0,0,0.7)", padding: "2px 8px", borderRadius: 3, fontSize: 10, fontWeight: 700, color: ACCENT, border: `1px solid ${ACCENT}44` }}>PRV</div>
                <div style={{ background: "rgba(0,0,0,0.7)", padding: "2px 8px", borderRadius: 3, fontSize: 10, color: "#a1a1aa", fontFamily: "monospace" }}>{fmt(time)}</div>
              </div>
              <div style={{ position: "absolute", right: 8, bottom: 8, background: "rgba(0,0,0,0.7)", padding: "2px 8px", borderRadius: 3, fontSize: 10, color: "#7dd3fc", fontFamily: "monospace", pointerEvents: "none" }}>{comp.w} × {comp.h}</div>
            </div>
          </div>
          {/* Playback Controls */}
          <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 12, padding: "8px 0", background: "#080808", borderBottom: `1px solid ${BORDER}`, flexShrink: 0 }}>
            <button onClick={() => { setTime(0); setPlaying(false); }} style={{ background: "none", border: "none", color: "#71717a", fontSize: 16, cursor: "pointer" }}>⏮</button>
            <button onClick={() => setTime(t => Math.max(0, t - 5))} style={{ background: "none", border: "none", color: "#71717a", fontSize: 14, cursor: "pointer" }}>◁◁</button>
            <button onClick={() => setPlaying(p => !p)}
              style={{ width: 40, height: 40, borderRadius: 10, background: ACCENT, border: "none", color: "#000", fontSize: 18, cursor: "pointer", fontWeight: 700 }}>
              {playing ? "⏸" : "▶"}
            </button>
            <button onClick={() => setTime(t => Math.min(totalDur, t + 5))} style={{ background: "none", border: "none", color: "#71717a", fontSize: 14, cursor: "pointer" }}>▷▷</button>
            <button onClick={() => { setTime(totalDur); setPlaying(false); }} style={{ background: "none", border: "none", color: "#71717a", fontSize: 16, cursor: "pointer" }}>⏭</button>
            <div style={{ marginLeft: 12, display: "flex", alignItems: "center", gap: 6 }}>
              <span style={{ fontSize: 10, color: "#52525b" }}>Zoom:</span>
              <input type="range" min={0.3} max={5} step={0.1} value={zoom} onChange={e => setZoom(Number(e.target.value))}
                style={{ width: 80, accentColor: ACCENT }} />
            </div>
            <div style={{ display: "flex", gap: 4 }}>
              <button onClick={undoFn} title="Undo (Ctrl+Z)" style={{ background: "none", border: `1px solid ${BORDER}`, color: "#71717a", fontSize: 12, cursor: "pointer", borderRadius: 4, padding: "2px 8px" }}>↩</button>
              <button onClick={redoFn} title="Redo (Ctrl+Shift+Z)" style={{ background: "none", border: `1px solid ${BORDER}`, color: "#71717a", fontSize: 12, cursor: "pointer", borderRadius: 4, padding: "2px 8px" }}>↪</button>
            </div>
          </div>
          {/* Timeline */}
          <div style={{ flex: 1, display: "flex", overflow: "hidden", minHeight: 0 }}>
            {/* Track labels */}
            <div style={{ width: 56, background: "#0a0a0a", borderRight: `1px solid ${BORDER}`, flexShrink: 0, paddingTop: 24 }}>
              {["V3", "V2", "V1", "GFX", "A1"].map((l, i) => (
                <div key={l} style={{ height: 44, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 10, color: "#52525b", fontWeight: 700, borderBottom: l === "V1" || l === "GFX" ? `1px solid ${BORDER}` : "none" }}>
                  {l}
                </div>
              ))}
            </div>
            {/* Timeline scroll area */}
            <div style={{ flex: 1, overflowX: "auto", overflowY: "auto", position: "relative" }}>
              <div
                style={{ position: "relative", minWidth: "100%", width: `${Math.max(600, totalDur * 20 * zoom + 200)}px`, cursor: tool === "razor" ? "crosshair" : "default" }}
                onClick={handleTimelineClick}>
                {/* Ruler */}
                <div style={{ height: 24, background: "#0a0a0a", borderBottom: `1px solid ${BORDER}`, position: "sticky", top: 0, zIndex: 10, display: "flex", alignItems: "flex-end" }}>
                  {Array.from({ length: Math.ceil(totalDur / 1) + 5 }).map((_, i) => (
                    <div key={i} style={{ position: "absolute", left: i * 20 * zoom, fontSize: 9, color: "#3f3f46", paddingBottom: 2, pointerEvents: "none", whiteSpace: "nowrap" }}>
                      {i % Math.max(1, Math.round(5 / zoom)) === 0 ? fmt(i) : ""}
                      <div style={{ width: 1, height: i % Math.max(1, Math.round(5 / zoom)) === 0 ? 8 : 4, background: "#3f3f46", position: "absolute", bottom: 0, left: 0 }} />
                    </div>
                  ))}
                </div>
                {/* Playhead */}
                <div style={{ position: "absolute", top: 0, bottom: 0, left: time * 20 * zoom, width: 2, background: ACCENT, zIndex: 50, pointerEvents: "none" }}>
                  <div style={{ width: 10, height: 10, background: ACCENT, position: "absolute", top: 24, left: -4, transform: "rotate(45deg)" }} />
                </div>
                {/* Tracks */}
                {[3, 2, 1].map(tn => (
                  <div key={tn} style={{ height: 44, background: tn % 2 ? "#080808" : "#0a0a0a", borderBottom: tn === 1 ? `1px solid ${BORDER}` : "none", position: "relative" }}>
                    {clips.filter(c => c.track === tn).map(c => (
                      <div key={c.id}
                        style={{ position: "absolute", top: 4, height: 36, left: c.ts * 20 * zoom, width: Math.max(4, c.dur * 20 * zoom), borderRadius: 4, background: selClipId === c.id ? "#1a1010" : "#181818", border: `2px solid ${selClipId === c.id ? ACCENT : "#3f3f46"}`, cursor: tool === "razor" ? "crosshair" : "move", overflow: "hidden", boxSizing: "border-box" }}
                        onMouseDown={e => {
                          e.stopPropagation();
                          if (tool === "razor") { handleSplit(c.id); return; }
                          snap(); setSelClipId(c.id); setSelGfxId(null);
                          const rect = e.currentTarget.parentElement?.getBoundingClientRect();
                          if (rect) { setTimelineDrag(c.id); setDragStart({ x: e.clientX, ts: c.ts, dur: c.dur }); }
                        }}>
                        {/* resize handles */}
                        <div onMouseDown={e => { e.stopPropagation(); snap(); const rect = e.currentTarget.parentElement?.parentElement?.getBoundingClientRect(); if (rect) { setTimelineResize({ id: c.id, side: "left" }); setDragStart({ x: e.clientX, ts: c.ts, dur: c.dur }); } }}
                          style={{ position: "absolute", left: 0, top: 0, bottom: 0, width: 6, cursor: "ew-resize", background: "rgba(249,115,22,0)", zIndex: 5 }} />
                        <div onMouseDown={e => { e.stopPropagation(); snap(); const rect = e.currentTarget.parentElement?.parentElement?.getBoundingClientRect(); if (rect) { setTimelineResize({ id: c.id, side: "right" }); setDragStart({ x: e.clientX, ts: c.ts, dur: c.dur }); } }}
                          style={{ position: "absolute", right: 0, top: 0, bottom: 0, width: 6, cursor: "ew-resize", background: "rgba(249,115,22,0)", zIndex: 5 }} />
                        <div style={{ padding: "2px 8px", fontSize: 10, color: "#a1a1aa", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", lineHeight: "32px" }}>{c.name}</div>
                        {collectKeyframeTimes(c).map((kt, i) => (
                          <div key={i} style={{ position: "absolute", left: Math.max(6, Math.min(c.dur * 20 * zoom - 10, kt * 20 * zoom)), top: 13, width: 8, height: 8, background: ACCENT, transform: "rotate(45deg)", borderRadius: 1, boxShadow: "0 0 0 1px rgba(0,0,0,0.4)" }} />
                        ))}
                      </div>
                    ))}
                  </div>
                ))}
                {/* GFX Track */}
                <div style={{ height: 44, background: "#08100a", borderBottom: `1px solid ${BORDER}`, position: "relative" }}>
                  {graphics.map(g => (
                    <div key={g.id}
                      style={{ position: "absolute", top: 4, height: 36, left: g.ts * 20 * zoom, width: Math.max(4, g.dur * 20 * zoom), borderRadius: 4, background: selGfxId === g.id ? "#0f1a10" : "#0a1208", border: `2px solid ${selGfxId === g.id ? ACCENT2 : ACCENT2 + "44"}`, cursor: "move", overflow: "hidden", boxSizing: "border-box" }}
                      onMouseDown={e => {
                        e.stopPropagation();
                        snap(); setSelGfxId(g.id); setSelClipId(null);
                        const rect = e.currentTarget.parentElement?.getBoundingClientRect();
                        if (rect) { setTimelineDrag(g.id); setDragStart({ x: e.clientX, ts: g.ts, dur: g.dur }); }
                      }}>
                      <div onMouseDown={e => { e.stopPropagation(); snap(); const rect = e.currentTarget.parentElement?.parentElement?.getBoundingClientRect(); if (rect) { setTimelineResize({ id: g.id, side: "right" }); setDragStart({ x: e.clientX, ts: g.ts, dur: g.dur }); } }}
                        style={{ position: "absolute", right: 0, top: 0, bottom: 0, width: 6, cursor: "ew-resize", zIndex: 5 }} />
                      <div style={{ padding: "2px 8px", fontSize: 10, color: ACCENT2, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", lineHeight: "32px", display: "flex", alignItems: "center", gap: 4, height: "100%" }}>
                        <span style={{ fontSize: 9 }}>{g.type === "ae_template" ? "🎨" : g.type === "text" ? "T" : "■"}</span>
                        <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>{g.type === "ae_template" ? g.compName : g.content}</span>
                      </div>
                      {collectKeyframeTimes(g).map((kt, i) => (
                        <div key={i} style={{ position: "absolute", left: Math.max(6, Math.min(g.dur * 20 * zoom - 10, kt * 20 * zoom)), top: 13, width: 8, height: 8, background: ACCENT2, transform: "rotate(45deg)", borderRadius: 1, boxShadow: "0 0 0 1px rgba(0,0,0,0.4)" }} />
                      ))}
                    </div>
                  ))}
                </div>
                {/* Audio track */}
                <div style={{ height: 44, background: "#080a10", position: "relative" }}>
                  <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", paddingLeft: 12, fontSize: 10, color: "#3f3f46" }}>오디오 트랙 (준비 중)</div>
                </div>
              </div>
            </div>
          </div>
        </div>
        {/* ── RIGHT: EFFECT CONTROLS ── */}
        <div style={{ width: 260, borderLeft: `1px solid ${BORDER}`, background: "#0d0d0d", display: "flex", flexDirection: "column", flexShrink: 0, overflow: "hidden" }}>
          <div style={{ padding: "10px 12px 6px", borderBottom: `1px solid ${BORDER}` }}>
            <div style={{ fontSize: 10, fontWeight: 700, color: "#52525b", textTransform: "uppercase", letterSpacing: "0.1em" }}>효과 컨트롤</div>
          </div>
          <div style={{ flex: 1, overflowY: "auto", padding: 12 }}>
            {selGfx ? (
              <>
                <div style={{ fontSize: 11, fontWeight: 700, color: selGfx.type === "ae_template" ? ACCENT2 : ACCENT, marginBottom: 12, display: "flex", alignItems: "center", gap: 6 }}>
                  <span>{selGfx.type === "ae_template" ? "🎨" : selGfx.type === "text" ? "T" : "■"}</span>
                  <span>{selGfx.type === "ae_template" ? "AE 템플릿" : selGfx.type === "text" ? "텍스트" : "도형"}</span>
                </div>
                {/* AE Template fields */}
                {selGfx.type === "ae_template" && (
                  <div style={{ marginBottom: 12 }}>
                    <div style={{ fontSize: 10, color: "#52525b", fontWeight: 700, textTransform: "uppercase", marginBottom: 6 }}>템플릿 정보</div>
                    <div style={{ fontSize: 10, color: "#52525b", marginBottom: 8, padding: "6px 8px", background: "#0a1a0a", borderRadius: 4, border: `1px solid ${ACCENT2}22` }}>
                      {selGfx.compName}
                    </div>
                    <div style={{ fontSize: 10, color: "#52525b", fontWeight: 700, textTransform: "uppercase", margin: "10px 0 6px" }}>텍스트 필드</div>
                    {(selGfx.fields || []).length > 0 ? (selGfx.fields || []).map((f, idx) => {
                      const internalMode = !shouldUseOverlayForField(f, selGfx.glyphChars || []);
                      const selectedFontKey = internalMode ? `internal:${f.fontKey || selGfx.fontOptions?.find(option => option.mode === 'internal')?.value || ""}` : `overlay:${f.fontFamily || "Pretendard, 'Noto Sans KR', sans-serif"}`;
                      return (
                        <div key={f.id} style={{ marginBottom: 12, padding: 8, background: "#0f1115", border: `1px solid ${BORDER}`, borderRadius: 6 }}>
                          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, marginBottom: 6 }}>
                            <div style={{ fontSize: 10, color: ACCENT2, fontWeight: 700 }}>{f.label || `텍스트 ${idx + 1}`}</div>
                            <div style={{ fontSize: 9, color: "#52525b", fontFamily: "monospace" }}>{internalMode ? (f.bindingKey?.split("::").pop() || "live") : "overlay"}</div>
                          </div>
                          {!internalMode && <div style={{ fontSize: 9, color: "#f59e0b", marginBottom: 6 }}>현재 JSON 글리프로는 이 문자를 못 그려서 웹폰트 오버레이로 표시합니다.</div>}
                          <input type="text" value={f.value} onChange={e => updateField(selGfx.id, f.id, e.target.value)} onBlur={snap} style={{ width: "100%", background: "#18181b", border: `1px solid ${BORDER}`, borderRadius: 4, color: "#e4e4e7", fontSize: 11, padding: "5px 8px", outline: "none", boxSizing: "border-box", marginBottom: 8 }} />
                          <div style={{ display: "grid", gridTemplateColumns: "1fr 90px", gap: 6, marginBottom: 6 }}>
                            <select value={selectedFontKey} onChange={e => {
                              const selected = (selGfx.fontOptions || []).find(option => option.key === e.target.value);
                              if (selected?.mode === "internal") updateFieldProps(selGfx.id, f.id, { fontMode: "internal", fontKey: selected.value, fontFamily: selected.label.includes("Pretendard") ? "Pretendard, 'Noto Sans KR', sans-serif" : (f.fontFamily || "Pretendard, 'Noto Sans KR', sans-serif") });
                              else updateFieldProps(selGfx.id, f.id, { fontMode: "overlay", fontFamily: selected?.value || "Pretendard, 'Noto Sans KR', sans-serif" });
                              snap();
                            }} style={{ background: "#18181b", border: `1px solid ${BORDER}`, color: "#e4e4e7", fontSize: 10, padding: "4px 6px", borderRadius: 4, outline: "none" }}>
                              {(selGfx.fontOptions || WEB_FONT_OPTIONS).map(option => <option key={option.key} value={option.key}>{option.label}</option>)}
                            </select>
                            <input type="number" min={8} max={400} value={Number(f.fontSize || 72)} onChange={e => updateFieldProps(selGfx.id, f.id, { fontSize: Number(e.target.value) })} onBlur={snap} style={{ background: "#18181b", border: `1px solid ${BORDER}`, borderRadius: 4, color: "#fff", padding: "4px 6px", fontSize: 10 }} />
                          </div>
                          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6, marginBottom: 6 }}>
                            <input type="color" value={f.color || "#ffffff"} onChange={e => { updateFieldProps(selGfx.id, f.id, { color: e.target.value }); snap(); }} style={{ width: "100%", height: 30, background: "#18181b", border: `1px solid ${BORDER}`, borderRadius: 4 }} />
                            <select value={f.textAlign || "left"} onChange={e => { updateFieldProps(selGfx.id, f.id, { textAlign: e.target.value }); snap(); }} style={{ background: "#18181b", border: `1px solid ${BORDER}`, color: "#e4e4e7", fontSize: 10, padding: "4px 6px", borderRadius: 4, outline: "none" }}>
                              <option value="left">왼쪽 정렬</option>
                              <option value="center">가운데 정렬</option>
                              <option value="right">오른쪽 정렬</option>
                            </select>
                          </div>
                          <div style={{ display: "grid", gridTemplateColumns: "1fr 70px 1fr", gap: 6, marginBottom: internalMode ? 0 : 6 }}>
                            <input type="color" value={f.strokeColor || "#0a4a4d"} onChange={e => { updateFieldProps(selGfx.id, f.id, { strokeColor: e.target.value }); snap(); }} style={{ width: "100%", height: 30, background: "#18181b", border: `1px solid ${BORDER}`, borderRadius: 4 }} />
                            <input type="number" min={0} max={60} value={Number(f.strokeWidth || 0)} onChange={e => updateFieldProps(selGfx.id, f.id, { strokeWidth: Number(e.target.value) })} onBlur={snap} style={{ background: "#18181b", border: `1px solid ${BORDER}`, borderRadius: 4, color: "#fff", padding: "4px 6px", fontSize: 10 }} />
                            <select value={f.strokeMode || "outside"} onChange={e => { updateFieldProps(selGfx.id, f.id, { strokeMode: e.target.value }); snap(); }} style={{ background: "#18181b", border: `1px solid ${BORDER}`, color: "#e4e4e7", fontSize: 10, padding: "4px 6px", borderRadius: 4, outline: "none" }}>
                              <option value="outside">바깥 느낌 획</option>
                              <option value="center">기본 획</option>
                              {!internalMode && <option value="inside">안쪽 획</option>}
                            </select>
                          </div>
                          {!internalMode && (
                            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1fr", gap: 6 }}>
                              <input type="number" min={0} max={100} value={Number(f.x ?? 10)} onChange={e => updateFieldProps(selGfx.id, f.id, { x: Number(e.target.value) })} onBlur={snap} placeholder="X" style={{ background: "#18181b", border: `1px solid ${BORDER}`, borderRadius: 4, color: "#fff", padding: "4px 6px", fontSize: 10 }} />
                              <input type="number" min={0} max={100} value={Number(f.y ?? 34)} onChange={e => updateFieldProps(selGfx.id, f.id, { y: Number(e.target.value) })} onBlur={snap} placeholder="Y" style={{ background: "#18181b", border: `1px solid ${BORDER}`, borderRadius: 4, color: "#fff", padding: "4px 6px", fontSize: 10 }} />
                              <input type="number" min={1} max={100} value={Number(f.w ?? 80)} onChange={e => updateFieldProps(selGfx.id, f.id, { w: Number(e.target.value) })} onBlur={snap} placeholder="W" style={{ background: "#18181b", border: `1px solid ${BORDER}`, borderRadius: 4, color: "#fff", padding: "4px 6px", fontSize: 10 }} />
                              <input type="number" min={1} max={100} value={Number(f.h ?? 16)} onChange={e => updateFieldProps(selGfx.id, f.id, { h: Number(e.target.value) })} onBlur={snap} placeholder="H" style={{ background: "#18181b", border: `1px solid ${BORDER}`, borderRadius: 4, color: "#fff", padding: "4px 6px", fontSize: 10 }} />
                            </div>
                          )}
                        </div>
                      );
                    }) : (
                      <div style={{ fontSize: 10, color: "#a1a1aa", lineHeight: 1.6, padding: "8px 10px", background: "#0f1115", borderRadius: 6, border: `1px solid ${BORDER}` }}>
                        텍스트 필드가 없습니다. 템플릿 설정에서 필드를 추가하세요.
                      </div>
                    )}
                    {!selGfx.lottieData && (
                      <>
                        <div style={{ fontSize: 10, color: ACCENT2, fontWeight: 700, marginBottom: 4, marginTop: 8 }}>폰트</div>
                        <select value={selGfx.fontFamily || "sans-serif"} onChange={e => { updateGfx(selGfx.id, { fontFamily: e.target.value }); snap(); }} style={{ width: "100%", background: "#18181b", border: `1px solid ${BORDER}`, color: "#e4e4e7", fontSize: 11, padding: "4px 6px", borderRadius: 4, outline: "none" }}>
                          <option value="Pretendard, 'Noto Sans KR', sans-serif">Pretendard</option>
                          <option value="'Noto Sans KR', 'Malgun Gothic', sans-serif">Noto Sans KR</option>
                          <option value="'Malgun Gothic', sans-serif">맑은 고딕</option>
                          <option value="Arial, sans-serif">Arial</option>
                          <option value="Georgia, serif">Georgia</option>
                        </select>
                      </>
                    )}
                  </div>
                )}

                {/* Text content */}
                {selGfx.type === "text" && (
                  <div style={{ marginBottom: 12 }}>
                    <div style={{ fontSize: 10, color: "#52525b", fontWeight: 700, textTransform: "uppercase", marginBottom: 6 }}>텍스트 내용</div>
                    <input type="text" value={selGfx.content}
                      onChange={e => updateGfx(selGfx.id, { content: e.target.value })}
                      onBlur={snap}
                      style={{ width: "100%", background: "#18181b", border: `1px solid ${BORDER}`, borderRadius: 4, color: "#e4e4e7", fontSize: 11, padding: "5px 8px", outline: "none", boxSizing: "border-box", marginBottom: 6 }}
                    />
                    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6, marginBottom: 6 }}>
                      <div>
                        <div style={{ fontSize: 9, color: "#52525b", marginBottom: 3 }}>폰트</div>
                        <select value={selGfx.fontFamily || "sans-serif"} onChange={e => { updateGfx(selGfx.id, { fontFamily: e.target.value }); snap(); }}
                          style={{ width: "100%", background: "#18181b", border: `1px solid ${BORDER}`, color: "#e4e4e7", fontSize: 10, padding: "3px 4px", borderRadius: 4, outline: "none" }}>
                          <option value="Pretendard, 'Noto Sans KR', sans-serif">Pretendard</option>
                          <option value="'Noto Sans KR', sans-serif">Noto Sans KR</option>
                          <option value="'Malgun Gothic', sans-serif">맑은 고딕</option>
                          <option value="Arial, sans-serif">Arial</option>
                          <option value="Georgia, serif">Georgia</option>
                        </select>
                      </div>
                      <div>
                        <div style={{ fontSize: 9, color: "#52525b", marginBottom: 3 }}>굵기</div>
                        <select value={selGfx.fontWeight || "700"} onChange={e => { updateGfx(selGfx.id, { fontWeight: e.target.value }); snap(); }}
                          style={{ width: "100%", background: "#18181b", border: `1px solid ${BORDER}`, color: "#e4e4e7", fontSize: 10, padding: "3px 4px", borderRadius: 4, outline: "none" }}>
                          <option value="300">Light</option>
                          <option value="400">Regular</option>
                          <option value="500">Medium</option>
                          <option value="600">SemiBold</option>
                          <option value="700">Bold</option>
                          <option value="800">ExtraBold</option>
                        </select>
                      </div>
                    </div>
                    <div style={{ display: "flex", gap: 4, marginBottom: 6 }}>
                      {["left", "center", "right"].map(a => (
                        <button key={a} onClick={() => { updateGfx(selGfx.id, { textAlign: a }); snap(); }}
                          style={{ flex: 1, padding: "3px", background: (selGfx.textAlign || "center") === a ? ACCENT + "20" : "#18181b", border: `1px solid ${(selGfx.textAlign || "center") === a ? ACCENT : BORDER}`, borderRadius: 4, color: (selGfx.textAlign || "center") === a ? ACCENT : "#71717a", cursor: "pointer", fontSize: 11 }}>
                          {a === "left" ? "⬅" : a === "center" ? "↔" : "➡"}
                        </button>
                      ))}
                    </div>
                    <div style={{ marginBottom: 6 }}>
                      <div style={{ fontSize: 9, color: "#52525b", marginBottom: 3 }}>색상</div>
                      <ColorPicker value={selGfx.color} onChange={v => updateGfx(selGfx.id, { color: v })} />
                    </div>
                    <PropRow label="글자 크기" value={selGfx.fontSize || 36} min={8} max={200} step={1} unit="px"
                      onChange={v => updateGfx(selGfx.id, { fontSize: v })} onCommit={snap} />
                  </div>
                )}
                {/* Shape color */}
                {(selGfx.type === "rectangle" || selGfx.type === "circle") && (
                  <div style={{ marginBottom: 12 }}>
                    <div style={{ fontSize: 10, color: "#52525b", fontWeight: 700, textTransform: "uppercase", marginBottom: 6 }}>도형 설정</div>
                    <div style={{ fontSize: 9, color: "#52525b", marginBottom: 3 }}>색상</div>
                    <ColorPicker value={selGfx.color} onChange={v => { updateGfx(selGfx.id, { color: v }); snap(); }} />
                  </div>
                )}
                {/* Transform */}
                <div>
                  <div style={{ fontSize: 10, color: "#52525b", fontWeight: 700, textTransform: "uppercase", marginBottom: 6, marginTop: 4 }}>변형 (TRANSFORM)</div>
                  <AnimPropRow label="위치 X" value={Math.round(selGfx.x * 10) / 10} min={0} max={100} step={0.1} unit="%"
                    keyframed={hasKeyframeAt(selGfx, "x", clamp(time - selGfx.ts, 0, selGfx.dur))}
                    onToggleKeyframe={() => toggleGraphicKeyframe(selGfx, "x")}
                    onChange={v => updateGfx(selGfx.id, { x: v })} onCommit={snap} />
                  <AnimPropRow label="위치 Y" value={Math.round(selGfx.y * 10) / 10} min={0} max={100} step={0.1} unit="%"
                    keyframed={hasKeyframeAt(selGfx, "y", clamp(time - selGfx.ts, 0, selGfx.dur))}
                    onToggleKeyframe={() => toggleGraphicKeyframe(selGfx, "y")}
                    onChange={v => updateGfx(selGfx.id, { y: v })} onCommit={snap} />
                  <AnimPropRow label="비율 (Scale)" value={Math.round(selGfx.scale)} min={10} max={500} step={1} unit="%"
                    keyframed={hasKeyframeAt(selGfx, "scale", clamp(time - selGfx.ts, 0, selGfx.dur))}
                    onToggleKeyframe={() => toggleGraphicKeyframe(selGfx, "scale")}
                    onChange={v => updateGfx(selGfx.id, { scale: v })} onCommit={snap} />
                  <AnimPropRow label="회전" value={Math.round((selGfx.rotation || 0) * 10) / 10} min={-180} max={180} step={0.1} unit="°"
                    keyframed={hasKeyframeAt(selGfx, "rotation", clamp(time - selGfx.ts, 0, selGfx.dur))}
                    onToggleKeyframe={() => toggleGraphicKeyframe(selGfx, "rotation")}
                    onChange={v => updateGfx(selGfx.id, { rotation: v })} onCommit={snap} />
                  <AnimPropRow label="불투명도" value={Math.round(selGfx.opacity * 100)} min={0} max={100} step={1} unit="%"
                    keyframed={hasKeyframeAt(selGfx, "opacity", clamp(time - selGfx.ts, 0, selGfx.dur))}
                    onToggleKeyframe={() => toggleGraphicKeyframe(selGfx, "opacity")}
                    onChange={v => updateGfx(selGfx.id, { opacity: v / 100 })} onCommit={snap} />
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6, marginTop: 6 }}>
                    <div>
                      <div style={{ fontSize: 9, color: "#52525b", marginBottom: 3 }}>시작 (초)</div>
                      <input type="number" value={selGfx.ts.toFixed(1)} min={0} step={0.1}
                        onChange={e => updateGfx(selGfx.id, { ts: Math.max(0, Number(e.target.value)) })}
                        onBlur={snap}
                        style={{ width: "100%", background: "#18181b", border: `1px solid ${BORDER}`, color: "#e4e4e7", fontSize: 11, padding: "3px 6px", borderRadius: 4, outline: "none", boxSizing: "border-box" }} />
                    </div>
                    <div>
                      <div style={{ fontSize: 9, color: "#52525b", marginBottom: 3 }}>길이 (초)</div>
                      <input type="number" value={selGfx.dur.toFixed(1)} min={0.1} step={0.1}
                        onChange={e => updateGfx(selGfx.id, { dur: Math.max(0.1, Number(e.target.value)) })}
                        onBlur={snap}
                        style={{ width: "100%", background: "#18181b", border: `1px solid ${BORDER}`, color: "#e4e4e7", fontSize: 11, padding: "3px 6px", borderRadius: 4, outline: "none", boxSizing: "border-box" }} />
                    </div>
                  </div>
                </div>
              </>
            ) : selClip ? (
              <>
                <div style={{ fontSize: 11, fontWeight: 700, color: ACCENT, marginBottom: 12 }}>🎬 {selClip.name}</div>
                <div style={{ fontSize: 10, color: "#52525b", fontWeight: 700, textTransform: "uppercase", marginBottom: 6 }}>변형 (TRANSFORM)</div>
                <div style={{ marginBottom: 8 }}>
                  <div style={{ fontSize: 10, color: "#71717a", textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 3 }}>트랙</div>
                  <select value={selClip.track} onChange={e => { updateClip(selClip.id, { track: Number(e.target.value) }); snap(); }} style={{ width: "100%", background: "#18181b", border: `1px solid ${BORDER}`, color: "#e4e4e7", fontSize: 11, padding: "4px 6px", borderRadius: 4, outline: "none" }}>
                    <option value={1}>V1</option><option value={2}>V2</option><option value={3}>V3</option>
                  </select>
                </div>
                <AnimPropRow label="위치 X" value={Math.round(selClip.x * 10) / 10} min={0} max={100} step={0.1} unit="%"
                  keyframed={hasKeyframeAt(selClip, "x", clamp(time - selClip.ts, 0, selClip.dur))}
                  onToggleKeyframe={() => toggleClipKeyframe(selClip, "x")}
                  onChange={v => updateClip(selClip.id, { x: v })} onCommit={snap} />
                <AnimPropRow label="위치 Y" value={Math.round(selClip.y * 10) / 10} min={0} max={100} step={0.1} unit="%"
                  keyframed={hasKeyframeAt(selClip, "y", clamp(time - selClip.ts, 0, selClip.dur))}
                  onToggleKeyframe={() => toggleClipKeyframe(selClip, "y")}
                  onChange={v => updateClip(selClip.id, { y: v })} onCommit={snap} />
                <AnimPropRow label="비율 (Scale)" value={Math.round(selClip.scale)} min={10} max={500} step={1} unit="%"
                  keyframed={hasKeyframeAt(selClip, "scale", clamp(time - selClip.ts, 0, selClip.dur))}
                  onToggleKeyframe={() => toggleClipKeyframe(selClip, "scale")}
                  onChange={v => updateClip(selClip.id, { scale: v })} onCommit={snap} />
                <AnimPropRow label="회전" value={Math.round((selClip.rotation || 0) * 10) / 10} min={-180} max={180} step={0.1} unit="°"
                  keyframed={hasKeyframeAt(selClip, "rotation", clamp(time - selClip.ts, 0, selClip.dur))}
                  onToggleKeyframe={() => toggleClipKeyframe(selClip, "rotation")}
                  onChange={v => updateClip(selClip.id, { rotation: v })} onCommit={snap} />
                <AnimPropRow label="불투명도" value={Math.round(selClip.opacity * 100)} min={0} max={100} step={1} unit="%"
                  keyframed={hasKeyframeAt(selClip, "opacity", clamp(time - selClip.ts, 0, selClip.dur))}
                  onToggleKeyframe={() => toggleClipKeyframe(selClip, "opacity")}
                  onChange={v => updateClip(selClip.id, { opacity: v / 100 })} onCommit={snap} />
              </>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", height: 200, opacity: 0.25 }}>
                <div style={{ fontSize: 32, marginBottom: 8 }}>⚙️</div>
                <div style={{ fontSize: 11, textAlign: "center", lineHeight: 1.5 }}>클립이나 그래픽을<br />선택하세요</div>
              </div>
            )}
          </div>
          {/* Audio Meter */}
          <div style={{ height: 100, borderTop: `1px solid ${BORDER}`, padding: "10px 12px", background: "#080808" }}>
            <div style={{ fontSize: 10, color: "#52525b", fontWeight: 700, textTransform: "uppercase", marginBottom: 6 }}>오디오 미터</div>
            <div style={{ display: "flex", gap: 8, height: 56 }}>
              {[playing ? Math.random() * 60 + 20 : 0, playing ? Math.random() * 50 + 15 : 0].map((h, i) => (
                <div key={i} style={{ flex: 1, background: "#18181b", borderRadius: 2, position: "relative", overflow: "hidden" }}>
                  <div style={{ position: "absolute", bottom: 0, left: 0, right: 0, background: "linear-gradient(to top, #22c55e, #eab308, #ef4444)", height: `${h}%`, transition: "height 0.1s" }} />
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
      {/* ── STATUS BAR ── */}
      <div style={{ height: 24, borderTop: `1px solid ${BORDER}`, background: "#0a0a0a", display: "flex", alignItems: "center", justifyContent: "space-between", padding: "0 12px", flexShrink: 0 }}>
        <div style={{ display: "flex", gap: 12, fontSize: 10, color: "#52525b" }}>
          <span style={{ color: ACCENT, fontWeight: 700 }}>VibeEdit Pro</span>
          <span>컴포지션 {comp.w}×{comp.h} @ {comp.fps}fps</span>
          <span>클립: {clips.length}개</span>
          <span>그래픽: {graphics.length}개</span>
        </div>
        <div style={{ display: "flex", gap: 12, fontSize: 10, color: "#52525b" }}>
          <span>{fmt(time)} / {fmt(totalDur)}</span>
          <span style={{ display: "flex", alignItems: "center", gap: 4 }}>
            <span style={{ width: 6, height: 6, borderRadius: "50%", background: renderStatus === "done" ? ACCENT2 : renderStatus === "rendering" ? "#38bdf8" : renderStatus === "queued" ? ACCENT : "#52525b", display: "inline-block" }} />
            렌더 서버: {renderStatus === "idle" ? "대기" : renderStatus === "queued" ? "큐잉" : renderStatus === "rendering" ? "렌더 중" : "완료"}
          </span>
        </div>
      </div>
      {/* ── COMPOSITION SETTINGS MODAL ── */}
      {showCompSettings && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.75)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 200 }}
          onClick={e => e.target === e.currentTarget && setShowCompSettings(false)}>
          <div style={{ background: "#18181b", border: `1px solid ${BORDER}`, borderRadius: 12, padding: 24, width: 400, boxShadow: "0 24px 48px rgba(0,0,0,0.5)" }}>
            <div style={{ fontSize: 16, fontWeight: 700, marginBottom: 4 }}>컴포지션 설정</div>
            <div style={{ fontSize: 12, color: "#71717a", marginBottom: 20 }}>작업 화면 해상도와 기본값을 설정합니다</div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 16 }}>
              {[["너비", "w", 16, 7680], ["높이", "h", 16, 4320], ["FPS", "fps", 1, 60]].map(([l, k, mn, mx]) => (
                <label key={k} style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                  <span style={{ fontSize: 11, color: "#71717a" }}>{l}</span>
                  <input type="number" value={comp[k]} min={mn} max={mx}
                    onChange={e => setComp(c => ({ ...c, [k]: Math.max(mn, Math.min(mx, Number(e.target.value) || c[k])) }))}
                    style={{ background: "#0a0a0a", border: `1px solid ${BORDER}`, color: "#e4e4e7", fontSize: 13, padding: "6px 10px", borderRadius: 6, outline: "none" }} />
                </label>
              ))}
              <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                <span style={{ fontSize: 11, color: "#71717a" }}>배경색</span>
                <input type="color" value={comp.bg} onChange={e => setComp(c => ({ ...c, bg: e.target.value }))}
                  style={{ height: 38, background: "#0a0a0a", border: `1px solid ${BORDER}`, borderRadius: 6, cursor: "pointer", padding: 2 }} />
              </label>
            </div>
            <div style={{ background: "#0a0a0a", borderRadius: 8, padding: 12, marginBottom: 16, fontSize: 12, color: "#71717a" }}>
              현재: <b style={{ color: "#e4e4e7" }}>{comp.w} × {comp.h}</b> / {comp.fps} FPS · 배경 <b style={{ color: comp.bg }}>{comp.bg}</b>
            </div>
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
              <button onClick={() => setShowCompSettings(false)}
                style={{ padding: "8px 16px", background: "transparent", border: `1px solid ${BORDER}`, color: "#a1a1aa", borderRadius: 6, cursor: "pointer", fontSize: 12 }}>
                취소
              </button>
              <button onClick={() => setShowCompSettings(false)}
                style={{ padding: "8px 16px", background: ACCENT, border: "none", color: "#000", borderRadius: 6, cursor: "pointer", fontSize: 12, fontWeight: 700 }}>
                적용
              </button>
            </div>
          </div>
        </div>
      )}
      {/* ── AE TEMPLATE PANEL (float) ── */}
      {editingTemplate && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.5)", zIndex: 160, display: "flex", alignItems: "center", justifyContent: "center" }}>
          <div style={{ width: 520, maxHeight: "80vh", overflowY: "auto", background: "#111", border: `1px solid ${ACCENT2}55`, borderRadius: 12, padding: 16, boxShadow: "0 20px 48px rgba(0,0,0,0.55)" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
              <div>
                <div style={{ fontSize: 13, fontWeight: 800, color: ACCENT2 }}>템플릿 등록 설정</div>
                <div style={{ fontSize: 10, color: "#52525b", marginTop: 2 }}>Lottie JSON / AEP 패키지 기준 · live text면 내부 텍스트 직접 수정</div>
              </div>
              <button onClick={() => setEditingTemplateId(null)} style={{ background: "none", border: "none", color: "#71717a", cursor: "pointer", fontSize: 18 }}>✕</button>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "160px 1fr", gap: 16 }}>
              <div>
                <div style={{ width: "100%", height: 96, background: "#000", borderRadius: 8, overflow: "hidden", border: `1px solid ${BORDER}` }}>
                  <TemplateThumbnail template={editingTemplate} fontFamily="Pretendard, 'Noto Sans KR', sans-serif" />
                </div>
              </div>
              <div>
                <div style={{ marginBottom: 8 }}>
                  <div style={{ fontSize: 10, color: "#71717a", marginBottom: 3 }}>템플릿 이름</div>
                  <input type="text" value={editingTemplate.name} onChange={e => updateTemplateAsset(editingTemplate.id, { name: e.target.value })} style={{ width: "100%", background: "#18181b", border: `1px solid ${BORDER}`, borderRadius: 6, color: "#fff", padding: "6px 8px", fontSize: 11, boxSizing: "border-box" }} />
                </div>
                <div style={{ marginBottom: 8 }}>
                  <div style={{ fontSize: 10, color: "#71717a", marginBottom: 3 }}>메인 컴프명</div>
                  <input type="text" value={editingTemplate.compName || ""} onChange={e => updateTemplateAsset(editingTemplate.id, { compName: e.target.value })} style={{ width: "100%", background: "#18181b", border: `1px solid ${BORDER}`, borderRadius: 6, color: "#fff", padding: "6px 8px", fontSize: 11, boxSizing: "border-box" }} />
                </div>
                <div style={{ display: "flex", gap: 12, marginBottom: 10 }}>
                  <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11, color: "#a1a1aa" }}><input type="checkbox" checked={editingTemplate.allowFontChange ?? true} onChange={e => updateTemplateAsset(editingTemplate.id, { allowFontChange: e.target.checked })} />폰트 변경</label>
                  <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11, color: "#a1a1aa" }}><input type="checkbox" checked={editingTemplate.allowColorChange ?? true} onChange={e => updateTemplateAsset(editingTemplate.id, { allowColorChange: e.target.checked })} />색상 변경</label>
                </div>
              </div>
            </div>
            <div style={{ marginTop: 14 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
                <div style={{ fontSize: 11, fontWeight: 700, color: ACCENT2 }}>기본 텍스트 필드</div>
                <button onClick={() => addTemplateFieldDef(editingTemplate.id)} style={{ padding: "4px 8px", background: ACCENT2, color: "#000", border: "none", borderRadius: 4, fontSize: 10, fontWeight: 700, cursor: "pointer" }}>+ 필드 추가</button>
              </div>
              {(editingTemplate.fields || []).map((f, idx) => (
                <div key={f.id} style={{ display: "grid", gridTemplateColumns: "1fr 1fr auto", gap: 8, marginBottom: 8 }}>
                  <input type="text" value={f.label} onChange={e => updateTemplateFieldDef(editingTemplate.id, f.id, { label: e.target.value })} placeholder={`필드 ${idx + 1} 이름`} style={{ background: "#18181b", border: `1px solid ${BORDER}`, borderRadius: 6, color: "#fff", padding: "6px 8px", fontSize: 11 }} />
                  <input type="text" value={f.value} onChange={e => updateTemplateFieldDef(editingTemplate.id, f.id, { value: e.target.value })} placeholder="기본값" style={{ background: "#18181b", border: `1px solid ${BORDER}`, borderRadius: 6, color: "#fff", padding: "6px 8px", fontSize: 11 }} />
                  <button onClick={() => removeTemplateFieldDef(editingTemplate.id, f.id)} style={{ padding: "6px 10px", background: "#18181b", color: "#ef4444", border: `1px solid ${BORDER}`, borderRadius: 6, fontSize: 10, cursor: "pointer" }}>삭제</button>
                </div>
              ))}
            </div>
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 12 }}>
              <button onClick={() => setEditingTemplateId(null)} style={{ padding: "6px 12px", background: "#18181b", color: "#a1a1aa", border: `1px solid ${BORDER}`, borderRadius: 6, fontSize: 11, cursor: "pointer" }}>닫기</button>
              <button onClick={() => setEditingTemplateId(null)} style={{ padding: "6px 12px", background: ACCENT2, color: "#000", border: "none", borderRadius: 6, fontSize: 11, fontWeight: 700, cursor: "pointer" }}>저장</button>
            </div>
          </div>
        </div>
      )}
      {showAEPanel && (
        <div style={{ position: "fixed", top: 50, left: 55, width: 320, background: "#111", border: `1px solid ${ACCENT2}55`, borderRadius: 10, padding: 16, zIndex: 150, boxShadow: "0 16px 32px rgba(0,0,0,0.5)" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
            <div style={{ fontSize: 12, fontWeight: 700, color: ACCENT2 }}>🎨 자막/Lottie 템플릿 라이브러리</div>
            <button onClick={() => setShowAEPanel(false)} style={{ background: "none", border: "none", color: "#71717a", cursor: "pointer", fontSize: 16 }}>✕</button>
          </div>
          <div style={{ marginBottom: 12 }}>
            <div style={{ fontSize: 10, color: "#52525b", marginBottom: 6 }}>내장 템플릿</div>
            <div
              onClick={() => addAETemplate({ id: "builtin", name: "TopTitle_F_04", compName: "TopTitle_F_04_AGL & NAVIADs", fields: DEFAULT_FIELDS.map(f => ({ ...f })) })}
              style={{ padding: 10, background: "#0a1a0a", border: `1px solid ${ACCENT2}33`, borderRadius: 6, cursor: "pointer", marginBottom: 4 }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: ACCENT2, marginBottom: 4 }}>TopTitle_F_04_AGL &amp; NAVIADs</div>
              {/* Mini SVG preview */}
              <div style={{ width: "100%", height: 60, background: "#000" }}>
                <TemplateThumbnail template={{ compName: "TopTitle_F_04_AGL & NAVIADs", fields: DEFAULT_FIELDS }} />
              </div>
              <div style={{ fontSize: 9, color: "#52525b", marginTop: 4 }}>필드: Sub_텍스트 / Main_텍스트 상 / Main_텍스트 하</div>
            </div>
          </div>
          {importedAE.length > 0 && (
            <div>
              <div style={{ fontSize: 10, color: "#52525b", marginBottom: 6 }}>불러온 템플릿 (Lottie/AEP)</div>
              {importedAE.map(t => (
                <div key={t.id}
                  style={{ padding: 10, background: "#0a1a0a", border: `1px solid ${ACCENT2}33`, borderRadius: 6, marginBottom: 4 }}>
                  <div onClick={() => addAETemplate(t)} style={{ cursor: "pointer" }}>
                    <div style={{ width: "100%", height: 60, background: "#000", marginBottom: 6, borderRadius: 4, overflow: "hidden" }}>
                      <TemplateThumbnail template={t} fontFamily="Pretendard, 'Noto Sans KR', sans-serif" />
                    </div>
                    <div style={{ fontSize: 11, fontWeight: 700, color: ACCENT2 }}>{t.name}</div>
                    <div style={{ fontSize: 9, color: "#52525b" }}>{t.compName || "메인 컴프 미설정"}</div>
                  </div>
                  <div style={{ display: "flex", gap: 6, marginTop: 6 }}>
                    <button onClick={() => addAETemplate(t)} style={{ flex: 1, padding: 6, background: ACCENT2, color: "#000", border: "none", borderRadius: 4, fontSize: 10, fontWeight: 700, cursor: "pointer" }}>삽입</button>
                    <button onClick={() => setEditingTemplateId(t.id)} style={{ padding: "6px 10px", background: "#18181b", color: ACCENT2, border: `1px solid ${ACCENT2}55`, borderRadius: 4, fontSize: 10, cursor: "pointer" }}>설정</button>
                  </div>
                </div>
              ))}
            </div>
          )}
          <button onClick={() => aeFileRef.current?.click()}
            style={{ width: "100%", padding: 8, background: "transparent", border: `1px dashed ${ACCENT2}55`, color: ACCENT2, borderRadius: 6, cursor: "pointer", fontSize: 11, marginTop: 4 }}>
            + Lottie JSON + PNG 불러오기
          </button>
        </div>
      )}
    </div>
  );
}
