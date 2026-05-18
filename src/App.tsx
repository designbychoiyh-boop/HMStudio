import React, { useState, useRef, useEffect, useCallback, useMemo, memo } from "react";
import { createPortal } from "react-dom";
import { WebGLRenderStage } from './rendering/WebGLRenderStage';

const TEMP_DISABLE_LOGIN = false;
// ── Interpolation ─────────────────────────────────────────────────────────────
const smoothstep = p => p * p * (3 - 2 * p);
const lerp = (kfs, time, fallback) => {
  if (!kfs || !kfs.length) return fallback;
  const s = [...kfs].sort((a, b) => a.t - b.t);
  if (time <= s[0].t) return s[0].v;
  if (time >= s[s.length - 1].t) return s[s.length - 1].v;
  for (let i = 0; i < s.length - 1; i++) {
    const a = s[i], b = s[i + 1];
    if (time >= a.t && time <= b.t) {
      let p = (time - a.t) / Math.max(0.0001, b.t - a.t);
      if (a.easing === 'ease') p = smoothstep(p);
      return a.v + (b.v - a.v) * p;
    }
  }
  return fallback;
};
const clamp = (v, mn, mx) => Math.max(mn, Math.min(mx, v));
const fmt = s => [Math.floor(s / 3600), Math.floor((s % 3600) / 60), Math.floor(s % 60), Math.floor((s % 1) * 30)]
  .map(n => String(n).padStart(2, "0")).join(":");
const uid = () => Math.random().toString(36).slice(2);
const pathToPlaybackUrl = filePath => {
  const normalized = String(filePath || "").replace(/\\/g, "/");
  if (!normalized) return "";
  return `file:///${normalized.split("/").map((part, index) => index === 0 ? part : encodeURIComponent(part)).join("/")}`;
};
const localFileUrlToPath = url => {
  if (typeof url !== "string" || !url.startsWith("local-file://")) return "";
  const rawPath = url.replace("local-file://", "");
  try {
    const decoded = decodeURIComponent(rawPath);
    if (/^\/[a-zA-Z]:/.test(decoded)) return decoded.slice(1).replace(/\//g, "\\");
    if (/^[a-zA-Z]\//.test(decoded)) return `${decoded[0].toUpperCase()}:\\${decoded.slice(2).replace(/\//g, "\\")}`;
    return decoded.replace(/\//g, "\\");
  } catch {
    if (/^\/[a-zA-Z]:/.test(rawPath)) return rawPath.slice(1).replace(/\//g, "\\");
    if (/^[a-zA-Z]\//.test(rawPath)) return `${rawPath[0].toUpperCase()}:\\${rawPath.slice(2).replace(/\//g, "\\")}`;
    return rawPath.replace(/\//g, "\\");
  }
};
const resolvePlaybackUrl = item => {
  if (!item) return "";
  if (item.storedPath) return pathToPlaybackUrl(item.storedPath);
  const primary = item.serverUrl || item.url || "";
  if (typeof primary === "string" && primary.startsWith("local-file://")) {
    const filePath = localFileUrlToPath(primary);
    if (filePath) return pathToPlaybackUrl(filePath);
  }
  return primary;
};
const KEYFRAME_PROPS = ["x", "y", "scale", "rotation", "opacity"];
const hasKeyframeAt = (item, prop, time) => !!(item?.kf?.[prop] || []).find(k => Math.abs(k.t - time) < 0.001);
const upsertKeyframe = (item, prop, time, value) => {
  const next = { ...(item.kf || {}) };
  const arr = [...(next[prop] || [])];
  const idx = arr.findIndex(k => Math.abs(k.t - time) < 0.001);
  const kf = { ...(idx >= 0 ? arr[idx] : {}), t: time, v: value };
  if (idx >= 0) arr[idx] = kf; else arr.push(kf);
  arr.sort((a, b) => a.t - b.t);
  next[prop] = arr;
  return next;
};
const removeKeyframe = (item: any, prop: string, time: number) => {
  const next = { ...(item.kf || {}) };
  next[prop] = [...(next[prop] || [])].filter(k => Math.abs(k.t - time) >= 0.001);
  return next;
};
const KF_PROP_CONFIG: Record<string, { label: string, index: number }> = {
  x: { label: '위치 X', index: 0 },
  y: { label: '위치 Y', index: 1 },
  scale: { label: '비율', index: 2 },
  rotation: { label: '회전', index: 3 },
  opacity: { label: '불투명도', index: 4 }
};
const collectAllKeyframes = (item: any) => {
  const kfs: any[] = [];
  KEYFRAME_PROPS.forEach(prop => {
    (item?.kf?.[prop] || []).forEach((k: any) => {
      kfs.push({ t: Number(k.t.toFixed(3)), prop, easing: k.easing, v: k.v });
    });
  });
  return kfs.sort((a, b) => a.t - b.t);
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
  { id: "mainTop", label: "Main_텍스트 상", value: "Reconstruction Project", order: 0 },
  { id: "mainBottom", label: "Main_텍스트 하", value: "SHUAIBA AIR BASE", order: 1 },
  { id: "subText", label: "Sub_텍스트", value: "부산 수영구 망미동", order: 2 },
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
    // Take the FIRST keyframe's start value (Time 0) instead of the last one.
    // This matches the initial design state of most templates.
    const first = key[0];
    if (Array.isArray(first?.s)) return first.s;
    if (typeof first?.s !== "undefined") return first.s;
    return first;
  }
  return fallback;
};

const readTransformValueForLayout = (prop, fallback, data = null) => {
  const key = prop?.k;
  if (Array.isArray(key) && key.length && typeof key[0] === "number") return key;
  if (Array.isArray(key) && key.length && typeof key[0] === "object") {
    const endFrame = Number(data?.op ?? Number.POSITIVE_INFINITY);
    const keyed = key.filter(frame => typeof frame?.t !== "undefined" && Number(frame.t) <= endFrame + 0.001);
    const chosen = (keyed.length ? keyed[keyed.length - 1] : key[0]) || {};
    if (Array.isArray(chosen?.s)) return chosen.s;
    if (typeof chosen?.s !== "undefined") return chosen.s;
    return chosen;
  }
  return fallback;
};

const getLayerScalePairForLayout = (layer, data = null) => {
  const scl = readTransformValueForLayout(layer?.ks?.s, [100, 100, 100], data);
  return [Number(scl?.[0] || 100), Number(scl?.[1] || 100)];
};

const textAlignToFactor = align => align === "right" ? 1 : align === "center" ? 0.5 : 0;

const getLottieTextAnchorPointInComp = (layer, data = null) => {
  const doc = getLottieTextDoc(layer) || {};
  const pos = readTransformValueForLayout(layer?.ks?.p, [0, 0, 0], data);
  const anc = readTransformValueForLayout(layer?.ks?.a, [0, 0, 0], data);
  const [sxPct, syPct] = getLayerScalePairForLayout(layer, data);
  const sx = Number(sxPct || 100) / 100;
  const sy = Number(syPct || 100) / 100;
  const align = lottieJustifyToAlign(doc.j);
  const hasBox = Array.isArray(doc.ps) && Array.isArray(doc.sz);
  const ps = hasBox ? doc.ps : [0, 0];
  const sz = hasBox ? doc.sz : [0, 0];
  const x = hasBox
    ? Number(pos?.[0] || 0) - Number(anc?.[0] || 0) * sx + Number(ps?.[0] || 0) * sx + Number(sz?.[0] || 0) * sx * textAlignToFactor(align)
    : Number(pos?.[0] || 0) - Number(anc?.[0] || 0) * sx;
  let y = Number(pos?.[1] || 0) - Number(anc?.[1] || 0) * sy;
  if (hasBox) {
    // For Paragraph Text, AE draws text within a bounding box at 'ps'.
    // The top of the box is y + ps[1]. The first line's baseline is at top + ascent.
    // We approximate the font ascent as ~80% of the scaled font size.
    const fontSize = Number(doc.s || 72) * sy;
    y = y + Number(ps?.[1] || 0) * sy + fontSize * 0.8;
  }
  return { x, y, align, hasBox, ps, sz };
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
  // Don't force overlay by default for Lottie templates to preserve animations.
  // Only use overlay if explicitly requested in metaFields.
  if (field.renderMode === "overlay" || field.fontMode === "overlay") return true;
  return false; 
};

const createDefaultTemplateField = index => ({
  id: uid(),
  label: `텍스트 ${index}`,
  value: `텍스트 ${index}`,
  renderMode: "internal",
  fontMode: "internal",
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


const loadDataImage = src => new Promise((resolve, reject) => {
  if (typeof Image === 'undefined') return reject(new Error('Image unavailable'));
  const img = new Image();
  img.onload = () => resolve(img);
  img.onerror = reject;
  img.src = src;
});

const computeLottieAssetAlphaBounds = async lottieData => {
  const out = {};
  if (typeof document === 'undefined') return out;
  for (const asset of (lottieData?.assets || [])) {
    if (!asset?.id || typeof asset?.p !== 'string' || !asset.p.startsWith('data:image/')) continue;
    try {
      const img = await loadDataImage(asset.p);
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, img.width || Number(asset.w || 1));
      canvas.height = Math.max(1, img.height || Number(asset.h || 1));
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      if (!ctx) throw new Error('ctx');
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
      let minX = canvas.width, minY = canvas.height, maxX = -1, maxY = -1;
      for (let y = 0; y < canvas.height; y++) {
        for (let x = 0; x < canvas.width; x++) {
          const a = pixels[(y * canvas.width + x) * 4 + 3];
          if (a > 4) {
            if (x < minX) minX = x;
            if (y < minY) minY = y;
            if (x > maxX) maxX = x;
            if (y > maxY) maxY = y;
          }
        }
      }
      out[asset.id] = maxX >= minX && maxY >= minY
        ? { x: minX, y: minY, w: Math.max(1, maxX - minX + 1), h: Math.max(1, maxY - minY + 1) }
        : { x: 0, y: 0, w: Math.max(1, Number(asset?.w || canvas.width || 1)), h: Math.max(1, Number(asset?.h || canvas.height || 1)) };
    } catch (e) {
      out[asset.id] = { x: 0, y: 0, w: Math.max(1, Number(asset?.w || 1)), h: Math.max(1, Number(asset?.h || 1)) };
    }
  }
  return out;
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
const scalePointXAround = (value, centerX, factor) => {
  if (!Array.isArray(value)) return value;
  return [centerX + (Number(value[0] || 0) - centerX) * factor, value[1], ...(value.length > 2 ? [value[2]] : [])];
};
const scaleDeltaX = (value, factor) => {
  if (!Array.isArray(value)) return value;
  return [Number(value[0] || 0) * factor, value[1], ...(value.length > 2 ? [value[2]] : [])];
};
const scaleLayerPositionX = (layer, centerX, factor) => {
  const pos = layer?.ks?.p;
  if (!pos || pos.s) return;
  const key = pos.k;
  if (Array.isArray(key) && key.length && typeof key[0] === "number") {
    pos.k = scalePointXAround(key, centerX, factor);
    return;
  }
  if (Array.isArray(key) && key.length && typeof key[0] === "object") {
    pos.k = key.map(frame => ({
      ...frame,
      s: scalePointXAround(frame?.s, centerX, factor),
      e: scalePointXAround(frame?.e, centerX, factor),
      to: scaleDeltaX(frame?.to, factor),
      ti: scaleDeltaX(frame?.ti, factor),
    }));
  }
};
const hasAnimatedPositionX = layer => {
  const key = layer?.ks?.p?.k;
  if (!Array.isArray(key) || !key.length || typeof key[0] !== "object") return false;
  const xs = key.flatMap(frame => [frame?.s, frame?.e])
    .filter(value => Array.isArray(value))
    .map(value => Number(value[0]))
    .filter(value => Number.isFinite(value));
  return xs.length >= 2 && Math.max(...xs) - Math.min(...xs) > 1;
};
const getLayerPositionSamples = layer => {
  const key = layer?.ks?.p?.k;
  if (Array.isArray(key) && key.length && typeof key[0] === "number") return [key];
  if (Array.isArray(key) && key.length && typeof key[0] === "object") {
    return key.flatMap(frame => [frame?.s, frame?.e]).filter(value => Array.isArray(value));
  }
  const point = readTransformValueForLayout(layer?.ks?.p, null);
  return Array.isArray(point) ? [point] : [];
};
const getLayerTimingSec = (layer, data) => {
  const fr = Math.max(1, Number(data?.fr || 30));
  return { ip: Number(layer?.ip ?? data?.ip ?? 0) / fr, op: Number(layer?.op ?? data?.op ?? 0) / fr };
};
const getScaleFactors = layer => {
  const scl = readTransformValue(layer?.ks?.s, [100, 100, 100]);
  return [Number(scl?.[0] || 100) / 100, Number(scl?.[1] || 100) / 100];
};

const getAnimatedRangeSec = (transform, data, fallback = { start: 0, end: 0 }) => {
  const fr = Math.max(1, Number(data?.fr || 30));
  const key = transform?.k;
  if (Array.isArray(key) && key.length && typeof key[0] === 'object') {
    const first = key[0];
    const last = key[key.length - 1];
    const start = Number(first?.t || 0) / fr;
    const end = Number(last?.t || first?.t || 0) / fr;
    return { start, end: Math.max(start, end) };
  }
  return fallback;
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
const getLayerXScaleKeyframesSec = (layer, data) => {
  const fr = Math.max(1, Number(data?.fr || 30));
  const key = layer?.ks?.s?.k;
  if (Array.isArray(key) && key.length && typeof key[0] === 'object') {
    return key.map(frame => ({ t: Number(frame.t || 0) / fr, v: Number((frame.s && frame.s[0]) ?? 100) / 100 }));
  }
  const scl = readTransformValue(layer?.ks?.s, [100, 100, 100]);
  return [{ t: 0, v: Number(scl?.[0] || 100) / 100 }];
};

const readEffectValue = (effectParam, fallback) => {
  const value = effectParam?.v;
  if (!value || typeof value !== 'object') return fallback;
  const key = value.k;
  if (Array.isArray(key) && key.length && typeof key[0] === 'object') {
    const first = key[0];
    if (Array.isArray(first?.s)) return first.s;
    if (typeof first?.s !== 'undefined') return first.s;
  }
  return typeof key !== 'undefined' ? key : fallback;
};

const readEffectKeyframesSec = (effectParam, data, fallback = 0) => {
  const fr = Math.max(1, Number(data?.fr || 30));
  const value = effectParam?.v;
  const key = value?.k;
  if (Array.isArray(key) && key.length && typeof key[0] === 'object') {
    return key.map(frame => ({
      t: Number(frame.t || 0) / fr,
      v: Number((Array.isArray(frame.s) ? frame.s[0] : frame.s) ?? fallback),
    }));
  }
  return [{ t: 0, v: Number(key ?? fallback) }];
};

const findLottieEffect = (layer, effectName, matchMn = '') => {
  const effects = Array.isArray(layer?.ef) ? layer.ef : [];
  const wanted = String(effectName || '').toLowerCase();
  const wantedMn = String(matchMn || '').toLowerCase();
  return effects.find(effect => {
    const nm = String(effect?.nm || '').toLowerCase();
    const mn = String(effect?.mn || '').toLowerCase();
    return nm === wanted || (wantedMn && mn === wantedMn);
  }) || null;
};

const getTintEffectModel = (layer, data) => {
  const tint = findLottieEffect(layer, 'tint', 'adbe tint');
  if (!tint?.en || !Array.isArray(tint?.ef)) return null;
  const params = tint.ef;
  const blackParam = params.find(param => /Map Black To/i.test(param?.nm || '') || /Tint-0001/i.test(param?.mn || '')) || params[0];
  const whiteParam = params.find(param => /Map White To/i.test(param?.nm || '') || /Tint-0002/i.test(param?.mn || '')) || params[1];
  const amountParam = params.find(param => /Amount to Tint/i.test(param?.nm || '') || /Tint-0003/i.test(param?.mn || '')) || params[2];
  const black = readEffectValue(blackParam, [0, 0, 0, 1]);
  const white = readEffectValue(whiteParam, [1, 1, 1, 1]);
  const amount = readEffectKeyframesSec(amountParam, data, 0).map(kf => ({ ...kf, v: Number(kf.v || 0) / 100 }));
  return {
    black: Array.isArray(black) ? black.slice(0, 4) : [0, 0, 0, 1],
    white: Array.isArray(white) ? white.slice(0, 4) : [1, 1, 1, 1],
    amount,
  };
};

const sampleTintAmount = (tint, time) => tint?.amount ? clamp(lerp(tint.amount, time, tint.amount[tint.amount.length - 1]?.v ?? 0), 0, 1) : 0;

const hexToRgb01 = hex => {
  const normalized = String(hex || '#ffffff').replace('#', '');
  const safe = normalized.length === 3 ? normalized.split('').map(ch => ch + ch).join('') : normalized.padEnd(6, 'f').slice(0, 6);
  return [parseInt(safe.slice(0, 2), 16) / 255, parseInt(safe.slice(2, 4), 16) / 255, parseInt(safe.slice(4, 6), 16) / 255];
};

const rgb01ToHex = rgb => {
  const toHex = value => Math.max(0, Math.min(255, Math.round(Number(value || 0) * 255))).toString(16).padStart(2, '0');
  return '#' + toHex(rgb?.[0]) + toHex(rgb?.[1]) + toHex(rgb?.[2]);
};

const applyTintToRgb = (rgb, tint, time) => {
  const amount = sampleTintAmount(tint, time);
  if (!tint || amount <= 0.0001) return rgb;
  const black = tint.black || [0, 0, 0, 1];
  const white = tint.white || [1, 1, 1, 1];
  const lum = clamp(Number(rgb?.[0] || 0) * 0.2126 + Number(rgb?.[1] || 0) * 0.7152 + Number(rgb?.[2] || 0) * 0.0722, 0, 1);
  const tinted = [0, 1, 2].map(i => Number(black[i] || 0) * (1 - lum) + Number(white[i] || 0) * lum);
  return [0, 1, 2].map(i => Number(rgb?.[i] || 0) * (1 - amount) + tinted[i] * amount);
};

const applyTintToHex = (hex, tint, time) => rgb01ToHex(applyTintToRgb(hexToRgb01(hex), tint, time));

const buildTintMatrixValues = (tint, time) => {
  const amount = sampleTintAmount(tint, time);
  if (!tint || amount <= 0.0001) return null;
  const lr = 0.2126, lg = 0.7152, lb = 0.0722;
  const black = tint.black || [0, 0, 0, 1];
  const white = tint.white || [1, 1, 1, 1];
  const row = channel => {
    const diff = Number(white[channel] || 0) - Number(black[channel] || 0);
    return [
      (channel === 0 ? (1 - amount) : 0) + amount * diff * lr,
      (channel === 1 ? (1 - amount) : 0) + amount * diff * lg,
      (channel === 2 ? (1 - amount) : 0) + amount * diff * lb,
      0,
      amount * Number(black[channel] || 0),
    ];
  };
  return [...row(0), ...row(1), ...row(2), 0, 0, 0, 1, 0].map(v => Number(v.toFixed(6))).join(' ');
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
  const boundsMap = data?.__assetAlphaBounds || {};
  const textLayers = (data?.layers || []).filter(layer => layer?.ty === 5);
  const imageLayers = (data?.layers || []).filter(layer => layer?.ty === 2 && assetMap.get(layer.refId));
  const fontList = data?.fonts?.list || [];
  const texts = textLayers.map(layer => {
    const doc = getLottieTextDoc(layer) || {};
    const fontMeta = fontList.find(font => font.fName === doc.f) || {};
    const fontFamily = fontMeta.fFamily ? `'${fontMeta.fFamily}', 'Noto Sans KR', sans-serif` : "Pretendard, 'Noto Sans KR', sans-serif";
    const pos = readTransformValueForLayout(layer?.ks?.p, [0, 0, 0], data);
    const [sx, sy] = getScaleFactors(layer);
    const timing = getLayerTimingSec(layer, data);
    const bindingKey = `__main__::${layer.nm || ''}`;
    const baseWidth = measureCanvasTextWidth(String(doc.t || '').replace(/\r/g, ''), fontFamily, Number(doc.s || 72) * sx, '700', Number(doc.tr || 0));
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
      baseWidth,
      textAlign: lottieJustifyToAlign(doc.j),
      layerName: layer.nm || '',
      layerIndex: (data?.layers || []).indexOf(layer),
      maxY: Math.max(...(layer?.ks?.p?.k || []).map(kf => Array.isArray(kf.s) ? kf.s[1] : 0).concat([Number(readTransformValue(layer?.ks?.p, [0, 0, 0])?.[1] || 0)])),
    };
  });
  const usedTextKeys = new Set();
  return imageLayers.map(layer => {
    const asset = assetMap.get(layer.refId);
    const bbox = boundsMap[layer.refId] || { x: 0, y: 0, w: Number(asset?.w || 1), h: Number(asset?.h || 1) };
    const pos = readTransformValueForLayout(layer?.ks?.p, [0, 0, 0], data);
    const anc = readTransformValueForLayout(layer?.ks?.a, [0, 0, 0], data);
    const [sxPct, syPct] = getLayerScalePairForLayout(layer, data);
    const scaleX = Number(sxPct || 100) / 100;
    const scaleY = Number(syPct || 100) / 100;
    const timing = getLayerTimingSec(layer, data);
    const imageCenterX = Number(pos?.[0] || 0) - Number(anc?.[0] || 0) * scaleX + (Number(bbox.x || 0) + Number(bbox.w || 0) / 2) * scaleX;
    const imageCenterY = Number(pos?.[1] || 0) - Number(anc?.[1] || 0) * scaleY + (Number(bbox.y || 0) + Number(bbox.h || 0) / 2) * scaleY;
    const visibleW = Math.max(1, Number(bbox.w || asset?.w || 1) * scaleX);
    const visibleH = Math.max(1, Number(bbox.h || asset?.h || 1) * scaleY);
    const imageLeft = imageCenterX - visibleW / 2;
    const imageTop = imageCenterY - visibleH / 2;
    
    // 이미 사용된 텍스트는 제외하고 가장 적합한 대상을 찾음 (1대1 매칭 지향)
    const candidates = texts.filter(t => !usedTextKeys.has(t.bindingKey)).map(txt => {
      const overlap = Math.max(0, Math.min(txt.op, timing.op) - Math.max(txt.ip, timing.ip));
      const timingPenalty = Math.abs(txt.ip - timing.ip) + Math.abs(txt.op - timing.op) - overlap * 3;
      const spatialPenalty = Math.abs(txt.y - imageCenterY) + Math.abs(txt.x - imageCenterX) * 0.1;
      const indexPenalty = Math.abs(txt.layerIndex - (data?.layers || []).indexOf(layer)) * 10;
      
      const imgNm = (layer.nm || '').toLowerCase();
      const txtNm = (txt.layerName || '').toLowerCase();
      let namePenalty = 0;
      if ((imgNm.includes('main') || imgNm.includes('title')) && txtNm.includes('sub')) namePenalty = 20000;
      if (imgNm.includes('sub') && (txtNm.includes('main') || txtNm.includes('title'))) namePenalty = 20000;
      
      return { txt, score: timingPenalty * 1000 + spatialPenalty + indexPenalty + namePenalty };
    }).sort((a, b) => a.score - b.score);

    const nearest = candidates[0]?.txt;
    if (nearest) usedTextKeys.add(nearest.bindingKey);

    return nearest ? {
      layerIndex: (data?.layers || []).indexOf(layer),
      bindingKey: nearest.bindingKey,
      baseScaleX: Number(sxPct || 100),
      visibleW,
      visibleH,
      imageCenterX,
      imageCenterY,
      imageLeft,
      imageRight: imageLeft + visibleW,
      imageTop,
      imageBottom: imageTop + visibleH,
      bbox,
      ip: timing.ip,
      op: timing.op,
      layerName: layer.nm || '',
    } : null;
  }).filter(Boolean);
};

const shapeLayerMatchesResizeTarget = (layer, target, data) => {
  if (layer?.ty !== 4 || layer?.hd) return false;
  const timing = getLayerTimingSec(layer, data);
  if (Math.abs(timing.ip - target.ip) > 0.35) return false;
  const overlap = Math.max(0, Math.min(timing.op, target.op) - Math.max(timing.ip, target.ip));
  if (overlap <= 0) return false;
  const samples = getLayerPositionSamples(layer);
  if (!samples.length) return false;
  const xs = samples.map(point => Number(point?.[0] || 0));
  const ys = samples.map(point => Number(point?.[1] || 0));
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const avgY = ys.reduce((sum, y) => sum + y, 0) / Math.max(1, ys.length);
  const horizontalPad = Math.max(80, target.visibleW * 0.25);
  const verticalPad = Math.max(40, target.visibleH * 0.75);
  return maxX >= target.imageLeft - horizontalPad
    && minX <= target.imageRight + horizontalPad
    && avgY >= target.imageTop - verticalPad
    && avgY <= target.imageBottom + verticalPad;
};

const autoFitLottieBackground = (data, sourceData, fields = []) => {
  if (!data || !sourceData) return data;
  const bindingMap = new Map((fields || []).filter(f => f.bindingKey).map(f => [f.bindingKey, f]));
  const targets = collectResizeTargets(sourceData);
  const scaledShapeLayerIndices = new Set();
  targets.forEach(target => {
    const layer = data?.layers?.[target.layerIndex];
    const field = bindingMap.get(target.bindingKey);
    if (!layer || !field) return;
    const fontFamily = field.fontFamily || "Pretendard, 'Noto Sans KR', sans-serif";
    const fontSize = Number(field.fontSize || 72);
    const newWidth = measureCanvasTextWidth(String(field.value || '').replace(/\r/g, ''), fontFamily, fontSize, field.fontWeight || '700', Number(field.letterSpacing || 0));
    const innerPad = Math.max(24, Math.min(72, target.visibleW * 0.08));
    const desiredVisibleW = Math.max(target.visibleW, newWidth + innerPad * 2);
    const factor = Math.max(1, desiredVisibleW / Math.max(1, target.visibleW));
    scaleLayerX(layer, factor);
    (data?.layers || []).forEach((candidate, index) => {
      if (scaledShapeLayerIndices.has(index)) return;
      if (!shapeLayerMatchesResizeTarget(candidate, target, sourceData)) return;
      if (!hasAnimatedPositionX(candidate)) return;
      if (factor <= 1.0001) return;
      scaleLayerPositionX(candidate, target.imageCenterX, factor);
      scaledShapeLayerIndices.add(index);
    });
  });
  return data;
};

const extractVectorSubtitleModel = data => {
  const dims = getLottieDimensions(data);
  const mainTextLayers = (data?.layers || []).filter(layer => layer?.ty === 5);
  const mainImageLayers = (data?.layers || []).filter(layer => layer?.ty === 2);
  if (dims.h > 160 || mainTextLayers.length !== 1 || mainImageLayers.length !== 1) return null;
  const textLayer = mainTextLayers[0];
  const imageLayer = mainImageLayers[0];
  const asset = (data?.assets || []).find(a => a.id === imageLayer.refId);
  if (!asset?.p) return null;
  const doc = getLottieTextDoc(textLayer) || {};
  const fontList = data?.fonts?.list || [];
  const fontMeta = fontList.find(font => font.fName === doc.f) || {};
  const fontFamily = fontMeta.fFamily ? `'${fontMeta.fFamily}', 'Noto Sans KR', sans-serif` : "Pretendard, 'Noto Sans KR', sans-serif";
  const [imgSxPct, imgSyPct] = getLayerScalePair(imageLayer);
  const [txtSx, txtSy] = getScaleFactors(textLayer);
  const baseBarWidth = Number(asset.w || 1) * (Number(imgSxPct || 100) / 100);
  const baseBarHeight = Number(asset.h || 1) * (Number(imgSyPct || 100) / 100);
  const fontSize = Math.min(Number(doc.s || 72) * txtSx, baseBarHeight * 0.82);
  const textWidth = measureCanvasTextWidth(String(doc.t || '').replace(/\r/g, ''), fontFamily, fontSize, '700', Number(doc.tr || 0));
  const paddingX = Math.max(24, (baseBarWidth - textWidth) / 2);
  const imgTiming = getLayerTimingSec(imageLayer, data);
  const txtTiming = getLayerTimingSec(textLayer, data);
  const barRange = getAnimatedRangeSec(imageLayer?.ks?.s, data, { start: imgTiming.ip, end: imgTiming.ip + 0.6 });
  const textRange = getAnimatedRangeSec(textLayer?.ks?.o, data, { start: txtTiming.ip, end: txtTiming.ip + 0.6 });
  return {
    imageSrc: asset.p,
    baseBarWidth,
    baseBarHeight,
    baseTextWidth: textWidth,
    paddingX,
    fontSize,
    fontFamily,
    strokeWidth: Math.max(0, Number(doc.sw || 0) * txtSx),
    textAlign: lottieJustifyToAlign(doc.j),
    textY: baseBarHeight / 2,
    barAnimStart: barRange.start,
    barAnimEnd: Math.max(barRange.start + 0.01, barRange.end),
    textAnimStart: textRange.start,
    textAnimEnd: Math.max(textRange.start + 0.01, textRange.end),
  };
};


const extractMultiPngTitleModel = data => {
  const dims = getLottieDimensions(data);
  const textLayers = (data?.layers || []).filter(layer => layer?.ty === 5);
  const imageLayers = (data?.layers || []).filter(layer => layer?.ty === 2);
  if (!textLayers.length || !imageLayers.length) return null;
  const assetMap = new Map((data?.assets || []).map(a => [a.id, a]));
  const boundsMap = data?.__assetAlphaBounds || {};
  const fontList = data?.fonts?.list || [];
  const pairs = textLayers.map(layer => {
    const doc = getLottieTextDoc(layer) || {};
    const fontMeta = fontList.find(font => font.fName === doc.f) || {};
    const fontFamily = fontMeta.fFamily ? `'${fontMeta.fFamily}', 'Noto Sans KR', sans-serif` : "Pretendard, 'Noto Sans KR', sans-serif";
    const textAnchor = getLottieTextAnchorPointInComp(layer, data);
    const [txtSx] = getScaleFactors(layer);
    const textAlign = lottieJustifyToAlign(doc.j);
    const textWidth = measureCanvasTextWidth(String(doc.t || '').replace(/\r/g, ''), fontFamily, Number(doc.s || 72) * txtSx, '700', Number(doc.tr || 0));
    const timing = getLayerTimingSec(layer, data);
    const bindingKey = `__main__::${layer.nm || ''}`;
    const nearestImage = imageLayers.map(imgLayer => {
      const asset = assetMap.get(imgLayer.refId);
      if (!asset?.p) return null;
      const bbox = boundsMap[imgLayer.refId] || { x: 0, y: 0, w: Number(asset?.w || 1), h: Number(asset?.h || 1) };
      const pos = readTransformValueForLayout(imgLayer?.ks?.p, [0, 0, 0], data);
      const anc = readTransformValueForLayout(imgLayer?.ks?.a, [0, 0, 0], data);
      const [sxPct, syPct] = getLayerScalePairForLayout(imgLayer, data);
      const scaleX = Number(sxPct || 100) / 100;
      const scaleY = Number(syPct || 100) / 100;
      const imageTiming = getLayerTimingSec(imgLayer, data);
      const left = Number(pos?.[0] || 0) - Number(anc?.[0] || 0) * scaleX + Number(bbox.x || 0) * scaleX;
      const top = Number(pos?.[1] || 0) - Number(anc?.[1] || 0) * scaleY + Number(bbox.y || 0) * scaleY;
      const width = Math.max(1, Number(bbox.w || asset?.w || 1) * scaleX);
      const height = Math.max(1, Number(bbox.h || asset?.h || 1) * scaleY);
      const cx = left + width / 2;
      const cy = top + height / 2;
      const overlap = Math.max(0, Math.min(timing.op, imageTiming.op) - Math.max(timing.ip, imageTiming.ip));
      const timingPenalty = Math.abs(timing.ip - imageTiming.ip) + Math.abs(timing.op - imageTiming.op) - overlap * 3;
      const anchorX = Number(textAnchor.x || 0);
      const anchorY = Number(textAnchor.y || 0);
      const expandedPadX = Math.max(16, width * 0.08);
      const expandedPadY = Math.max(8, height * 0.35);
      const anchorInside = anchorX >= left - expandedPadX && anchorX <= left + width + expandedPadX && anchorY >= top - expandedPadY && anchorY <= top + height + expandedPadY;
      const verticalGap = anchorY < top ? top - anchorY : anchorY > top + height ? anchorY - (top + height) : 0;
      const horizontalGap = anchorX < left ? left - anchorX : anchorX > left + width ? anchorX - (left + width) : 0;
      const centerDistance = Math.abs(anchorY - cy) + Math.abs(anchorX - cx) * 0.12;
      const containmentBonus = anchorInside ? -100000 : 0;
      const spatialPenalty = verticalGap * 8 + horizontalGap * 0.7 + centerDistance;
      return {
        imgLayer,
        asset,
        bbox,
        left,
        top,
        width,
        height,
        cx,
        cy,
        scaleOriginXInBar: Number(pos?.[0] || 0) - left,
        scaleOriginYInBar: Number(pos?.[1] || 0) - top,
        score: containmentBonus + timingPenalty * 1000 + spatialPenalty,
      };
    }).filter(Boolean).sort((a, b) => a.score - b.score)[0];
    if (!nearestImage?.asset?.p) return null;
    const relatedImageLayerIndices = imageLayers.filter(candidateLayer => {
      const candidateAsset = assetMap.get(candidateLayer.refId);
      if (!candidateAsset || candidateLayer.refId !== nearestImage.imgLayer.refId) return false;
      const candidateBbox = boundsMap[candidateLayer.refId] || { x: 0, y: 0, w: Number(candidateAsset?.w || 1), h: Number(candidateAsset?.h || 1) };
      const candidatePos = readTransformValueForLayout(candidateLayer?.ks?.p, [0, 0, 0], data);
      const candidateAnc = readTransformValueForLayout(candidateLayer?.ks?.a, [0, 0, 0], data);
      const [candidateSxPct, candidateSyPct] = getLayerScalePairForLayout(candidateLayer, data);
      const candidateScaleX = Number(candidateSxPct || 100) / 100;
      const candidateScaleY = Number(candidateSyPct || 100) / 100;
      const candidateLeft = Number(candidatePos?.[0] || 0) - Number(candidateAnc?.[0] || 0) * candidateScaleX + Number(candidateBbox.x || 0) * candidateScaleX;
      const candidateTop = Number(candidatePos?.[1] || 0) - Number(candidateAnc?.[1] || 0) * candidateScaleY + Number(candidateBbox.y || 0) * candidateScaleY;
      const candidateWidth = Math.max(1, Number(candidateBbox.w || candidateAsset?.w || 1) * candidateScaleX);
      const candidateHeight = Math.max(1, Number(candidateBbox.h || candidateAsset?.h || 1) * candidateScaleY);
      return Math.abs(candidateLeft - nearestImage.left) < 1 && Math.abs(candidateTop - nearestImage.top) < 1 && Math.abs(candidateWidth - nearestImage.width) < 1 && Math.abs(candidateHeight - nearestImage.height) < 1;
    }).map(candidateLayer => (data?.layers || []).indexOf(candidateLayer));
    const baseWidth = Number(nearestImage.width || 1);
    const baseHeight = Number(nearestImage.height || 1);
    const textXInBar = Number(textAnchor.x || 0) - Number(nearestImage.left || 0);
    const textYInBar = Number(textAnchor.y || 0) - Number(nearestImage.top || 0);
    const textLeft = textAlign === 'right' ? textXInBar - textWidth : textAlign === 'center' ? textXInBar - textWidth / 2 : textXInBar;
    const textRight = textAlign === 'right' ? textXInBar : textAlign === 'center' ? textXInBar + textWidth / 2 : textXInBar + textWidth;
    const measuredPad = Math.min(Math.max(0, textLeft), Math.max(0, baseWidth - textRight));
    const paddingX = Math.max(24, Math.min(72, measuredPad || baseWidth * 0.08));
    return {
      bindingKey,
      label: layer.nm || '',
      textLayerIndex: (data?.layers || []).indexOf(layer),
      imageLayerIndex: (data?.layers || []).indexOf(nearestImage.imgLayer),
      relatedImageLayerIndices,
      imageSrc: nearestImage.asset.p,
      sourceCrop: nearestImage.bbox,
      left: nearestImage.left,
      top: nearestImage.top,
      baseWidth,
      baseHeight,
      centerX: nearestImage.cx,
      centerY: nearestImage.cy,
      scaleOriginXInBar: nearestImage.scaleOriginXInBar,
      scaleOriginYInBar: nearestImage.scaleOriginYInBar,
      textXInBar,
      textYInBar,
      fontFamily,
      fontSize: Number(doc.s || 72) * txtSx,
      textAlign,
      textY: Number(textAnchor.y || 0),
      textOpacity: getLayerOpacityKeyframesSec(layer, data),
      imageOpacity: getLayerOpacityKeyframesSec(nearestImage.imgLayer, data),
      imageScaleX: getLayerXScaleKeyframesSec(nearestImage.imgLayer, data),
      imageOpacityTracks: relatedImageLayerIndices.map(idx => getLayerOpacityKeyframesSec((data?.layers || [])[idx], data)).filter(Boolean),
      imageScaleXTracks: relatedImageLayerIndices.map(idx => getLayerXScaleKeyframesSec((data?.layers || [])[idx], data)).filter(Boolean),
      textTint: getTintEffectModel(layer, data),
      imageTint: getTintEffectModel(nearestImage.imgLayer, data) || relatedImageLayerIndices.map(idx => getTintEffectModel((data?.layers || [])[idx], data)).find(Boolean) || null,
      textZ: Math.max(1, ((data?.layers || []).length - (data?.layers || []).indexOf(layer)) * 10 + 2),
      imageZ: Math.max(1, ((data?.layers || []).length - (data?.layers || []).indexOf(nearestImage.imgLayer)) * 10 + 1),
      paddingX,
      baseText: String(doc.t || '').replace(/\r/g, ''),
      strokeWidth: (Number(doc.sw || 0) <= 1 ? 0 : Number(doc.sw || 0)) * txtSx,
      color: lottieColorToHex(doc.fc || [1, 1, 1]),
      strokeColor: lottieColorToHex(doc.sc || [0, 0, 0]),
    };
  }).filter(Boolean);
  if (!pairs.length) return null;
  return { w: dims.w, h: dims.h, pairs };
};

const computeVectorSubtitleMetrics = (model, field = {}) => {
  const text = String(field?.value || '');
  const fontFamily = field?.fontFamily || model?.fontFamily || "Pretendard, 'Noto Sans KR', sans-serif";
  const baseHeight = Number(model?.baseBarHeight || 30);
  const fontSize = Math.min(Number(field?.fontSize || model?.fontSize || 28), baseHeight * 0.82);
  const barHeight = baseHeight;
  const textWidth = measureCanvasTextWidth(text, fontFamily, fontSize, field?.fontWeight || '700', field?.letterSpacing || 0);
  const paddingX = Math.max(24, Number(model?.paddingX || 32));
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

const getTemplateContentBounds = (template, fields = []) => {
  const sourceW = Math.max(1, Number(template?.templateW || template?.lottieData?.w || template?.webDef?.w || 1000));
  const sourceH = Math.max(1, Number(template?.templateH || template?.lottieData?.h || template?.webDef?.h || 170));
  const fallback = { x: 0, y: 0, w: sourceW, h: sourceH, sourceW, sourceH };
  const normalize = bounds => {
    if (!bounds) return fallback;
    const bw = Math.max(1, Number(bounds.w || bounds.width || sourceW));
    const bh = Math.max(1, Number(bounds.h || bounds.height || sourceH));
    return {
      x: Number.isFinite(Number(bounds.x)) ? Number(bounds.x) : 0,
      y: Number.isFinite(Number(bounds.y)) ? Number(bounds.y) : 0,
      w: bw,
      h: bh,
      sourceW: Math.max(1, Number(bounds.sourceW || sourceW)),
      sourceH: Math.max(1, Number(bounds.sourceH || sourceH)),
    };
  };

  if (template?.cropBounds) return normalize(template.cropBounds);
  if (template?.lottieData) return normalize(computeLottieVisibleBounds(template.lottieData));
  return fallback;
};
const getLottieFillEffectColor = (layer) => {
  const fillEffect = (layer?.ef || []).find(e => e?.mn === "ADBE Fill");
  if (!fillEffect) return null;
  const colorParam = (fillEffect.ef || []).find(p => p?.mn === "ADBE Fill-0002" || p?.nm === "Color");
  const val = colorParam?.v?.k;
  if (!val) return null;
  if (Array.isArray(val)) {
    if (typeof val[0] === "number") {
      return val.slice(0, 3);
    } else if (val[0] && typeof val[0] === "object" && Array.isArray(val[0].s)) {
      return val[0].s.slice(0, 3);
    }
  }
  return null;
};

const setLottieFillEffectColor = (layer, colorHex) => {
  const fillEffect = (layer?.ef || []).find(e => e?.mn === "ADBE Fill");
  if (!fillEffect) return;
  const colorParam = (fillEffect.ef || []).find(p => p?.mn === "ADBE Fill-0002" || p?.nm === "Color");
  if (!colorParam?.v) return;
  const rgb = hexToLottieColor(colorHex);
  const val = colorParam.v.k;
  if (Array.isArray(val)) {
    if (typeof val[0] === "number") {
      const alpha = val[3] !== undefined ? val[3] : 1;
      colorParam.v.k = [rgb[0], rgb[1], rgb[2], alpha];
    } else {
      colorParam.v.k = val.map(kf => {
        if (kf && typeof kf === "object") {
          if (Array.isArray(kf.s)) {
            const alpha = kf.s[3] !== undefined ? kf.s[3] : 1;
            kf.s = [rgb[0], rgb[1], rgb[2], alpha];
          }
          if (Array.isArray(kf.e)) {
            const alpha = kf.e[3] !== undefined ? kf.e[3] : 1;
            kf.e = [rgb[0], rgb[1], rgb[2], alpha];
          }
        }
        return kf;
      });
    }
  }
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
      const fillEffColor = getLottieFillEffectColor(layer);
      const box = estimateTextLayerBounds(layer, data, charMap);
      const fontMeta = fontMap.get(doc.f || "") || {};
        const layoutScl = getLayerScalePairForLayout(layer, data);
        const sx = Number(layoutScl?.[0] || 100) / 100;
        const sy = Number(layoutScl?.[1] || 100) / 100;
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
          sourceScaleX: sx,
          sourceScaleY: sy,
          fontSize: Math.round(Number(doc.s || 72) * sx),
          color: lottieColorToHex(fillEffColor || doc.fc || [1, 1, 1]),
          strokeColor: lottieColorToHex(doc.sc || [0, 0, 0]),
          strokeWidth: Number(doc.sw || 0) <= 1 ? 0 : Number(doc.sw || 0) * sx,
          textAlign: lottieJustifyToAlign(doc.j),
          strokeMode: doc.of ? "center" : "outside",
          lineHeight: Math.round(Number(doc.lh || doc.s || 72) * sy),
          animOpacity: getLayerOpacityKeyframesSec(layer, data),
          x: (Number(readTransformValueForLayout(layer?.ks?.p, [0, 0, 0], data)?.[0] || 0) / sourceW) * 100,
          // Y uses raw position percentage - the overlay places text at this % with dominantBaseline="middle"
          y: (Number(readTransformValueForLayout(layer?.ks?.p, [0, 0, 0], data)?.[1] || 0) / sourceH) * 100,
        kf: {
          x: (layer?.ks?.p?.k || []).filter(kf => typeof kf.t !== 'undefined' && Array.isArray(kf.s)).map(kf => ({ t: kf.t / (data.fr || 30), v: (kf.s[0] / sourceW) * 100 })),
          y: (layer?.ks?.p?.k || []).filter(kf => typeof kf.t !== 'undefined' && Array.isArray(kf.s)).map(kf => ({ t: kf.t / (data.fr || 30), v: (kf.s[1] / sourceH) * 100 })),
        },
        w: 100,
        h: 100,
        useCropAnchor: true,
        boxHint: box,
      });
    });
  };
  visit(data?.layers, "__main__");
  (data?.assets || []).forEach((asset, index) => visit(asset?.layers, asset?.id || `asset_${index}`));

  // Sort detected fields so that "Main" comes before "Sub"
  detected.sort((a, b) => {
    const aMain = /Main/i.test(a.label);
    const bMain = /Main/i.test(b.label);
    if (aMain && !bMain) return -1;
    if (!aMain && bMain) return 1;
    const aSub = /Sub/i.test(a.label);
    const bSub = /Sub/i.test(b.label);
    if (aSub && !bSub) return 1;
    if (!aSub && bSub) return -1;
    return a.order - b.order;
  });
  
  // Update order property after sorting so that the UI respects this order
  detected.forEach((f, idx) => f.order = idx);
  // Re-assign order based on the new sort
  detected.forEach((f, i) => { f.order = i; });

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

const applyLottieTextFields = (sourceData, fields = [], options = {}) => {
  if (!sourceData) return null;
  const glyphChars = getGlyphChars(sourceData);
  const bindingMap = new Map((fields || []).filter(f => f.bindingKey).map(f => [f.bindingKey, f]));

  const cloned = JSON.parse(JSON.stringify(sourceData));
  const applyToLayers = (layers, scope) => {
    if (!Array.isArray(layers)) return;
    layers.forEach(layer => {
      if (layer?.ty !== 5 || !Array.isArray(layer?.t?.d?.k)) return;
      const layerName = layer.nm || "";
      const bindingKey = `${scope}::${layerName}`;
      if (!bindingMap.has(bindingKey)) return;
      const field = bindingMap.get(bindingKey);
      const useOverlay = typeof field?.useOverlay === "boolean" ? field.useOverlay : shouldUseOverlayForField(field, glyphChars);
      layer.t.d.k = layer.t.d.k.map(kf => {
        if (kf?.s && typeof kf.s === "object") {
          if (useOverlay) {
            kf.s.t = "";
          } else {
            kf.s.t = field.value ?? "";
            if (field.fontKey) kf.s.f = field.fontKey;
            if (field.fontSize) kf.s.s = Number(field.fontSize) / Math.max(0.0001, Number(field.sourceScaleX || 1));
            if (field.color) {
              kf.s.fc = hexToLottieColor(field.color);
              setLottieFillEffectColor(layer, field.color);
            }
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

  if (bindingMap.size) {
    applyToLayers(cloned.layers, "__main__");
    (cloned.assets || []).forEach((asset, index) => applyToLayers(asset?.layers, asset?.id || `asset_${index}`));
  }
  const customHide = options.applyCustomHide === false ? null : (sourceData?.__customHide || null);
  const hideNativeLayer = idx => {
    const layer = cloned?.layers?.[idx];
    if (!layer) return;
    layer.ks = layer.ks || {};
    layer.ks.o = { a: 0, k: 0, ix: 11 };
    if (layer.ty === 5 && Array.isArray(layer?.t?.d?.k)) {
      layer.t.d.k = layer.t.d.k.map(kf => {
        if (kf?.s && typeof kf.s === "object") kf.s.t = "";
        return kf;
      });
    }
  };
  if (customHide?.imageLayerIndices?.length) customHide.imageLayerIndices.forEach(hideNativeLayer);
  if (customHide?.textLayerIndices?.length) customHide.textLayerIndices.forEach(hideNativeLayer);
  autoFitLottieBackground(cloned, sourceData, fields);

  // After applying text, check if any text layer contains characters not in chars.
  // If so, delete chars entirely so lottie-web uses consistent browser font rendering
  // instead of mixed glyph+fallback rendering which causes baseline misalignment.
  if (cloned.chars && cloned.chars.length > 0) {
    const charSet = new Set(cloned.chars.map(c => c.ch).filter(Boolean));
    let needsCharsDeletion = false;
    const checkLayers = (layers) => {
      if (!Array.isArray(layers) || needsCharsDeletion) return;
      layers.forEach(layer => {
        if (needsCharsDeletion) return;
        if (layer?.ty === 5 && Array.isArray(layer?.t?.d?.k)) {
          layer.t.d.k.forEach(kf => {
            if (needsCharsDeletion) return;
            const text = kf?.s?.t || "";
            for (const ch of text) {
              if (ch === "\n" || ch === "\r" || ch === " ") continue;
              if (!charSet.has(ch)) {
                needsCharsDeletion = true;
                return;
              }
            }
          });
        }
      });
    };
    checkLayers(cloned.layers);
    if (!needsCharsDeletion) {
      (cloned.assets || []).forEach(asset => checkLayers(asset?.layers));
    }
    if (needsCharsDeletion) {
      delete cloned.chars;
    }
  }

  return cloned;
};

// ── SVG Template Renderer ─────────────────────────────────────────────────────
function AETemplateSVG({ compName, fields = [], fontFamily = "sans-serif", webDef = null }) {
  const def = webDef || AE_TEMPLATES[compName];
  if (!def) return (
    <div style={{ width: "100%", height: "100%", background: "rgba(34,197,94,0.08)", border: "1px dashed rgba(34,197,94,0.4)", display: "flex", alignItems: "center", justifyContent: "center", color: "#22c55e", fontSize: 11 }}>
      템플릿 (웹 정의 미등록)
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

const renderHighlightedText = (text, highlightText, highlightColor) => {
  if (!text) return ' ';
  if (!highlightText || !text.includes(highlightText)) return text;
  const parts = text.split(highlightText);
  return (
    <>
      {parts.map((part, i) => (
        <React.Fragment key={i}>
          {i > 0 && <tspan fill={highlightColor}>{highlightText}</tspan>}
          {part && <tspan>{part}</tspan>}
        </React.Fragment>
      ))}
    </>
  );
};

function VectorSubtitleTemplate({ model, fields = [], time = 999, selected = false }) {
  const field = fields?.[0] || {};
  const { text, fontFamily, fontSize, barWidth, barHeight, paddingX } = computeVectorSubtitleMetrics(model, field);
  const strokeWidth = Number(field?.strokeWidth ?? model?.strokeWidth ?? 0);
  const textAlign = field?.textAlign || model?.textAlign || 'center';
  const textAnchor = textAlign === 'left' ? 'start' : textAlign === 'right' ? 'end' : 'middle';
  const reveal = model?.barAnimEnd > model?.barAnimStart ? clamp((time - model.barAnimStart) / Math.max(0.001, model.barAnimEnd - model.barAnimStart), 0, 1) : 1;
  const textOpacity = model?.textAnimEnd > model?.textAnimStart ? clamp((time - model.textAnimStart) / Math.max(0.001, model.textAnimEnd - model.textAnimStart), 0, 1) : 1;
  const textX = textAlign === 'left' ? paddingX : textAlign === 'right' ? barWidth - paddingX : barWidth / 2;
  const hasAeCoords = model?.textY !== undefined;
  const textY = hasAeCoords ? Number(model.textY) : barHeight / 2;
  const dominantBaseline = hasAeCoords ? 'alphabetic' : 'middle';

  const [imgMeta, setImgMeta] = useState(null);
  useEffect(() => {
    if (!model?.imageSrc) return;
    const img = new Image();
    img.onload = () => {
      setImgMeta({ width: img.width, height: img.height, src: model.imageSrc });
    };
    img.src = model.imageSrc;
  }, [model?.imageSrc]);

  let bgEls = null;
  if (imgMeta) {
    const srcW = imgMeta.width;
    const srcH = imgMeta.height;
    const capSrc = Math.min(Math.round(srcW * 0.18), Math.floor(srcW * 0.3));
    const leftW = Math.min(Math.max(1, Math.round(barWidth * (capSrc / srcW))), Math.floor(barWidth / 3));
    const rightW = leftW;
    const centerSrcW = Math.max(1, srcW - capSrc * 2);
    const centerDestW = Math.max(1, barWidth - leftW - rightW);
    const sourceBleed = Math.min(2, capSrc - 1, centerSrcW / 2);

    bgEls = (
      <g transform={`translate(${barWidth / 2} ${barHeight / 2}) scale(${reveal} 1) translate(${-barWidth / 2} ${-barHeight / 2})`}>
        <svg x={0} y={0} width={leftW} height={barHeight} viewBox={`0 0 ${capSrc + sourceBleed} ${srcH}`} preserveAspectRatio="none">
          <image href={imgMeta.src} x={0} y={0} width={srcW} height={srcH} preserveAspectRatio="none" />
        </svg>
        <svg x={leftW} y={0} width={centerDestW} height={barHeight} viewBox={`${capSrc - sourceBleed} 0 ${centerSrcW + sourceBleed * 2} ${srcH}`} preserveAspectRatio="none">
          <image href={imgMeta.src} x={0} y={0} width={srcW} height={srcH} preserveAspectRatio="none" />
        </svg>
        <svg x={leftW + centerDestW} y={0} width={rightW} height={barHeight} viewBox={`${srcW - capSrc - sourceBleed} 0 ${capSrc + sourceBleed} ${srcH}`} preserveAspectRatio="none">
          <image href={imgMeta.src} x={0} y={0} width={srcW} height={srcH} preserveAspectRatio="none" />
        </svg>
      </g>
    );
  }

  return (
    <svg viewBox={`0 0 ${barWidth} ${barHeight}`} style={{ width: '100%', height: '100%', overflow: 'visible' }} preserveAspectRatio="none">
      {bgEls}
      <text x={textX} y={textY} textAnchor={textAnchor} dominantBaseline={dominantBaseline} fill={field?.color || '#ffffff'} stroke={field?.strokeColor || '#0a4a4d'} strokeWidth={strokeWidth} paintOrder="stroke fill" fontSize={fontSize} fontWeight={field?.fontWeight || '700'} fontFamily={fontFamily} opacity={textOpacity}>
        {renderHighlightedText(text, field?.highlightText, field?.highlightColor || '#ffea00')}
      </text>
    </svg>
  );
}

function MultiPngTitlePair({ pair, field, model, time = 0, drawBackground = true }) {
  const fontFamily = field?.fontFamily || pair.fontFamily || "Pretendard, 'Noto Sans KR', sans-serif";
  const fontSize = Number(field?.fontSize || pair.fontSize || 48);
  const text = String(field?.value ?? pair.baseText ?? '');
  const textAlign = field?.textAlign || pair.textAlign || 'center';
  const textAnchor = textAlign === 'left' ? 'start' : textAlign === 'right' ? 'end' : 'middle';
  const textWidth = measureCanvasTextWidth(text, fontFamily, fontSize, field?.fontWeight || '700', Number(field?.letterSpacing || 0));
  const baseWidth = Math.max(1, Number(pair.baseWidth || 1));
  const barHeight = Math.max(1, Number(pair.baseHeight || 1));
  const baseLeft = Number(pair.left ?? (Number(pair.centerX || model.w / 2) - baseWidth / 2));
  const baseTop = Number(pair.top ?? (Number(pair.centerY || model.h / 2) - barHeight / 2));
  const baseTextX = Number(pair.textXInBar ?? baseWidth / 2);
  const hasAeCoords = pair.textYInBar !== undefined;
  const textY = hasAeCoords ? Number(pair.textYInBar) : barHeight / 2;
  const dominantBaseline = hasAeCoords ? 'alphabetic' : 'middle';
  const paddingX = Math.max(1, Number(field?.paddingX ?? pair.paddingX ?? 32));
  const textLeft = textAlign === 'right' ? baseTextX - textWidth : textAlign === 'center' ? baseTextX - textWidth / 2 : baseTextX;
  const textRight = textAlign === 'right' ? baseTextX : textAlign === 'center' ? baseTextX + textWidth / 2 : baseTextX + textWidth;
  const extraLeft = Math.max(0, paddingX - textLeft);
  const extraRight = Math.max(0, paddingX - (baseWidth - textRight));
  const barWidth = Math.max(baseWidth + extraLeft + extraRight, textWidth + paddingX * 2);
  const leftComp = baseLeft - extraLeft;
  const topComp = baseTop;
  const left = (leftComp / Math.max(1, model.w)) * 100;
  const top = (topComp / Math.max(1, model.h)) * 100;
  const widthPct = (barWidth / Math.max(1, model.w)) * 100;
  const heightPct = (barHeight / Math.max(1, model.h)) * 100;
  const textOpacity = Array.isArray(pair.textOpacity) ? clamp(lerp(pair.textOpacity, time, pair.textOpacity[pair.textOpacity.length - 1]?.v ?? 1), 0, 1) : 1;
  const resolveTrack = (track, fallback = 1) => Array.isArray(track) ? clamp(lerp(track, time, track[track.length - 1]?.v ?? fallback), 0, 1) : fallback;
  const imageOpacityTracks = Array.isArray(pair.imageOpacityTracks) && pair.imageOpacityTracks.length ? pair.imageOpacityTracks : [pair.imageOpacity];
  const imageScaleXTracks = Array.isArray(pair.imageScaleXTracks) && pair.imageScaleXTracks.length ? pair.imageScaleXTracks : [pair.imageScaleX];
  // 같은 위치에 같은 PNG가 여러 레이어로 겹친 Bodymovin 구조에서는 일부 레이어가 페이드아웃되어도
  // 다른 레이어가 계속 보이는 경우가 있다. 원본 레이어들을 숨기고 웹에서 3분할로 다시 그릴 때는
  // 이 중 가장 보이는 레이어 값을 사용해야 배경이 중간에 사라지지 않는다.
  const imageOpacity = Math.max(...imageOpacityTracks.map(track => resolveTrack(track, 1)), 0);
  const imageScaleX = Math.max(...imageScaleXTracks.map(track => resolveTrack(track, 1)), 0);
  const tintFilterId = useMemo(() => `png-tint-${uid()}`, []);
  const imageTintMatrix = buildTintMatrixValues(pair.imageTint, time);
  const textFill = applyTintToHex(field?.color || pair.color || '#ffffff', pair.textTint, time);
  const textStroke = applyTintToHex(field?.strokeColor || pair.strokeColor || '#000000', pair.textTint, time);

  const [imgMeta, setImgMeta] = useState(null);
  useEffect(() => {
    if (!pair?.imageSrc) return;
    const img = new Image();
    img.onload = () => {
      setImgMeta({ width: img.width, height: img.height, src: pair.imageSrc });
    };
    img.src = pair.imageSrc;
  }, [pair?.imageSrc]);

  let bgEls = null;
  if (imgMeta) {
    const crop = pair.sourceCrop || { x: 0, y: 0, w: imgMeta.width, h: imgMeta.height };
    const srcW = Math.max(1, Number(crop.w || imgMeta.width));
    const srcH = Math.max(1, Number(crop.h || imgMeta.height));
    const srcX = Number(crop.x || 0);
    const srcY = Number(crop.y || 0);
    const scaleX = baseWidth / Math.max(1, srcW);
    const capSrc = Math.max(1, Math.min(Math.round(srcW * 0.18), Math.floor(srcW * 0.3), Math.floor((srcW - 1) / 2)));
    const leftW = Math.max(1, Math.min(barWidth / 2 - 1, capSrc * scaleX));
    const rightW = leftW;
    const centerSrcW = Math.max(1, srcW - capSrc * 2);
    const centerDestW = Math.max(1, barWidth - leftW - rightW);
    const sourceBleed = Math.min(2, capSrc - 1, centerSrcW / 2);
    const originX = Number(pair.scaleOriginXInBar ?? baseWidth / 2) + extraLeft;
    const originY = Number(pair.scaleOriginYInBar ?? barHeight / 2);

    bgEls = (
      <g opacity={imageOpacity} filter={imageTintMatrix ? `url(#${tintFilterId})` : undefined} transform={`translate(${originX} ${originY}) scale(${imageScaleX} 1) translate(${-originX} ${-originY})`}>
        <svg x={0} y={0} width={leftW} height={barHeight} viewBox={`${srcX} ${srcY} ${capSrc + sourceBleed} ${srcH}`} preserveAspectRatio="none">
          <image href={imgMeta.src} x={0} y={0} width={imgMeta.width} height={imgMeta.height} preserveAspectRatio="none" />
        </svg>
        <svg x={leftW} y={0} width={centerDestW} height={barHeight} viewBox={`${srcX + capSrc - sourceBleed} ${srcY} ${centerSrcW + sourceBleed * 2} ${srcH}`} preserveAspectRatio="none">
          <image href={imgMeta.src} x={0} y={0} width={imgMeta.width} height={imgMeta.height} preserveAspectRatio="none" />
        </svg>
        <svg x={leftW + centerDestW} y={0} width={rightW} height={barHeight} viewBox={`${srcX + srcW - capSrc - sourceBleed} ${srcY} ${capSrc + sourceBleed} ${srcH}`} preserveAspectRatio="none">
          <image href={imgMeta.src} x={0} y={0} width={imgMeta.width} height={imgMeta.height} preserveAspectRatio="none" />
        </svg>
      </g>
    );
  }

  const textX = baseTextX + extraLeft;

  return (
    <div style={{ position: 'absolute', left: `${left}%`, top: `${top}%`, width: `${widthPct}%`, height: `${heightPct}%`, overflow: 'visible', pointerEvents: 'none', zIndex: Number(pair.textZ || pair.imageZ || 1) }}>
      <svg viewBox={`0 0 ${barWidth} ${barHeight}`} style={{ position: 'absolute', inset: 0, overflow: 'visible' }} preserveAspectRatio='none'>
        {drawBackground && imageTintMatrix && (
          <defs>
            <filter id={tintFilterId} colorInterpolationFilters='sRGB'>
              <feColorMatrix type='matrix' values={imageTintMatrix} />
            </filter>
          </defs>
        )}
        {drawBackground && bgEls}
        <text x={textX} y={textY} textAnchor={textAnchor} dominantBaseline={dominantBaseline} fill={textFill} stroke={textStroke} strokeWidth={Math.max(0, Number(field?.strokeWidth ?? pair.strokeWidth ?? 0))} paintOrder='stroke fill' fontSize={fontSize} fontWeight={field?.fontWeight || '700'} fontFamily={fontFamily} opacity={textOpacity}>
          {renderHighlightedText(text, field?.highlightText || pair.highlightText, applyTintToHex(field?.highlightColor || pair.highlightColor || '#ffea00', pair.textTint, time))}
        </text>
      </svg>
    </div>
  );
}

function MultiPngTitleTemplate({ model, fields = [], time = 0 }) {
  const fieldMap = new Map((fields || []).map(f => [f.bindingKey, f]));
  const seenImages = new Set();
  return (
    <div style={{ position: 'absolute', inset: 0, overflow: 'visible', pointerEvents: 'none' }}>
      {(model?.pairs || []).map(pair => {
        const drawBackground = !seenImages.has(pair.imageLayerIndex);
        seenImages.add(pair.imageLayerIndex);
        return <MultiPngTitlePair key={pair.bindingKey} pair={pair} field={fieldMap.get(pair.bindingKey)} model={model} time={time} drawBackground={drawBackground} />;
      })}
    </div>
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

      const clonedData = JSON.parse(JSON.stringify(animationData));

      localAnim = lottie.loadAnimation({
        container: hostRef.current,
        renderer: "svg",
        loop: mode === "loop",
        autoplay: mode === "loop",
        animationData: clonedData,
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
  return <div ref={hostRef} style={{ width: "100%", height: "100%", overflow: "visible" }} />;
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
      fontSize={`calc(${fontSize}px * var(--stage-scale, 1))`}
      fontWeight={field?.fontWeight || "700"}
      fontFamily={field?.fontFamily || "Pretendard, 'Noto Sans KR', sans-serif"}
      dominantBaseline="middle"
      transform={`translate(0 ${baselineShift})`}
      style={{ letterSpacing: `${Number(field?.letterSpacing || 0)}px` }}
      {...extraProps}
    >
      {lines.map((line, idx) => (
        <tspan key={idx} x={`${anchorX}%`} dy={idx === 0 ? 0 : fontSize * lineHeight}>
          {renderHighlightedText(line, field?.highlightText, field?.highlightColor || '#ffea00')}
        </tspan>
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
    <div style={{ position: "relative", width: "100%", height: "100%", overflow: "visible" }}>
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

  // Auto-compute the visible content bounding box to zoom/fit thumbnails for any template size
  const contentBounds = useMemo(() => {
    const fullW = template?.templateW || 1920;
    const fullH = template?.templateH || 1080;
    // vector_subtitle: the bar IS the content
    if (template?.templateKind === "vector_subtitle" && template?.vectorModel) {
      const field0 = normalizedFields?.[0] || {};
      const { barWidth, barHeight } = computeVectorSubtitleMetrics(template.vectorModel, field0);
      return { x: 0, y: 0, w: barWidth, h: barHeight, sourceW: barWidth, sourceH: barHeight, useDirectRender: true };
    }
    // multi_png_title: compute bounding box of all pairs (bars + text areas)
    if (template?.templateKind === "multi_png_title" && template?.multiTitleModel) {
      const pairs = template.multiTitleModel.pairs || [];
      if (pairs.length > 0) {
        const pad = 30;
        let minX = fullW, minY = fullH, maxX = 0, maxY = 0;
        pairs.forEach(p => {
          const l = Number(p.left ?? 0);
          const t = Number(p.top ?? 0);
          const bw = Number(p.baseWidth ?? 0);
          const bh = Number(p.baseHeight ?? 0);
          // Account for text that may extend beyond the bar image
          const fs = Number(p.fontSize ?? 48);
          const textH = fs * 1.2;
          const textCenterY = t + bh / 2;
          minX = Math.min(minX, l);
          minY = Math.min(minY, t, textCenterY - textH / 2);
          maxX = Math.max(maxX, l + bw);
          maxY = Math.max(maxY, t + bh, textCenterY + textH / 2);
        });
        minX = Math.max(0, minX - pad);
        minY = Math.max(0, minY - pad);
        maxX = Math.min(fullW, maxX + pad);
        maxY = Math.min(fullH, maxY + pad);
        const cropW = Math.max(1, maxX - minX);
        const cropH = Math.max(1, maxY - minY);
        return { x: minX, y: minY, w: cropW, h: cropH, sourceW: fullW, sourceH: fullH, useDirectRender: false };
      }
    }
    // Default: use full canvas
    return { x: 0, y: 0, w: fullW, h: fullH, sourceW: fullW, sourceH: fullH, useDirectRender: false };
  }, [template?.templateKind, template?.templateW, template?.templateH, template?.vectorModel, template?.multiTitleModel, normalizedFields]);

  const containerRef = useRef(null);
  const [dim, setDim] = useState({ w: 100, h: 100, scale: 0.1 });
  useEffect(() => {
    if (!containerRef.current) return;
    const obs = new ResizeObserver(entries => {
      for (let e of entries) {
        const cw = e.contentRect.width;
        const ch = e.contentRect.height;
        const s = Math.min(cw / contentBounds.w, ch / contentBounds.h);
        setDim({ w: contentBounds.w * s, h: contentBounds.h * s, scale: s });
      }
    });
    obs.observe(containerRef.current);
    return () => obs.disconnect();
  }, [contentBounds.w, contentBounds.h]);

  let content = null;
  if (template?.previewUrl) {
    content = <img src={template.previewUrl} alt={template.name || template.compName || "template"} style={{ width: "100%", height: "100%", objectFit: "contain", display: "block" }} />;
  } else if (contentBounds.useDirectRender && template?.templateKind === "vector_subtitle" && template?.vectorModel) {
    // VectorSubtitleTemplate renders its own SVG with viewBox matching bar dimensions
    content = <VectorSubtitleTemplate model={template.vectorModel} fields={normalizedFields} time={999} />;
  } else if (template?.templateKind === "multi_png_title" && template?.multiTitleModel) {
    // Use CroppedTemplateStage to zoom into the content area
    content = (
      <CroppedTemplateStage sourceW={contentBounds.sourceW} sourceH={contentBounds.sourceH} cropBounds={contentBounds}>
        <LottieTemplatePlayer animationData={resolvedLottieData} mode="scrub" progress={0.999} />
        <MultiPngTitleTemplate model={template.multiTitleModel} fields={normalizedFields} time={999} />
      </CroppedTemplateStage>
    );
  } else if (resolvedLottieData) {
    const overlayFields = normalizedFields.filter(field => field.useOverlay);
    content = (
      <CroppedTemplateStage sourceW={template?.templateW} sourceH={template?.templateH} cropBounds={template?.cropBounds}>
        <LottieTemplatePlayer animationData={resolvedLottieData} mode="scrub" progress={0.999} />
        {overlayFields.length > 0 && <TemplateTextOverlay fields={overlayFields} time={999} />}
      </CroppedTemplateStage>
    );
  } else {
    content = <AETemplateSVG compName={template?.compName} fields={normalizedFields} fontFamily={fontFamily} webDef={template?.webDef || null} />;
  }

  return (
    <div ref={containerRef} style={{ width: "100%", height: "100%", display: "flex", alignItems: "center", justifyContent: "center" }}>
      <div style={{ width: dim.w, height: dim.h, position: "relative", "--stage-scale": dim.scale }}>
        {content}
      </div>
    </div>
  );
}
// ── Graphic on Canvas ─────────────────────────────────────────────────────────
function GraphicEl({ g, time, renderZ = 1, selected, editing, onEdit, onEndEdit, onChange }) {
  const visible = time >= g.ts && time < g.ts + g.dur;
  if (!visible) return null;
  const localFromTemplateStart = time - Number(g.ts || 0);
  if (g.type === "ae_template" && g.templateKind === "multi_png_title" && localFromTemplateStart < 1 / 30) return null;
  const ct = time - g.ts + (g.startT || 0);
  const x = lerp(g.kf?.x, ct, g.x);
  const y = lerp(g.kf?.y, ct, g.y);
  const sc = lerp(g.kf?.scale, ct, g.scale);
  const op = lerp(g.kf?.opacity, ct, g.opacity);
  const rot = lerp(g.kf?.rotation, ct, g.rotation ?? 0);
  const base = {
    position: "absolute",
    left: `${x}%`, top: `${y}%`,
    width: `calc(${g.width}px * var(--stage-scale, 1))`,
    height: `calc(${g.height}px * var(--stage-scale, 1))`,
    opacity: op,
    transform: `translate(-50%,-50%) scale(${sc / 100}) rotate(${rot}deg)`,
    transformOrigin: "center center",
    pointerEvents: "none",
    outline: "none",
    overflow: "visible",
    zIndex: selected ? Math.max(1000, renderZ + 100) : renderZ,
  };
  if (g.type === "ae_template") {
    const templateDur = Math.max(0.1, Number(g.templateDuration || g.dur || 5));
    const progress = clamp(ct / templateDur, 0, 1);
    const normalizedFields = useMemo(() => (g.fields || []).map(field => ({
      ...field,
      useOverlay: shouldUseOverlayForField(field, g.glyphChars || []),
    })), [g.fields, g.glyphChars]);
    const resolvedLottieData = useMemo(() => applyLottieTextFields(g.lottieData, normalizedFields), [g.lottieData, normalizedFields]);
    const overlayFields = normalizedFields.filter(field => field.useOverlay);
    return (
      <div style={{ ...base }}>
        {g.templateKind === "vector_subtitle" && g.vectorModel ? (
          <VectorSubtitleTemplate model={g.vectorModel} fields={normalizedFields} time={ct} selected={selected} />
        ) : g.templateKind === "multi_png_title" && g.multiTitleModel ? (
          <CroppedTemplateStage sourceW={g.templateW} sourceH={g.templateH} cropBounds={g.cropBounds}>
            <LottieTemplatePlayer animationData={resolvedLottieData} progress={progress} />
            <MultiPngTitleTemplate model={g.multiTitleModel} fields={normalizedFields} time={ct} />
          </CroppedTemplateStage>
        ) : resolvedLottieData ? (
          <CroppedTemplateStage sourceW={g.templateW} sourceH={g.templateH} cropBounds={g.cropBounds}>
            <LottieTemplatePlayer animationData={resolvedLottieData} progress={progress} />
            {overlayFields.length > 0 && <TemplateTextOverlay fields={overlayFields} time={ct} />}
          </CroppedTemplateStage>
        ) : (
          <AETemplateSVG compName={g.compName} fields={normalizedFields} fontFamily={g.fontFamily} webDef={g.webDef || null} />
        )}
        {selected && (
          <div style={{ position: "absolute", top: -18, left: 0, background: "rgba(34,197,94,0.85)", color: "#000", fontSize: 9, fontWeight: 700, padding: "1px 6px", borderRadius: 3, whiteSpace: "nowrap" }}>
            {(g.templateKind === "vector_subtitle") ? "Vector Subtitle" : g.templateKind === "multi_png_title" ? "Title Template" : g.lottieData ? "Lottie Template" : "AE Template"} · {g.compName}
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
      <div style={{ ...base, color: g.color, fontSize: `calc(${g.fontSize}px * var(--stage-scale, 1))`, fontFamily: g.fontFamily || "sans-serif", fontWeight: g.fontWeight || "700", textAlign: g.textAlign || "center", display: "flex", alignItems: "center", justifyContent: g.textAlign === "left" ? "flex-start" : g.textAlign === "right" ? "flex-end" : "center", padding: "4px 8px", whiteSpace: "pre-wrap", wordBreak: "break-word", border: selected ? "1px solid #f97316" : "none" }}>
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
  const ct = time - g.ts + (g.startT || 0);
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
    <div style={{ position: "absolute", left: `${x}%`, top: `${y}%`, width: `calc(${g.width}px * var(--stage-scale, 1))`, height: `calc(${g.height}px * var(--stage-scale, 1))`, transform: `translate(-50%,-50%) scale(${sc / 100}) rotate(${rot}deg)`, transformOrigin: "center center", pointerEvents: "none", zIndex: 200 }}>
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
    <div style={{ position: "relative", width: "100%", height: 32, display: "flex", alignItems: "center", ...style }}>
      <input type="range" min={min} max={max} step={step} value={value}
        onChange={e => onChange(Number(e.target.value))}
        onMouseUp={onCommit} onTouchEnd={onCommit}
        style={{ 
          width: "100%", 
          appearance: "none", 
          background: "#1e1e20", 
          height: 8, 
          borderRadius: 4, 
          outline: "none", 
          cursor: "pointer",
          accentColor: "#f97316"
        }} 
      />
      <style>{`
        input[type=range]::-webkit-slider-thumb {
          appearance: none;
          width: 20px;
          height: 20px;
          background: #f97316;
          border-radius: 50%;
          cursor: pointer;
          border: 3px solid #000;
          box-shadow: 0 0 8px rgba(0,0,0,0.6);
          transition: transform 0.1s ease;
          margin-top: -6px; /* Center thumb on larger track */
        }
        input[type=range]::-webkit-slider-thumb:hover {
          transform: scale(1.15);
        }
        /* Firefox support */
        input[type=range]::-moz-range-thumb {
          width: 20px;
          height: 20px;
          background: #f97316;
          border-radius: 50%;
          cursor: pointer;
          border: 3px solid #000;
          box-shadow: 0 0 8px rgba(0,0,0,0.6);
        }
        input[type=range]::-moz-range-track {
          height: 8px;
          background: #1e1e20;
          border-radius: 4px;
        }
      `}</style>
    </div>
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
// ── ScrubbableNumberInput ──────────────────────────────────────────────────
function ScrubbableNumberInput({ value, min, max, step, onChange, onCommit, style = {} }) {
  const [isDragging, setIsDragging] = useState(false);
  const [isHovered, setIsHovered] = useState(false);
  const inputRef = useRef(null);
  
  // Track drag state
  const dragStart = useRef({ y: 0, val: 0, hasDragged: false });

  const handleMouseDown = (e) => {
    // Start scrubbing drag on mouse down
    dragStart.current = {
      y: e.clientY,
      val: value,
      hasDragged: false
    };

    const handleMouseMove = (moveEvent) => {
      const deltaY = dragStart.current.y - moveEvent.clientY;
      if (Math.abs(deltaY) > 3) {
        dragStart.current.hasDragged = true;
        setIsDragging(true);
      }

      if (dragStart.current.hasDragged) {
        moveEvent.preventDefault();
        // Shift speeds up (10x), Alt slows down (0.1x)
        let multiplier = 1;
        if (moveEvent.shiftKey) multiplier = 10;
        else if (moveEvent.altKey) multiplier = 0.1;

        const rawStep = step ?? 1;
        // 1px of drag changes the value by rawStep * multiplier
        const deltaValue = deltaY * rawStep * multiplier;
        const newValue = Math.min(max ?? Infinity, Math.max(min ?? -Infinity, dragStart.current.val + deltaValue));
        
        // Let's keep decimal precision tidy based on step
        const decimalPlaces = (rawStep.toString().split('.')[1] || '').length;
        const roundedValue = parseFloat(newValue.toFixed(decimalPlaces));
        onChange(roundedValue);
      }
    };

    const handleMouseUp = () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
      
      if (dragStart.current.hasDragged) {
        setIsDragging(false);
        if (onCommit) onCommit();
      } else {
        // Normal click: focus and select all text
        inputRef.current?.focus();
        inputRef.current?.select();
      }
    };

    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
  };

  const increment = (e) => {
    e.stopPropagation();
    e.preventDefault();
    const newValue = Math.min(max ?? Infinity, value + (step ?? 1));
    const decimalPlaces = ((step ?? 1).toString().split('.')[1] || '').length;
    onChange(parseFloat(newValue.toFixed(decimalPlaces)));
    if (onCommit) onCommit();
  };

  const decrement = (e) => {
    e.stopPropagation();
    e.preventDefault();
    const newValue = Math.max(min ?? -Infinity, value - (step ?? 1));
    const decimalPlaces = ((step ?? 1).toString().split('.')[1] || '').length;
    onChange(parseFloat(newValue.toFixed(decimalPlaces)));
    if (onCommit) onCommit();
  };

  return (
    <div 
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
      style={{ 
        position: "relative", 
        display: "inline-flex", 
        alignItems: "center",
        cursor: isDragging ? "ns-resize" : "ew-resize",
        ...style
      }}
    >
      <input
        ref={inputRef}
        type="number"
        value={value}
        min={min}
        max={max}
        step={step}
        onChange={e => onChange(Number(e.target.value))}
        onBlur={() => {
          onChange(Math.min(max ?? Infinity, Math.max(min ?? -Infinity, value)));
          if (onCommit) onCommit();
        }}
        onMouseDown={handleMouseDown}
        style={{
          width: "100%",
          height: "100%",
          background: "transparent",
          border: "none",
          color: "inherit",
          fontSize: "inherit",
          paddingRight: isHovered ? 20 : 8, // room for arrows on the right when hovered
          paddingLeft: 8,
          textAlign: "right",
          outline: "none",
          fontFamily: "monospace",
          fontWeight: "bold",
          cursor: isDragging ? "ns-resize" : "text",
          MozAppearance: "textfield" // hides Firefox spin buttons
        }}
      />
      {/* Custom premium styled spinner arrows on hover */}
      {isHovered && (
        <div style={{
          position: "absolute",
          right: 4,
          top: "50%",
          transform: "translateY(-50%)",
          display: "flex",
          flexDirection: "column",
          gap: 1,
          zIndex: 10,
          background: "rgba(39,39,42,0.95)",
          borderRadius: 3,
          padding: "1px 2px",
          border: "1px solid #52525b"
        }}>
          <button 
            onClick={increment}
            style={{ 
              background: "transparent", 
              border: "none", 
              color: "#f97316", 
              fontSize: 8, 
              padding: 0, 
              cursor: "pointer", 
              lineHeight: 1,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              height: 10,
              width: 12
            }}
          >
            ▲
          </button>
          <button 
            onClick={decrement}
            style={{ 
              background: "transparent", 
              border: "none", 
              color: "#f97316", 
              fontSize: 8, 
              padding: 0, 
              cursor: "pointer", 
              lineHeight: 1,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              height: 10,
              width: 12
            }}
          >
            ▼
          </button>
        </div>
      )}
    </div>
  );
}
// ── PropRow ───────────────────────────────────────────────────────────────────
function PropRow({ label, value, min, max, step, unit = "", onChange, onCommit }) {
  return (
    <div style={{ marginBottom: 12 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, marginBottom: 5 }}>
        <span style={{ fontSize: 13, color: "#a1a1aa", fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.08em" }}>{label}</span>
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <ScrubbableNumberInput 
            value={typeof value === "number" ? value : 0} 
            min={min} 
            max={max} 
            step={step}
            onChange={onChange}
            onCommit={onCommit}
            style={{ width: 80, height: 28, background: "#18181b", border: "1px solid #3f3f46", borderRadius: 4, color: "#fff", fontSize: 13 }} />
          <span style={{ fontSize: 11, color: "#71717a", fontFamily: "monospace" }}>{unit}</span>
        </div>
      </div>
      <Slider value={value} min={min} max={max} step={step} onChange={onChange} onCommit={onCommit} />
    </div>
  );
}
function AnimPropRow({ label, value, min, max, step, unit = "", onChange, onCommit, keyframed, onToggleKeyframe, onPrevKeyframe, onNextKeyframe }) {
  const icon = label.includes("위치 X") ? "↔" : label.includes("위치 Y") ? "↕" : label.includes("비율") ? "⛶" : label.includes("회전") ? "↺" : label.includes("불투명도") ? "◐" : "•";
  return (
    <div style={{ marginBottom: 16, background: "rgba(255,255,255,0.02)", padding: "12px 14px", borderRadius: 8, border: "1px solid rgba(255,255,255,0.05)" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, marginBottom: 10 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ fontSize: 16, color: "#f97316", opacity: 0.8 }}>{icon}</span>
          <span style={{ fontSize: 13, color: "#e4e4e7", fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.05em" }}>{label}</span>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 2 }}>
            {onPrevKeyframe && (
              <button onClick={onPrevKeyframe} title="이전 키프레임으로 이동" style={{ background: "transparent", color: "#a1a1aa", border: "none", cursor: "pointer", padding: "0 4px", fontSize: 12 }}>◀</button>
            )}
            <button onClick={onToggleKeyframe} 
              title={keyframed ? "현재 시간의 키프레임 삭제" : "현재 시간에 키프레임 추가"}
              style={{ 
                background: keyframed ? "#f97316" : "transparent", 
                color: keyframed ? "#000" : "#a1a1aa", 
                border: `1px solid ${keyframed ? "#f97316" : "#3f3f46"}`, 
                borderRadius: 6, 
                height: 26,
                padding: "0 8px", 
                display: "flex", 
                alignItems: "center", 
                justifyContent: "center",
                gap: 4,
                fontSize: 11, 
                fontWeight: 800,
                cursor: "pointer", 
                transition: "all 0.1s" 
              }}>
              {keyframed ? (
                <><span>◆</span><span>애니메이션 키</span></>
              ) : (
                <><span>◇</span><span>애니메이션 키</span></>
              )}
            </button>
            {onNextKeyframe && (
              <button onClick={onNextKeyframe} title="다음 키프레임으로 이동" style={{ background: "transparent", color: "#a1a1aa", border: "none", cursor: "pointer", padding: "0 4px", fontSize: 12 }}>▶</button>
            )}
          </div>
          <div style={{ position: "relative", display: "flex", alignItems: "center" }}>
            <ScrubbableNumberInput 
              value={typeof value === "number" ? value : 0} 
              min={min} 
              max={max} 
              step={step}
              onChange={onChange}
              onCommit={onCommit}
              style={{ 
                width: 68, 
                height: 30,
                background: "#000", 
                border: "1px solid #27272a", 
                borderRadius: 4, 
                color: "#f97316", 
                fontSize: 13, 
              }} 
            />
            <span style={{ marginLeft: 6, fontSize: 11, color: "#52525b", fontWeight: 700, width: 16 }}>{unit}</span>
          </div>
        </div>
      </div>
      <Slider value={value} min={min} max={max} step={step} onChange={onChange} onCommit={onCommit} />
    </div>
  );
}
// ── Main App ──────────────────────────────────────────────────────────────────
// ── DETAILED WAVEFORM RENDERER ──
const WaveformCache = new Map();

const DetailedWaveform = memo(({ url, color, opacity = 0.6 }) => {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const canvasRef = useRef(null);

  useEffect(() => {
    if (!url) return;
    if (WaveformCache.has(url)) {
      setData(WaveformCache.get(url));
      return;
    }

    setLoading(true);
    const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    
    fetch(url)
      .then(res => res.arrayBuffer())
      .then(ab => audioCtx.decodeAudioData(ab))
      .then(buffer => {
        const channelData = buffer.getChannelData(0);
        const samples = 1200; 
        const blockSize = Math.floor(channelData.length / samples);
        const points = new Float32Array(samples);
        
        let maxVal = 0;
        for (let i = 0; i < samples; i++) {
          let max = 0;
          const start = i * blockSize;
          for (let j = 0; j < blockSize; j++) {
            const val = Math.abs(channelData[start + j]);
            if (val > max) max = val;
          }
          points[i] = max;
          if (max > maxVal) maxVal = max;
        }
        
        const result = { points, peak: maxVal || 1 };
        WaveformCache.set(url, result);
        setData(result);
        setLoading(false);
      })
      .catch(() => {
        setLoading(false);
        setData({ points: new Float32Array(0), peak: 1 });
      });

    return () => {};
  }, [url]);

  useEffect(() => {
    if (!data || !canvasRef.current) return;
    const canvas = canvasRef.current;
    const ctx = canvas.getContext('2d');
    const w = canvas.width;
    const h = canvas.height;
    const centerY = h / 2;
    
    ctx.clearRect(0, 0, w, h);
    ctx.strokeStyle = color;
    ctx.lineWidth = 1;
    ctx.beginPath();
    
    const scale = (h * 0.45) / data.peak; 
    const points = data.points;
    const step = w / points.length;
    
    for (let i = 0; i < points.length; i++) {
      const x = i * step;
      const amp = points[i] * scale;
      ctx.moveTo(x, centerY - amp);
      ctx.lineTo(x, centerY + amp);
    }
    ctx.stroke();
  }, [data, color]);

  if (loading) return <div style={{ fontSize: 9, color, opacity: 0.5, paddingLeft: 10 }}>Analyzing Audio...</div>;
  if (!data || data.points.length === 0) return <div style={{ width: '100%', height: 1, background: 'rgba(255,255,255,0.1)' }} />;

  return (
    <canvas 
      ref={canvasRef}
      width={1000} 
      height={60} 
      style={{ width: '100%', height: '100%', opacity, pointerEvents: 'none' }}
    />
  );
});

export default function HMStudio() {
  // ── State ──────────────────────────────────────────────────────────────
  const [keyframeDrag, setKeyframeDrag] = useState<{ layerId: string, kind: string, prop: string, initialT: number, currentT: number, entries?: Array<{ prop: string, initialT: number, currentT: number }> } | null>(null);
  const [expandedLayers, setExpandedLayers] = useState<Set<string>>(new Set());
  const toggleLayerExpand = (id: string) => {
    const next = new Set(expandedLayers);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setExpandedLayers(next);
  };
  const [clips, setClips] = useState([]);
  const [mediaAssets, setMediaAssets] = useState([]);
  const [graphics, setGraphics] = useState([]);
  const [time, setTime] = useState(0);
  const [totalDur, setTotalDur] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [playRestartNonce, setPlayRestartNonce] = useState(0);
  const [selClipId, setSelClipId] = useState(null);
  const [selGfxId, setSelGfxId] = useState(null);
  const [selectedMediaAssetId, setSelectedMediaAssetId] = useState(null);
  const [selectedTimelineItems, setSelectedTimelineItems] = useState<Set<string>>(new Set());
  const [selectedKeyframes, setSelectedKeyframes] = useState<Set<string>>(new Set());
  const [keyframeSelectBox, setKeyframeSelectBox] = useState<any>(null);
  const suppressTimelineClickRef = useRef(false);
  const [copiedItem, setCopiedItem] = useState<{ kind: 'clip' | 'graphic', data: any } | null>(null);
  const makeTimelineKey = (kind: string, id: string) => `${kind}:${id}`;
  const makeAnimationKeyId = (layerId: string, prop: string, t: number) => `${layerId}:${prop}:${Number(t).toFixed(4)}`;
  const buildTimelineGroupTs = (keys: Set<string>) => {
    const groupTs: Record<string, number> = {};
    clips.forEach(c => {
      const key = makeTimelineKey('clip', c.id);
      if (keys.has(key)) groupTs[key] = Number(c.ts || 0);
    });
    graphics.forEach(g => {
      const key = makeTimelineKey('graphic', g.id);
      if (keys.has(key)) groupTs[key] = Number(g.ts || 0);
    });
    return groupTs;
  };
  const [editingGfxId, setEditingGfxId] = useState(null);
  const [tool, setTool] = useState("select"); // select | razor | text | rect | circle | ae
  const [zoom, setZoom] = useState(1);
  const [comp, setComp] = useState({ w: 3840, h: 2160, fps: 30, bg: "#000000" });
  
  const [leftPanelWidth, setLeftPanelWidth] = useState(280);
  const [rightPanelWidth, setRightPanelWidth] = useState(450);
  const [isResizingPanel, setIsResizingPanel] = useState<'left' | 'right' | null>(null);
  const [activeKeyframePopup, setActiveKeyframePopup] = useState<{ layerId: string, time: number, prop?: string } | null>(null);

  useEffect(() => {
    if (!activeKeyframePopup) return;
    
    const handleOutsideClick = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      if (target.closest('[data-keyframe-popup]')) {
        return;
      }
      setActiveKeyframePopup(null);
    };

    const timer = setTimeout(() => {
      window.addEventListener('click', handleOutsideClick);
    }, 0);

    return () => {
      clearTimeout(timer);
      window.removeEventListener('click', handleOutsideClick);
    };
  }, [activeKeyframePopup]);

  const [showAEPanel, setShowAEPanel] = useState(false);
  const [importedAE, setImportedAE] = useState([]);

  useEffect(() => {
    fetch('/api/templates')
      .then(res => res.json())
      .then(defaultTemplates => {
        if (!Array.isArray(defaultTemplates)) return;
        Promise.all(defaultTemplates.map(async (tmpl) => {
          try {
            const res = await fetch(tmpl.path);
        if (!res.ok) throw new Error('Network response was not ok');
        const lottieData = await res.json();
        
        const dims = getLottieDimensions(lottieData);
        const cropBounds = { x: 0, y: 0, w: dims.w, h: dims.h, sourceW: dims.w, sourceH: dims.h };
        const templateDuration = getLottieDuration(lottieData);
        const glyphChars = [...getGlyphChars(lottieData)];
        const assetAlphaBounds = await computeLottieAssetAlphaBounds(lottieData);
        lottieData.__assetAlphaBounds = assetAlphaBounds;
        const vectorModel = extractVectorSubtitleModel(lottieData);
        const nameStr = (tmpl.name || "").toLowerCase();
        const isLottieOverride = nameStr.includes("상단_04") || nameStr.includes("상단 04") || nameStr.includes("하단_04") || nameStr.includes("하단 04") || nameStr.includes("추가예정");
        const multiTitleModel = (!vectorModel && !isLottieOverride) ? extractMultiPngTitleModel(lottieData) : null;
        if (multiTitleModel?.pairs?.length) lottieData.__customHide = {
          imageLayerIndices: [...new Set(multiTitleModel.pairs.flatMap(p => p.relatedImageLayerIndices?.length ? p.relatedImageLayerIndices : [p.imageLayerIndex]).filter(idx => Number.isFinite(idx)))],
          textLayerIndices: [...new Set(multiTitleModel.pairs.map(p => p.textLayerIndex).filter(idx => Number.isFinite(idx)))],
        };
        const detectedFields = extractLottieTextFields(lottieData, []).map(field => normalizeFieldToCrop(field, cropBounds, dims.w, dims.h));
        const strictInternalText = false;
        const internalFontOptions = (lottieData?.fonts?.list || []).map(font => ({
          key: `internal:${font.fName}`,
          value: font.fName,
          mode: "internal",
          label: `${font.fFamily || font.fName}${font.fStyle ? ` (${font.fStyle})` : ""}`,
        }));
        const fontOptions = [...internalFontOptions, ...WEB_FONT_OPTIONS];

        return {
          id: uid(),
          name: tmpl.name,
          file: null,
          compName: tmpl.name,
          fields: detectedFields.length ? detectedFields : [createDefaultTemplateField(1)],
          previewUrl: null,
          webDef: null,
          allowFontChange: true,
          allowColorChange: true,
          templateKind: vectorModel ? "vector_subtitle" : (multiTitleModel ? "multi_png_title" : "lottie"),
          textBindingMode: vectorModel ? "overlay" : (detectedFields.length ? "internal" : "overlay"),
          fontOptions,
          glyphChars,
          vectorModel,
          multiTitleModel,
          lottieData,
          templateDuration,
          cropBounds,
          templateW: dims.w,
          templateH: dims.h,
          strictInternalText,
        };
      } catch (e) {
        console.warn("Could not load default template:", tmpl.name, e);
        return null;
      }
    })).then(results => {
      setImportedAE(prev => {
        const newAE = results.filter(r => r !== null);
        const existingNames = new Set(prev.map(p => p.name));
        const toAdd = newAE.filter(n => !existingNames.has(n.name));
        return [...prev, ...toAdd];
      });
    });
  })
  .catch(err => console.error("Failed to fetch templates list:", err));
  }, []);
  const [editingTemplateId, setEditingTemplateId] = useState(null);
  const [history, setHistory] = useState<any[]>([]);
  const [redo, setRedo] = useState<any[]>([]);
  const [interact, setInteract] = useState(null);
  const [timelineDrag, setTimelineDrag] = useState(null);
  const [timelineResize, setTimelineResize] = useState(null);
  const [markerDrag, setMarkerDrag] = useState(null); // 'in' | 'out' | null
  const [playheadDrag, setPlayheadDrag] = useState(false);
  const [timelineDragOffset, setTimelineDragOffset] = useState(0);
  const [dragStart, setDragStart] = useState<any>({ x: 0, y: 0, ts: 0, dur: 0, rowIndex: 0, kind: null });
  const [renderStatus, setRenderStatus] = useState("idle"); // idle | queued | rendering | done
  const [renderQueue, setRenderQueue] = useState([]);
  const savedJobsRef = useRef(new Set());
  const [isExportView, setIsExportView] = useState(false);
  const exportStageRef = useRef(null);
  const [exportStageWidth, setExportStageWidth] = useState(comp.w);

  useEffect(() => {
    if (!exportStageRef.current) return;
    const observer = new ResizeObserver(entries => {
      for (let entry of entries) {
        setExportStageWidth(entry.contentRect.width);
      }
    });
    observer.observe(exportStageRef.current);
    return () => observer.disconnect();
  }, [isExportView, comp.w]);

  const [exportStageParentDim, setExportStageParentDim] = useState({ w: 800, h: 600 });
  const exportStageContainerRefVal = useRef(null);

  const exportStageContainerRef = useCallback((node: any) => {
    if (exportStageContainerRefVal.current) {
      if ((exportStageContainerRefVal.current as any).__observer) {
        (exportStageContainerRefVal.current as any).__observer.disconnect();
      }
    }
    exportStageContainerRefVal.current = node;
    if (node) {
      const observer = new ResizeObserver(entries => {
        for (let entry of entries) {
          setExportStageParentDim({
            w: entry.contentRect.width,
            h: entry.contentRect.height
          });
        }
      });
      observer.observe(node);
      (node as any).__observer = observer;
    }
  }, []);

  const [exportSettings, setExportSettings] = useState({
    filename: "Untitled_Project",
    path: "C:\\Users\\user\\Desktop\\HMStudio_AE_Render_Server\\renders",

    format: "MPEG-4 (.mp4)",
    codec: "H.264 / AVC (x264)",
    width: 3840,
    height: 2160,
    bitrate: 45.0,
    audioEnabled: true,
    audioNormalize: false,
    preset: "4K"
  });
  const [renderIn, setRenderIn] = useState(0);
  const [renderOut, setRenderOut] = useState(null);
  const [exportPresets, setExportPresets] = useState([
    { id: "PROJECT", type: "default", label: "프로젝트 설정", w: 1920, h: 1080, icon: "🎞️" },
    { id: "4K", type: "default", label: "3840×2160 (4K)", w: 3840, h: 2160, icon: "📹" },
    { id: "FHD", type: "default", label: "1920×1080 (FHD)", w: 1920, h: 1080, icon: "🎬" },
    { id: "SIGNAGE", type: "default", label: "7680×2160 (사이니지)", w: 7680, h: 2160, icon: "📺" },
    { id: "HD", type: "default", label: "1280×720 (HD)", w: 1280, h: 720, icon: "📄" },
    { id: "CUSTOM1", type: "custom", baseName: "사용자 설정 1", label: "3840×1080(사용자 설정 1)", w: 3840, h: 1080, icon: "⚙️" },
  ]);
  const saveProject = async () => {
    const serializeMediaItem = item => {
      const { file, ...rest } = item || {};
      const storedPath = rest.storedPath || null;
      const url = typeof rest.url === "string" && rest.url.startsWith("blob:") && storedPath ? "" : rest.url;
      const serverUrl = typeof rest.serverUrl === "string" && rest.serverUrl.startsWith("blob:") && storedPath ? "" : rest.serverUrl;
      return { ...rest, url, serverUrl, storedPath };
    };

    const projectData = {
      version: "1.0",
      composition: comp,
      mediaAssets: mediaAssets.map(serializeMediaItem),
      clips: clips.map(serializeMediaItem),
      graphics: graphics,
      exportSettings: exportSettings
    };

    if ('showSaveFilePicker' in window) {
      try {
        const options = {
          suggestedName: `${exportSettings.filename || "project"}.json`,
          types: [{
            description: 'HMStudio Project JSON file',
            accept: {
              'application/json': ['.json'],
            },
          }],
        };
        const handle = await (window as any).showSaveFilePicker(options);
        const writable = await handle.createWritable();
        await writable.write(JSON.stringify(projectData, null, 2));
        await writable.close();
        return;
      } catch (err) {
        if ((err as Error).name === 'AbortError') {
          return;
        }
      }
    }

    const blob = new Blob([JSON.stringify(projectData, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${exportSettings.filename || "project"}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const loadProject = (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    
    // Preview window is already open from login, so we just load data
    const reader = new FileReader();
    reader.onload = async (ev) => {
      try {
        const data = JSON.parse(ev.target?.result as string);
        if (data.composition) setComp(data.composition);
        
        if (data.clips) {
          // Attempt to fetch server assets to auto-relink missing files
          let assetFiles = [];
          try {
            const res = await fetch('/api/system/assets');
            if (res.ok) {
              const resData = await res.json();
              if (resData.ok && Array.isArray(resData.files)) {
                assetFiles = resData.files;
              }
            }
          } catch (err) {
            console.warn("Could not fetch system assets for auto-relinking:", err);
          }

          const isElectron = !!(window as any).electron;
          const isBlobUrl = url => typeof url === "string" && url.startsWith("blob:");
          const isAbsoluteFilePath = filePath => /^[a-zA-Z]:[\\/]/.test(String(filePath || "")) || /^\\\\/.test(String(filePath || "")) || String(filePath || "").startsWith("/");
          const basenameFromPath = filePath => String(filePath || "").split(/[\\/]/).filter(Boolean).pop() || "";
          const fileExistsAtPath = async filePath => {
            if (!isElectron || !isAbsoluteFilePath(filePath)) return null;
            try {
              const res = await fetch('/api/file-exists', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ path: filePath })
              });
              if (!res.ok) return null;
              const data = await res.json();
              return !!data.exists;
            } catch {
              return null;
            }
          };

          const relinkMediaItem = async c => {
            let resolvedUrl = !isBlobUrl(c.serverUrl) ? c.serverUrl : "";
            if (!resolvedUrl && !isBlobUrl(c.url)) resolvedUrl = c.url;
            let resolvedPath = c.storedPath || "";
            let matchedAssetUrl = typeof resolvedUrl === "string" && resolvedUrl.startsWith("/assets/");
            const pathFromUrl = localFileUrlToPath(resolvedUrl);
            if (!resolvedPath && pathFromUrl) resolvedPath = pathFromUrl;
            const hasSavedAbsolutePath = !!(resolvedPath && isAbsoluteFilePath(resolvedPath));
            const savedPathExists = hasSavedAbsolutePath ? await fileExistsAtPath(resolvedPath) : false;
            const savedPathMissing = hasSavedAbsolutePath && savedPathExists === false;
            const savedPathUnchecked = hasSavedAbsolutePath && savedPathExists == null;

            const getSafeName = (name: string) => name.replace(/[^a-zA-Z0-9._-]+/g, '_');

            if (savedPathExists) {
              resolvedUrl = pathToPlaybackUrl(resolvedPath);
              matchedAssetUrl = false;
            } else if (savedPathMissing) {
              resolvedUrl = "";
              matchedAssetUrl = false;
            } else if (savedPathUnchecked) {
              resolvedUrl = pathToPlaybackUrl(resolvedPath);
              matchedAssetUrl = false;
            } else if (assetFiles.length > 0) {
              const cleanName = getSafeName(c.name).replace(/\.[^/.]+$/, "");
              const cleanExt = (c.name.split('.').pop() || "").toLowerCase();
              
              const match = assetFiles.find(f => {
                const lowerF = f.toLowerCase();
                if (!lowerF.endsWith("." + cleanExt)) return false;
                
                const cleanPart = cleanName.replace(/_+/g, '_').replace(/^_|_$/g, '');
                const fClean = lowerF.replace(/_+/g, '_');
                
                return cleanPart && fClean.includes(cleanPart.toLowerCase());
              });

              if (match) {
                resolvedUrl = `/assets/${match}`;
                matchedAssetUrl = true;
                console.log(`[Frontend Relinking] Relinked "${c.name}" to url: "${resolvedUrl}"`);
              } else {
                // Suffix fallback
                const parts = c.name.split('_');
                const lastPart = parts[parts.length - 1];
                if (lastPart && lastPart.length > 5) {
                  const match2 = assetFiles.find(f => f.toLowerCase().endsWith(lastPart.toLowerCase()));
                  if (match2) {
                    resolvedUrl = `/assets/${match2}`;
                    matchedAssetUrl = true;
                    console.log(`[Frontend Relinking] Suffix fallback relinked "${c.name}" to url: "${resolvedUrl}"`);
                  }
                }
              }
            }

            if (!resolvedUrl && resolvedPath && !isAbsoluteFilePath(resolvedPath)) {
              const basename = basenameFromPath(resolvedPath);
              if (basename) resolvedUrl = `/assets/${basename}`;
            }

            if (isElectron && hasSavedAbsolutePath && !savedPathMissing && !matchedAssetUrl) {
              resolvedUrl = pathToPlaybackUrl(resolvedPath);
            }

            return {
              ...c,
              url: resolvedUrl,
              serverUrl: resolvedUrl,
              storedPath: resolvedPath,
              needsRelink: !resolvedUrl || savedPathMissing
            };
          };

          const processed = await Promise.all(data.clips.map(relinkMediaItem));
          setClips(processed);
          const sourceAssets = Array.isArray(data.mediaAssets) ? data.mediaAssets : data.clips;
          setMediaAssets(await Promise.all(sourceAssets.map(relinkMediaItem)));
        }
        
        if (data.graphics) setGraphics(data.graphics);
        if (data.exportSettings) setExportSettings(data.exportSettings);
        setSelClipId(null); setSelGfxId(null); setTime(0);
        if (!isPreviewWindow && !isRenderMode) {
          setTimeout(() => {
            openPreviewPopout({ fullscreen: true, focusWindow: true, hasUserGesture: false, skipScreenDetails: true });
          }, 0);
        }
      } catch (err) {
        alert("올바른 프로젝트 파일이 아닙니다.");
      }
    };
    reader.readAsText(file);
    e.target.value = "";
  };

  const selectedPresetObj = exportPresets.find(p => p.id === exportSettings.preset);
  const isCustom = selectedPresetObj?.type === "custom";

  const addCustomPreset = () => {
    const customCount = exportPresets.filter(p => p.type === "custom").length + 1;
    const newId = `CUSTOM_${Date.now()}`;
    const baseName = `사용자 설정 ${customCount}`;
    const newPreset = {
      id: newId,
      type: "custom",
      baseName: baseName,
      label: baseName,
      w: exportSettings.width,
      h: exportSettings.height,
      icon: "⚙️"
    };
    setExportPresets(prev => [...prev, newPreset]);
    setExportSettings(s => ({ ...s, preset: newId }));
  };

  const saveCustomPreset = () => {
    if (!isCustom) return;
    setExportPresets(prev => prev.map(p => {
      if (p.id === exportSettings.preset) {
        return {
          ...p,
          w: exportSettings.width,
          h: exportSettings.height,
          label: `${exportSettings.width}×${exportSettings.height}(${p.baseName || p.label})`
        };
      }
      return p;
    }));
  };

  const pickExportDirectory = async () => {
    try {
      const res = await fetch('/api/system/browse-folder', { method: 'POST' });
      const data = await res.json();
      if (data.ok && data.path) {
        setExportSettings(s => ({ ...s, path: data.path }));
        console.log("Selected export directory via server:", data.path);
      }
    } catch (e) {
      console.error("Server-side folder picker error:", e);
      alert("폴더 찾아보기 창을 열 수 없습니다. 직접 텍스트 박스에 경로를 입력해주세요.");
    }
  };

  const videoRefs = useRef({});
  const lastMediaRestartNonceRef = useRef(0);
  const stageRef = useRef(null);
  const popupStageRef = useRef(null);
  const timelineBodyRef = useRef(null);
  const previewWinRef = useRef(null);
  const previewHostRef = useRef(null);
  const previewChannelRef = useRef<any>(null);
  const latestPreviewPayloadRef = useRef<any>(null);
  const previewPayloadSignatureRef = useRef('');
  const previewPublishSignatureRef = useRef('');
  const applyingPreviewStateRef = useRef(false);
  const previewHasParentStateRef = useRef(false);
  
  useEffect(() => {
    const closePreviewPopup = () => {
      try {
        const win = previewWinRef.current;
        if (win && !win.closed) {
          win.close();
        }
      } catch (e) { /* ignore */ }
    };
    window.addEventListener('beforeunload', closePreviewPopup);
    window.addEventListener('pagehide', closePreviewPopup);
    window.addEventListener('unload', closePreviewPopup);
    return () => {
      window.removeEventListener('beforeunload', closePreviewPopup);
      window.removeEventListener('pagehide', closePreviewPopup);
      window.removeEventListener('unload', closePreviewPopup);
    };
  }, []);
  const [previewPopout, setPreviewPopout] = useState(false);
  const [previewZoom, setPreviewZoom] = useState(1);
  const [previewPan, setPreviewPan] = useState({ x: 0, y: 0 });
  const previewScrollNodeRef = useRef<HTMLDivElement | null>(null);
  const previewScrollRef = useCallback((node: HTMLDivElement | null) => {
    if (previewScrollNodeRef.current) {
      const prevNode = previewScrollNodeRef.current;
      if ((prevNode as any).__wheelHandler) {
        prevNode.removeEventListener('wheel', (prevNode as any).__wheelHandler);
        delete (prevNode as any).__wheelHandler;
      }
      if ((prevNode as any).__mouseDownHandler) {
        prevNode.removeEventListener('mousedown', (prevNode as any).__mouseDownHandler);
        delete (prevNode as any).__mouseDownHandler;
      }
    }
    previewScrollNodeRef.current = node;
    if (node) {
      const handleWheel = (e: WheelEvent) => {
        e.preventDefault();
        setPreviewZoom(z => {
          const nextZoom = z + (e.deltaY < 0 ? 0.05 : -0.05);
          return Math.max(0.1, Math.min(5, nextZoom));
        });
      };

      const handleMouseDown = (e: MouseEvent) => {
        if (e.button === 1) { // Middle click / wheel click
          e.preventDefault(); // Stop default browser auto-scrolling
          
          let lastX = e.clientX;
          let lastY = e.clientY;

          const handleMouseMove = (mv: MouseEvent) => {
            mv.preventDefault();
            const dx = mv.clientX - lastX;
            const dy = mv.clientY - lastY;
            lastX = mv.clientX;
            lastY = mv.clientY;
            
            setPreviewPan(p => ({ x: p.x + dx, y: p.y + dy }));
          };

          const targetWindow = node.ownerDocument.defaultView || window;
          const handleMouseUp = (mu: MouseEvent) => {
            if (mu.button === 1) {
              targetWindow.removeEventListener('mousemove', handleMouseMove);
              targetWindow.removeEventListener('mouseup', handleMouseUp);
            }
          };

          targetWindow.addEventListener('mousemove', handleMouseMove);
          targetWindow.addEventListener('mouseup', handleMouseUp);
        }
      };

      node.addEventListener('wheel', handleWheel, { passive: false });
      (node as any).__wheelHandler = handleWheel;

      node.addEventListener('mousedown', handleMouseDown);
      (node as any).__mouseDownHandler = handleMouseDown;
    }
  }, []);
  const fileRef = useRef(null);
  const aeFileRef = useRef(null);
  const projectFileRef = useRef(null);
  const rafRef = useRef(null);
  const playStartRef = useRef({ wallTime: 0, editTime: 0 });
  const queryParams = useMemo(() => new URLSearchParams(window.location.search), []);
  const renderJobId = queryParams.get('renderJob');
  const renderTsParam = Number(queryParams.get('renderTs') || 0);
  const isPreviewWindow = queryParams.get('previewWindow') === '1';
  const isRenderMode = !!renderJobId;
  const isTransparentGraphicsCapture = queryParams.get('transparent') === '1' && queryParams.get('onlyGraphics') === '1';
  const [renderJobLoaded, setRenderJobLoaded] = useState(!isRenderMode);
  const renderReadyResolverRef = useRef(null);
  const isPrecachingRef = useRef(false);

  useEffect(() => {
    // main.ts toggles this during the Lottie pre-render pass so the Electron
    // capture hook does not write warm-up frames into FFmpeg.
    (window as any).isPrecachingRef = isPrecachingRef;
    return () => {
      delete (window as any).isPrecachingRef;
    };
  }, []);

  const makePreviewPayload = useCallback(() => {
    const stripRuntimeFile = item => {
      if (!item) return item;
      const { file, ...rest } = item;
      return rest;
    };
    return {
      comp,
      clips: clips.map(stripRuntimeFile),
      graphics,
      mediaAssets: mediaAssets.map(stripRuntimeFile),
      time,
      playing,
      totalDur,
      previewZoom,
      previewPan,
      isExportView,
    };
  }, [clips, comp, graphics, isExportView, mediaAssets, playing, previewPan, previewZoom, time, totalDur]);

  const makePreviewEditPayload = useCallback(() => {
    const stripRuntimeFile = item => {
      if (!item) return item;
      const { file, ...rest } = item;
      return rest;
    };
    return {
      comp,
      clips: clips.map(stripRuntimeFile),
      graphics,
      mediaAssets: mediaAssets.map(stripRuntimeFile),
      totalDur,
      isExportView,
    };
  }, [clips, comp, graphics, isExportView, mediaAssets, totalDur]);

  const makePreviewSignature = useCallback((payload) => JSON.stringify({
    comp: payload.comp || null,
    clips: (payload.clips || []).map(c => ({
      id: c.id, assetId: c.assetId, type: c.type, url: c.url, serverUrl: c.serverUrl, storedPath: c.storedPath,
      ts: c.ts, dur: c.dur, startT: c.startT, endT: c.endT, x: c.x, y: c.y, scale: c.scale,
      rotation: c.rotation, opacity: c.opacity, visible: c.visible, layerOrder: c.layerOrder,
      sourceW: c.sourceW, sourceH: c.sourceH, track: c.track,
    })),
    graphics: (payload.graphics || []).map(g => ({
      id: g.id, type: g.type, templateKind: g.templateKind, sourceName: g.sourceName, compName: g.compName,
      ts: g.ts, dur: g.dur, startT: g.startT, x: g.x, y: g.y, scale: g.scale, rotation: g.rotation,
      opacity: g.opacity, visible: g.visible, layerOrder: g.layerOrder, content: g.content,
      subContent: g.subContent, textFields: g.textFields, style: g.style, width: g.width, height: g.height,
    })),
    mediaAssets: (payload.mediaAssets || []).map(a => ({
      id: a.id, name: a.name, type: a.type, url: a.url, serverUrl: a.serverUrl, storedPath: a.storedPath,
      dur: a.dur, w: a.w, h: a.h,
    })),
    totalDur: payload.totalDur || 0,
    isExportView: !!payload.isExportView,
  }), []);

  const publishPreviewState = useCallback(() => {
    if (isRenderMode || isPreviewWindow || typeof BroadcastChannel === 'undefined') return;
    const payload = makePreviewPayload();
    latestPreviewPayloadRef.current = payload;
    try {
      const channel = previewChannelRef.current || new BroadcastChannel('hmstudio-preview-state');
      previewChannelRef.current = channel;
      const signature = makePreviewSignature(payload);
      if (previewPublishSignatureRef.current !== signature) {
        previewPublishSignatureRef.current = signature;
        channel.postMessage({ type: 'state', payload });
      } else {
        channel.postMessage({ type: 'tick', payload: { time: payload.time, playing: payload.playing } });
      }
    } catch (err) {
      console.warn('[Preview] Failed to publish state:', err);
    }
  }, [isPreviewWindow, isRenderMode, makePreviewPayload, makePreviewSignature]);

  useEffect(() => {
    if (isRenderMode || typeof BroadcastChannel === 'undefined') return;
    const channel = new BroadcastChannel('hmstudio-preview-state');
    previewChannelRef.current = channel;

    channel.onmessage = event => {
      const message = event.data || {};
      if (!isPreviewWindow && message.type === 'edit-state') return;
      if (isPreviewWindow) {
        if (message.type === 'tick' && message.payload) {
          setTime(Number(message.payload.time || 0));
          setPlaying(!!message.payload.playing);
          return;
        }
        if (message.type !== 'state' || !message.payload) return;
        const payload = message.payload;
        previewHasParentStateRef.current = true;
        const signature = makePreviewSignature(payload);
        if (previewPayloadSignatureRef.current !== signature) {
          applyingPreviewStateRef.current = true;
          previewPayloadSignatureRef.current = signature;
          if (payload.comp) setComp(payload.comp);
          setClips(Array.isArray(payload.clips) ? payload.clips : []);
          setGraphics(Array.isArray(payload.graphics) ? payload.graphics : []);
          setMediaAssets(Array.isArray(payload.mediaAssets) ? payload.mediaAssets : []);
          setTotalDur(Number(payload.totalDur || 0));
          setIsExportView(!!payload.isExportView);
          setTimeout(() => { applyingPreviewStateRef.current = false; }, 0);
        }
        setTime(Number(payload.time || 0));
        setPlaying(!!payload.playing);
        setRenderJobLoaded(true);
        setIsLoggedIn(true);
        return;
      }

      if (message.type === 'ready') {
        const payload = latestPreviewPayloadRef.current || makePreviewPayload();
        latestPreviewPayloadRef.current = payload;
        channel.postMessage({ type: 'state', payload });
      }
    };

    if (isPreviewWindow) {
      channel.postMessage({ type: 'ready' });
    } else {
      latestPreviewPayloadRef.current = makePreviewPayload();
    }

    return () => {
      channel.close();
      if (previewChannelRef.current === channel) previewChannelRef.current = null;
    };
  }, [isPreviewWindow, isRenderMode, makePreviewPayload, makePreviewSignature]);

  useEffect(() => {
    if (!isPreviewWindow || isRenderMode || typeof BroadcastChannel === 'undefined') return;
    // The monitor preview must not push its local state back into the editor.
    // It can briefly be empty while waiting for the parent state; sending that
    // back would erase newly inserted media/templates from the timeline.
  }, [isPreviewWindow, isRenderMode, makePreviewEditPayload]);

  useEffect(() => {
    if (isPreviewWindow || isRenderMode) return;
    publishPreviewState();
  }, [clips, comp, graphics, isExportView, isPreviewWindow, isRenderMode, mediaAssets, playing, previewPan, previewZoom, publishPreviewState, time, totalDur]);
  
  useEffect(() => {
    // @ts-ignore
    window.__HM_PRECACHE_FRAME = async (ts) => {
      document.documentElement.setAttribute('data-render-ready', '0');
      document.body.setAttribute('data-render-ready', '0');
      setTime(ts);
      return new Promise(resolve => {
        // @ts-ignore
        renderReadyResolverRef.current = resolve;
        const tid = setTimeout(() => {
          document.documentElement.setAttribute('data-render-ready', '1');
          document.body.setAttribute('data-render-ready', '1');
          resolve(true);
        }, 3000);
        // @ts-ignore
        (renderReadyResolverRef as any)._tid = tid;
      });
    };

    // @ts-ignore
    window.__HM_SET_RENDER_TIME = async (ts) => {
      document.documentElement.setAttribute('data-render-ready', '0');
      document.body.setAttribute('data-render-ready', '0');

      setTime(ts);

      // In Electron render mode, this Promise resolves ONLY after onReady fires AND
      // __onElectronFrameReady completes its ipcRenderer.invoke('frame-captured').
      // That invoke writes the RGBA buffer into FFmpeg stdin and waits for
      // ipcMain.handle to return { ok: true }.
      // So: await executeJavaScript('__HM_SET_RENDER_TIME(ts)') in main.ts
      // = await the full pixel capture + stdin write for that frame. Serial, no deadlock.
      //
      // In CDP/server render mode, this resolves when data-render-ready=1 is polled.
      // In that case we use a 3s hard timeout as fallback.
      return new Promise(resolve => {
        // @ts-ignore
        renderReadyResolverRef.current = resolve;
        const isElectronIpcCapture = !!((window as any).electron && (window as any).__onElectronFrameReady);
        // Hard timeout: if onReady never fires (e.g. empty timeline), unblock after 3s.
        // In Electron IPC mode, onReady ALWAYS fires because WebGLRenderStage
        // skips nextPaint() and calls onReady synchronously after draw().
        const tid = setTimeout(() => {
          document.documentElement.setAttribute('data-render-ready', '1');
          document.body.setAttribute('data-render-ready', '1');
          renderReadyResolverRef.current = null;
          resolve(isElectronIpcCapture ? false : true);
        }, isElectronIpcCapture ? 10000 : 3000);
        // @ts-ignore
        (renderReadyResolverRef as any)._tid = tid;
      });
    };
    return () => {
      // @ts-ignore
      delete window.__HM_SET_RENDER_TIME;
      // @ts-ignore
      delete window.__HM_PRECACHE_FRAME;
    };
  }, []);

  useEffect(() => {
    if (!isRenderMode || !renderJobId) return;
    let cancelled = false;
    document.documentElement.setAttribute('data-render-ready', '0');
    document.body.setAttribute('data-render-ready', '0');
    (async () => {
      try {
        const res = await fetch(`/api/render-jobs/${renderJobId}`);
        if (!res.ok) throw new Error('render job load failed');
        const job = await res.json();
        if (cancelled) return;
        const payload = job.payload || {};
        const loadedClips = Array.isArray(payload.clips) ? payload.clips.map((clip) => ({ ...clip, url: resolvePlaybackUrl(clip), serverUrl: resolvePlaybackUrl(clip) })) : [];
        const loadedGraphics = Array.isArray(payload.graphics) ? payload.graphics : [];
        
        const isTransparent = queryParams.get('transparent') === '1';
        const isOnlyGraphics = queryParams.get('onlyGraphics') === '1';
        
        const rawComp = payload.composition || { w: 3840, h: 2160, fps: 30, bg: '#000000' };
        setComp({
          ...rawComp,
          bg: isTransparent ? 'transparent' : (rawComp.bg || '#000000')
        });
        setClips(isOnlyGraphics ? [] : loadedClips);
        setGraphics(loadedGraphics);
        setTime(renderTsParam);
        setSelClipId(null); setSelGfxId(null); setEditingGfxId(null); setPlaying(false);
        document.body.style.margin = '0';
        document.body.style.padding = '0';
        document.body.style.overflow = 'hidden';
        document.documentElement.style.margin = '0';
        document.documentElement.style.padding = '0';
        document.documentElement.style.overflow = 'hidden';
        document.body.style.background = isTransparent ? 'transparent' : '#000';
        setRenderJobLoaded(true);
        // 렌더 준비 신호는 WebGLRenderStage가 실제 첫 프레임을 그린 뒤 onReady에서 보낸다.
        // 여기서 먼저 ready=1을 보내면 서버가 검은 빈 화면을 캡처할 수 있다.
      } catch (err) {
        console.error(err);
        setRenderJobLoaded(true);
        document.documentElement.setAttribute('data-render-ready', '1');
      }
    })();
    return () => { cancelled = true; };
  }, [isRenderMode, renderJobId, renderTsParam]);

  const [isElectronRendering, setIsElectronRendering] = useState(false);

  // Electron High-Speed Raw Pixel Capture Render Loop
  useEffect(() => {
    if (!(window as any).electron) return;

    const unlisten = (window as any).electron.ipcRenderer.on('start-client-render', async (event: any, payload: any) => {
      const { jobId, fps, totalFrames } = payload;
      console.log(`[ClientRender] Received start render for job ${jobId}`, payload);

      // Transition the editor into bare full-resolution canvas mode
      setIsElectronRendering(true);
      setRenderJobLoaded(true);
      
      // Global flag to prevent __onElectronFrameReady from capturing pixels during precache
      isPrecachingRef.current = false;

      let frame = 0;
      const originalTime = time;

      const onFrameReady = async (canvas: HTMLCanvasElement) => {
        // Guard: main loop drives frame advancement via __HM_SET_RENDER_TIME,
        // so onFrameReady must NOT advance frame or call setTime itself.
        // Its sole job is to (1) extract pixels and (2) invoke 'frame-captured'
        // so main.ts can write bytes to FFmpeg stdin and release the per-frame latch.
        if (frame >= totalFrames || isPrecachingRef.current) return;

        try {
          const width = canvas.width;
          const height = canvas.height;
          const ctx = canvas.getContext('2d');
          if (!ctx) throw new Error('Could not get 2D context from canvas');

          const imgData = ctx.getImageData(0, 0, width, height);
          if (isTransparentGraphicsCapture) {
            const pixels = imgData.data;
            for (let p = 0; p < pixels.length; p += 4) {
              if (pixels[p] === 0 && pixels[p + 1] === 0 && pixels[p + 2] === 0 && pixels[p + 3] === 255) {
                pixels[p + 3] = 0;
              }
            }
          }

          // invoke (not send) so we await the write + backpressure in main.ts.
          // This also triggers the per-frame latch release in executeRenderJob.
          await (window as any).electron.ipcRenderer.invoke('frame-captured', {
            jobId,
            frame,
            width,
            height,
            buffer: imgData.data.buffer,
          });

          frame++;
          // Do NOT call setTime here \u2014 main.ts drives the next frame via
          // executeJavaScript('window.__HM_SET_RENDER_TIME(ts)').
          // Calling setTime here would double-advance and de-sync the loop.
          if (frame >= totalFrames) {
            // Last frame sent \u2014 clean up renderer state.
            setIsElectronRendering(false);
            setRenderJobLoaded(false);
            setTime(originalTime);
          }
        } catch (err: any) {
          console.error('[ClientRender] Capture error:', err);
          setIsElectronRendering(false);
          setRenderJobLoaded(false);
          setTime(originalTime);
        }
      };

      // Register the per-frame hook BEFORE main.ts starts sending timestamps.
      (window as any).__onElectronFrameReady = onFrameReady;

      // Do NOT call setTime(0) here \u2014 main.ts will call
      // executeJavaScript('window.__HM_SET_RENDER_TIME(0)') for frame 0
      // once start-client-render has been processed.
    });

    return () => {
      unlisten();
    };
  }, [time, setTime]);

  const [isLoggedIn, setIsLoggedIn] = useState(TEMP_DISABLE_LOGIN);
  const [isEditingTime, setIsEditingTime] = useState(false);
  const [timeInput, setTimeInput] = useState("");

  const [systemStatus, setSystemStatus] = useState<any>(null);
  const [showSystemModal, setShowSystemModal] = useState(false);
  const [isInstallingChrome, setIsInstallingChrome] = useState(false);
  const [isInstallingFfmpeg, setIsInstallingFfmpeg] = useState(false);

  const fetchSystemStatus = useCallback(() => {
    fetch('/api/system-status')
      .then(r => r.json())
      .then(data => {
        setSystemStatus(data);
        if (!data.ffmpeg?.found || !data.browser?.found) {
          setShowSystemModal(true);
        }
      })
      .catch(console.error);
  }, []);


  useEffect(() => {
    fetchSystemStatus();
  }, [fetchSystemStatus]);

  useEffect(() => {
    if (isLoggedIn) {
      // Also fetch server root folder to set default export path
      fetch('/api/render-server/status')
        .then(r => r.json())
        .then(data => {
          if (data.ok && data.folders?.renders) {
            setExportSettings(s => ({ 
              ...s, 
              path: s.path === "C:\\Users\\user\\Desktop\\HMStudio_AE_Render_Server\\renders" || !s.path 
                ? data.folders.renders 
                : s.path 
            }));
          }
        })
        .catch(console.error);
    }
  }, [isLoggedIn, fetchSystemStatus]);


  const installChrome = async () => {
    if (isInstallingChrome) return;
    setIsInstallingChrome(true);
    try {
      const res = await fetch('/api/system/install-chrome', { method: 'POST' });
      const data = await res.json();
      if (data.ok) {
        alert("브라우저 설치가 완료되었습니다.");
        fetchSystemStatus();
      } else {
        alert(`설치 실패: ${data.error}`);
      }
    } catch (err) {
      alert("설치 중 오류가 발생했습니다.");
    } finally {
      setIsInstallingChrome(false);
    }
  };

  const installFfmpeg = async () => {
    if (isInstallingFfmpeg) return;
    setIsInstallingFfmpeg(true);
    try {
      const res = await fetch('/api/system/install-ffmpeg', { method: 'POST' });
      const data = await res.json();
      if (data.ok) {
        alert("FFmpeg 설치가 완료되었습니다.");
        fetchSystemStatus();
      } else {
        alert(`설치 실패: ${data.error}`);
      }
    } catch (err) {
      alert("설치 중 오류가 발생했습니다.");
    } finally {
      setIsInstallingFfmpeg(false);
    }
  };

  const [loginId, setLoginId] = useState("");
  const [loginPw, setLoginPw] = useState("");
  const [isLoggingIn, setIsLoggingIn] = useState(false);
  const [loginError, setLoginError] = useState("");

  const handleLoginSubmit = async (e?: React.FormEvent) => {
    e?.preventDefault();
    if (!loginId || !loginPw) {
      setLoginError("사번과 비밀번호를 입력해주세요.");
      return;
    }
    setIsLoggingIn(true);
    setLoginError("");
    try {
      const res = await fetch('/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: loginId, password: loginPw }),
      });
      const data = await res.json();
      if (data.success) {
        // Set session for 24 hours
        const expiry = Date.now() + (24 * 60 * 60 * 1000);
        localStorage.setItem('hmstudio_auth', JSON.stringify({ userId: loginId, expiry }));
        setIsLoggedIn(true);
        if ((window as any).electron) {
          (window as any).electron.ipcRenderer.send('login-success');
        }
        // Open the persistent preview window immediately on login gesture
        openPreviewPopout({ hasUserGesture: true });
      } else {
        setLoginError(data.message || "로그인 실패");
      }
    } catch (err) {
      setLoginError("서버와 통신 중 오류가 발생했습니다.");
    } finally {
      setIsLoggingIn(false);
    }
  };

  useEffect(() => {
    const d1 = clips.reduce((m, c) => Math.max(m, c.ts + c.dur), 0);
    const d2 = graphics.reduce((m, g) => Math.max(m, g.ts + g.dur), 0);
    setTotalDur(Math.max(d1, d2, 0.1));
  }, [clips, graphics]);


  // ── History ────────────────────────────────────────────────────────────
  const cloneUndoValue = useCallback((value: any) => JSON.parse(JSON.stringify(value)), []);
  const makeUndoState = useCallback(() => ({
    clips: cloneUndoValue(clips),
    mediaAssets: cloneUndoValue(mediaAssets),
    graphics: cloneUndoValue(graphics),
    comp: cloneUndoValue(comp),
    renderIn,
    renderOut,
    time,
  }), [clips, mediaAssets, graphics, comp, renderIn, renderOut, time, cloneUndoValue]);
  const undoStateKey = useCallback((state: any) => JSON.stringify({
    clips: state.clips,
    mediaAssets: state.mediaAssets,
    graphics: state.graphics,
    comp: state.comp,
    renderIn: state.renderIn,
    renderOut: state.renderOut,
    time: state.time,
  }), []);
  const applyUndoState = useCallback((state: any) => {
    setClips(cloneUndoValue(state.clips || []));
    if (Array.isArray(state.mediaAssets)) setMediaAssets(cloneUndoValue(state.mediaAssets));
    setGraphics(cloneUndoValue(state.graphics || []));
    if (state.comp) setComp(cloneUndoValue(state.comp));
    setRenderIn(Number(state.renderIn || 0));
    setRenderOut(state.renderOut == null ? null : Number(state.renderOut));
    setTime(Number(state.time || 0));
  }, [cloneUndoValue]);
  const newProject = useCallback(() => {
    setPlaying(false);
    Object.values(videoRefs.current || {}).forEach((el: any) => {
      try {
        el.pause();
        el.removeAttribute("src");
        el.removeAttribute("data-cid");
        el.removeAttribute("data-src");
        el.load();
      } catch {}
    });
    videoRefs.current = {};
    setClips([]);
    setMediaAssets([]);
    setGraphics([]);
    setComp({ w: 3840, h: 2160, fps: 30, bg: "#000000" });
    setTime(0);
    setRenderIn(0);
    setRenderOut(null);
    setTotalDur(0);
    setSelClipId(null);
    setSelGfxId(null);
    setSelectedMediaAssetId(null);
    setSelectedTimelineItems(new Set());
    setSelectedKeyframes(new Set());
    setExpandedLayers(new Set());
    setActiveKeyframePopup(null);
    setCopiedItem(null);
    setEditingGfxId(null);
    setTool("select");
    setHistory([]);
    setRedo([]);
    setRenderStatus("idle");
    setRenderQueue([]);
    savedJobsRef.current.clear();
    setExportSettings(s => ({
      ...s,
      filename: "Untitled_Project",
      width: 3840,
      height: 2160,
      bitrate: 45.0,
      preset: "4K"
    }));
  }, []);
  const snap = useCallback(() => {
    const state = makeUndoState();
    const key = undoStateKey(state);
    setHistory(h => {
      if (h[h.length - 1]?.__key === key) return h;
      return [...h, { ...state, __key: key }].slice(-80);
    });
    setRedo([]);
  }, [makeUndoState, undoStateKey]);
  const undoFn = useCallback(() => {
    const current = makeUndoState();
    const currentKey = undoStateKey(current);
    setHistory(h => {
      let idx = h.length - 1;
      while (idx >= 0 && h[idx]?.__key === currentKey) idx -= 1;
      if (idx < 0) return h.filter(entry => entry?.__key !== currentKey);
      const prev = h[idx];
      setRedo(r => {
        if (r[r.length - 1]?.__key === currentKey) return r;
        return [...r, { ...current, __key: currentKey }].slice(-80);
      });
      applyUndoState(prev);
      return h.slice(0, idx);
    });
  }, [makeUndoState, undoStateKey, applyUndoState]);
  const redoFn = useCallback(() => {
    const current = makeUndoState();
    const currentKey = undoStateKey(current);
    setRedo(r => {
      let idx = r.length - 1;
      while (idx >= 0 && r[idx]?.__key === currentKey) idx -= 1;
      if (idx < 0) return r.filter(entry => entry?.__key !== currentKey);
      const next = r[idx];
      setHistory(h => {
        if (h[h.length - 1]?.__key === currentKey) return h;
        return [...h, { ...current, __key: currentKey }].slice(-80);
      });
      applyUndoState(next);
      return r.slice(0, idx);
    });
  }, [makeUndoState, undoStateKey, applyUndoState]);
  const getStageEl = useCallback(() => {
    if (isPreviewWindow) return popupStageRef.current || stageRef.current;
    return (previewPopout && previewHostRef.current) ? (popupStageRef.current || stageRef.current) : stageRef.current;
  }, [isPreviewWindow, previewPopout]);
  const layerKey = useCallback(layer => `${layer.__kind || (layer.url ? 'clip' : 'graphic')}:${layer.id}`, []);
  const applyLayerOrder = useCallback((orderedLayers) => {
    const orderMap = new Map();
    orderedLayers.forEach((layer, idx) => orderMap.set(`${layer.__kind}:${layer.id}`, orderedLayers.length - idx));
    setClips(cs => cs.map(c => orderMap.has(`clip:${c.id}`) ? { ...c, layerOrder: orderMap.get(`clip:${c.id}`) } : c));
    setGraphics(gs => gs.map(g => orderMap.has(`graphic:${g.id}`) ? { ...g, layerOrder: orderMap.get(`graphic:${g.id}`) } : g));
  }, []);
  const getCurrentTimelineLayers = useCallback(() => ([
    ...clips.map((c, idx) => ({ 
      ...c, 
      __kind: 'clip', 
      __label: c.name, 
      __sort: Number(c.layerOrder ?? idx),
      __type: c.type || 'video'
    })),
    ...graphics.map((g, idx) => ({ 
      ...g, 
      __kind: 'graphic', 
      __label: g.type === 'ae_template' ? g.compName : (g.content || g.type), 
      __sort: Number(g.layerOrder ?? (1000 + idx)),
      __type: 'graphic'
    })),
  ]).sort((a, b) => b.__sort - a.__sort), [clips, graphics]);
  const preparePreviewPopout = useCallback(async (hasUserGesture = false, skipScreenDetails = false) => {
    let win = previewWinRef.current;
    if (!win || win.closed) {
      // ── Multi-monitor positioning ─────────────────────────────────────
      let targetLeft = 0;
      let targetTop = 0;
      let targetWidth = 1280;
      let targetHeight = 720;
      let usedScreenAPI = false;
      let targetScreenRef: any = null;
      const isMultiMonitor = (window.screen as any).isExtended === true;

      console.log('[Preview] hasUserGesture:', hasUserGesture);
      console.log('[Preview] isMultiMonitor (screen.isExtended):', isMultiMonitor);
      console.log('[Preview] window.screenX:', window.screenX, 'window.screenY:', window.screenY);
      console.log('[Preview] window.outerWidth:', window.outerWidth, 'window.outerHeight:', window.outerHeight);
      console.log('[Preview] screen.availWidth:', window.screen.availWidth, 'screen.availHeight:', window.screen.availHeight);
      console.log('[Preview] screen.availLeft:', (window.screen as any).availLeft, 'screen.availTop:', (window.screen as any).availTop);

      // Strategy 1: Window Management API (only if we have user gesture)
      if (hasUserGesture && !skipScreenDetails) {
        try {
          if ('getScreenDetails' in window) {
            const screenDetails = await (window as any).getScreenDetails();
            const currentScreen = screenDetails.currentScreen;
            const screens: any[] = screenDetails.screens;

            console.log('[Preview] Screen API: screens=', screens.length);
            screens.forEach((s: any, i: number) => {
              console.log(`[Preview]   Screen ${i}: left=${s.left} top=${s.top} w=${s.width} h=${s.height} avail=(${s.availLeft},${s.availTop},${s.availWidth},${s.availHeight}) primary=${s.isPrimary}`);
            });

            const otherScreens = screens.filter((s: any) =>
              s.left !== currentScreen.left || s.top !== currentScreen.top ||
              s.width !== currentScreen.width || s.height !== currentScreen.height
            );

            const rightScreen = otherScreens.find((s: any) => s.left >= currentScreen.left + currentScreen.width);
            const leftScreen = [...otherScreens].reverse().find((s: any) => s.left + s.width <= currentScreen.left);
            const picked = rightScreen || leftScreen || otherScreens[0];

            if (picked) {
              targetLeft = picked.availLeft;
              targetTop = picked.availTop;
              targetWidth = picked.availWidth;
              targetHeight = picked.availHeight;
              targetScreenRef = picked;
              usedScreenAPI = true;
              console.log(`[Preview] API: picked screen at left=${targetLeft} top=${targetTop} ${targetWidth}x${targetHeight}`);
            } else if (screens.length === 1) {
              targetLeft = currentScreen.availLeft + Math.floor(currentScreen.availWidth / 2);
              targetTop = currentScreen.availTop;
              targetWidth = Math.floor(currentScreen.availWidth / 2);
              targetHeight = currentScreen.availHeight;
              usedScreenAPI = true;
              console.log('[Preview] API: single monitor → right half');
            }
          }
        } catch (err) {
          console.warn("[Preview] Window Management API failed:", err);
        }
      }

      // Strategy 2: Fallback using basic screen properties
      if (!usedScreenAPI) {
        const scrLeft = (window.screen as any).availLeft ?? 0;
        const scrTop = (window.screen as any).availTop ?? 0;
        const scrW = window.screen.availWidth || 1920;
        const scrH = window.screen.availHeight || 1080;

        if (isMultiMonitor) {
          // Multi-monitor: use screen.availLeft to determine which monitor we're on
          if (scrLeft > 0) {
            // Browser is on secondary monitor (right side, starts at scrLeft)
            // → open popup on primary monitor (left, starts at 0)
            targetLeft = 0;
            targetTop = 0;
            targetWidth = scrLeft;  // Primary monitor width = gap before this screen
            targetHeight = scrH;
          } else {
            // Browser is on primary monitor (left, starts at 0)
            // → open popup on secondary monitor (starts at screen.width or availWidth)
            targetLeft = window.screen.width || scrW;
            targetTop = scrTop;
            targetWidth = scrW;    // Assume similar resolution
            targetHeight = scrH;
          }
          console.log(`[Preview] Fallback multi-monitor: scrLeft=${scrLeft} → target left=${targetLeft} ${targetWidth}x${targetHeight}`);
        } else {
          // Single monitor: use right half
          targetLeft = scrLeft + Math.floor(scrW / 2);
          targetTop = scrTop;
          targetWidth = Math.floor(scrW / 2);
          targetHeight = scrH;
          console.log('[Preview] Fallback single monitor → right half');
        }
      }

      console.log(`[Preview] Final: left=${targetLeft} top=${targetTop} ${targetWidth}x${targetHeight}`);

      const electronInvoke = (window as any).electron?.ipcRenderer?.invoke;
      if (typeof electronInvoke === 'function') {
        const result = await electronInvoke('open-preview-window', {
          bounds: { x: targetLeft, y: targetTop, width: targetWidth, height: targetHeight },
          fullscreen: true,
        });
        if (!result?.ok) return null;
        const electronPreviewHandle = {
          __electronPreview: true,
          closed: false,
          close: () => electronInvoke('close-preview-window'),
          focus: () => electronInvoke('focus-preview-window'),
          moveTo: () => {},
          resizeTo: () => {},
        };
        previewWinRef.current = electronPreviewHandle as any;
        previewHostRef.current = null;
        popupStageRef.current = null;
        setTimeout(publishPreviewState, 100);
        setTimeout(publishPreviewState, 500);
        return electronPreviewHandle as any;
      }

      const features = `popup=yes,fullscreen=yes,width=${targetWidth},height=${targetHeight},left=${targetLeft},top=${targetTop},screenX=${targetLeft},screenY=${targetTop}`;
      win = window.open('about:blank', 'hmstudio-preview-monitor', features);
      if (!win) {
        alert("팝업이 차단되었습니다. 주소창 오른쪽의 '팝업 차단됨' 아이콘을 클릭하여 '항상 허용'으로 설정해주세요.");
        return null;
      }

      // Force-move to correct monitor
      try {
        win.moveTo(targetLeft, targetTop);
        win.resizeTo(targetWidth, targetHeight);
      } catch (_) {}

      (win as any).__targetScreen = targetScreenRef;
      (win as any).__targetPos = { left: targetLeft, top: targetTop, width: targetWidth, height: targetHeight };

      setTimeout(() => {
        try {
          console.log(`[Preview] Actual position: screenX=${win!.screenX} screenY=${win!.screenY} outer=${win!.outerWidth}x${win!.outerHeight}`);
        } catch (_) {}
      }, 500);

      win.document.title = 'HM Studio Preview';
      win.document.body.style.margin = '0';
      win.document.body.style.background = '#000';
      win.document.body.style.overflow = 'hidden';
      const host = win.document.createElement('div');
      host.style.width = '100vw';
      host.style.height = '100vh';
      host.style.background = '#000';
      win.document.body.appendChild(host);

      const style = win.document.createElement('style');
      style.textContent = `
        /* Custom Scrollbar Styles */
        ::-webkit-scrollbar {
          width: 12px;
          height: 12px;
        }

        ::-webkit-scrollbar-track {
          background: #141414;
        }

        ::-webkit-scrollbar-thumb {
          background: #52525b;
          border-radius: 9999px;
          border: 2px solid #141414;
        }

        ::-webkit-scrollbar-thumb:hover {
          background: #a1a1aa;
        }

        /* For Firefox */
        * {
          scrollbar-width: auto;
          scrollbar-color: #52525b #141414;
        }
      `;
      win.document.head.appendChild(style);

      const script = win.document.createElement('script');
      script.textContent = `
        function goFS() {
          const el = document.documentElement;
          const req = el.requestFullscreen || el.webkitRequestFullscreen || el.mozRequestFullScreen || el.msRequestFullscreen;
          if (req) req.call(el).catch(e => console.warn("FS failed", e));
        }
        window.addEventListener('keydown', (e) => {
          if (e.key === 'F11') {
            e.preventDefault();
            goFS();
          }
        });
        window.addEventListener('click', goFS);
        window.addEventListener('focus', goFS);
        setTimeout(goFS, 50);
        setTimeout(goFS, 300);
      `;
      win.document.head.appendChild(script);
      try {
        const req = win.document.documentElement.requestFullscreen || (win.document.documentElement as any).webkitRequestFullscreen || (win.document.documentElement as any).mozRequestFullScreen || (win.document.documentElement as any).msRequestFullscreen;
        req?.call(win.document.documentElement)?.catch?.(() => {});
      } catch (_) {}

      previewWinRef.current = win;
      previewHostRef.current = host;
      win.addEventListener('beforeunload', () => {
        previewWinRef.current = null;
        previewHostRef.current = null;
        popupStageRef.current = null;
        setPreviewPopout(false);
      });
    }
    return win;
  }, [publishPreviewState]);
  const requestPreviewFullscreenNow = useCallback(() => {
    try {
      const win = previewWinRef.current;
      if (!win || win.closed) return;
      if ((win as any).__electronPreview) {
        (window as any).electron?.ipcRenderer?.invoke?.('focus-preview-window');
        publishPreviewState();
        return;
      }
      win.focus();
      const el = win.document.documentElement;
      const req = el.requestFullscreen || (el as any).webkitRequestFullscreen || (el as any).mozRequestFullScreen || (el as any).msRequestFullscreen;
      req?.call(el)?.catch?.(() => {});
    } catch (_) {}
  }, [publishPreviewState]);
  // ── Media Sync (Video & Audio) ─────────────────────────────────────────
  useEffect(() => {
    const visibleClips = clips.filter(c => time >= c.ts && time < c.ts + c.dur);
    const forceRestart = playing && playRestartNonce !== lastMediaRestartNonceRef.current;
    Object.entries(videoRefs.current || {}).forEach(([refId, el]) => {
      if (!el) return;
      const isExportRef = refId.startsWith("export-");
      const clipId = isExportRef ? refId.slice(7) : refId;
      
      const clip = visibleClips.find(c => c.id === clipId);
      if (!clip) {
        try { el.pause(); } catch {}
        return;
      }
      const ct = Math.max(0, time - clip.ts + (clip.startT || 0));
      
      el.muted = false;
      el.playsInline = true;
      
      const targetSrc = resolvePlaybackUrl(clip);
      if (el.getAttribute("data-cid") !== refId || el.getAttribute("data-src") !== targetSrc) {
        el.src = targetSrc;
        el.setAttribute("data-cid", refId);
        el.setAttribute("data-src", targetSrc || "");
        el.load();
        const applyTime = () => {
          try { el.currentTime = ct; } catch {}
          if (playing) {
            if (isExportRef) {
              el.play().catch(() => {});
            } else if (!isExportView) {
              el.play().catch(() => {});
            }
          }
        };
        if (el.readyState >= 1) applyTime();
        else (el as any).onloadedmetadata = applyTime;
      } else if (playing) {
        // During playback, only seek if drift is large (>0.5s) to avoid choppy interruptions
        if (forceRestart || Math.abs((el.currentTime || 0) - ct) > 0.5) {
          try { el.currentTime = ct; } catch {}
        }
      } else {
        // When paused/scrubbing, seek precisely
        if (Math.abs((el.currentTime || 0) - ct) > 0.05) {
          try { el.currentTime = ct; } catch {}
        }
      }
      
      if (playing) {
        if (isExportRef) {
          if (el.paused) el.play().catch(() => {});
        } else {
          if (isExportView) {
            if (!el.paused) el.pause();
          } else {
            if (el.paused) el.play().catch(() => {});
          }
        }
      } else {
        if (!el.paused) el.pause();
      }
    });
    if (forceRestart) lastMediaRestartNonceRef.current = playRestartNonce;
  }, [time, clips, playing, playRestartNonce, isRenderMode, isExportView, isPreviewWindow]);
  // ── Playback RAF ────────────────────────────────────────────────────────
  const registerMediaElement = useCallback((refId: string, el: any) => {
    if (el) {
      videoRefs.current[refId] = el;
      el.dataset.clipId = refId.startsWith("export-") ? refId.slice(7) : refId;
      el.playsInline = true;
      el.muted = false;
    } else {
      delete videoRefs.current[refId];
    }
  }, []);
  const mediaRefCallbacks = useRef({});
  const getMediaElementRef = useCallback((refId: string) => {
    if (!mediaRefCallbacks.current[refId]) {
      mediaRefCallbacks.current[refId] = (el: any) => registerMediaElement(refId, el);
    }
    return mediaRefCallbacks.current[refId];
  }, [registerMediaElement]);
  const togglePlayback = useCallback(() => {
    setPlaying(prev => {
      const next = !prev;
      if (next) setPlayRestartNonce(n => n + 1);
      return next;
    });
  }, []);

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
  }, [playing, totalDur]);
  // ── Keyboard ───────────────────────────────────────────────────────────
  useEffect(() => {
    const onKey = e => {
      const tag = (e.target && e.target.tagName) ? String(e.target.tagName).toUpperCase() : "";
      if (["INPUT", "TEXTAREA", "SELECT", "OPTION"].includes(tag) || e.target?.isContentEditable) return;
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") { e.preventDefault(); e.shiftKey ? redoFn() : undoFn(); return; }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "c") {
        e.preventDefault();
        if (selClipId) {
          const clip = clips.find(c => c.id === selClipId);
          if (clip) setCopiedItem({ kind: 'clip', data: { ...clip } });
        } else if (selGfxId) {
          const gfx = graphics.find(g => g.id === selGfxId);
          if (gfx) {
            setCopiedItem({
              kind: 'graphic',
              data: {
                ...gfx,
                fields: gfx.fields ? gfx.fields.map(f => ({ ...f })) : undefined,
                kf: gfx.kf ? JSON.parse(JSON.stringify(gfx.kf)) : undefined
              }
            });
          }
        }
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "v") {
        e.preventDefault();
        if (!copiedItem) return;
        snap();
        const nid = uid();
        if (copiedItem.kind === 'clip') {
          const c = { ...copiedItem.data, id: nid, ts: time, layerOrder: Date.now() };
          setClips(prev => [...prev, c]);
          setSelClipId(nid);
          setSelGfxId(null);
        } else if (copiedItem.kind === 'graphic') {
          const g = { ...copiedItem.data, id: nid, ts: time, layerOrder: Date.now() };
          setGraphics(prev => [...prev, g]);
          setSelGfxId(nid);
          setSelClipId(null);
        }
        return;
      }
      if (e.key === "Delete" || e.key === "Backspace") { e.preventDefault(); if (!deleteSelectedKeyframes()) deleteSelected(); return; }
      if (e.key === " ") { e.preventDefault(); togglePlayback(); }
      if (e.key === "v" || e.key === "V") setTool("select");
      if (e.key === "c" || e.key === "C") setTool("razor");
      if (e.key === "t" || e.key === "T") setTool("text");
    };
    document.addEventListener("keydown", onKey, true);
    const popupWin = previewWinRef.current;
    if (popupWin && !popupWin.closed) {
      try { popupWin.document.addEventListener("keydown", onKey, true); } catch (_) {}
    }
    return () => {
      document.removeEventListener("keydown", onKey, true);
      if (popupWin && !popupWin.closed) {
        try { popupWin.document.removeEventListener("keydown", onKey, true); } catch (_) {}
      }
    };
  }, [selGfxId, selClipId, selectedMediaAssetId, clips, graphics, copiedItem, time, previewPopout, selectedKeyframes, undoFn, redoFn, snap, togglePlayback]);
  // ── Canvas Interaction Mouse ────────────────────────────────────────────
  useEffect(() => {
    if (!interact) return;
    const onMove = e => {
      const rect = getStageEl()?.getBoundingClientRect();
      if (!rect) return;
      const item = interact.kind === "clip" ? clips.find(c => c.id === interact.gid) : graphics.find(g => g.id === interact.gid);
      if (!item) return;
      if (interact.mode === "move") {
        const dx = ((e.clientX - interact.px) / rect.width) * 100;
        const dy = ((e.clientY - interact.py) / rect.height) * 100;
        if (interact.kind === "clip") updateClip(interact.gid, { x: interact.sx + dx, y: interact.sy + dy });
        else updateGfx(interact.gid, { x: interact.sx + dx, y: interact.sy + dy });
      } else if (interact.mode === "scale") {
        const cx = rect.left + rect.width * (interact.sx / 100);
        const cy = rect.top + rect.height * (interact.sy / 100);
        const d = Math.max(1, Math.hypot(e.clientX - cx, e.clientY - cy));
        const ns = clamp(interact.ss * (d / interact.sd), 10, 500);
        if (interact.kind === "clip") updateClip(interact.gid, { scale: ns });
        else updateGfx(interact.gid, { scale: ns });
      } else if (interact.mode === "rotate") {
        const cx = rect.left + rect.width * (interact.sx / 100);
        const cy = rect.top + rect.height * (interact.sy / 100);
        const ang = Math.atan2(e.clientY - cy, e.clientX - cx);
        let delta = (ang - interact.sa) * 180 / Math.PI;
        let next = interact.sr + delta;
        while (next > 180) next -= 360;
        while (next < -180) next += 360;
        if (interact.kind === "clip") updateClip(interact.gid, { rotation: next });
        else updateGfx(interact.gid, { rotation: next });
      }
    };
    const onUp = () => { setInteract(null); };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    const popupWin = previewWinRef.current;
    if (popupWin && !popupWin.closed && popupWin !== window) {
      popupWin.addEventListener("mousemove", onMove);
      popupWin.addEventListener("mouseup", onUp);
    }
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      if (popupWin && !popupWin.closed && popupWin !== window) {
        popupWin.removeEventListener("mousemove", onMove);
        popupWin.removeEventListener("mouseup", onUp);
      }
    };
  }, [interact, graphics, clips, previewPopout, getStageEl]);
  // ── Timeline Drag/Resize Mouse ──────────────────────────────────────────
  useEffect(() => {
    if (!timelineDrag && !timelineResize && !keyframeDrag && !markerDrag && !playheadDrag && !keyframeSelectBox) return;
    const rowH = 72;
    const onMove = e => {
      const dx = (e.clientX - dragStart.x) / (20 * zoom);
      
      if (keyframeSelectBox) {
        setKeyframeSelectBox(box => box ? { ...box, x2: e.clientX - box.rect.left, y2: e.clientY - box.rect.top } : null);
      } else if (markerDrag === 'in') {
        const nextIn = Math.max(0, dragStart.ts + dx);
        setRenderIn(nextIn);
        setRenderOut(prev => prev != null && prev < nextIn ? nextIn : prev);
      } else if (markerDrag === 'out') {
        const nextOut = Math.max(0, dragStart.ts + dx);
        setRenderOut(nextOut);
        setRenderIn(prev => prev > nextOut ? nextOut : prev);
      } else if (playheadDrag) {
        setTime(clamp(dragStart.ts + dx, 0, totalDur || 1));
      } else if (keyframeDrag) {
        const { layerId, kind, prop, initialT, currentT } = keyframeDrag;
        const targetTime = Math.max(0, initialT + dx);
        if (Math.abs(targetTime - currentT) > 0.001) {
           const setLayer = kind === 'clip' ? setClips : setGraphics;
           const dragEntries = keyframeDrag.entries?.length ? keyframeDrag.entries : [{ prop, initialT, currentT }];
           const nextEntries: Array<{ prop: string, initialT: number, currentT: number }> = [];
           setLayer(arr => arr.map(item => {
             if (item.id !== layerId) return item;
             const nextKf = { ...(item.kf || {}) };
             dragEntries.forEach(entry => {
               const propArr = [...(nextKf[entry.prop] || [])];
               const kfIndex = propArr.findIndex(k => Math.abs(k.t - entry.currentT) < 0.001);
               const nextT = Math.max(0, entry.initialT + (targetTime - initialT));
               if (kfIndex >= 0) {
                 propArr[kfIndex] = { ...propArr[kfIndex], t: nextT };
                 propArr.sort((a, b) => a.t - b.t);
                 nextKf[entry.prop] = propArr;
                 nextEntries.push({ ...entry, currentT: nextT });
               }
             });
             return { ...item, kf: nextKf };
           }));
           const keptEntries = nextEntries.length ? nextEntries : dragEntries.map(entry => ({ ...entry, currentT: Math.max(0, entry.initialT + (targetTime - initialT)) }));
           setSelectedKeyframes(new Set(keptEntries.map(entry => `${kind}:${layerId}:${entry.prop}:${Number(entry.currentT).toFixed(3)}`)));
           setKeyframeDrag(prev => prev ? { ...prev, currentT: targetTime, entries: keptEntries } : null);
        }
      } else if (timelineDrag) {
        const ns = Math.max(0, dragStart.ts + dx);
        const groupTs = (dragStart as any).groupTs || {};
        const groupKeys = new Set(Object.keys(groupTs));
        if (groupKeys.size > 1) {
          setClips(cs => cs.map(c => {
            const key = makeTimelineKey('clip', c.id);
            return groupKeys.has(key) ? { ...c, ts: Math.max(0, Number(groupTs[key] || 0) + dx) } : c;
          }));
          setGraphics(gs => gs.map(g => {
            const key = makeTimelineKey('graphic', g.id);
            return groupKeys.has(key) ? { ...g, ts: Math.max(0, Number(groupTs[key] || 0) + dx) } : g;
          }));
        } else {
          setClips(cs => cs.map(c => c.id === timelineDrag && dragStart.kind === 'clip' ? { ...c, ts: ns } : c));
          setGraphics(gs => gs.map(g => g.id === timelineDrag && dragStart.kind === 'graphic' ? { ...g, ts: ns } : g));
        }
        
        const dy = e.clientY - dragStart.y;
        const targetIndex = Math.max(0, Math.min(getCurrentTimelineLayers().length - 1, dragStart.rowIndex + Math.round(dy / rowH)));
        setTimelineDragOffset(dy - (targetIndex - dragStart.rowIndex) * rowH);
      } else if (timelineResize) {
        const { id, side, kind } = timelineResize;
        setClips(cs => cs.map(c => {
          if (kind !== 'clip' || c.id !== id) return c;
          // Video clips cannot be resized
          if (c.type === 'video') return c;
          if (side === 'right') return { ...c, dur: Math.max(0.1, dragStart.dur + dx) };
          const ns = Math.max(0, dragStart.ts + dx);
          return { ...c, ts: ns, dur: Math.max(0.1, dragStart.dur - (ns - dragStart.ts)) };
        }));
        setGraphics(gs => gs.map(g => {
          if (kind !== 'graphic' || g.id !== id) return g;
          if (side === 'right') return { ...g, dur: Math.max(0.1, dragStart.dur + dx) };
          const ns = Math.max(0, dragStart.ts + dx);
          return { ...g, ts: ns, dur: Math.max(0.1, dragStart.dur - (ns - dragStart.ts)) };
        }));
      }
    };
    const onUp = e => {
      if (keyframeSelectBox) {
        const box = keyframeSelectBox;
        const x1 = Math.min(box.x1, box.x2);
        const x2 = Math.max(box.x1, box.x2);
        const y1 = Math.min(box.y1, box.y2);
        const y2 = Math.max(box.y1, box.y2);
        let rowTop = 52;
        const next = new Set<string>();
        getCurrentTimelineLayers().forEach(layer => {
          const isExpanded = expandedLayers.has(layer.id);
          const rowHeight = isExpanded ? 72 + 8 + (24 * 5) : 72;
          collectAllKeyframes(layer).forEach(kf => {
            const displayKt = kf.t - (layer.startT || 0);
            if (displayKt < -0.001 || displayKt > layer.dur + 0.001) return;
            const propConf = KF_PROP_CONFIG[kf.prop];
            if (!propConf) return;
            const kx = (layer.ts + displayKt) * 20 * zoom;
            const ky = rowTop + (isExpanded ? 72 + 8 + propConf.index * 24 + 12 : rowHeight - 12);
            if (kx >= x1 && kx <= x2 && ky >= y1 && ky <= y2) next.add(`${layer.__kind}:${layer.id}:${kf.prop}:${Number(kf.t).toFixed(3)}`);
          });
          rowTop += rowHeight;
        });
        setSelectedKeyframes(next);
        setKeyframeSelectBox(null);
        suppressTimelineClickRef.current = true;
        setTimeout(() => { suppressTimelineClickRef.current = false; }, 0);
        return;
      }
      if (markerDrag) {
        suppressTimelineClickRef.current = true;
        setTimeout(() => { suppressTimelineClickRef.current = false; }, 0);
      }
      if (timelineDrag) {
        const dy = e.clientY - dragStart.y;
        const shift = Math.round(dy / rowH);
        const targetIndex = Math.max(0, Math.min(getCurrentTimelineLayers().length - 1, dragStart.rowIndex + shift));
        if (targetIndex !== dragStart.rowIndex) {
          const ordered = ([
            ...clips.map((c, idx) => ({ ...c, __kind: 'clip', __label: c.name, __sort: Number(c.layerOrder ?? idx) })),
            ...graphics.map((g, idx) => ({ ...g, __kind: 'graphic', __label: g.type === 'ae_template' ? g.compName : (g.content || g.type), __sort: Number(g.layerOrder ?? (1000 + idx)) })),
          ]).sort((a, b) => b.__sort - a.__sort);
          const fromIndex = ordered.findIndex(layer => layer.id === timelineDrag && layer.__kind === dragStart.kind);
          if (fromIndex >= 0) {
            const [moved] = ordered.splice(fromIndex, 1);
            ordered.splice(targetIndex, 0, moved);
            applyLayerOrder(ordered);
          }
        }
      }
      snap();
      setTimelineDrag(null); setTimelineResize(null); setKeyframeDrag(null); setMarkerDrag(null); setPlayheadDrag(false);
      setTimelineDragOffset(0);
      const allItems = [...clips, ...graphics];
      const newTotal = Math.max(0, ...allItems.map(i => i.ts + i.dur));
      setTotalDur(newTotal);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => { window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp); };
  }, [timelineDrag, timelineResize, keyframeDrag, markerDrag, playheadDrag, keyframeSelectBox, dragStart, zoom, clips, graphics, totalDur, expandedLayers, getCurrentTimelineLayers, applyLayerOrder, snap]);

  useEffect(() => {
    if (!isResizingPanel) return;
    const onMove = (e: MouseEvent) => {
      if (isResizingPanel === 'left') {
        setLeftPanelWidth(Math.max(200, Math.min(e.clientX, window.innerWidth - rightPanelWidth - 400)));
      } else if (isResizingPanel === 'right') {
        setRightPanelWidth(Math.max(250, Math.min(window.innerWidth - e.clientX, window.innerWidth - leftPanelWidth - 400)));
      }
    };
    const onUp = () => setIsResizingPanel(null);
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, [isResizingPanel, rightPanelWidth, leftPanelWidth]);
  // ── Helpers ────────────────────────────────────────────────────────────
  const beginInteract = useCallback((e, g, mode, kind = "graphic") => {
    if (e.button !== 0) return;
    e.stopPropagation();
    const rect = getStageEl()?.getBoundingClientRect();
    if (!rect) return;
    const ct = time - g.ts + (g.startT || 0);
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
    setSelectedMediaAssetId(null);
    snap();
    setInteract({ mode, kind, gid: g.id, px: e.clientX, py: e.clientY, sx, sy, ss, sr, sd, sa });
  }, [time, getStageEl, snap]);
  const handleCanvasDown = e => {
    if (e.button !== 0) return;
    if (editingGfxId) return;
    const rect = getStageEl()?.getBoundingClientRect();
    if (!rect) return;
    const xp = ((e.clientX - rect.left) / rect.width) * 100;
    const yp = ((e.clientY - rect.top) / rect.height) * 100;
    // hit-test graphics in preview stack order (top-most first)
    const hit = getCurrentTimelineLayers().filter(l => l.__kind === 'graphic').find(g => {
      if (time < g.ts || time >= g.ts + g.dur) return false;
      const ct = time - g.ts + (g.startT || 0);
      const gx = lerp(g.kf?.x, ct, g.x);
      const gy = lerp(g.kf?.y, ct, g.y);
      const gs = lerp(g.kf?.scale, ct, g.scale) / 100;
      const hw = (g.width * gs / rect.width) * 100 / 2;
      const hh = (g.height * gs / rect.height) * 100 / 2;
      return xp >= gx - hw && xp <= gx + hw && yp >= gy - hh && yp <= gy + hh;
    });
    if (hit) {
      setSelGfxId(hit.id); setSelClipId(null); setSelectedMediaAssetId(null);
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
    const clipHit = getCurrentTimelineLayers().filter(l => l.__kind === 'clip' && l.visible !== false && time >= l.ts && time < l.ts + l.dur).find(c => {
      const cx = lerp(c.kf?.x, time - c.ts, c.x);
      const cy = lerp(c.kf?.y, time - c.ts, c.y);
      const cs = lerp(c.kf?.scale, time - c.ts, c.scale) / 100;
      const hw = (((c.sourceW || comp.w) / comp.w) * 100 / 2) * cs;
      const hh = (((c.sourceH || comp.h) / comp.h) * 100 / 2) * cs;
      return xp >= cx - hw && xp <= cx + hw && yp >= cy - hh && yp <= cy + hh;
    });
    if (clipHit) {
        setSelClipId(clipHit.id); setSelGfxId(null); setSelectedMediaAssetId(null);
      if (tool === "select") beginInteract(e, clipHit, "move", "clip");
      return;
    }
    setSelGfxId(null); setSelClipId(null); setSelectedMediaAssetId(null);
  };
  const fitAllLayers = () => {
    snap();
    setClips(cs => cs.map(c => {
      if (c.type === 'audio') return c;
      const sw = c.sourceW || 1920;
      const sh = c.sourceH || 1080;
      const s = Math.ceil(Math.min(comp.w / sw, comp.h / sh) * 100);
      return { ...c, scale: s, x: 50, y: 50 };
    }));
    setGraphics(gs => gs.map(g => ({ ...g, x: 50, y: 50 })));
  };
  // Auto-adapt canvas resolution to imported media
  const ingestFiles = useCallback(async (files) => {
    if (!files?.length) return;
    const isAnyAudio = Array.from(files).some((f: any) => f.type.startsWith('audio/') || /\.(mp3|wav|m4a|aac|ogg)$/i.test(f.name));
    requestPreviewFullscreenNow();
    
    // Preview popout is mainly for video, but we keep it active if needed
    if (!isAnyAudio) {
      preparePreviewPopout(true).then(win => {
        setPreviewPopout(true);
        requestPreviewFullscreenNow();
        setTimeout(() => { try { win?.focus(); win?.document.documentElement.requestFullscreen?.(); } catch {} }, 60);
        setTimeout(() => { try { win?.focus(); win?.document.documentElement.requestFullscreen?.(); } catch {} }, 300);
      });
    }

    const startAt = time;
    const newClips = [];
    const newAssets = [];
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      const isElectron = !!(window as any).electron && typeof (file as any).path === 'string';
      const url = isElectron ? pathToPlaybackUrl((file as any).path) : URL.createObjectURL(file);
      const isAudio = file.type.startsWith('audio/') || /\.(mp3|wav|m4a|aac|ogg)$/i.test(file.name);
      const isImage = file.type.startsWith('image/') || /\.(jpg|jpeg|png|webp|gif)$/i.test(file.name);
      
      let meta: any = { dur: 5, w: 1920, h: 1080 };
      if (isAudio) {
        meta = await new Promise(res => {
          const a = new Audio(); a.src = url;
          a.onloadedmetadata = () => res({ dur: a.duration || 5, w: 0, h: 0 });
          a.onerror = () => res({ dur: 5, w: 0, h: 0 });
        });
      } else if (isImage) {
        meta = await new Promise(res => {
          const img = new Image(); img.src = url;
          img.onload = () => res({ dur: 5, w: img.width || 1920, h: img.height || 1080 });
          img.onerror = () => res({ dur: 5, w: 1920, h: 1080 });
        });
      } else {
        meta = await new Promise(res => {
          const v = document.createElement('video'); v.src = url; v.preload = 'metadata';
          v.onloadedmetadata = () => {
            if (v.videoWidth > 0) {
              let d = v.duration;
              if (!d || isNaN(d) || d === Infinity) d = 5;
              res({ dur: d, w: v.videoWidth, h: v.videoHeight });
            }
          };
          v.onloadeddata = () => {
            let d = v.duration;
            if (!d || isNaN(d) || d === Infinity) d = 5;
            res({ dur: d, w: v.videoWidth || 1920, h: v.videoHeight || 1080 });
          };
          v.onerror = () => res({ dur: 5, w: 1920, h: 1080 });
        });
      }

      let storedPath = isElectron ? (file as any).path : null;
      let serverUrl = isElectron ? url : null;
      if (!isElectron) {
        try {
          const fd = new FormData();
          fd.append('file', file);
          const res = await fetch('/api/uploads/video', { method: 'POST', body: fd });
          if (res.ok) {
            const uploaded = await res.json();
            storedPath = uploaded.storedPath || null;
            serverUrl = uploaded.url || null;
          }
        } catch {}
      }
      
      const dur = meta.dur;
      const assetId = uid();
      const clip = { 
        id: uid(), 
        assetId,
        type: isAudio ? 'audio' : (isImage ? 'image' : 'video'),
        file, url, serverUrl, storedPath, 
        name: file.name, 
        dur, ts: startAt, startT: 0, endT: dur, 
        opacity: 1, 
        // 100% = 1:1 pixel mapping on the project canvas
        scale: 100,
        x: 50, y: 50, rotation: 0, 
        track: isAudio ? 0 : 1, 
        sourceW: meta.w, sourceH: meta.h, 
        visible: true, 
        layerOrder: Date.now() + i 
      };
      newClips.push(clip);
      newAssets.push({
        ...clip,
        id: assetId,
        assetId,
        ts: 0,
        startT: 0,
        endT: dur,
        kf: null,
        visible: true,
        layerOrder: 0,
      });
    }

    snap();
    setMediaAssets(as => [...as, ...newAssets]);
    setClips(cs => [...cs, ...newClips]);
    const minNewTs = Math.min(...newClips.map(c => c.ts));
    const maxNewEnd = Math.max(...newClips.map(c => c.ts + c.dur));
    setTotalDur(prev => Math.max(prev, maxNewEnd));
    setRenderIn(minNewTs);
    setRenderOut(maxNewEnd);
    setTime(minNewTs);

    // Automatically trigger fullscreen on the preview popup window
    try {
      const win = previewWinRef.current;
      if (win && !win.closed) {
        const el = win.document.documentElement;
        const req = el.requestFullscreen || el.webkitRequestFullscreen || el.mozRequestFullScreen || el.msRequestFullscreen;
        if (req) {
          req.call(el).catch(() => {});
        }
      }
    } catch (_) {}
  }, [clips.length, preparePreviewPopout, requestPreviewFullscreenNow, snap, time, totalDur]);
  const handleFileUpload = async e => {
    const files = Array.from(e.target.files ?? []);
    if (fileRef.current) fileRef.current.value = '';
    await ingestFiles(files);
  };
  const openVideoPicker = useCallback(async () => {
    const electronInvoke = (window as any).electron?.ipcRenderer?.invoke;
    if (typeof electronInvoke === 'function') {
      try {
        const files = await electronInvoke('open-media-dialog');
        if (Array.isArray(files) && files.length) {
          await ingestFiles(files);
        }
        return;
      } catch (err) {
        console.warn("Could not open native media dialog:", err);
      }
    }

    const picker = (window as any).showOpenFilePicker;
    if (typeof picker === 'function') {
      try {
        const handles = await picker.call(window, {
          multiple: true,
          excludeAcceptAllOption: false,
          types: [
            { description: 'Media Files', accept: { 'video/*': ['.mp4', '.mov', '.webm', '.avi', '.mkv'], 'audio/*': ['.mp3', '.wav', '.m4a', '.aac', '.ogg'], 'image/*': ['.png', '.jpg', '.jpeg', '.webp', '.gif'] } }
          ]
        });
        const files = await Promise.all(handles.map(h => h.getFile()));
        await ingestFiles(files);
        return;
      } catch (err) {
        if (err?.name === 'AbortError') return;
      }
    }
    fileRef.current?.click();
  }, [ingestFiles]);

  const pickSingleMediaFile = useCallback(async () => {
    const electronInvoke = (window as any).electron?.ipcRenderer?.invoke;
    if (typeof electronInvoke === 'function') {
      try {
        const files = await electronInvoke('open-media-dialog');
        if (Array.isArray(files) && files.length) return files[0];
      } catch (err) {
        console.warn("Could not open native relink dialog:", err);
      }
    }

    const picker = (window as any).showOpenFilePicker;
    if (typeof picker === 'function') {
      try {
        const [handle] = await picker.call(window, {
          multiple: false,
          excludeAcceptAllOption: false,
          types: [
            { description: 'Media Files', accept: { 'video/*': ['.mp4', '.mov', '.webm', '.avi', '.mkv'], 'audio/*': ['.mp3', '.wav', '.m4a', '.aac', '.ogg'], 'image/*': ['.png', '.jpg', '.jpeg', '.webp', '.gif'] } }
          ]
        });
        return handle ? await handle.getFile() : null;
      } catch (err) {
        if (err?.name === 'AbortError') return null;
      }
    }

    return await new Promise(resolve => {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = 'video/*,audio/*,image/*';
      input.onchange = () => resolve(input.files?.[0] || null);
      input.click();
    });
  }, []);

  const readMediaMeta = useCallback(async (file, url) => {
    const name = String(file?.name || '');
    const type = String(file?.type || '');
    const isAudio = type.startsWith('audio/') || /\.(mp3|wav|m4a|aac|ogg)$/i.test(name);
    const isImage = type.startsWith('image/') || /\.(jpg|jpeg|png|webp|gif)$/i.test(name);

    if (isAudio) {
      return await new Promise(res => {
        const a = new Audio(); a.src = url;
        a.onloadedmetadata = () => res({ type: 'audio', dur: a.duration || 5, w: 0, h: 0 });
        a.onerror = () => res({ type: 'audio', dur: 5, w: 0, h: 0 });
      });
    }

    if (isImage) {
      return await new Promise(res => {
        const img = new Image(); img.src = url;
        img.onload = () => res({ type: 'image', dur: 5, w: img.width || 1920, h: img.height || 1080 });
        img.onerror = () => res({ type: 'image', dur: 5, w: 1920, h: 1080 });
      });
    }

    return await new Promise(res => {
      const v = document.createElement('video'); v.src = url; v.preload = 'metadata';
      const done = () => {
        let d = v.duration;
        if (!d || isNaN(d) || d === Infinity) d = 5;
        res({ type: 'video', dur: d, w: v.videoWidth || 1920, h: v.videoHeight || 1080 });
      };
      v.onloadedmetadata = done;
      v.onloadeddata = done;
      v.onerror = () => res({ type: 'video', dur: 5, w: 1920, h: 1080 });
    });
  }, []);

  const relinkMediaAsset = useCallback(async (asset) => {
    if (!asset) return;
    const file: any = await pickSingleMediaFile();
    if (!file) return;

    const isElectronFile = !!(window as any).electron && typeof file.path === 'string';
    const localUrl = isElectronFile ? pathToPlaybackUrl(file.path) : URL.createObjectURL(file);
    let storedPath = isElectronFile ? file.path : null;
    let serverUrl = isElectronFile ? localUrl : null;

    if (!isElectronFile) {
      try {
        const fd = new FormData();
        fd.append('file', file);
        const res = await fetch('/api/uploads/video', { method: 'POST', body: fd });
        if (res.ok) {
          const uploaded = await res.json();
          storedPath = uploaded.storedPath || null;
          serverUrl = uploaded.url || localUrl;
        }
      } catch {}
    }

    const meta: any = await readMediaMeta(file, serverUrl || localUrl);
    const assetKey = asset.assetId || asset.id;
    const patch = {
      file,
      name: file.name || asset.name,
      type: meta.type || asset.type,
      url: serverUrl || localUrl,
      serverUrl: serverUrl || localUrl,
      storedPath,
      sourceW: meta.w,
      sourceH: meta.h,
      dur: Math.max(0.1, Number(meta.dur || asset.dur || 5)),
      needsRelink: false,
    };

    snap();
    setMediaAssets(as => as.map(item => {
      const itemKey = item.assetId || item.id;
      return item.id === asset.id || itemKey === assetKey
        ? { ...item, ...patch, id: item.id, assetId: item.assetId || item.id, ts: 0, startT: 0, endT: patch.dur }
        : item;
    }));
    setClips(cs => cs.map(clip => {
      const clipKey = clip.assetId || clip.id;
      if (clipKey !== assetKey && clip.id !== asset.id) return clip;
      const clipDur = Math.max(0.1, Number(clip.dur || patch.dur));
      const startT = Math.max(0, Number(clip.startT || 0));
      const endT = Math.min(Math.max(startT + 0.1, Number(clip.endT || startT + clipDur)), patch.dur);
      return {
        ...clip,
        file: patch.file,
        name: patch.name,
        type: patch.type,
        url: patch.url,
        serverUrl: patch.serverUrl,
        storedPath: patch.storedPath,
        sourceW: patch.sourceW,
        sourceH: patch.sourceH,
        needsRelink: false,
        id: clip.id,
        assetId: clip.assetId || assetKey,
        dur: clipDur,
        startT,
        endT
      };
    }));
  }, [pickSingleMediaFile, readMediaMeta, snap]);

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
          const assetAlphaBounds = await computeLottieAssetAlphaBounds(lottieData);
          lottieData.__assetAlphaBounds = assetAlphaBounds;
          const vectorModel = extractVectorSubtitleModel(lottieData);
          const nameStr = (meta?.name || base || "").toLowerCase();
          const isLottieOverride = nameStr.includes("상단_04") || nameStr.includes("상단 04") || nameStr.includes("하단_04") || nameStr.includes("하단 04") || nameStr.includes("추가예정");
          const multiTitleModel = (!vectorModel && !isLottieOverride) ? extractMultiPngTitleModel(lottieData) : null;
          if (multiTitleModel?.pairs?.length) lottieData.__customHide = {
            imageLayerIndices: [...new Set(multiTitleModel.pairs.flatMap(p => p.relatedImageLayerIndices?.length ? p.relatedImageLayerIndices : [p.imageLayerIndex]).filter(idx => Number.isFinite(idx)))],
            textLayerIndices: [...new Set(multiTitleModel.pairs.map(p => p.textLayerIndex).filter(idx => Number.isFinite(idx)))],
          };
          const detectedFields = extractLottieTextFields(lottieData, meta?.editableFields).map(field => normalizeFieldToCrop(field, cropBounds, dims.w, dims.h));
          const strictInternalText = false;
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
            templateKind: vectorModel ? "vector_subtitle" : (multiTitleModel ? "multi_png_title" : "lottie"),
            textBindingMode: vectorModel ? "overlay" : (detectedFields.length ? "internal" : "overlay"),
            fontOptions,
            glyphChars,
            vectorModel,
            multiTitleModel,
            lottieData,
            templateDuration,
            cropBounds,
            templateW: dims.w,
            templateH: dims.h,
            strictInternalText,
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
    requestPreviewFullscreenNow();
    setTimeout(requestPreviewFullscreenNow, 80);
    setTimeout(requestPreviewFullscreenNow, 300);
    snap();
    let insertBounds;
    try {
      insertBounds = getTemplateContentBounds(template, template.fields || []);
    } catch (err) {
      console.error("Template bounds failed:", err);
      const fallbackW = Math.max(1, Number(template?.templateW || template?.lottieData?.w || 1000));
      const fallbackH = Math.max(1, Number(template?.templateH || template?.lottieData?.h || 170));
      insertBounds = { x: 0, y: 0, w: fallbackW, h: fallbackH, sourceW: fallbackW, sourceH: fallbackH };
    }
    const naturalW = Math.max(1, Number(template.templateKind === "vector_subtitle" ? (template.vectorModel?.baseBarWidth || template.templateW || 1000) : (insertBounds.sourceW || template.templateW || 1000)));
    const naturalH = Math.max(1, Number(template.templateKind === "vector_subtitle" ? (template.vectorModel?.baseBarHeight || template.templateH || 170) : (insertBounds.sourceH || template.templateH || 170)));
    const cropBounds = template.templateKind === "vector_subtitle"
      ? (template.cropBounds || { x: 0, y: 0, w: naturalW, h: naturalH, sourceW: naturalW, sourceH: naturalH })
      : { x: Number(insertBounds.x || 0), y: Number(insertBounds.y || 0), w: Number(insertBounds.w || naturalW), h: Number(insertBounds.h || naturalH), sourceW: naturalW, sourceH: naturalH };
    const visibleW = Math.max(1, Number(cropBounds.w || naturalW));
    const visibleH = Math.max(1, Number(cropBounds.h || naturalH));

    let fitScale = 1;
    let defaultX = 50;
    let defaultY = 74;

    const templateLabel = String(template?.name || template?.compName || "");
    const isBottomTemplate = templateLabel.includes("하단") || templateLabel.toLowerCase().includes("bottom");
    if (template.templateKind === "vector_subtitle") {
      fitScale = (comp.w * 0.4) / visibleW;
    } else if (isBottomTemplate) {
      fitScale = Math.max(800, comp.w * 0.54) / visibleW;
      defaultY = 74;
    } else if (visibleW >= 1920) {
      fitScale = comp.w / visibleW;
      defaultX = 50;
      defaultY = 50; // Full-frame centered overlay
    } else {
      fitScale = (comp.w * 0.5) / visibleW;
    }

    const g = {
      id: uid(), type: "ae_template", content: "",
      compName: template.compName, fields: (template.fields || []).map(f => ({ ...f })),
      templateId: template.id, sourceName: template.name,
      ts: time,
      dur: Math.max(5, Number(template.templateDuration || 5)),
      x: defaultX, y: defaultY,
      width: Math.round(visibleW * fitScale),
      height: Math.round(visibleH * fitScale),
      templatePixelRatio: fitScale,
      opacity: 1, scale: 100, rotation: 0, track: 2, visible: true, layerOrder: Date.now(),
      fontFamily: "Pretendard, 'Noto Sans KR', sans-serif",
      webDef: template.webDef || null,
      lottieData: template.lottieData || null,
      vectorModel: template.vectorModel || null,
      multiTitleModel: template.multiTitleModel || null,
      templateKind: template.templateKind || "svg",
      textBindingMode: template.textBindingMode || "overlay",
      fontOptions: template.fontOptions || [],
      glyphChars: template.glyphChars || [],
      cropBounds,
      templateDuration: Number(template.templateDuration || 0),
      templateW: naturalW,
      templateH: naturalH,
      strictInternalText: !!template.strictInternalText,
    };
    setGraphics(gs => [...gs, g]);
    setSelGfxId(g.id); setSelClipId(null); setSelectedTimelineItems(new Set([`graphic:${g.id}`])); setShowAEPanel(false); setTool("select");
    const end = time + g.dur;
    setTotalDur(prev => Math.max(prev, end));
    setRenderIn(prev => Math.min(prev ?? time, time));
    setRenderOut(prev => prev == null ? end : Math.max(prev, end));
  };
  const insertMediaAsset = useCallback((asset) => {
    requestPreviewFullscreenNow();
    setTimeout(requestPreviewFullscreenNow, 80);
    setTimeout(requestPreviewFullscreenNow, 300);
    snap();
    const dur = Math.max(0.1, Number(asset.dur || asset.endT || 5));
    const id = uid();
    const clip = {
      ...asset,
      id,
      assetId: asset.assetId || asset.id,
      ts: time,
      dur,
      startT: 0,
      endT: dur,
      kf: null,
      visible: true,
      layerOrder: Date.now(),
    };
    setClips(cs => [...cs, clip]);
    setSelClipId(id);
    setSelGfxId(null);
    setSelectedMediaAssetId(null);
    setSelectedTimelineItems(new Set([`clip:${id}`]));
    setTool("select");
    const end = time + dur;
    setTotalDur(prev => Math.max(prev, end));
    setRenderIn(prev => Math.min(prev ?? time, time));
    setRenderOut(prev => prev == null ? end : Math.max(prev, end));
  }, [requestPreviewFullscreenNow, snap, time]);
  const selGfx = graphics.find(g => g.id === selGfxId);
  const selClip = clips.find(c => c.id === selClipId);
  const timelineLayers = useMemo(() => ([
    ...clips.map((c, idx) => ({ ...c, __kind: 'clip', __label: c.name, __sort: Number(c.layerOrder ?? idx), __type: c.type || 'video' })),
    ...graphics.map((g, idx) => ({ ...g, __kind: 'graphic', __label: g.type === 'ae_template' ? g.compName : (g.content || g.type), __sort: Number(g.layerOrder ?? (1000 + idx)), __type: 'graphic' })),
  ]).sort((a, b) => b.__sort - a.__sort), [clips, graphics]);
  const layerZMap = useMemo(() => {
    const map = new Map();
    timelineLayers.forEach((layer, idx) => map.set(layerKey(layer), timelineLayers.length - idx));
    return map;
  }, [timelineLayers, layerKey]);
  const visibleClips = clips.filter(c => c.visible !== false && time >= c.ts && time < c.ts + c.dur);
  const visibleGraphics = graphics.filter(g => g.visible !== false);
  const previewLayers = useMemo(() => timelineLayers
    .filter(layer => layer.visible !== false && time >= layer.ts && time < layer.ts + layer.dur)
    .sort((a, b) => (layerZMap.get(layerKey(a)) ?? 0) - (layerZMap.get(layerKey(b)) ?? 0)), [timelineLayers, time, layerZMap, layerKey]);
  const previewClip = visibleClips[0] ?? (time === 0 ? clips.find(c => c.visible !== false) || null : null);
  const editingTemplate = importedAE.find(t => t.id === editingTemplateId) || null;
  const updateGfx = (id, updates) => setGraphics(gs => gs.map(g => {
    if (g.id !== id) return g;
    if (updates.kf !== undefined) return { ...g, ...updates };
    let newKf = g.kf || {};
    let hasKfUpdates = false;
    const localTime = clamp(time - g.ts + (g.startT || 0), 0, (g.startT || 0) + g.dur);
    Object.keys(updates).forEach(key => {
      if (KEYFRAME_PROPS.includes(key) && newKf[key] && newKf[key].length > 0) {
        newKf = upsertKeyframe({ kf: newKf }, key, localTime, updates[key]);
        hasKfUpdates = true;
      }
    });
    return { ...g, ...updates, kf: hasKfUpdates ? newKf : g.kf };
  }));
  const updateClip = (id, updates) => setClips(cs => cs.map(c => {
    if (c.id !== id) return c;
    if (updates.kf !== undefined) return { ...c, ...updates };
    let newKf = c.kf || {};
    let hasKfUpdates = false;
    const localTime = clamp(time - c.ts, 0, c.dur);
    Object.keys(updates).forEach(key => {
      if (KEYFRAME_PROPS.includes(key) && newKf[key] && newKf[key].length > 0) {
        newKf = upsertKeyframe({ kf: newKf }, key, localTime, updates[key]);
        hasKfUpdates = true;
      }
    });
    return { ...c, ...updates, kf: hasKfUpdates ? newKf : c.kf };
  }));
  const handleAlign = (direction: 'horizontal' | 'vertical', alignment: 'left' | 'center' | 'right' | 'top' | 'bottom') => {
    snap();
    if (selClipId) {
      const clip = clips.find(c => c.id === selClipId);
      if (!clip) return;
      const assetW = Number(clip.sourceW || comp.w);
      const assetH = Number(clip.sourceH || comp.h);
      const clipScale = Number(clip.scale || 100) / 100;
      
      if (direction === 'horizontal') {
        const scaledWPct = (assetW * clipScale / comp.w) * 100;
        let newX = 50;
        if (alignment === 'left') {
          newX = scaledWPct / 2;
        } else if (alignment === 'center') {
          newX = 50;
        } else if (alignment === 'right') {
          newX = 100 - (scaledWPct / 2);
        }
        updateClip(clip.id, { x: newX });
      } else {
        const scaledHPct = (assetH * clipScale / comp.h) * 100;
        let newY = 50;
        if (alignment === 'top') {
          newY = scaledHPct / 2;
        } else if (alignment === 'center') {
          newY = 50;
        } else if (alignment === 'bottom') {
          newY = 100 - (scaledHPct / 2);
        }
        updateClip(clip.id, { y: newY });
      }
    } else if (selGfxId) {
      const gfx = graphics.find(g => g.id === selGfxId);
      if (!gfx) return;
      const assetW = Number(gfx.width || 200);
      const assetH = Number(gfx.height || 200);
      const gfxScale = Number(gfx.scale || 100) / 100;
      
      if (direction === 'horizontal') {
        const scaledWPct = (assetW * gfxScale / comp.w) * 100;
        let newX = 50;
        if (alignment === 'left') {
          newX = scaledWPct / 2;
        } else if (alignment === 'center') {
          newX = 50;
        } else if (alignment === 'right') {
          newX = 100 - (scaledWPct / 2);
        }
        updateGfx(gfx.id, { x: newX });
      } else {
        const scaledHPct = (assetH * gfxScale / comp.h) * 100;
        let newY = 50;
        if (alignment === 'top') {
          newY = scaledHPct / 2;
        } else if (alignment === 'center') {
          newY = 50;
        } else if (alignment === 'bottom') {
          newY = 100 - (scaledHPct / 2);
        }
        updateGfx(gfx.id, { y: newY });
      }
    }
  };
  const hasEasingAtTime = (layer, localTime) => {
    let has = false;
    KEYFRAME_PROPS.forEach(prop => {
      const kfs = layer.kf?.[prop] || [];
      const kf = kfs.find(k => Math.abs(k.t - localTime) < 0.001);
      if (kf && kf.easing === 'ease') has = true;
    });
    return has;
  };
  const toggleEasingAtPropTime = (layer: any, prop: string, localTime: number) => {
    const kfs = layer.kf?.[prop] || [];
    const kf = kfs.find((k: any) => Math.abs(k.t - localTime) < 0.001);
    const isEase = kf && kf.easing === 'ease';
    const nextEasing = isEase ? 'linear' : 'ease';
    const newKf = { ...(layer.kf || {}) };
    newKf[prop] = kfs.map((k: any) => {
      if (Math.abs(k.t - localTime) < 0.001) {
        return { ...k, easing: nextEasing };
      }
      return k;
    });
    if (layer.__kind === 'clip') updateClip(layer.id, { kf: newKf });
    else updateGfx(layer.id, { kf: newKf });
    snap();
  };
  const removeKeyframeAtPropTime = (layer: any, prop: string, localTime: number) => {
    const newKf = removeKeyframe(layer, prop, localTime);
    if (layer.__kind === 'clip') updateClip(layer.id, { kf: newKf });
    else updateGfx(layer.id, { kf: newKf });
    snap();
  };
  const deleteSelectedKeyframes = () => {
    if (selectedKeyframes.size === 0) return false;
    snap();
    setClips(cs => cs.map(c => {
      const nextKf = { ...(c.kf || {}) };
      KEYFRAME_PROPS.forEach(prop => {
        nextKf[prop] = [...(nextKf[prop] || [])].filter(k => !selectedKeyframes.has(`clip:${c.id}:${prop}:${Number(k.t).toFixed(3)}`));
      });
      return { ...c, kf: nextKf };
    }));
    setGraphics(gs => gs.map(g => {
      const nextKf = { ...(g.kf || {}) };
      KEYFRAME_PROPS.forEach(prop => {
        nextKf[prop] = [...(nextKf[prop] || [])].filter(k => !selectedKeyframes.has(`graphic:${g.id}:${prop}:${Number(k.t).toFixed(3)}`));
      });
      return { ...g, kf: nextKf };
    }));
    setSelectedKeyframes(new Set());
    setActiveKeyframePopup(null);
    return true;
  };
  const toggleLayerVisible = (kind: string, id: string) => {
    if (kind === "clip") setClips(cs => cs.map(c => c.id === id ? { ...c, visible: c.visible === false ? true : false } : c));
    else setGraphics(gs => gs.map(g => g.id === id ? { ...g, visible: g.visible === false ? true : false } : g));
  };
  const updateField = (gid, fid, val) => setGraphics(gs => gs.map(g => g.id === gid ? resizeVectorGraphic({ ...g, fields: (g.fields || []).map(f => f.id === fid ? { ...f, value: val } : f) }) : g));
  const updateFieldProps = (gid, fid, updates) => setGraphics(gs => gs.map(g => g.id === gid ? resizeVectorGraphic({ ...g, fields: (g.fields || []).map(f => f.id === fid ? { ...f, ...updates } : f) }) : g));
  const toggleGraphicKeyframe = (graphic, prop) => {
    const localTime = clamp(time - graphic.ts + (graphic.startT || 0), 0, (graphic.startT || 0) + graphic.dur);
    const currentValue = prop === "opacity" ? graphic.opacity : prop === "rotation" ? (graphic.rotation || 0) : graphic[prop];
    const isAdding = !hasKeyframeAt(graphic, prop, localTime);
    const nextKf = isAdding ? upsertKeyframe(graphic, prop, localTime, currentValue) : removeKeyframe(graphic, prop, localTime);
    setGraphics(gs => gs.map(g => g.id === graphic.id ? { ...g, kf: nextKf } : g));
    if (isAdding) setExpandedLayers(prev => new Set(prev).add(graphic.id));
    snap();
  };
  const toggleClipKeyframe = (clip, prop) => {
    const localTime = clamp(time - clip.ts, 0, clip.dur);
    const currentValue = prop === "opacity" ? clip.opacity : prop === "rotation" ? (clip.rotation || 0) : clip[prop];
    const isAdding = !hasKeyframeAt(clip, prop, localTime);
    const nextKf = isAdding ? upsertKeyframe(clip, prop, localTime, currentValue) : removeKeyframe(clip, prop, localTime);
    setClips(cs => cs.map(c => c.id === clip.id ? { ...c, kf: nextKf } : c));
    if (isAdding) setExpandedLayers(prev => new Set(prev).add(clip.id));
    snap();
  };
  const jumpToKeyframe = (item, prop, direction) => {
    const localTime = clamp(time - item.ts + (item.startT || 0), 0, (item.startT || 0) + item.dur);
    const times = (item.kf?.[prop] || []).map(k => k.t).sort((a, b) => a - b);
    if (!times.length) return;
    if (direction === "prev") {
      const prevs = times.filter(t => t < localTime - 0.001);
      if (prevs.length) {
        const target = Math.max(...prevs);
        setTime(item.ts + target - (item.startT || 0));
        setActiveKeyframePopup({ layerId: item.id, time: target, prop });
      }
    } else {
      const nexts = times.filter(t => t > localTime + 0.001);
      if (nexts.length) {
        const target = Math.min(...nexts);
        setTime(item.ts + target - (item.startT || 0));
        setActiveKeyframePopup({ layerId: item.id, time: target, prop });
      }
    }
  };
  const deleteSelected = () => {
    if (selectedMediaAssetId) {
      snap();
      const asset = mediaAssets.find(item => item.id === selectedMediaAssetId);
      const assetKey = asset?.assetId || asset?.id || selectedMediaAssetId;
      const removeIds = new Set([selectedMediaAssetId, assetKey]);
      setMediaAssets(as => as.filter(asset => asset.id !== selectedMediaAssetId));
      setClips(cs => cs.filter(clip => !removeIds.has(clip.id) && !removeIds.has(clip.assetId || clip.id)));
      setSelectedMediaAssetId(null);
      setSelClipId(null);
      return;
    }
    if (selGfxId) { snap(); setGraphics(gs => gs.filter(g => g.id !== selGfxId)); setSelGfxId(null); }
    if (selClipId) { snap(); setClips(cs => cs.filter(c => c.id !== selClipId)); setSelClipId(null); }
  };
  const createGraphicAtPoint = (kind, clientX, clientY) => {
    const rect = getStageEl()?.getBoundingClientRect();
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
  const openPreviewPopout = useCallback(async (opts: any = {}) => {
    const { activate = true, focusWindow = true, fullscreen = true, hasUserGesture = false, skipScreenDetails = false } = opts;
    const win = await preparePreviewPopout(hasUserGesture, skipScreenDetails);
    if (!win) return;
    if (activate) setPreviewPopout(true);
    if ((win as any).__electronPreview) {
      (window as any).electron?.ipcRenderer?.invoke?.('focus-preview-window');
      setTimeout(publishPreviewState, 100);
      setTimeout(publishPreviewState, 500);
      return;
    }

    // Re-apply moveTo multiple times to ensure the window is on the right monitor
    // before requesting fullscreen. Browsers may delay honoring moveTo.
    const pos = (win as any).__targetPos;
    const targetScreen = (win as any).__targetScreen;

    const ensurePosition = () => {
      try {
        if (pos) {
          win.moveTo(pos.left, pos.top);
          win.resizeTo(pos.width, pos.height);
        }
        if (focusWindow) win.focus();
      } catch (_) {}
    };

    const tryFullscreen = () => {
      try {
        if (!fullscreen) return;
        const docEl = win.document.documentElement;
        const requestMethod = docEl.requestFullscreen || (docEl as any).webkitRequestFullscreen || (docEl as any).mozRequestFullScreen || (docEl as any).msRequestFullscreen;
        if (requestMethod) {
          // Use {screen} option from Window Management API if available
          const fsOpts = targetScreen ? { screen: targetScreen } : undefined;
          requestMethod.call(docEl, fsOpts)?.catch?.((e: any) => console.warn("FS failed:", e));
          requestMethod.call(docEl)?.catch?.(() => {});
        }
      } catch (err) {
        console.warn("Fullscreen request failed:", err);
      }
    };

    // Step 1: Immediately position
    ensurePosition();
    tryFullscreen();
    // Step 2: Re-position after short delay (browser may ignore first moveTo)
    setTimeout(ensurePosition, 200);
    // Step 3: Re-position again
    setTimeout(ensurePosition, 500);
    // Step 4: THEN request fullscreen after window has settled on the target monitor
    setTimeout(() => {
      ensurePosition();
      tryFullscreen();
    }, 800);
  }, [preparePreviewPopout, publishPreviewState]);
  const closePreviewPopout = () => {
    try { previewWinRef.current?.close(); } catch {}
    previewWinRef.current = null;
    previewHostRef.current = null;
    popupStageRef.current = null;
    setPreviewPopout(false);
  };
  useEffect(() => () => { try { previewWinRef.current?.close(); } catch {} }, []);
  useEffect(() => {
    const on = (window as any).electron?.ipcRenderer?.on;
    if (typeof on !== 'function') return;
    return on('preview-window-closed', () => {
      previewWinRef.current = null;
      previewHostRef.current = null;
      popupStageRef.current = null;
      setPreviewPopout(false);
    });
  }, []);

  // Auto-fit preview zoom to the window dimensions when the popout is opened or composition size changes
  useEffect(() => {
    if (previewPopout && previewWinRef.current) {
      const win = previewWinRef.current;
      if ((win as any).__electronPreview) return;
      const fitZoom = () => {
        const w = win.innerWidth || 1280;
        const h = win.innerHeight || 720;
        const scaleX = w / Math.max(1, comp.w);
        const scaleY = h / Math.max(1, comp.h);
        const scale = Math.min(scaleX, scaleY) * 0.95; // 95% of window size for a beautiful fit with margins
        setPreviewZoom(Math.max(0.1, Math.min(5, scale)));
        setPreviewPan({ x: 0, y: 0 });
      };

      // Run immediately
      fitZoom();

      // Run again with a slight delay to ensure window geometry is fully loaded/settled
      const timer = setTimeout(fitZoom, 300);
      const timer2 = setTimeout(fitZoom, 1000);

      win.addEventListener('resize', fitZoom);
      return () => {
        clearTimeout(timer);
        clearTimeout(timer2);
        win.removeEventListener('resize', fitZoom);
      };
    }
  }, [previewPopout, comp.w, comp.h]);

  useEffect(() => {
    if (!isPreviewWindow) return;
    const fitZoom = () => {
      const scaleX = window.innerWidth / Math.max(1, comp.w);
      const controlsHeight = 56;
      const scaleY = Math.max(1, window.innerHeight - controlsHeight) / Math.max(1, comp.h);
      const scale = Math.min(scaleX, scaleY) * 0.95;
      setPreviewZoom(Math.max(0.1, Math.min(5, scale)));
      setPreviewPan({ x: 0, y: 0 });
    };
    fitZoom();
    const timer = setTimeout(fitZoom, 300);
    window.addEventListener('resize', fitZoom);
    return () => {
      clearTimeout(timer);
      window.removeEventListener('resize', fitZoom);
    };
  }, [isPreviewWindow, comp.w, comp.h]);

  // On first user click: request Window Management permission and move popup to other monitor
  useEffect(() => {
    if (!isLoggedIn || isRenderMode || isPreviewWindow) return;
    const isMultiMonitor = (window.screen as any).isExtended === true;
    if (!isMultiMonitor) return;  // Skip for single monitor

    const movePopupToOtherMonitor = async () => {
      const win = previewWinRef.current;
      if (!win || win.closed) return;
      if ((win as any).__electronPreview) return;

      try {
        if (!('getScreenDetails' in window)) return;
        const screenDetails = await (window as any).getScreenDetails();
        const currentScreen = screenDetails.currentScreen;
        const screens: any[] = screenDetails.screens;

        console.log('[Preview] User click → repositioning. Screens:', screens.length);
        screens.forEach((s: any, i: number) => {
          console.log(`[Preview]   Screen ${i}: left=${s.left} top=${s.top} w=${s.width} h=${s.height} primary=${s.isPrimary}`);
        });

        const otherScreens = screens.filter((s: any) =>
          s.left !== currentScreen.left || s.top !== currentScreen.top ||
          s.width !== currentScreen.width || s.height !== currentScreen.height
        );

        // For triple monitor: prefer the screen to the RIGHT of current
        const rightScreen = otherScreens.find((s: any) => s.left >= currentScreen.left + currentScreen.width);
        const leftScreen = [...otherScreens].reverse().find((s: any) => s.left + s.width <= currentScreen.left);
        const picked = rightScreen || leftScreen || otherScreens[0];

        if (picked) {
          console.log(`[Preview] Moving popup to screen at left=${picked.availLeft} ${picked.availWidth}x${picked.availHeight}`);
          
          // Close existing popup and reopen with correct position
          try { win.close(); } catch {}
          previewWinRef.current = null;
          previewHostRef.current = null;
          popupStageRef.current = null;

          // Small delay then reopen with user gesture context
          setTimeout(() => {
            openPreviewPopout({ fullscreen: true, focusWindow: true, hasUserGesture: true });
          }, 100);
        }
      } catch (err) {
        console.warn('[Preview] Failed to reposition:', err);
      }
    };

    // Attach one-time click listener
    const handler = () => {
      movePopupToOtherMonitor();
    };
    
    // Wait a bit for auto-open to complete first
    const timer = setTimeout(() => {
      document.addEventListener('click', handler, { once: true });
    }, 1500);

    return () => {
      clearTimeout(timer);
      document.removeEventListener('click', handler);
    };
  }, [isLoggedIn, isPreviewWindow, isRenderMode, openPreviewPopout]);

  useEffect(() => {
    if (totalDur <= 0.1) return;
    setRenderOut(prev => prev == null ? totalDur : prev);
    setRenderIn(prev => prev == null ? 0 : prev);
  }, [totalDur]);

  useEffect(() => {
    if (!renderQueue.length) return;
    const iv = setInterval(async () => {
      try {
        const res = await fetch('/api/render-jobs');
        if (!res.ok) return;
        const data = await res.json();
        if (Array.isArray(data.jobs)) {
          setRenderQueue(data.jobs.map(job => ({
            id: job.id,
            name: job.payload?.output?.fileName || `${job.id}.mp4`,
            status: job.status,
            progress: Number(job.progress || 0),
            downloadUrl: job.downloadUrl,
            error: job.error || null,
            statusText: job.statusText || '',
            currentFrame: Number(job.currentFrame || 0),
            totalFrames: Number(job.totalFrames || 0),
          })));
          
          // Auto-save to directory if completed and handle exists
          for (const jobItem of data.jobs) {
            const queueItem = {
              id: jobItem.id,
              name: jobItem.payload?.output?.fileName || `${jobItem.id}.mp4`,
              status: jobItem.status,
              progress: Number(jobItem.progress || 0),
              downloadUrl: jobItem.downloadUrl,
              error: jobItem.error || null,
              statusText: jobItem.statusText || '',
              currentFrame: Number(jobItem.currentFrame || 0),
              totalFrames: Number(jobItem.totalFrames || 0),
            };
            
            if (jobItem.status === 'completed' && (window as any)._exportDirHandle && !savedJobsRef.current.has(jobItem.id)) {
               savedJobsRef.current.add(jobItem.id);
               // Only attempt auto-save if we have a handle and it's a fresh completion
               // We catch the error silently to avoid spamming the console with SecurityErrors
               saveRemoteJobLocally(queueItem).catch(() => {});
            }
          }

          const hasActive = data.jobs.some(job => job.status === 'rendering' || job.status === 'queued' || job.status === 'preparing');
          if (hasActive) setRenderStatus('rendering');
          else {
            const hasDone = data.jobs.some(job => job.status === 'completed');
            setRenderStatus(hasDone ? 'done' : 'idle');
          }
        }
      } catch {}
    }, 1000);
    return () => clearInterval(iv);
  }, [renderQueue.length]);

  const buildRenderProjectPayload = useCallback(() => {
    const outPoint = renderOut == null ? totalDur : renderOut;
    return {
      projectName: exportSettings.filename || `hmstudio_${Date.now()}`,
      composition: { ...comp },
      renderRange: { in: Number(renderIn || 0), out: Number(outPoint || 0) },
      clips: clips.map(c => ({
        id: c.id, name: c.name, url: c.url, serverUrl: c.serverUrl || null, storedPath: c.storedPath || null, ts: c.ts, dur: c.dur, startT: c.startT || 0, endT: c.endT || c.dur,
        type: c.type || 'video',
        x: c.x, y: c.y, scale: c.scale, rotation: c.rotation || 0, opacity: c.opacity, sourceW: c.sourceW, sourceH: c.sourceH,
        visible: c.visible !== false, layerOrder: c.layerOrder ?? 0, kf: c.kf || null,
      })),
      graphics: graphics.map(g => ({
        ...g,
        visible: g.visible !== false,
        layerOrder: g.layerOrder ?? 0,
      })),
    };
  }, [clips, graphics, comp, renderIn, renderOut, totalDur, exportSettings.filename]);

  const markRenderIn = useCallback(() => {
    const nextIn = clamp(time, 0, Math.max(0, totalDur));
    snap();
    setRenderIn(nextIn);
    setRenderOut(prev => prev != null && prev < nextIn ? nextIn : prev);
  }, [time, totalDur, snap]);

  const markRenderOut = useCallback(() => {
    const nextOut = clamp(time, 0.1, Math.max(0.1, totalDur));
    snap();
    setRenderOut(nextOut);
    setRenderIn(prev => prev > nextOut ? nextOut : prev);
  }, [time, totalDur, snap]);

  const clearRenderRange = useCallback(() => {
    snap();
    setRenderIn(0);
    setRenderOut(Math.max(totalDur, 0.1));
  }, [totalDur, snap]);

  const saveRemoteJobLocally = async (job: any) => {
    try {
      // @ts-ignore
      const handle = window._exportDirHandle;
      if (!handle) return;
      
      const res = await fetch(job.downloadUrl);
      if (!res.ok) throw new Error("Failed to fetch rendered file");
      const blob = await res.blob();
      
      const fileHandle = await handle.getFileHandle(job.name, { create: true });
      const writable = await fileHandle.createWritable();
      await writable.write(blob);
      await writable.close();
      
      console.log(`Job ${job.id} saved to local directory.`);
      
      // Update UI to show saved status
      setRenderQueue(q => q.map(item => item.id === job.id ? { ...item, statusText: '✓ 파일이 지정된 위치에 저장되었습니다.' } : item));
    } catch (err: any) {
      if (err.name === 'SecurityError') {
        console.warn(`Auto-save for job ${job.id} skipped (User activation required for FileSystem API).`);
      } else {
        console.error(`Failed to auto-save job ${job.id}:`, err);
      }
    }
  };

  const handleRender = () => {
    // Sync 'PROJECT' preset resolution with current comp
    setExportPresets(prev => prev.map(p => {
      if (p.id === "PROJECT") {
        return { ...p, w: comp.w, h: comp.h, label: `프로젝트 설정 (${comp.w}×${comp.h})` };
      }
      return p;
    }));

    // Set export settings to PROJECT preset and current resolution
    setExportSettings(prev => ({
      ...prev,
      width: comp.w,
      height: comp.h,
      preset: "PROJECT"
    }));

    setIsExportView(true);
  };

  const clearRenderQueue = async () => {
    if (!window.confirm("모든 렌더 기록과 실제 파일을 삭제하시겠습니까?")) return;
    try {
      await fetch('/api/render-jobs/clear', { method: 'POST' });
      
      // @ts-ignore
      const handle = window._exportDirHandle;
      if (handle) {
        try {
          // @ts-ignore
          for await (const [name, entry] of handle.entries()) {
            if (entry.kind === 'file') {
              await handle.removeEntry(name);
            }
          }
        } catch (e) {
          console.warn("Failed to clear local directory files:", e);
        }
      }

      setRenderQueue([]);
      savedJobsRef.current.clear();
    } catch (err) {
      console.error(err);
      alert("대기열을 비우는 데 실패했습니다.");
    }
  };

  const deleteRenderJob = async (id: string) => {
    if (!window.confirm("선택한 렌더 기록과 실제 대기열 파일을 삭제하시겠습니까?")) return;
    try {
      await fetch('/api/render-jobs/delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id })
      });
      setRenderQueue(q => q.filter(item => item.id !== id));
      setRenderStatus('idle');
    } catch (err) {
      console.error(err);
      alert("항목을 삭제하는 데 실패했습니다.");
    }
  };

  const startActualRender = async () => {
    console.log("startActualRender called (Server Mode)", { clips: clips.length, graphics: graphics.length, totalDur });
    
    if (!clips.length && !graphics.length) {
      alert("렌더링할 내용(영상 또는 그래픽)이 없습니다.");
      return;
    }
    const outPoint = renderOut == null ? totalDur : renderOut;
    if (outPoint <= renderIn) {
      alert('Render Out은 Render In보다 뒤에 있어야 합니다.');
      return;
    }

    const payload = buildRenderProjectPayload();
    const outputFileName = `${exportSettings.filename || 'Untitled_Project'}.mp4`;
    
    const resolveOutputPath = (basePath, fileName) => {
      if (!basePath) return "";
      const isWindows = basePath.includes('\\') || basePath.includes(':');
      const separator = isWindows ? '\\' : '/';
      const looksLikeFile = basePath.toLowerCase().endsWith('.mp4');
      return looksLikeFile
        ? basePath
        : basePath.endsWith(separator)
          ? `${basePath}${fileName}`
          : `${basePath}${separator}${fileName}`;
    };
    const finalOutputPath = resolveOutputPath(exportSettings.path, outputFileName);

    if (finalOutputPath) {
      try {
        const existsRes = await fetch('/api/file-exists', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ path: finalOutputPath }),
        });
        if (existsRes.ok) {
          const existsData = await existsRes.json();
          if (existsData.exists) {
            const overwrite = window.confirm(`이미 같은 이름의 파일이 있습니다.\n\n${finalOutputPath}\n\n덮어쓰시겠습니까?`);
            if (!overwrite) return;
          }
        }
      } catch (err) {
        console.warn('Output file overwrite check failed:', err);
      }
    }

    // Override with export view settings
    payload.output = {
      fileName: outputFileName,
    };
    payload.composition = {
      ...comp,
      w: comp.w,
      h: comp.h,
    };
    payload.renderRange = { in: renderIn, out: outPoint };

    // Set absolute output path if manual path is provided
    if (finalOutputPath) {
      payload.output = {
        ...payload.output,
        outputPath: finalOutputPath
      };
    }


    setRenderStatus('rendering');
    
    try {
      // Automatically clear previous render jobs so they don't accumulate
      // await fetch('/api/render-jobs/clear', { method: 'POST' });
      // setRenderQueue([]);
      // savedJobsRef.current.clear();


      const res = await fetch('/api/render-jobs/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      
      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        throw new Error(errData.message || 'Render server error');
      }
      
      const job = await res.json();
      console.log("Render job started on server:", job.id);

      // Add to local queue to trigger polling immediately
      setRenderQueue(q => {
        if (q.some(j => j.id === job.id)) return q;
        return [{
          id: job.id,
          name: outputFileName,
          status: 'queued',
          progress: 0,
          statusText: '서버 대기 중...',
          currentFrame: 0,
          totalFrames: 0,
        }, ...q];
      });
      
    } catch (err: any) {
      console.error("Render start failed:", err);
      alert(`렌더 서버 연결에 실패했습니다: ${err.message || '알 수 없는 오류'}`);
      setRenderStatus('idle');
    }
  };
  // ── Timeline click ─────────────────────────────────────────────────────
  const handleTimelineClick = e => {
    if (timelineDrag || timelineResize || playheadDrag || suppressTimelineClickRef.current) return;
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
  const handleGraphicSplit = (graphicId) => {
    const idx = graphics.findIndex(g => g.id === graphicId); if (idx === -1) return;
    const graphic = graphics[idx];
    const sp = time - graphic.ts;
    if (sp <= 0 || sp >= graphic.dur) return;
    snap();
    const startT = graphic.startT || 0;
    const a = { ...graphic, id: uid(), dur: sp };
    const b = { ...graphic, id: uid(), dur: graphic.dur - sp, ts: time, startT: startT + sp };
    setGraphics(gs => { const ng = [...gs]; ng.splice(idx, 1, a, b); return ng; });
  };
  // ── Colors ─────────────────────────────────────────────────────────────
  const BG = "#0a0a0a", PANEL = "#111111", BORDER = "#27272a", ACCENT = "#f97316", ACCENT2 = "#22c55e";
  const txt = c => ({ color: c || "#a1a1aa" });
  const panel = (extra = {}) => ({ background: PANEL, border: `1px solid ${BORDER}`, ...extra });
  const previewStageNode = (popup = false) => (
    <div style={{
      display: 'flex',
      flexDirection: 'column',
      width: popup ? 'auto' : '100%',
      height: popup ? 'auto' : '56vh',
      borderBottom: popup ? 'none' : `1px solid ${BORDER}`,
      background: popup ? 'transparent' : '#0c0c0e',
      overflow: popup ? 'visible' : 'hidden'
    }}>
      {/* Modern Preview Header Bar */}
      {!popup && (
        <div style={{
          height: 38,
          background: '#121214',
          borderBottom: `1px solid ${BORDER}`,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '0 16px',
          fontSize: 12,
          fontWeight: 600,
          color: '#a1a1aa',
          userSelect: 'none',
          width: '100%',
          boxSizing: 'border-box',
          flexShrink: 0
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ color: ACCENT, fontSize: 14 }}>🎬</span>
            <span style={{ color: '#e4e4e7', fontWeight: 800, fontSize: 13 }}>
              {selClip ? `선택된 클립: ${selClip.name}` : selGfx ? `선택된 그래픽: ${selGfx.name || '자막/도형'}` : '모니터 프리뷰'}
            </span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <span style={{ color: '#38bdf8', fontSize: 13, fontWeight: 800, background: 'rgba(56,189,248,0.1)', padding: '4px 10px', borderRadius: 6, border: '1px solid rgba(56,189,248,0.2)', letterSpacing: '0.02em' }}>
              🖥️ {comp.w} × {comp.h} ({comp.w === 3840 ? '4K UHD' : comp.w === 1920 ? 'FHD' : 'HD'})
            </span>
          </div>
        </div>
      )}
      <div style={{ 
        flex: 1,
        position: 'relative', 
        background: 'linear-gradient(rgba(0,0,0,0.55), rgba(0,0,0,0.55)), repeating-conic-gradient(#2d3038 0 25%, #424653 0 50%) 0 0 / 16px 16px',
        display: 'flex', 
        alignItems: 'center', 
        justifyContent: 'center', 
        overflow: 'visible', 
        minHeight: 0
      }} onMouseDown={handleCanvasDown}>
        <div ref={popup ? popupStageRef : stageRef} style={{ position: 'relative', overflow: 'visible', background: comp.bg, ...(popup ? { width: comp.w, height: comp.h } : { aspectRatio: `${comp.w}/${comp.h}`, maxWidth: '100%', maxHeight: '100%', width: '100%' }), '--stage-scale': (popup ? 1 : (stageRef.current?.clientWidth || comp.w) / comp.w) } as any}>
          {/* Canvas Bounds Overlay (Always on top) */}
          <div style={{ position: 'absolute', inset: 0, zIndex: 9999, pointerEvents: 'none', boxShadow: 'inset 0 0 0 2px rgba(56,189,248,0.75)' }} />
          {/* Off-Canvas Dimming Mask (Dim everything outside the canvas with a 75% dark overlay) */}
          <div style={{ position: 'absolute', inset: 0, zIndex: 9998, pointerEvents: 'none', boxShadow: '0 0 0 9999px rgba(0,0,0,0.75)' }} />
        {previewLayers.length ? (
          <>
            {previewLayers.map(layer => {
              if (layer.__kind === 'clip') {
                const clip = layer;
                const clipScale = lerp(clip.kf?.scale, time - clip.ts, clip.scale) / 100;
                const clipLeft = lerp(clip.kf?.x, time - clip.ts, clip.x);
                const clipTop = lerp(clip.kf?.y, time - clip.ts, clip.y);
                const clipRot = lerp(clip.kf?.rotation, time - clip.ts, clip.rotation ?? 0);
                const clipOpacity = lerp(clip.kf?.opacity, time - clip.ts, clip.opacity);
                // Render asset at its natural dimensions with proper transform
                const assetW = (clip.sourceW || comp.w);
                const assetH = (clip.sourceH || comp.h);
                const assetWPct = (assetW / comp.w) * 100;
                const assetHPct = (assetH / comp.h) * 100;
                return (
                  <div key={clip.id} style={{ position: 'absolute', left: `${clipLeft}%`, top: `${clipTop}%`, width: `${assetWPct}%`, height: `${assetHPct}%`, transform: `translate(-50%,-50%) scale(${clipScale}) rotate(${clipRot}deg)`, transformOrigin: 'center center', zIndex: layerZMap.get(layerKey(layer)) || 1, display: clip.type === 'audio' ? 'none' : 'block' }}>
                    {clip.type === 'image' ? (
                      <img 
                        src={resolvePlaybackUrl(clip)}
                        style={{ width: '100%', height: '100%', objectFit: 'fill', opacity: clipOpacity, pointerEvents: 'none', display: 'block' }} 
                      />
                    ) : (
                    <video 
                      src={resolvePlaybackUrl(clip)}
                      ref={getMediaElementRef(clip.id)}
                      playsInline
                      muted={false}
                      preload='auto'
                      style={{ width: '100%', height: '100%', objectFit: 'fill', opacity: clipOpacity, pointerEvents: 'none', display: 'block' }} 
                    />
                    )}
                    <div onMouseDown={ev => { if (ev.button === 1) return; ev.stopPropagation(); if (tool === 'text' || tool === 'rect' || tool === 'circle') { createGraphicAtPoint(tool, ev.clientX, ev.clientY); return; } setSelClipId(clip.id); setSelGfxId(null); if (tool === 'select') beginInteract(ev, clip, 'move', 'clip'); }} style={{ position: 'absolute', inset: 0, cursor: tool === 'select' ? 'move' : 'crosshair', background: 'transparent' }} />
                  </div>
                );
              }
              const g = layer;
              const gCt = time - g.ts + (g.startT || 0);
              const gLeft = lerp(g.kf?.x, gCt, g.x);
              const gTop = lerp(g.kf?.y, gCt, g.y);
              const gScale = lerp(g.kf?.scale, gCt, g.scale) / 100;
              const gRot = lerp(g.kf?.rotation, gCt, g.rotation ?? 0);
              const gZ = layerZMap.get(layerKey(layer)) || 1;
              return (
                <React.Fragment key={g.id}>
                  <GraphicEl g={g} time={time} renderZ={gZ} selected={selGfxId === g.id} editing={editingGfxId === g.id} onEdit={() => setEditingGfxId(g.id)} onEndEdit={() => setEditingGfxId(null)} onChange={content => { updateGfx(g.id, { content }); snap(); }} />
                  {!editingGfxId && (
                    <div
                      onMouseDown={ev => {
                        if (ev.button === 1) return;
                        ev.stopPropagation();
                        setSelGfxId(g.id);
                        setSelClipId(null);
                        if (tool === 'select') beginInteract(ev, g, 'move', 'graphic');
                      }}
                      onDoubleClick={ev => {
                        ev.stopPropagation();
                        if (g.type === 'text') setEditingGfxId(g.id);
                      }}
                      style={{
                        position: 'absolute',
                        left: `${gLeft}%`,
                        top: `${gTop}%`,
                        width: `calc(${g.width}px * var(--stage-scale, 1))`,
                        height: `calc(${g.height}px * var(--stage-scale, 1))`,
                        transform: `translate(-50%,-50%) scale(${gScale}) rotate(${gRot}deg)`,
                        transformOrigin: 'center center',
                        zIndex: Math.max(1, gZ) + 500,
                        cursor: tool === 'select' ? 'move' : 'crosshair',
                        background: 'transparent',
                      }}
                    />
                  )}
                </React.Fragment>
              );
            })}
            {/* Audio Clips Hidden Sync */}
            <div style={{ display: 'none' }}>
              {clips.filter(c => c.type === 'audio' && time >= c.ts && time < c.ts + c.dur).map(c => (
                <audio 
                  key={c.id} 
                  src={resolvePlaybackUrl(c)}
                  ref={getMediaElementRef(c.id)}
                />
              ))}
            </div>
            {selClip && visibleClips.some(c => c.id === selClip.id) && (() => {
              const clipScale = lerp(selClip.kf?.scale, time - selClip.ts, selClip.scale) / 100;
              const clipLeft = lerp(selClip.kf?.x, time - selClip.ts, selClip.x);
              const clipTop = lerp(selClip.kf?.y, time - selClip.ts, selClip.y);
              const clipRot = lerp(selClip.kf?.rotation, time - selClip.ts, selClip.rotation ?? 0);
              const assetW = (selClip.sourceW || comp.w);
              const assetH = (selClip.sourceH || comp.h);
              const assetWPct = (assetW / comp.w) * 100;
              const assetHPct = (assetH / comp.h) * 100;
              return <div style={{ position: 'absolute', left: `${clipLeft}%`, top: `${clipTop}%`, width: `${assetWPct}%`, height: `${assetHPct}%`, transform: `translate(-50%,-50%) scale(${clipScale}) rotate(${clipRot}deg)`, transformOrigin: 'center center', pointerEvents: 'none', zIndex: 90, boxSizing: 'border-box', outline: `1px solid ${ACCENT}` }} />;
            })()}
            {selGfx && selGfx.visible !== false && !editingGfxId && <TransformHandles g={selGfx} time={time} stageRef={(previewPopout && popupStageRef.current) ? popupStageRef : stageRef} onBeginInteract={beginInteract} />}
          </>
        ) : <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100%', color: '#27272a' }}><div style={{ fontSize: 40, marginBottom: 8 }}>🎬</div><div style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.1em' }}>영상을 드래그하거나 추가하세요</div></div>}

        </div>
      </div>
    </div>
  );

  const renderTransportControls = (popup = false) => (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 12, padding: '8px 12px', background: popup ? 'rgba(8,8,8,0.92)' : '#080808', borderTop: popup ? `1px solid ${BORDER}` : 'none', borderBottom: popup ? 'none' : `1px solid ${BORDER}`, flexShrink: 0, backdropFilter: popup ? 'blur(6px)' : 'none', position: 'relative' }}>
      <button onClick={() => { setTime(0); setPlaying(false); }} style={{ background: 'none', border: 'none', color: '#71717a', fontSize: 16, cursor: 'pointer' }}>⏮</button>
      <button onClick={() => setTime(t => Math.max(0, t - 5))} style={{ background: 'none', border: 'none', color: '#71717a', fontSize: 14, cursor: 'pointer' }}>◁◁</button>
      <button onClick={togglePlayback} style={{ width: 40, height: 40, borderRadius: 10, background: ACCENT, border: 'none', color: '#000', fontSize: 18, cursor: 'pointer', fontWeight: 700 }}>
        {playing ? '⏸' : '▶'}
      </button>
      <button onClick={() => setTime(t => Math.min(totalDur, t + 5))} style={{ background: 'none', border: 'none', color: '#71717a', fontSize: 14, cursor: 'pointer' }}>▷▷</button>
      <button onClick={() => { setTime(totalDur); setPlaying(false); }} style={{ background: 'none', border: 'none', color: '#71717a', fontSize: 16, cursor: 'pointer' }}>⏭</button>
      {!popup && (
        <div style={{ display: 'flex', gap: 4 }}>
          <button onClick={undoFn} title='Undo (Ctrl+Z)' style={{ background: 'none', border: `1px solid ${BORDER}`, color: '#71717a', fontSize: 12, cursor: 'pointer', borderRadius: 4, padding: '2px 8px' }}>↩</button>
          <button onClick={redoFn} title='Redo (Ctrl+Shift+Z)' style={{ background: 'none', border: `1px solid ${BORDER}`, color: '#71717a', fontSize: 12, cursor: 'pointer', borderRadius: 4, padding: '2px 8px' }}>↪</button>
        </div>
      )}

      {!popup && (
        <button 
          onClick={() => openPreviewPopout({ fullscreen: true, focusWindow: true, hasUserGesture: true })} 
          style={{ 
            position: 'absolute', 
            right: 16, 
            background: 'rgba(255, 255, 255, 0.05)', 
            border: `1px solid ${BORDER}`, 
            color: '#a1a1aa', 
            padding: '6px 12px', 
            borderRadius: 6, 
            fontSize: 12, 
            fontWeight: 700, 
            cursor: 'pointer', 
            display: 'flex', 
            alignItems: 'center', 
            gap: 6,
            transition: 'all 0.15s' 
          }}
          onMouseEnter={e => { e.currentTarget.style.background = 'rgba(255, 255, 255, 0.1)'; e.currentTarget.style.color = '#fff'; }}
          onMouseLeave={e => { e.currentTarget.style.background = 'rgba(255, 255, 255, 0.05)'; e.currentTarget.style.color = '#a1a1aa'; }}
        >
          <span>⧉ 새창으로 보기</span>
        </button>
      )}
    </div>
  );
  const previewPortal = previewPopout && previewHostRef.current ? createPortal(
    <div style={{ width: '100vw', height: '100vh', overflow: 'hidden', background: '#000', display: 'flex', flexDirection: 'column', position: 'relative' }}>
      <div ref={previewScrollRef} style={{ flex: 1, minHeight: 0, overflow: 'hidden', display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'repeating-conic-gradient(#373a45 0 25%, #4b4f5d 0 50%) 0 0 / 24px 24px' }}>
        <div style={{ transform: `translate(${previewPan.x}px, ${previewPan.y}px) scale(${previewZoom})`, transformOrigin: 'center center', flexShrink: 0 }}>
          {isExportView ? (
            <div style={{ width: comp.w, height: comp.h, background: '#000', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', color: '#71717a', gap: 12 }}>
              <div style={{ fontSize: 40 }}>🎬</div>
              <div style={{ fontSize: 14, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em' }}>대기열 프리뷰 재생 중</div>
            </div>
          ) : (
            previewStageNode(true)
          )}
        </div>
      </div>
      {!isExportView && renderTransportControls(true)}
    </div>,
    previewHostRef.current
  ) : null;

  const processedGraphicsForWebGL = useMemo(() => {
    return graphics.map(g => {
      if (g.type === 'ae_template' && g.lottieData) {
        // Apply text fields using the same logic as GraphicEl
        const normalizedFields = (g.fields || []).map(field => ({
          ...field,
          useOverlay: shouldUseOverlayForField(field, g.glyphChars || []),
        }));
        const resolvedLottieData = applyLottieTextFields(g.lottieData, normalizedFields);
        return { ...g, lottieData: resolvedLottieData };
      }
      return g;
    });
  }, [graphics]);
  const isTransparent = queryParams.get('transparent') === '1';
  const isFullPageCapture = queryParams.get('fullPageCapture') === '1';
  const renderDomTemplateOverlay = isFullPageCapture;
  const webglRenderGraphics = isFullPageCapture
    ? processedGraphicsForWebGL.filter(g => !(g?.type === 'ae_template' && (g.templateKind === 'vector_subtitle' || g.templateKind === 'multi_png_title')))
    : processedGraphicsForWebGL;
  const renderOnlyStage = (
    <div style={{ position: 'fixed', top: 0, left: 0, width: comp.w, height: comp.h, background: isTransparent ? 'transparent' : '#000', overflow: 'hidden', margin: 0, padding: 0, border: 'none' }}>
      {renderJobLoaded && (
        <div style={{ position: 'relative', width: comp.w, height: comp.h, '--stage-scale': 1 } as any}>
          <WebGLRenderStage
            composition={comp}
            clips={clips}
            graphics={webglRenderGraphics}
            time={time}
            onReady={async (canvas) => {
              const isElectronIpcCapture = !!((window as any).electron && (window as any).__onElectronFrameReady);
              if (!isElectronIpcCapture) {
                await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
              }
              document.documentElement.setAttribute('data-render-ready', '1');
              document.body.setAttribute('data-render-ready', '1');

              if (isElectronIpcCapture && renderReadyResolverRef.current) {
                // In Electron IPC mode: invoke('frame-captured') inside __onElectronFrameReady
                // writes RGBA bytes to FFmpeg stdin and awaits ipcMain.handle's return.
                // We MUST await this before resolving renderReadyResolverRef so that
                // executeJavaScript in main.ts does NOT unblock until the pixel write is done.
                await (window as any).__onElectronFrameReady(canvas);
              }

              // Resolve the Promise returned by __HM_SET_RENDER_TIME.
              // In Electron mode: this happens AFTER the invoke completes (pixel written).
              // In CDP mode: this signals data-render-ready=1 for screenshot capture.
              // @ts-ignore
              if (renderReadyResolverRef.current) {
                // @ts-ignore
                const resolve = renderReadyResolverRef.current;
                // @ts-ignore
                renderReadyResolverRef.current = null;
                // Clear the hard-timeout so it doesn't fire after we've moved on
                // @ts-ignore
                const tid = (renderReadyResolverRef as any)._tid;
                if (tid) clearTimeout(tid);
                resolve(true);
              }
            }}
          />
          {renderDomTemplateOverlay && graphics
            .filter(g => {
              if (!(g.templateKind === 'vector_subtitle' || g.templateKind === 'multi_png_title')) return false;
              if (g.visible === false) return false;
              const start = Number(g.ts || 0);
              const dur = Number(g.dur || 0);
              if (!(time >= start && time < start + dur)) return false;
              if (g.templateKind === 'multi_png_title' && time - start < 1 / Math.max(1, Number(comp.fps || 30))) return false;
              return true;
            })
            .map(g => (
              <GraphicEl
                key={g.id}
                g={g}
                time={time}
                renderZ={layerZMap.get(layerKey(g)) || 1}
                selected={false}
                editing={false}
                onEdit={() => {}}
                onEndEdit={() => {}}
                onChange={() => {}}
              />
            ))}
        </div>
      )}
    </div>
  );

  const btn = (active, color = ACCENT) => ({
    background: active ? `${color}18` : "transparent", color: active ? color : "#71717a",
    border: `1px solid ${active ? color + "55" : BORDER}`, borderRadius: 6, padding: "5px 10px", fontSize: 11, cursor: "pointer", fontWeight: 600, transition: "all 0.15s"
  });
  // ── RENDER ─────────────────────────────────────────────────────────────
  const SystemStatusModal = showSystemModal && (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.9)', zIndex: 9999, display: 'flex', alignItems: 'center', justifyContent: 'center', backdropFilter: 'blur(10px)' }}>
      <div style={{ width: 520, background: '#121212', borderRadius: 16, border: `1px solid ${BORDER}`, padding: 32, boxShadow: '0 25px 50px rgba(0,0,0,0.5)' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 28 }}>
          <h3 style={{ margin: 0, fontSize: 20, fontWeight: 900, color: ACCENT, letterSpacing: '-0.02em' }}>필수 프로그램 설치 확인</h3>
          <button onClick={() => setShowSystemModal(false)} style={{ background: 'none', border: 'none', color: '#71717a', cursor: 'pointer', fontSize: 24 }}>&times;</button>
        </div>
        
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          {/* FFmpeg Section */}
          <div style={{ background: '#1a1a1a', padding: 20, borderRadius: 12, border: `1px solid ${systemStatus?.ffmpeg?.found ? '#22c55e33' : '#ef444433'}`, transition: 'all 0.2s' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 12 }}>
              <div>
                <div style={{ fontSize: 11, color: '#52525b', fontWeight: 800, textTransform: 'uppercase', marginBottom: 6, letterSpacing: '0.05em' }}>영상 인코딩 엔진</div>
                <div style={{ fontSize: 16, fontWeight: 700, color: systemStatus?.ffmpeg?.found ? '#22c55e' : '#ef4444', display: 'flex', alignItems: 'center', gap: 6 }}>
                  {systemStatus?.ffmpeg?.found ? "✅ FFmpeg 설치됨" : "❌ FFmpeg 미설치"}
                </div>
              </div>
              <button 
                onClick={installFfmpeg}
                disabled={isInstallingFfmpeg}
                style={{ 
                  padding: '8px 16px', 
                  background: systemStatus?.ffmpeg?.found ? '#27272a' : ACCENT, 
                  color: systemStatus?.ffmpeg?.found ? '#a1a1aa' : '#000', 
                  border: 'none', 
                  borderRadius: 6, 
                  fontSize: 12, 
                  fontWeight: 800, 
                  cursor: 'pointer',
                  opacity: isInstallingFfmpeg ? 0.6 : 1
                }}
              >
                {isInstallingFfmpeg ? "설치 중..." : (systemStatus?.ffmpeg?.found ? "재설치" : "엔진 설치하기")}
              </button>
            </div>
            <div style={{ fontSize: 12, color: '#71717a', lineHeight: 1.5 }}>
              {systemStatus?.ffmpeg?.found 
                ? `경로: ${systemStatus?.ffmpeg?.path}`
                : "영상 저장 및 렌더링을 위해 FFmpeg 엔진이 반드시 필요합니다."}
            </div>
          </div>

          {/* Browser Engine Section */}
          <div style={{ background: '#1a1a1a', padding: 20, borderRadius: 12, border: `1px solid ${systemStatus?.browser?.found ? '#22c55e33' : '#ef444433'}`, transition: 'all 0.2s' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 12 }}>
              <div>
                <div style={{ fontSize: 11, color: '#52525b', fontWeight: 800, textTransform: 'uppercase', marginBottom: 6, letterSpacing: '0.05em' }}>웹 렌더링 엔진</div>
                <div style={{ fontSize: 16, fontWeight: 700, color: systemStatus?.browser?.found ? '#22c55e' : '#ef4444', display: 'flex', alignItems: 'center', gap: 6 }}>
                  {systemStatus?.browser?.found ? "✅ Chrome/Edge 설치됨" : "❌ 브라우저 엔진 미설치"}
                </div>
              </div>
              <button 
                onClick={installChrome}
                disabled={isInstallingChrome}
                style={{ 
                  padding: '8px 16px', 
                  background: systemStatus?.browser?.found ? '#27272a' : ACCENT, 
                  color: systemStatus?.browser?.found ? '#a1a1aa' : '#000', 
                  border: 'none', 
                  borderRadius: 6, 
                  fontSize: 12, 
                  fontWeight: 800, 
                  cursor: 'pointer',
                  opacity: isInstallingChrome ? 0.6 : 1
                }}
              >
                {isInstallingChrome ? "설치 중..." : (systemStatus?.browser?.found ? "재설치" : "엔진 설치하기")}
              </button>
            </div>
            <div style={{ fontSize: 12, color: '#71717a', lineHeight: 1.5 }}>
              {systemStatus?.browser?.found 
                ? `경로: ${systemStatus?.browser?.path}`
                : "고성능 렌더링을 위해 Chrome 또는 Edge 브라우저 엔진이 필요합니다."}
            </div>
          </div>

          <div style={{ padding: '12px', background: '#f9731611', borderRadius: 8, border: '1px solid #f9731622', marginTop: 8 }}>
            <div style={{ fontSize: 12, color: ACCENT, fontWeight: 700, marginBottom: 4 }}>💡 도움말</div>
            <div style={{ fontSize: 11, color: '#a1a1aa', lineHeight: 1.6 }}>
              위 프로그램들은 영상 편집 및 최종 파일 생성을 위한 핵심 구성 요소입니다.<br />
              미설치 시 렌더링 기능이 작동하지 않을 수 있으므로 반드시 설치를 완료해 주세요.
            </div>
          </div>
        </div>

        <button onClick={() => setShowSystemModal(false)} style={{ width: '100%', marginTop: 28, padding: '14px', background: ACCENT, color: '#000', border: 'none', borderRadius: 8, fontSize: 14, fontWeight: 900, cursor: 'pointer', boxShadow: '0 4px 15px rgba(249, 115, 22, 0.2)' }}>설정 완료</button>
      </div>
    </div>
  );

  if (isPreviewWindow) {
    return (
      <div style={{ width: '100vw', height: '100vh', overflow: 'hidden', background: '#000', display: 'flex', flexDirection: 'column', position: 'relative', color: '#e4e4e7', fontFamily: "'Inter', 'Noto Sans KR', sans-serif", userSelect: 'none' }}>
        <div ref={previewScrollRef} style={{ flex: 1, minHeight: 0, overflow: 'hidden', display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'repeating-conic-gradient(#373a45 0 25%, #4b4f5d 0 50%) 0 0 / 24px 24px' }}>
          <div style={{ transform: `translate(${previewPan.x}px, ${previewPan.y}px) scale(${previewZoom})`, transformOrigin: 'center center', flexShrink: 0 }}>
            {isExportView ? (
              <div style={{ width: comp.w, height: comp.h, background: '#000', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', color: '#71717a', gap: 12 }}>
                <div style={{ fontSize: 14, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em' }}>Preview</div>
              </div>
            ) : (
              previewStageNode(true)
            )}
          </div>
        </div>
        {!isExportView && renderTransportControls(true)}
      </div>
    );
  }

  if (!isLoggedIn && !isRenderMode) {
    if (showSystemModal) {
      return (
        <div style={{ display: "flex", flexDirection: "column", height: "100vh", width: "100vw", background: BG, color: "#e4e4e7", fontFamily: "'Inter', 'Noto Sans KR', sans-serif", fontSize: 14, overflow: "hidden", userSelect: "none" }}>
          {SystemStatusModal}
        </div>
      );
    }
    return (
      <LoginScreenComponent
        loginId={loginId}
        setLoginId={setLoginId}
        loginPw={loginPw}
        setLoginPw={setLoginPw}
        isLoggingIn={isLoggingIn}
        loginError={loginError}
        handleLoginSubmit={handleLoginSubmit}
      />
    );
  }

  return (isRenderMode || isElectronRendering) ? renderOnlyStage : (
    <div style={{ display: "flex", flexDirection: "column", height: "100vh", width: "100vw", background: BG, color: "#e4e4e7", fontFamily: "'Inter', 'Noto Sans KR', sans-serif", fontSize: 14, overflow: "hidden", userSelect: "none" }}>
      {SystemStatusModal}
      {/* ── HEADER ── */}
      {/* ── HEADER ── */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", height: 72, padding: "0 20px", borderBottom: `1px solid ${BORDER}`, background: "#0f0f0f", flexShrink: 0 }}>
        {/* LEFT: TOOLS */}
        <div style={{ display: "flex", alignItems: "center", gap: 16, flex: 1 }}>
          <div style={{ display: "flex", alignItems: "center" }}>
            <img src="/HMStudio_logo.png" alt="HMStudio Logo" style={{ height: 50, objectFit: 'contain', display: 'block' }} />
          </div>
          
          <div style={{ width: 1, height: 40, background: BORDER, margin: "0 8px" }} />

          <div style={{ display: "flex", alignItems: "center", gap: 8, background: 'rgba(255,255,255,0.02)', padding: '4px 8px', borderRadius: 12, border: `1px solid ${BORDER}` }}>
            {[
              { t: "select", label: "↖", text: "선택(V)", tip: "선택 (V)" },
              { t: "razor", label: "✂", text: "자르기(C)", tip: "자르기 (C)" },
              { t: "text", label: "T", text: "텍스트(T)", tip: "텍스트 (T)" },
              { t: "rect", label: "▬", text: "사각형", tip: "사각형" },
              { t: "circle", label: "●", text: "원", tip: "원" },
            ].map(({ t, label, text, tip }) => (
              <button key={t} title={tip} onClick={() => setTool(t)}
                style={{ 
                   width: 64, height: 58, borderRadius: 8, border: `1px solid ${tool === t ? ACCENT + "88" : "transparent"}`, 
                  background: tool === t ? ACCENT + "18" : "transparent", color: tool === t ? ACCENT : "#71717a", 
                  cursor: "pointer", fontWeight: 700, transition: 'all 0.1s',
                  display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 2
                }}>
                <span style={{ fontSize: t === "text" ? 18 : 22, height: 26, display: 'flex', alignItems: 'center' }}>{label}</span>
                <span style={{ fontSize: 13, fontWeight: 800 }}>{text}</span>
              </button>
            ))}
          </div>
        </div>

        {/* CENTER: COMPOSITION SETTINGS (MOVED FROM TIMELINE) */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 24, flex: 1.5, justifyContent: 'center' }}>
          {/* Direct Inputs */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
            {[["가로", "w", 16, 7680], ["세로", "h", 16, 4320], ["프레임 수", "fps", 1, 60]].map(([l, k, mn, mx]) => (
              <div key={k} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ fontSize: 13, color: '#71717a', fontWeight: 900 }}>{l}</span>
                <input
                  type="number"
                  value={comp[k]}
                  min={mn}
                  max={mx}
                  onChange={e => setComp(c => ({ ...c, [k]: Number(e.target.value) || 0 }))}
                  onBlur={e => {
                    const val = Number(e.target.value);
                    setComp(c => ({ ...c, [k]: Math.max(mn, Math.min(mx, val || mn)) }));
                  }}
                  onFocus={e => e.target.select()}
                  style={{
                    width: k === 'fps' ? 60 : 85,
                    background: '#000000',
                    border: `1px solid ${BORDER}`,
                    color: ACCENT,
                    fontSize: 16,
                    fontWeight: 800,
                    padding: '6px 8px',
                    borderRadius: 8,
                    outline: 'none',
                    textAlign: 'center',
                    fontFamily: 'monospace',
                    boxShadow: '0 4px 12px rgba(0,0,0,0.5)'
                  }}
                />
              </div>
            ))}
          </div>

          {/* 총 길이 */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, paddingLeft: 16, borderLeft: `1px solid ${BORDER}` }}>
            <span style={{ fontSize: 13, color: '#71717a', fontWeight: 900 }}>총 길이</span>
            <input
              type="number"
              value={Math.round(totalDur)}
              min={1}
              max={36000}
              onChange={e => setTotalDur(Number(e.target.value) || 1)}
              onBlur={e => {
                const val = Number(e.target.value);
                setTotalDur(Math.max(1, Math.min(36000, val || 1)));
              }}
              onFocus={e => e.target.select()}
              style={{
                width: 70,
                background: '#000000',
                border: `1px solid ${BORDER}`,
                color: ACCENT,
                fontSize: 16,
                fontWeight: 800,
                padding: '6px 8px',
                borderRadius: 8,
                outline: 'none',
                textAlign: 'center',
                fontFamily: 'monospace',
                boxShadow: '0 4px 12px rgba(0,0,0,0.5)'
              }}
            />
            <span style={{ fontSize: 13, color: '#a1a1aa', fontWeight: 800, fontFamily: 'monospace' }}>
              초 <span style={{ color: '#52525b', fontWeight: 600 }}>({fmt(totalDur)})</span>
            </span>
          </div>

          {/* Background Color */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontSize: 13, color: '#71717a', fontWeight: 900 }}>배경색</span>
            <input
              type="color"
              value={comp.bg}
              onChange={e => setComp(c => ({ ...c, bg: e.target.value }))}
              style={{
                width: 34,
                height: 34,
                background: '#000000',
                border: `1px solid ${BORDER}`,
                borderRadius: 8,
                padding: 3,
                cursor: 'pointer'
              }}
            />
          </div>

          {/* Presets */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, paddingLeft: 12, borderLeft: `1px solid ${BORDER}` }}>
            {[
              { label: "4K", w: 3840, h: 2160 },
              { label: "FHD", w: 1920, h: 1080 },
              { label: "HD", w: 1280, h: 720 },
              { label: "사이니지", w: 7680, h: 2160 },
            ].map(p => (
              <button 
                key={p.label}
                onClick={() => { snap(); setComp(c => ({ ...c, w: p.w, h: p.h })); }}
                style={{ 
                  padding: "6px 10px", 
                  background: (comp.w === p.w && comp.h === p.h) ? ACCENT : "rgba(255,255,255,0.05)", 
                  color: (comp.w === p.w && comp.h === p.h) ? "#000" : "#a1a1aa", 
                  border: `1px solid ${(comp.w === p.w && comp.h === p.h) ? ACCENT : BORDER}`, 
                  borderRadius: 6, 
                  fontSize: 12, 
                  fontWeight: 800, 
                  cursor: "pointer",
                  transition: "all 0.15s"
                }}
              >
                {p.label}
              </button>
            ))}
          </div>
        </div>

        {/* RIGHT: PROJECT ACTIONS */}
        <div style={{ display: "flex", gap: 8, alignItems: "center", flex: 1, justifyContent: "flex-end" }}>
          <button onClick={newProject} style={{ ...btn(false), fontSize: 13, padding: '6px 14px' }}>새 프로젝트</button>
          <button onClick={() => projectFileRef.current?.click()} style={{ ...btn(false), fontSize: 13, padding: '6px 14px' }}>📂 프로젝트 불러오기</button>
          <button onClick={saveProject} style={{ ...btn(false), fontSize: 13, padding: '6px 14px' }}>💾 프로젝트 저장</button>
          <input ref={projectFileRef} type="file" accept=".json" style={{ display: "none" }} onChange={loadProject} />
          <button onClick={handleRender} style={{ background: ACCENT, color: "#000", border: "none", borderRadius: 6, padding: "8px 24px", fontSize: 14, fontWeight: 800, cursor: "pointer", marginLeft: 4 }}>
            ▶ Render
          </button>
        </div>
      </div>
      <div style={{ display: "flex", flex: 1, overflow: "hidden", position: "relative" }}>
        {/* Resize Overlay */}
        {isResizingPanel && <div style={{ position: "absolute", top: 0, left: 0, right: 0, bottom: 0, zIndex: 9999, cursor: "col-resize" }} />}
        
        {/* ── ASSET PANEL (Lowest Priority) ── */}
        <div style={{ width: leftPanelWidth, borderRight: `1px solid ${BORDER}`, background: "#000000", display: "flex", flexDirection: "column", flexShrink: 0, overflow: "hidden" }}>
          <div className="no-scrollbar" style={{ flex: 1, overflowY: "auto", padding: "20px 10px" }}>
            {/* Video Assets */}
            <div style={{ marginBottom: 24 }}>
              <div style={{ fontSize: 16, color: ACCENT, fontWeight: 900, marginBottom: 12, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <span>📁 원본 푸티지</span>
              </div>
              <div style={{ maxHeight: 320, overflowY: "auto", marginBottom: 12, paddingRight: 4 }}>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: 10 }}>
                  {mediaAssets.map(c => {
                    const assetKey = c.assetId || c.id;
                    const isInTimeline = clips.some(clip => (clip.assetId || clip.id) === assetKey);
                    const isSelected = selectedMediaAssetId === c.id;
                    const needsRelink = !!c.needsRelink;
                    return (
                    <div key={c.id}
                      onClick={() => {
                        setSelectedMediaAssetId(c.id);
                        setSelClipId(null);
                        setSelGfxId(null);
                        setSelectedTimelineItems(new Set());
                        setSelectedKeyframes(new Set());
                      }}
                      style={{ 
                        padding: 8, 
                        borderRadius: 8, 
                        background: needsRelink ? "#2a1111" : (isSelected ? ACCENT + "22" : (isInTimeline ? ACCENT + "14" : "#141414")),
                        border: `1px solid ${needsRelink ? "#ef4444" : (isSelected ? ACCENT : (isInTimeline ? ACCENT + "88" : BORDER))}`,
                        color: isSelected ? "#fff" : "#a1a1aa", 
                        cursor: "pointer",
                        display: "flex", 
                        flexDirection: "column", 
                        gap: 8, 
                        alignItems: "center",
                        textAlign: "center",
                        transition: "all 0.1s",
                        minWidth: 0,
                        width: '100%'
                      }}>
                      <div style={{ width: "100%", aspectRatio: "16/9", background: "#000", borderRadius: 4, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 24, boxShadow: "inset 0 0 10px rgba(0,0,0,0.5)", overflow: 'hidden' }}>
                        🎬
                      </div>
                      <span style={{ fontSize: 11, fontWeight: "normal", width: "100%", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{c.name}</span>
                      {needsRelink && <span style={{ fontSize: 10, color: "#fca5a5", fontWeight: 800 }}>링크 끊김</span>}
                      <button onClick={(e) => { e.stopPropagation(); insertMediaAsset(c); }}
                        style={{ width: "100%", padding: "7px 8px", background: ACCENT, color: "#000", border: "none", borderRadius: 6, fontSize: 11, fontWeight: 800, cursor: "pointer" }}>
                        삽입
                      </button>
                      {needsRelink && <button onClick={(e) => { e.stopPropagation(); relinkMediaAsset(c); }}
                        style={{ width: "100%", padding: "7px 8px", background: needsRelink ? "#ef4444" : "transparent", color: needsRelink ? "#fff" : ACCENT, border: `1px solid ${needsRelink ? "#ef4444" : ACCENT + "88"}`, borderRadius: 6, fontSize: 11, fontWeight: 800, cursor: "pointer" }}>
                        파일 연결
                      </button>}
                    </div>
                    );
                  })}
                </div>
              </div>
              <button onClick={() => { openVideoPicker(); }}
                style={{ width: "100%", padding: "12px", borderRadius: 8, background: "transparent", border: `1px solid ${ACCENT}88`, color: ACCENT, fontSize: 14, fontWeight: 800, cursor: "pointer", marginTop: 4, display: "flex", alignItems: "center", justifyContent: "center", gap: 8 }}>
                <span style={{ fontSize: 18 }}>+</span> 미디어 추가
              </button>
              <input ref={fileRef} type="file" accept="video/*,audio/*,image/*" multiple className="hidden" style={{ display: "none" }} onChange={handleFileUpload} />
            </div>
            <div style={{ height: 1, background: BORDER, margin: "8px 0" }} />
            {/* AE Templates - 상단 자막 */}
            <div style={{ marginBottom: 20 }}>
              <div style={{ fontSize: 16, color: ACCENT2, fontWeight: 900, marginBottom: 12 }}>
                <span>🎨 상단 자막</span>
              </div>
              <div style={{ maxHeight: 450, overflowY: "auto", marginBottom: 12, paddingRight: 4 }}>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: 10 }}>
                  {importedAE.filter(t => (t.name || "").includes("상단")).map(t => (
                    <div key={t.id}
                      style={{ 
                        padding: 10, 
                        borderRadius: 8, 
                        background: "#0a1a0a", 
                        border: `1px solid ${ACCENT2}55`,
                        display: 'flex',
                        flexDirection: 'column',
                        minWidth: 0,
                        width: '100%'
                      }}>
                      <div onClick={() => addAETemplate(t)} style={{ cursor: "pointer", display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
                        <div style={{ width: "100%", aspectRatio: "16/9", background: "#000", borderRadius: 6, overflow: "hidden", marginBottom: 10, display: "flex", alignItems: "center", justifyContent: "center", boxShadow: "0 4px 12px rgba(0,0,0,0.5)" }}>
                          <TemplateThumbnail template={t} fontFamily="Pretendard, 'Noto Sans KR', sans-serif" />
                        </div>
                        <div style={{ fontSize: 11, color: "#fff", fontWeight: 400, width: '100%', marginBottom: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', textAlign: 'center' }}>{t.name}</div>
                      </div>
                      <div style={{ display: "flex", gap: 6, marginTop: 8 }}>
                        <button onClick={(e) => { e.stopPropagation(); addAETemplate(t); }} style={{ flex: 1, padding: "6px", background: ACCENT2, color: "#000", border: "none", borderRadius: 6, fontSize: 11, fontWeight: 800, cursor: "pointer" }}>삽입</button>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </div>

            <div style={{ height: 1, background: BORDER, margin: "16px 0" }} />

            {/* AE Templates - 하단 자막 */}
            <div style={{ marginBottom: 24 }}>
              <div style={{ fontSize: 16, color: "#38bdf8", fontWeight: 900, marginBottom: 12 }}>
                <span>🎨 하단 자막</span>
              </div>
              <div style={{ maxHeight: 450, overflowY: "auto", marginBottom: 12, paddingRight: 4 }}>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: 10 }}>
                  {importedAE.filter(t => !(t.name || "").includes("상단")).map(t => (
                    <div key={t.id}
                      style={{ 
                        padding: 10, 
                        borderRadius: 8, 
                        background: "#0a121c", 
                        border: `1px solid #38bdf855`,
                        display: 'flex',
                        flexDirection: 'column',
                        minWidth: 0,
                        width: '100%'
                      }}>
                      <div onClick={() => addAETemplate(t)} style={{ cursor: "pointer", display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
                        <div style={{ width: "100%", aspectRatio: "16/9", background: "#000", borderRadius: 6, overflow: "hidden", marginBottom: 10, display: "flex", alignItems: "center", justifyContent: "center", boxShadow: "0 4px 12px rgba(0,0,0,0.5)" }}>
                          <TemplateThumbnail template={t} fontFamily="Pretendard, 'Noto Sans KR', sans-serif" />
                        </div>
                        <div style={{ fontSize: 11, color: "#fff", fontWeight: 400, width: '100%', marginBottom: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', textAlign: 'center' }}>{t.name}</div>
                      </div>
                      <div style={{ display: "flex", gap: 6, marginTop: 8 }}>
                        <button onClick={(e) => { e.stopPropagation(); addAETemplate(t); }} style={{ flex: 1, padding: "6px", background: "#38bdf8", color: "#000", border: "none", borderRadius: 6, fontSize: 11, fontWeight: 800, cursor: "pointer" }}>삽입</button>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </div>

          {/* 템플릿 불러오기 버튼 - 맨 아래 고정 */}
          <div style={{ padding: "10px 10px 20px 10px", borderTop: `1px solid ${BORDER}`, background: "#000000", flexShrink: 0, zIndex: 10 }}>
            <button onClick={() => aeFileRef.current?.click()}
              style={{ width: "100%", padding: "12px", borderRadius: 8, background: "transparent", border: "1px solid #3f3f46", color: "#a1a1aa", fontSize: 13, fontWeight: 700, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", gap: 8 }}>
              <span style={{ fontSize: 18 }}>+</span> 템플릿 불러오기
            </button>
            <input ref={aeFileRef} type="file" accept=".json,.aep,.png,.jpg,.jpeg,.webp" multiple style={{ display: "none" }} onChange={handleAEImport} />
          </div>
        </div>

        {/* Left Resizer */}
        <div 
          onMouseDown={() => setIsResizingPanel('left')}
          style={{ width: 6, margin: "0 -3px", zIndex: 100, cursor: "col-resize", background: "transparent", flexShrink: 0 }}
          onMouseEnter={e => e.currentTarget.style.background = "rgba(255,255,255,0.1)"}
          onMouseLeave={e => e.currentTarget.style.background = "transparent"}
        />

        {/* ── CENTER: PREVIEW + TIMELINE ── */}
        <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden", minWidth: 0 }}>
          {/* Preview */}
          {!previewPopout && previewStageNode(false)}
          {/* Playback Controls */}
          {!previewPopout && renderTransportControls(false)}
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16, padding: '12px 24px', background: '#18181b', borderBottom: `1px solid ${BORDER}`, flexShrink: 0 }}>
            {/* ── LEFT: TIMELINE CONTROLS ── */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 32 }}>
              {/* Current Time */}
              <div 
                style={{ display: 'flex', alignItems: 'center', gap: 12, background: '#161616', padding: '8px 16px', borderRadius: 8, border: `1px solid ${isEditingTime ? ACCENT : BORDER}`, cursor: 'pointer', transition: 'all 0.1s' }}
                title="클릭하여 시간 수정"
              >
                <span style={{ fontSize: 14, color: '#52525b', fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.05em' }}>현재 시간</span>
                {isEditingTime ? (
                  <input
                    autoFocus
                    type="text"
                    value={timeInput}
                    onChange={e => setTimeInput(e.target.value)}
                    onBlur={() => {
                      setIsEditingTime(false);
                      const input = timeInput;
                      let newTime = 0;
                      if (input.includes(":")) {
                        const parts = input.split(":").map(Number);
                        if (parts.length === 4) newTime = parts[0] * 3600 + parts[1] * 60 + parts[2] + parts[3] / 30;
                        else if (parts.length === 3) newTime = parts[0] * 3600 + parts[1] * 60 + parts[2];
                        else if (parts.length === 2) newTime = parts[0] * 60 + parts[1];
                      } else {
                        newTime = Number(input);
                      }
                      if (!isNaN(newTime)) setTime(clamp(newTime, 0, totalDur || 1));
                    }}
                    onKeyDown={e => {
                      if (e.key === 'Enter') e.currentTarget.blur();
                      if (e.key === 'Escape') setIsEditingTime(false);
                    }}
                    style={{ background: 'transparent', border: 'none', color: ACCENT, fontSize: 22, fontWeight: 900, fontFamily: 'monospace', width: 140, textAlign: 'center', outline: 'none', padding: 0 }}
                  />
                ) : (
                  <span 
                    onClick={() => {
                      setTimeInput(fmt(time));
                      setIsEditingTime(true);
                    }}
                    style={{ fontSize: 22, color: ACCENT, fontWeight: 900, fontFamily: 'monospace', minWidth: 140, textAlign: 'center' }}
                  >
                    {fmt(time)}
                  </span>
                )}
              </div>

              <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                <button onClick={markRenderIn} style={{ background: 'transparent', color: '#22c55e', border: `1px solid ${BORDER}`, borderRadius: 8, padding: '8px 16px', fontSize: 15, fontWeight: 700, cursor: 'pointer', transition: 'all 0.15s' }}>렌더 범위(시작)</button>
                <button onClick={markRenderOut} style={{ background: 'transparent', color: '#f43f5e', border: `1px solid ${BORDER}`, borderRadius: 8, padding: '8px 16px', fontSize: 15, fontWeight: 700, cursor: 'pointer', transition: 'all 0.15s' }}>렌더 범위(끝)</button>
                <button onClick={clearRenderRange} style={{ background: 'transparent', color: '#71717a', border: `1px solid ${BORDER}`, borderRadius: 8, padding: '8px 16px', fontSize: 15, fontWeight: 700, cursor: 'pointer', transition: 'all 0.15s' }}>초기화</button>
              </div>

            </div>

            {/* ── RIGHT: TIMELINE ZOOM ── */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <span style={{ fontSize: 14, color: '#52525b', fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.05em' }}>타임라인 확대</span>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ fontSize: 16, color: '#3f3f46' }}>-</span>
                <input type='range' min={0.3} max={5} step={0.1} value={zoom} onChange={e => setZoom(Number(e.target.value))} 
                  style={{ width: 140, height: 6, appearance: 'none', background: '#1e1e20', borderRadius: 3, outline: 'none', accentColor: ACCENT }} />
                <span style={{ fontSize: 16, color: '#3f3f46' }}>+</span>
              </div>
              <span style={{ fontSize: 14, color: '#a1a1aa', fontWeight: 700, minWidth: 40 }}>{Math.round(zoom * 100)}%</span>
            </div>
          </div>
          {/* Timeline (Highest Priority) */}
          <div style={{ flex: 1, display: "flex", overflow: "hidden", minHeight: 0, background: "#18181b" }}>
            <div style={{ width: 220, background: "#18181b", borderRight: `1px solid ${BORDER}`, flexShrink: 0, paddingTop: 52, position: "relative" }}>
              <div style={{ position: "absolute", top: 0, left: 0, right: 0, height: 52, borderBottom: `1px solid ${BORDER}`, display: "flex", flexDirection: "column", justifyContent: "center", padding: "0 8px", background: "#18181b", color: "#a1a1aa", fontSize: 10, fontWeight: 700, lineHeight: "1.4", zIndex: 20, letterSpacing: "-0.03em" }}>
                <div style={{ whiteSpace: "nowrap" }}>타임라인을 클릭하면 재생 바가 이동합니다 →</div>
                <div style={{ color: "#71717a", fontSize: 9.5, fontWeight: 500, whiteSpace: "nowrap" }}>(재생/정지 스페이스바)</div>
              </div>
              {timelineLayers.map((layer, idx) => {
                const isBottomSub = layer.__kind === 'graphic' && !(layer.sourceName || layer.compName || "").includes("상단");
                const labelColor = layer.__kind === 'clip' ? ACCENT : (isBottomSub ? '#38bdf8' : ACCENT2);
                const labelIcon = layer.__type === 'video' ? 'V' : layer.__type === 'audio' ? 'A' : 'G';
                const isExpanded = expandedLayers.has(layer.id);
                return (
                  <div key={layer.id} style={{ display: "flex", flexDirection: "column", borderBottom: `1px solid ${BORDER}`, background: idx % 2 ? "#1c1c1f" : "#18181b" }}>
                    <div style={{ height: 72, display: "flex", alignItems: "center", gap: 10, padding: "0 14px", fontSize: 12, color: "#a1a1aa", fontWeight: 600 }}>
                      <button onClick={e => { e.stopPropagation(); toggleLayerExpand(layer.id); }} style={{ width: 20, height: 20, display: "flex", alignItems: "center", justifyContent: "center", background: "transparent", border: "none", color: "#a1a1aa", cursor: "pointer", transition: "transform 0.2s", transform: isExpanded ? "rotate(90deg)" : "none", padding: 0 }}>
                        ▶
                      </button>
                      <button onClick={e => { e.stopPropagation(); toggleLayerVisible(layer.__kind, layer.id); snap(); }} style={{ width: 24, height: 24, borderRadius: 6, border: `1px solid ${BORDER}`, background: "transparent", color: layer.visible === false ? "#52525b" : labelColor, cursor: "pointer", fontSize: 13, padding: 0 }}>
                        {layer.visible === false ? '○' : '◉'}
                      </button>
                      <div style={{ flex: 1, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{layer.__label}</div>
                    </div>
                    {isExpanded && (
                      <div style={{ paddingBottom: 8 }}>
                        {Object.values(KF_PROP_CONFIG).map((pConf, i) => (
                          <div key={i} style={{ height: 24, display: 'flex', alignItems: 'center', paddingLeft: 84, fontSize: 13, color: ACCENT, fontWeight: 400, borderTop: `1px solid rgba(255,255,255,0.02)` }}>
                            {pConf.label}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
            <div style={{ flex: 1, overflowX: "auto", overflowY: "auto", position: "relative", background: "#18181b" }}>
              <div
                style={{ position: "relative", minWidth: "100%", width: `${Math.max(600, totalDur * 20 * zoom + 200)}px`, cursor: tool === "razor" ? "crosshair" : "default" }}
                onClick={handleTimelineClick}
                onMouseDown={e => {
                  if (e.button !== 0 || tool !== "select" || e.shiftKey) return;
                  const rect = e.currentTarget.getBoundingClientRect();
                  setKeyframeSelectBox({ rect, x1: e.clientX - rect.left, y1: e.clientY - rect.top, x2: e.clientX - rect.left, y2: e.clientY - rect.top });
                }}>
                <div
                  onMouseDown={e => {
                    if (e.button !== 0) return;
                    e.stopPropagation();
                    const rect = e.currentTarget.parentElement?.getBoundingClientRect();
                    if (!rect) return;
                    const nextTime = clamp((e.clientX - rect.left) / (20 * zoom), 0, totalDur || 1);
                    setPlaying(false);
                    setTime(nextTime);
                    setPlayheadDrag(true);
                    setDragStart({ x: e.clientX, y: e.clientY, ts: nextTime, dur: 0, rowIndex: 0, kind: 'playhead' });
                  }}
                  style={{ height: 52, background: "#18181b", borderBottom: `1px solid ${BORDER}`, position: "sticky", top: 0, zIndex: 10, display: "flex", alignItems: "flex-end", cursor: "ew-resize" }}>
                  {Array.from({ length: Math.ceil(totalDur / 1) + 5 }).map((_, i) => (
                    <div key={i} style={{ position: "absolute", left: i * 20 * zoom, fontSize: 11, color: "#52525b", paddingBottom: 4, pointerEvents: "none", whiteSpace: "nowrap", fontWeight: 600 }}>
                      {i % Math.max(1, Math.round(5 / zoom)) === 0 ? fmt(i) : ""}
                      <div style={{ width: 1, height: i % Math.max(1, Math.round(5 / zoom)) === 0 ? 10 : 5, background: "#3f3f46", position: "absolute", bottom: 0, left: 0 }} />
                    </div>
                  ))}
                </div>
                <div style={{ position: 'absolute', top: 52, bottom: 0, left: renderIn * 20 * zoom, width: Math.max(2, (Math.max(renderIn, renderOut == null ? totalDur : renderOut) - renderIn) * 20 * zoom), background: 'rgba(34,197,94,0.08)', boxShadow: 'inset 0 0 0 1px rgba(34,197,94,0.18)', pointerEvents: 'none' }} />
                {keyframeSelectBox && (
                  <div style={{
                    position: 'absolute',
                    left: Math.min(keyframeSelectBox.x1, keyframeSelectBox.x2),
                    top: Math.min(keyframeSelectBox.y1, keyframeSelectBox.y2),
                    width: Math.abs(keyframeSelectBox.x2 - keyframeSelectBox.x1),
                    height: Math.abs(keyframeSelectBox.y2 - keyframeSelectBox.y1),
                    background: 'rgba(56,189,248,0.14)',
                    border: '1px solid rgba(56,189,248,0.8)',
                    pointerEvents: 'none',
                    zIndex: 200
                  }} />
                )}
                <div 
                  onMouseDown={e => {
                    if (e.button !== 0) return;
                    e.stopPropagation();
                    e.preventDefault();
                    suppressTimelineClickRef.current = true;
                    snap();
                    setMarkerDrag('in');
                    setDragStart({ x: e.clientX, y: e.clientY, ts: renderIn, dur: 0, rowIndex: 0, kind: 'marker' });
                  }}
                  style={{ position: 'absolute', top: 0, height: 52, left: renderIn * 20 * zoom, width: 28, transform: 'translateX(-50%)', background: 'transparent', zIndex: 110, cursor: 'ew-resize' }}
                >
                  <div style={{ position: 'absolute', top: 52, left: '50%', transform: 'translateX(-50%)', width: 2, height: 9999, background: '#22c55e', pointerEvents: 'none' }} />
                  <div style={{ position: 'absolute', top: 38, left: '50%', transform: 'translateX(-50%)', width: 0, height: 0, borderLeft: '5px solid transparent', borderRight: '5px solid transparent', borderTop: '10px solid #22c55e', pointerEvents: 'none' }} />
                  <div style={{ position: 'absolute', top: 4, left: '50%', transform: 'translateX(-50%)', background: '#22c55e', color: '#000', fontSize: 11, fontWeight: 900, padding: '3px 6px', borderRadius: 4, pointerEvents: 'none', whiteSpace: 'nowrap' }}>시작</div>
                </div>
                <div 
                  onMouseDown={e => {
                    if (e.button !== 0) return;
                    e.stopPropagation();
                    e.preventDefault();
                    suppressTimelineClickRef.current = true;
                    snap();
                    setMarkerDrag('out');
                    setDragStart({ x: e.clientX, y: e.clientY, ts: renderOut == null ? totalDur : renderOut, dur: 0, rowIndex: 0, kind: 'marker' });
                  }}
                  style={{ position: 'absolute', top: 0, height: 52, left: (renderOut == null ? totalDur : renderOut) * 20 * zoom, width: 28, transform: 'translateX(-50%)', background: 'transparent', zIndex: 110, cursor: 'ew-resize' }}
                >
                  <div style={{ position: 'absolute', top: 52, left: '50%', transform: 'translateX(-50%)', width: 2, height: 9999, background: '#f43f5e', pointerEvents: 'none' }} />
                  <div style={{ position: 'absolute', top: 38, left: '50%', transform: 'translateX(-50%)', width: 0, height: 0, borderLeft: '5px solid transparent', borderRight: '5px solid transparent', borderTop: '10px solid #f43f5e', pointerEvents: 'none' }} />
                  <div style={{ position: 'absolute', top: 4, left: '50%', transform: 'translateX(-50%)', background: '#f43f5e', color: '#fff', fontSize: 11, fontWeight: 900, padding: '3px 6px', borderRadius: 4, pointerEvents: 'none', whiteSpace: 'nowrap' }}>끝</div>
                </div>
                <div
                  onMouseDown={e => {
                    e.stopPropagation();
                    setPlaying(false);
                    setPlayheadDrag(true);
                    setDragStart({ x: e.clientX, y: e.clientY, ts: time, dur: 0, rowIndex: 0, kind: 'playhead' });
                  }}
                  style={{ position: "absolute", top: 0, height: 52, left: time * 20 * zoom, width: 14, transform: "translateX(-50%)", background: `linear-gradient(90deg, transparent 0 6px, ${ACCENT} 6px 8px, transparent 8px)`, zIndex: 50, cursor: "ew-resize" }}
                >
                  <div style={{ position: "absolute", top: 52, left: "50%", transform: "translateX(-50%)", width: 2, height: 9999, background: ACCENT, pointerEvents: "none" }} />
                  <div style={{ 
                    position: "absolute", 
                    top: 2, 
                    left: "50%", 
                    transform: "translateX(-50%)", 
                    color: ACCENT, 
                    fontSize: 15, 
                    fontWeight: "bold",
                    lineHeight: 1,
                    textShadow: "0 1px 2px rgba(0,0,0,0.6)"
                  }}>
                    ▼
                  </div>
                </div>
                {timelineLayers.map((layer, rowIdx) => {
                  const isBottomSub = layer.__kind === 'graphic' && !(layer.sourceName || layer.compName || "").includes("상단");
                  const isExpanded = expandedLayers.has(layer.id);
                  const rowHeight = isExpanded ? 72 + 8 + (24 * 5) : 72;
                  const timelineItemKey = `${layer.__kind}:${layer.id}`;
                  const isTimelineSelected = selectedTimelineItems.has(timelineItemKey) || (layer.__kind === 'clip' ? selClipId === layer.id : selGfxId === layer.id);
                  const commonStyle = { position: 'absolute', top: 6, height: 60, left: layer.ts * 20 * zoom, width: Math.max(4, layer.dur * 20 * zoom), borderRadius: 6, cursor: tool === 'razor' ? 'crosshair' : 'move', overflow: 'hidden', boxSizing: 'border-box' };
                  return (
                    <div key={layer.id + '-row'} style={{ position: 'relative', height: rowHeight, background: rowIdx % 2 ? '#1c1c1f' : '#18181b', borderBottom: `1px solid ${BORDER}` }}>
                      <div
                        style={{ 
                          ...commonStyle, 
                          transform: timelineDrag === layer.id ? `translateY(${timelineDragOffset}px)` : 'none',
                          zIndex: timelineDrag === layer.id ? 100 : 1,
                          boxShadow: timelineDrag === layer.id ? '0 12px 30px rgba(0,0,0,0.7), 0 0 0 1px rgba(255,255,255,0.1)' : 'none',
                          opacity: timelineDrag === layer.id ? 0.85 : 1,
                          background: layer.__kind === 'clip'
                            ? (isTimelineSelected ? '#211204' : '#140c03')
                            : isBottomSub
                              ? (isTimelineSelected ? '#0a121c' : '#060b12')
                              : (isTimelineSelected ? '#0f1a10' : '#0a1208'), 
                          border: `2px solid ${
                            layer.__kind === 'clip'
                              ? (isTimelineSelected ? ACCENT : ACCENT + '44')
                              : isBottomSub
                                ? (isTimelineSelected ? '#38bdf8' : '#38bdf844')
                                : (isTimelineSelected ? ACCENT2 : ACCENT2 + '44')
                          }` 
                        }}
                        onMouseDown={e => {
                          e.stopPropagation();
                          if (e.shiftKey) {
                            setSelectedTimelineItems(prev => {
                              const next = new Set(prev);
                              if (next.has(timelineItemKey)) next.delete(timelineItemKey);
                              else next.add(timelineItemKey);
                              return next;
                            });
                            if (layer.__kind === 'clip') { setSelClipId(layer.id); setSelGfxId(null); }
                            else { setSelGfxId(layer.id); setSelClipId(null); }
                            setSelectedMediaAssetId(null);
                            return;
                          }
                          const dragSelection = selectedTimelineItems.has(timelineItemKey) ? new Set(selectedTimelineItems) : new Set([timelineItemKey]);
                          setSelectedTimelineItems(dragSelection);
                          if (layer.__kind === 'clip') {
                            if (tool === 'razor') { handleSplit(layer.id); return; }
                            snap(); setSelClipId(layer.id); setSelGfxId(null); setSelectedMediaAssetId(null); setTimelineDrag(layer.id); setDragStart({ x: e.clientX, y: e.clientY, ts: layer.ts, dur: layer.dur, rowIndex: rowIdx, kind: 'clip', groupTs: buildTimelineGroupTs(dragSelection) });
                          } else {
                            if (tool === 'razor') { handleGraphicSplit(layer.id); return; }
                            snap(); setSelGfxId(layer.id); setSelClipId(null); setSelectedMediaAssetId(null); setTimelineDrag(layer.id); setDragStart({ x: e.clientX, y: e.clientY, ts: layer.ts, dur: layer.dur, rowIndex: rowIdx, kind: 'graphic', groupTs: buildTimelineGroupTs(dragSelection) });
                          }
                        }}>
                        {layer.__kind === 'clip' && layer.__type === 'video' && layer.url && (
                          <div style={{ position: 'absolute', top: 0, left: 0, bottom: 0, width: 80, opacity: 0.6, pointerEvents: 'none', zIndex: 0, borderRight: `1px solid ${BORDER}` }}>
                            <video src={layer.url} preload="metadata" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                          </div>
                        )}
                        {/* Resize handles - only for non-video layers */}
                        {layer.__type !== 'video' && (
                        <>
                        <div 
                          onMouseDown={e => { e.stopPropagation(); snap(); setTimelineResize({ id: layer.id, side: 'left', kind: layer.__kind }); setDragStart({ x: e.clientX, y: e.clientY, ts: layer.ts, dur: layer.dur, rowIndex: rowIdx, kind: layer.__kind }); }}
                          onMouseEnter={e => e.currentTarget.style.background = 'rgba(255,255,255,0.2)'}
                          onMouseLeave={e => e.currentTarget.style.background = 'rgba(0,0,0,0.15)'}
                          style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: 10, cursor: 'ew-resize', zIndex: 5, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(0,0,0,0.15)', borderRight: '1px solid rgba(0,0,0,0.3)', transition: 'background 0.2s' }}
                        >
                          <div style={{ display: 'flex', gap: 2 }}>
                            <div style={{ width: 2, height: 28, background: 'rgba(255,255,255,0.8)', borderRadius: 1, boxShadow: '0 1px 2px rgba(0,0,0,0.6)' }} />
                            <div style={{ width: 2, height: 28, background: 'rgba(255,255,255,0.8)', borderRadius: 1, boxShadow: '0 1px 2px rgba(0,0,0,0.6)' }} />
                          </div>
                        </div>
                        <div 
                          onMouseDown={e => { e.stopPropagation(); snap(); setTimelineResize({ id: layer.id, side: 'right', kind: layer.__kind }); setDragStart({ x: e.clientX, y: e.clientY, ts: layer.ts, dur: layer.dur, rowIndex: rowIdx, kind: layer.__kind }); }}
                          onMouseEnter={e => e.currentTarget.style.background = 'rgba(255,255,255,0.2)'}
                          onMouseLeave={e => e.currentTarget.style.background = 'rgba(0,0,0,0.15)'}
                          style={{ position: 'absolute', right: 0, top: 0, bottom: 0, width: 10, cursor: 'ew-resize', zIndex: 5, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(0,0,0,0.15)', borderLeft: '1px solid rgba(0,0,0,0.3)', transition: 'background 0.2s' }}
                        >
                          <div style={{ display: 'flex', gap: 2 }}>
                            <div style={{ width: 2, height: 28, background: 'rgba(255,255,255,0.8)', borderRadius: 1, boxShadow: '0 1px 2px rgba(0,0,0,0.6)' }} />
                            <div style={{ width: 2, height: 28, background: 'rgba(255,255,255,0.8)', borderRadius: 1, boxShadow: '0 1px 2px rgba(0,0,0,0.6)' }} />
                          </div>
                        </div>
                        </>
                        )}
                        <div style={{ padding: '2px 10px', fontSize: 11, color: layer.__kind === 'clip' ? ACCENT : (isBottomSub ? '#38bdf8' : ACCENT2), whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', lineHeight: '56px', display: 'flex', alignItems: 'center', gap: 6, height: '100%', position: 'relative', zIndex: 1, paddingLeft: layer.__kind === 'clip' && layer.__type === 'video' ? 90 : 10, textShadow: '0 1px 2px rgba(0,0,0,0.8)' }}>
                          <span style={{ fontSize: 10 }}>{layer.__type === 'video' ? '🎥' : layer.__type === 'audio' ? '🔊' : (layer.type === 'ae_template' ? '🎨' : layer.type === 'text' ? 'T' : '■')}</span>
                          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', fontWeight: 600 }}>{layer.__label}</span>
                        </div>
                        {/* Waveform Visualization Overlay */}
                        <div style={{ position: 'absolute', inset: 0, pointerEvents: 'none', zIndex: 0, display: 'flex', alignItems: 'center', overflow: 'hidden' }}>
                          { (layer.__type === 'audio' || layer.__type === 'video' || layer.type === 'video' || layer.type === 'audio') && layer.url ? (
                            <DetailedWaveform 
                              url={layer.url} 
                              color={layer.__kind === 'clip' ? ACCENT : (isBottomSub ? '#38bdf8' : ACCENT2)} 
                              opacity={0.8}
                            />
                          ) : (
                            <div style={{ width: '100%', height: 1, background: 'rgba(255,255,255,0.2)', boxShadow: '0 0 4px rgba(255,255,255,0.1)' }} />
                          )}
                        </div>
                      </div>
                      
                      {isExpanded && (
                        <div style={{ position: 'absolute', top: 72, left: 0, right: 0, bottom: 0, pointerEvents: 'none' }}>
                          {Object.values(KF_PROP_CONFIG).map((pConf, i) => (
                            <div key={i} style={{ position: 'absolute', top: 8 + i * 24, left: 0, right: 0, height: 24, borderTop: `1px solid rgba(255,255,255,0.02)` }} />
                          ))}
                        </div>
                      )}
                      
                      {collectAllKeyframes(layer).map((kf, i) => {
                        const kt = kf.t;
                        const displayKt = kt - (layer.startT || 0);
                        if (displayKt < -0.001 || displayKt > layer.dur + 0.001) return null;
                        const propConf = KF_PROP_CONFIG[kf.prop];
                        if (!propConf) return null;
                        const keyframeKey = `${layer.__kind}:${layer.id}:${kf.prop}:${Number(kt).toFixed(3)}`;
                        const isSelected = selectedKeyframes.has(keyframeKey) || Math.abs(time - (layer.ts + displayKt)) < 0.001;
                        const isEase = kf.easing === 'ease';
                        const isPopupActive = activeKeyframePopup?.layerId === layer.id && Math.abs(activeKeyframePopup.time - kt) < 0.001 && activeKeyframePopup.prop === kf.prop;
                        
                        const handleKeyframeClick = (e: any) => {
                          e.stopPropagation();
                          setTime(layer.ts + displayKt);
                          if (e.shiftKey) {
                            setSelectedKeyframes(prev => {
                              const next = new Set(prev);
                              if (next.has(keyframeKey)) next.delete(keyframeKey);
                              else next.add(keyframeKey);
                              return next;
                            });
                            return;
                          }
                          setSelectedKeyframes(new Set([keyframeKey]));
                          if (isPopupActive) setActiveKeyframePopup(null);
                          else setActiveKeyframePopup({ layerId: layer.id, time: kt, prop: kf.prop });
                        };
                        
                        const yPosStyle = isExpanded ? { top: 72 + 8 + propConf.index * 24 + 3 } : { bottom: 3 };
                        
                        return (
                          <div key={`${kf.prop}-${i}`} style={{ position: 'absolute', left: (layer.ts + displayKt) * 20 * zoom - 9, ...yPosStyle, zIndex: 10 + i }}>
                            {isPopupActive && (
                              <div data-keyframe-popup="true" style={{ position: 'absolute', bottom: 22, left: '50%', transform: 'translateX(-50%)', background: '#27272a', padding: '8px', borderRadius: 8, display: 'flex', flexDirection: 'column', gap: 6, boxShadow: '0 4px 12px rgba(0,0,0,0.8)', zIndex: 100, whiteSpace: 'nowrap', border: `1px solid ${ACCENT}` }}>
                                <div style={{ fontSize: 13, fontWeight: 800, color: ACCENT, textAlign: 'center', borderBottom: '1px solid #3f3f46', paddingBottom: 4, marginBottom: 2 }}>{propConf.label}</div>
                                <div style={{ position: 'absolute', bottom: -5, left: '50%', transform: 'translateX(-50%) rotate(45deg)', width: 8, height: 8, background: '#27272a', borderRight: `1px solid ${ACCENT}`, borderBottom: `1px solid ${ACCENT}` }} />
                                
                                <button onClick={(e) => { 
                                  e.stopPropagation(); 
                                  toggleEasingAtPropTime(layer, kf.prop, kt); 
                                  setActiveKeyframePopup(null); 
                                }} style={{ background: '#3f3f46', border: 'none', color: '#fff', fontWeight: 600, fontSize: 12, cursor: 'pointer', borderRadius: 4, padding: '4px 8px', transition: 'background 0.2s' }}
                                   onMouseEnter={e => e.currentTarget.style.background = '#52525b'}
                                   onMouseLeave={e => e.currentTarget.style.background = '#3f3f46'}
                                >
                                  {isEase ? '✨ 부드럽게 (해제)' : '✨ 부드럽게 (적용)'}
                                </button>
                                
                                <button onClick={(e) => { 
                                  e.stopPropagation(); 
                                  removeKeyframeAtPropTime(layer, kf.prop, kt); 
                                  setActiveKeyframePopup(null); 
                                }} style={{ background: 'rgba(239,68,68,0.2)', border: 'none', color: '#f87171', fontWeight: 600, fontSize: 12, cursor: 'pointer', borderRadius: 4, padding: '4px 8px', transition: 'background 0.2s' }}
                                   onMouseEnter={e => e.currentTarget.style.background = 'rgba(239,68,68,0.4)'}
                                   onMouseLeave={e => e.currentTarget.style.background = 'rgba(239,68,68,0.2)'}
                                >
                                  🗑️ 애니메이션 키 삭제
                                </button>
                              </div>
                            )}
                            
                            <svg width="18" height="18" viewBox="0 0 24 24" 
                              onMouseDown={e => {
                                e.stopPropagation();
                                if (e.shiftKey) return;
                                const dragKeys = selectedKeyframes.has(keyframeKey) ? new Set(selectedKeyframes) : new Set([keyframeKey]);
                                if (!selectedKeyframes.has(keyframeKey)) setSelectedKeyframes(dragKeys);
                                const entries = collectAllKeyframes(layer)
                                  .filter(item => dragKeys.has(`${layer.__kind}:${layer.id}:${item.prop}:${Number(item.t).toFixed(3)}`))
                                  .map(item => ({ prop: item.prop, initialT: item.t, currentT: item.t }));
                                setKeyframeDrag({ layerId: layer.id, kind: layer.__kind, prop: kf.prop, initialT: kt, currentT: kt, entries: entries.length ? entries : [{ prop: kf.prop, initialT: kt, currentT: kt }] });
                                setDragStart({ x: e.clientX, y: e.clientY });
                              }}
                              onClick={handleKeyframeClick} 
                              style={{ 
                                cursor: 'pointer', 
                                filter: isSelected ? `drop-shadow(0 0 8px ${ACCENT})` : 'drop-shadow(0 0 2px rgba(0,0,0,0.8))',
                                transition: 'all 0.1s'
                              }}>
                              {isEase ? (
                                <path d="M2 2 L22 2 L12 12 L22 22 L2 22 L12 12 Z" fill={isSelected ? "#fff" : ACCENT} stroke="#000" strokeWidth="2" strokeLinejoin="round" />
                              ) : (
                                <path d="M12 2 L22 12 L12 22 L2 12 Z" fill={isSelected ? "#fff" : ACCENT} stroke="#000" strokeWidth="2" strokeLinejoin="round" />
                              )}
                            </svg>
                          </div>
                        );
                      })}
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        </div>

        {/* Right Resizer */}
        <div 
          onMouseDown={() => setIsResizingPanel('right')}
          style={{ width: 6, margin: "0 -3px", zIndex: 100, cursor: "col-resize", background: "transparent", flexShrink: 0 }}
          onMouseEnter={e => e.currentTarget.style.background = "rgba(255,255,255,0.1)"}
          onMouseLeave={e => e.currentTarget.style.background = "transparent"}
        />

        {/* ── RIGHT PANEL: EFFECT CONTROLS (2nd Priority) ── */}
        <div style={{ width: rightPanelWidth, borderLeft: `1px solid ${BORDER}`, background: "#09090b", display: "flex", flexDirection: "column", flexShrink: 0, overflow: "hidden" }}>
          <div style={{ flex: 1, overflowY: "auto", padding: 12 }}>
            {selGfx ? (
              <>
                {(() => {
                  const isBottom = selGfx.type === "ae_template" && !(selGfx.sourceName || selGfx.compName || "").includes("상단");
                  const headerColor = selGfx.type === "ae_template" ? (isBottom ? '#38bdf8' : ACCENT2) : ACCENT;
                  const headerText = selGfx.type === "ae_template" 
                    ? (() => {
                        const name1 = (selGfx.compName || "").trim();
                        const name2 = (selGfx.sourceName || selGfx.name || "").trim();
                        const combined = (name1 && name2 && name1 === name2) 
                          ? name1 
                          : (name1 && name2) 
                            ? `${name1} - ${name2}` 
                            : (name1 || name2);
                        const templateTypeStr = isBottom ? "하단 자막템플릿" : "상단 자막템플릿";
                        return `${templateTypeStr} (${combined})`;
                      })()
                    : selGfx.type === "text" ? "텍스트" : "도형";

                  return (
                    <div style={{ fontSize: 13, fontWeight: 800, color: headerColor, marginBottom: 16, display: "flex", alignItems: "center", gap: 8 }}>
                      <span style={{ fontSize: 16 }}>{selGfx.type === "ae_template" ? "🎨" : selGfx.type === "text" ? "T" : "■"}</span>
                      <span>{headerText}</span>
                    </div>
                  );
                })()}
                {/* AE Template fields */}
                {selGfx.type === "ae_template" && (
                  <div style={{ marginBottom: 16 }}>
                    <div style={{ fontSize: 12, color: "#52525b", fontWeight: 800, textTransform: "uppercase", margin: "0 0 10px" }}>텍스트 필드</div>
                    {(selGfx.fields || []).length > 0 ? (selGfx.fields || []).slice().sort((a, b) => {
                      const aMain = /Main/i.test(a.label || "");
                      const bMain = /Main/i.test(b.label || "");
                      if (aMain && !bMain) return -1;
                      if (!aMain && bMain) return 1;
                      return (a.order ?? 0) - (b.order ?? 0);
                    }).map((f, idx) => {
                      const internalMode = !shouldUseOverlayForField(f, selGfx.glyphChars || []);
                      const selectedFontKey = internalMode ? `internal:${f.fontKey || selGfx.fontOptions?.find(option => option.mode === 'internal')?.value || ""}` : `overlay:${f.fontFamily || "Pretendard, 'Noto Sans KR', sans-serif"}`;
                      return (
                        <div key={f.id} style={{ marginBottom: 12, padding: 8, background: "#0f1115", border: `1px solid ${BORDER}`, borderRadius: 6 }}>
                          <div style={{ marginBottom: 6 }}>
                            <div style={{ fontSize: 11, color: ACCENT2, fontWeight: 700 }}>
                              {/Main_Text/i.test(f.label || "") 
                                ? "메인 문구" 
                                : /Sub_Text/i.test(f.label || "") 
                                  ? "서브 문구" 
                                  : (f.label || `텍스트 ${idx + 1}`)}
                            </div>
                          </div>
                          {!internalMode && <div style={{ fontSize: 9, color: "#f59e0b", marginBottom: 6 }}>현재 JSON 글리프로는 이 문자를 못 그려서 웹폰트 오버레이로 표시합니다.</div>}
                          <input type="text" value={f.value} 
                            onChange={e => updateField(selGfx.id, f.id, e.target.value)} 
                            onFocus={e => {
                              e.target.style.borderColor = "#f97316";
                              e.target.style.boxShadow = "inset 0 2px 5px rgba(0,0,0,0.8), 0 0 0 3px rgba(249, 115, 22, 0.25)";
                            }}
                            onBlur={e => {
                              e.target.style.borderColor = "#52525b";
                              e.target.style.boxShadow = "inset 0 2px 5px rgba(0,0,0,0.8)";
                              snap();
                            }}
                            style={{ 
                              width: "100%", 
                              background: "#0d0e12", 
                              border: "1.5px solid #52525b", 
                              borderRadius: 6, 
                              color: "#ffffff", 
                              fontSize: 13, 
                              padding: "10px 12px", 
                              outline: "none", 
                              boxSizing: "border-box", 
                              marginBottom: 10, 
                              boxShadow: "inset 0 2px 5px rgba(0,0,0,0.8)",
                              transition: "all 0.15s ease-in-out"
                            }} 
                          />
                          <div style={{ display: "grid", gridTemplateColumns: "1fr 50px", gap: 6, marginBottom: 10 }}>
                            <input type="text" value={f.highlightText || ""} onChange={e => updateFieldProps(selGfx.id, f.id, { highlightText: e.target.value })} onBlur={snap} placeholder="↑ 위의 텍스트에서 강조하고 싶은 부분을 복사/붙여넣기 하세요" style={{ background: "#18181b", border: `1px solid ${BORDER}`, borderRadius: 6, color: "#fff", padding: "6px 8px", fontSize: 12, outline: "none" }} />
                            <input type="color" value={f.highlightColor || "#ffea00"} onChange={e => { updateFieldProps(selGfx.id, f.id, { highlightColor: e.target.value }); snap(); }} style={{ width: "100%", height: 32, background: "#27272a", border: "1px solid #52525b", borderRadius: 6, outline: "none", cursor: "pointer" }} />
                          </div>
                          <div style={{ display: "grid", gridTemplateColumns: "1fr 90px", gap: 6, marginBottom: 6 }}>
                            <select value={selectedFontKey} onChange={e => {
                              const selected = (selGfx.fontOptions || []).find(option => option.key === e.target.value);
                              if (selected?.mode === "internal") updateFieldProps(selGfx.id, f.id, { fontMode: "internal", fontKey: selected.value, fontFamily: selected.label.includes("Pretendard") ? "Pretendard, 'Noto Sans KR', sans-serif" : (f.fontFamily || "Pretendard, 'Noto Sans KR', sans-serif") });
                              else updateFieldProps(selGfx.id, f.id, { fontMode: "overlay", fontFamily: selected?.value || "Pretendard, 'Noto Sans KR', sans-serif" });
                              snap();
                            }} style={{ background: "#27272a", border: "1px solid #52525b", color: "#ffffff", fontSize: 13, padding: "6px 8px", borderRadius: 6, outline: "none" }}>
                              {(selGfx.fontOptions || WEB_FONT_OPTIONS).map(option => <option key={option.key} value={option.key}>{option.label}</option>)}
                            </select>
                            <ScrubbableNumberInput value={Number(f.fontSize || 72)} min={8} max={400} step={1} onChange={v => updateFieldProps(selGfx.id, f.id, { fontSize: v })} onCommit={snap} style={{ background: "#27272a", border: "1px solid #52525b", borderRadius: 6, color: "#ffffff", fontSize: 13, height: 32, width: 90 }} />
                          </div>
                          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6, marginBottom: 6 }}>
                            <input type="color" value={f.color || "#ffffff"} onChange={e => { updateFieldProps(selGfx.id, f.id, { color: e.target.value }); snap(); }} style={{ width: "100%", height: 32, background: "#27272a", border: "1px solid #52525b", borderRadius: 6, outline: "none", cursor: "pointer" }} />
                            <select value={f.textAlign || "left"} onChange={e => { updateFieldProps(selGfx.id, f.id, { textAlign: e.target.value }); snap(); }} style={{ background: "#27272a", border: "1px solid #52525b", color: "#ffffff", fontSize: 13, padding: "6px 8px", borderRadius: 6, outline: "none" }}>
                              <option value="left">왼쪽 정렬</option>
                              <option value="center">가운데 정렬</option>
                              <option value="right">오른쪽 정렬</option>
                            </select>
                          </div>
                          <div style={{ display: "grid", gridTemplateColumns: "1fr 70px 1fr", gap: 6, marginBottom: 6 }}>
                            <input type="color" value={f.strokeColor || "#0a4a4d"} onChange={e => { updateFieldProps(selGfx.id, f.id, { strokeColor: e.target.value }); snap(); }} style={{ width: "100%", height: 32, background: "#27272a", border: "1px solid #52525b", borderRadius: 6, outline: "none", cursor: "pointer" }} />
                            <ScrubbableNumberInput value={Number(f.strokeWidth || 0)} min={0} max={60} step={1} onChange={v => updateFieldProps(selGfx.id, f.id, { strokeWidth: v })} onCommit={snap} style={{ background: "#27272a", border: "1px solid #52525b", borderRadius: 6, color: "#ffffff", fontSize: 13, height: 32, width: 70 }} />
                            <select value={f.strokeMode || "outside"} onChange={e => { updateFieldProps(selGfx.id, f.id, { strokeMode: e.target.value }); snap(); }} style={{ background: "#27272a", border: "1px solid #52525b", color: "#ffffff", fontSize: 13, padding: "6px 8px", borderRadius: 6, outline: "none" }}>
                              <option value="outside">바깥 획</option>
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
                  <div style={{ marginBottom: 16 }}>
                    <div style={{ fontSize: 14, color: "#e4e4e7", fontWeight: 700, textTransform: "uppercase", marginBottom: 10 }}>텍스트 내용</div>
                    <input type="text" value={selGfx.content}
                      onChange={e => updateGfx(selGfx.id, { content: e.target.value })}
                      onBlur={snap}
                      style={{ width: "100%", background: "#18181b", border: `1px solid ${BORDER}`, borderRadius: 4, color: "#e4e4e7", fontSize: 13, padding: "8px 12px", outline: "none", boxSizing: "border-box", marginBottom: 10 }}
                    />
                    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 10 }}>
                      <div>
                        <div style={{ fontSize: 11, color: "#71717a", marginBottom: 5 }}>폰트</div>
                        <select value={selGfx.fontFamily || "sans-serif"} onChange={e => { updateGfx(selGfx.id, { fontFamily: e.target.value }); snap(); }}
                          style={{ width: "100%", background: "#18181b", border: `1px solid ${BORDER}`, color: "#e4e4e7", fontSize: 13, padding: "6px 8px", borderRadius: 4, outline: "none" }}>
                          <option value="Pretendard, 'Noto Sans KR', sans-serif">Pretendard</option>
                          <option value="'Noto Sans KR', sans-serif">Noto Sans KR</option>
                          <option value="'Malgun Gothic', sans-serif">맑은 고딕</option>
                          <option value="Arial, sans-serif">Arial</option>
                          <option value="Georgia, serif">Georgia</option>
                        </select>
                      </div>
                      <div>
                        <div style={{ fontSize: 11, color: "#71717a", marginBottom: 5 }}>굵기</div>
                        <select value={selGfx.fontWeight || "700"} onChange={e => { updateGfx(selGfx.id, { fontWeight: e.target.value }); snap(); }}
                          style={{ width: "100%", background: "#18181b", border: `1px solid ${BORDER}`, color: "#e4e4e7", fontSize: 13, padding: "6px 8px", borderRadius: 4, outline: "none" }}>
                          <option value="300">Light</option>
                          <option value="400">Regular</option>
                          <option value="500">Medium</option>
                          <option value="600">SemiBold</option>
                          <option value="700">Bold</option>
                          <option value="800">ExtraBold</option>
                        </select>
                      </div>
                    </div>
                    <div style={{ display: "flex", gap: 6, marginBottom: 10 }}>
                      {["left", "center", "right"].map(a => (
                        <button key={a} onClick={() => { updateGfx(selGfx.id, { textAlign: a }); snap(); }}
                          style={{ flex: 1, padding: "6px", background: (selGfx.textAlign || "center") === a ? ACCENT + "20" : "#18181b", border: `1px solid ${(selGfx.textAlign || "center") === a ? ACCENT : BORDER}`, borderRadius: 4, color: (selGfx.textAlign || "center") === a ? ACCENT : "#71717a", cursor: "pointer", fontSize: 13 }}>
                          {a === "left" ? "⬅" : a === "center" ? "↔" : "➡"}
                        </button>
                      ))}
                    </div>
                    <div style={{ marginBottom: 10 }}>
                      <div style={{ fontSize: 11, color: "#71717a", marginBottom: 5 }}>색상</div>
                      <ColorPicker value={selGfx.color} onChange={v => updateGfx(selGfx.id, { color: v })} />
                    </div>
                    <PropRow label="글자 크기" value={selGfx.fontSize || 36} min={8} max={200} step={1} unit="px"
                      onChange={v => updateGfx(selGfx.id, { fontSize: v })} onCommit={snap} />
                  </div>
                )}
                {/* Shape color */}
                {(selGfx.type === "rectangle" || selGfx.type === "circle") && (
                  <div style={{ marginBottom: 16 }}>
                    <div style={{ fontSize: 14, color: "#e4e4e7", fontWeight: 700, textTransform: "uppercase", marginBottom: 10 }}>도형 설정</div>
                    <div style={{ fontSize: 11, color: "#71717a", marginBottom: 5 }}>색상</div>
                    <ColorPicker value={selGfx.color} onChange={v => { updateGfx(selGfx.id, { color: v }); snap(); }} />
                  </div>
                )}
                {/* Transform */}
                <div>
                  {/* Alignment Controls */}
                  <div style={{ marginBottom: 20 }}>
                    <div style={{ fontSize: 14, color: "#e4e4e7", fontWeight: 800, textTransform: "uppercase", marginBottom: 12 }}>정렬</div>
                    
                    {/* Horizontal */}
                    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10, background: "rgba(255,255,255,0.02)", padding: "8px 12px", borderRadius: 6, border: "1px solid rgba(255,255,255,0.04)" }}>
                      <span style={{ fontSize: 12, color: "#a1a1aa", fontWeight: 700 }}>가로 정렬</span>
                      <div style={{ display: "flex", gap: 4 }}>
                        <button 
                          onClick={() => handleAlign('horizontal', 'left')}
                          title="왼쪽 정렬" 
                          style={{ background: "rgba(255,255,255,0.05)", border: "1px solid rgba(255,255,255,0.1)", color: "#e4e4e7", width: 28, height: 28, borderRadius: 4, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", transition: "all 0.1s" }}
                          onMouseEnter={e => e.currentTarget.style.background = "rgba(255,255,255,0.15)"}
                          onMouseLeave={e => e.currentTarget.style.background = "rgba(255,255,255,0.05)"}
                        >
                          <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
                            <rect x="2" y="2" width="2" height="12" rx="0.5"/>
                            <rect x="6" y="4" width="8" height="3" rx="1"/>
                            <rect x="6" y="9" width="5" height="3" rx="1"/>
                          </svg>
                        </button>
                        <button 
                          onClick={() => handleAlign('horizontal', 'center')}
                          title="가운데 정렬" 
                          style={{ background: "rgba(255,255,255,0.05)", border: "1px solid rgba(255,255,255,0.1)", color: "#e4e4e7", width: 28, height: 28, borderRadius: 4, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", transition: "all 0.1s" }}
                          onMouseEnter={e => e.currentTarget.style.background = "rgba(255,255,255,0.15)"}
                          onMouseLeave={e => e.currentTarget.style.background = "rgba(255,255,255,0.05)"}
                        >
                          <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
                            <rect x="7" y="2" width="2" height="12" rx="0.5"/>
                            <rect x="3" y="4" width="10" height="3" rx="1"/>
                            <rect x="5" y="9" width="6" height="3" rx="1"/>
                          </svg>
                        </button>
                        <button 
                          onClick={() => handleAlign('horizontal', 'right')}
                          title="오른쪽 정렬" 
                          style={{ background: "rgba(255,255,255,0.05)", border: "1px solid rgba(255,255,255,0.1)", color: "#e4e4e7", width: 28, height: 28, borderRadius: 4, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", transition: "all 0.1s" }}
                          onMouseEnter={e => e.currentTarget.style.background = "rgba(255,255,255,0.15)"}
                          onMouseLeave={e => e.currentTarget.style.background = "rgba(255,255,255,0.05)"}
                        >
                          <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
                            <rect x="12" y="2" width="2" height="12" rx="0.5"/>
                            <rect x="2" y="4" width="8" height="3" rx="1"/>
                            <rect x="5" y="9" width="5" height="3" rx="1"/>
                          </svg>
                        </button>
                      </div>
                    </div>

                    {/* Vertical */}
                    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", background: "rgba(255,255,255,0.02)", padding: "8px 12px", borderRadius: 6, border: "1px solid rgba(255,255,255,0.04)" }}>
                      <span style={{ fontSize: 12, color: "#a1a1aa", fontWeight: 700 }}>세로 정렬</span>
                      <div style={{ display: "flex", gap: 4 }}>
                        <button 
                          onClick={() => handleAlign('vertical', 'top')}
                          title="위쪽 정렬" 
                          style={{ background: "rgba(255,255,255,0.05)", border: "1px solid rgba(255,255,255,0.1)", color: "#e4e4e7", width: 28, height: 28, borderRadius: 4, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", transition: "all 0.1s" }}
                          onMouseEnter={e => e.currentTarget.style.background = "rgba(255,255,255,0.15)"}
                          onMouseLeave={e => e.currentTarget.style.background = "rgba(255,255,255,0.05)"}
                        >
                          <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
                            <rect x="2" y="2" width="12" height="2" rx="0.5"/>
                            <rect x="4" y="6" width="3" height="8" rx="1"/>
                            <rect x="9" y="6" width="3" height="5" rx="1"/>
                          </svg>
                        </button>
                        <button 
                          onClick={() => handleAlign('vertical', 'center')}
                          title="가운데 정렬" 
                          style={{ background: "rgba(255,255,255,0.05)", border: "1px solid rgba(255,255,255,0.1)", color: "#e4e4e7", width: 28, height: 28, borderRadius: 4, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", transition: "all 0.1s" }}
                          onMouseEnter={e => e.currentTarget.style.background = "rgba(255,255,255,0.15)"}
                          onMouseLeave={e => e.currentTarget.style.background = "rgba(255,255,255,0.05)"}
                        >
                          <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
                            <rect x="2" y="7" width="12" height="2" rx="0.5"/>
                            <rect x="4" y="3" width="3" height="10" rx="1"/>
                            <rect x="9" y="5" width="3" height="6" rx="1"/>
                          </svg>
                        </button>
                        <button 
                          onClick={() => handleAlign('vertical', 'bottom')}
                          title="아래쪽 정렬" 
                          style={{ background: "rgba(255,255,255,0.05)", border: "1px solid rgba(255,255,255,0.1)", color: "#e4e4e7", width: 28, height: 28, borderRadius: 4, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", transition: "all 0.1s" }}
                          onMouseEnter={e => e.currentTarget.style.background = "rgba(255,255,255,0.15)"}
                          onMouseLeave={e => e.currentTarget.style.background = "rgba(255,255,255,0.05)"}
                        >
                          <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
                            <rect x="2" y="12" width="12" height="2" rx="0.5"/>
                            <rect x="4" y="2" width="3" height="8" rx="1"/>
                            <rect x="9" y="5" width="3" height="5" rx="1"/>
                          </svg>
                        </button>
                      </div>
                    </div>
                  </div>

                  <div style={{ fontSize: 15, color: "#e4e4e7", fontWeight: 800, textTransform: "uppercase", marginBottom: 16, marginTop: 4 }}>변형</div>
                  <AnimPropRow label="위치 X" value={Math.round((selGfx.x / 100) * comp.w)} min={-comp.w} max={comp.w * 2} step={1} unit="px"
                    keyframed={hasKeyframeAt(selGfx, "x", clamp(time - selGfx.ts, 0, selGfx.dur))}
                    onToggleKeyframe={() => toggleGraphicKeyframe(selGfx, "x")}
                    onPrevKeyframe={() => jumpToKeyframe(selGfx, "x", "prev")}
                    onNextKeyframe={() => jumpToKeyframe(selGfx, "x", "next")}
                    onChange={v => updateGfx(selGfx.id, { x: (v / comp.w) * 100 })} onCommit={snap} />
                  <AnimPropRow label="위치 Y" value={Math.round((selGfx.y / 100) * comp.h)} min={-comp.h} max={comp.h * 2} step={1} unit="px"
                    keyframed={hasKeyframeAt(selGfx, "y", clamp(time - selGfx.ts, 0, selGfx.dur))}
                    onToggleKeyframe={() => toggleGraphicKeyframe(selGfx, "y")}
                    onPrevKeyframe={() => jumpToKeyframe(selGfx, "y", "prev")}
                    onNextKeyframe={() => jumpToKeyframe(selGfx, "y", "next")}
                    onChange={v => updateGfx(selGfx.id, { y: (v / comp.h) * 100 })} onCommit={snap} />
                  <AnimPropRow label="비율" value={Math.round(selGfx.scale)} min={10} max={500} step={1} unit="%"
                    keyframed={hasKeyframeAt(selGfx, "scale", clamp(time - selGfx.ts, 0, selGfx.dur))}
                    onToggleKeyframe={() => toggleGraphicKeyframe(selGfx, "scale")}
                    onPrevKeyframe={() => jumpToKeyframe(selGfx, "scale", "prev")}
                    onNextKeyframe={() => jumpToKeyframe(selGfx, "scale", "next")}
                    onChange={v => updateGfx(selGfx.id, { scale: v })} onCommit={snap} />
                  <AnimPropRow label="회전" value={Math.round((selGfx.rotation || 0) * 10) / 10} min={-180} max={180} step={0.1} unit="°"
                    keyframed={hasKeyframeAt(selGfx, "rotation", clamp(time - selGfx.ts, 0, selGfx.dur))}
                    onToggleKeyframe={() => toggleGraphicKeyframe(selGfx, "rotation")}
                    onPrevKeyframe={() => jumpToKeyframe(selGfx, "rotation", "prev")}
                    onNextKeyframe={() => jumpToKeyframe(selGfx, "rotation", "next")}
                    onChange={v => updateGfx(selGfx.id, { rotation: v })} onCommit={snap} />
                  <AnimPropRow label="불투명도" value={Math.round(selGfx.opacity * 100)} min={0} max={100} step={1} unit="%"
                    keyframed={hasKeyframeAt(selGfx, "opacity", clamp(time - selGfx.ts, 0, selGfx.dur))}
                    onToggleKeyframe={() => toggleGraphicKeyframe(selGfx, "opacity")}
                    onPrevKeyframe={() => jumpToKeyframe(selGfx, "opacity", "prev")}
                    onNextKeyframe={() => jumpToKeyframe(selGfx, "opacity", "next")}
                    onChange={v => updateGfx(selGfx.id, { opacity: v / 100 })} onCommit={snap} />
                </div>
              </>
            ) : selClip ? (
              <>
                <div style={{ fontSize: 14, fontWeight: 700, color: ACCENT, marginBottom: 12 }}>🎬 {selClip.name}</div>
                {/* Alignment Controls */}
                <div style={{ marginBottom: 20 }}>
                  <div style={{ fontSize: 14, color: "#e4e4e7", fontWeight: 800, textTransform: "uppercase", marginBottom: 12 }}>정렬</div>
                  
                  {/* Horizontal */}
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10, background: "rgba(255,255,255,0.02)", padding: "8px 12px", borderRadius: 6, border: "1px solid rgba(255,255,255,0.04)" }}>
                    <span style={{ fontSize: 12, color: "#a1a1aa", fontWeight: 700 }}>가로 정렬</span>
                    <div style={{ display: "flex", gap: 4 }}>
                      <button 
                        onClick={() => handleAlign('horizontal', 'left')}
                        title="왼쪽 정렬" 
                        style={{ background: "rgba(255,255,255,0.05)", border: "1px solid rgba(255,255,255,0.1)", color: "#e4e4e7", width: 28, height: 28, borderRadius: 4, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", transition: "all 0.1s" }}
                        onMouseEnter={e => e.currentTarget.style.background = "rgba(255,255,255,0.15)"}
                        onMouseLeave={e => e.currentTarget.style.background = "rgba(255,255,255,0.05)"}
                      >
                        <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
                          <rect x="2" y="2" width="2" height="12" rx="0.5"/>
                          <rect x="6" y="4" width="8" height="3" rx="1"/>
                          <rect x="6" y="9" width="5" height="3" rx="1"/>
                        </svg>
                      </button>
                      <button 
                        onClick={() => handleAlign('horizontal', 'center')}
                        title="가운데 정렬" 
                        style={{ background: "rgba(255,255,255,0.05)", border: "1px solid rgba(255,255,255,0.1)", color: "#e4e4e7", width: 28, height: 28, borderRadius: 4, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", transition: "all 0.1s" }}
                        onMouseEnter={e => e.currentTarget.style.background = "rgba(255,255,255,0.15)"}
                        onMouseLeave={e => e.currentTarget.style.background = "rgba(255,255,255,0.05)"}
                      >
                        <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
                          <rect x="7" y="2" width="2" height="12" rx="0.5"/>
                          <rect x="3" y="4" width="10" height="3" rx="1"/>
                          <rect x="5" y="9" width="6" height="3" rx="1"/>
                        </svg>
                      </button>
                      <button 
                        onClick={() => handleAlign('horizontal', 'right')}
                        title="오른쪽 정렬" 
                        style={{ background: "rgba(255,255,255,0.05)", border: "1px solid rgba(255,255,255,0.1)", color: "#e4e4e7", width: 28, height: 28, borderRadius: 4, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", transition: "all 0.1s" }}
                        onMouseEnter={e => e.currentTarget.style.background = "rgba(255,255,255,0.15)"}
                        onMouseLeave={e => e.currentTarget.style.background = "rgba(255,255,255,0.05)"}
                      >
                        <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
                          <rect x="12" y="2" width="2" height="12" rx="0.5"/>
                          <rect x="2" y="4" width="8" height="3" rx="1"/>
                          <rect x="5" y="9" width="5" height="3" rx="1"/>
                        </svg>
                      </button>
                    </div>
                  </div>

                  {/* Vertical */}
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", background: "rgba(255,255,255,0.02)", padding: "8px 12px", borderRadius: 6, border: "1px solid rgba(255,255,255,0.04)" }}>
                    <span style={{ fontSize: 12, color: "#a1a1aa", fontWeight: 700 }}>세로 정렬</span>
                    <div style={{ display: "flex", gap: 4 }}>
                      <button 
                        onClick={() => handleAlign('vertical', 'top')}
                        title="위쪽 정렬" 
                        style={{ background: "rgba(255,255,255,0.05)", border: "1px solid rgba(255,255,255,0.1)", color: "#e4e4e7", width: 28, height: 28, borderRadius: 4, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", transition: "all 0.1s" }}
                        onMouseEnter={e => e.currentTarget.style.background = "rgba(255,255,255,0.15)"}
                        onMouseLeave={e => e.currentTarget.style.background = "rgba(255,255,255,0.05)"}
                      >
                        <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
                          <rect x="2" y="2" width="12" height="2" rx="0.5"/>
                          <rect x="4" y="6" width="3" height="8" rx="1"/>
                          <rect x="9" y="6" width="3" height="5" rx="1"/>
                        </svg>
                      </button>
                      <button 
                        onClick={() => handleAlign('vertical', 'center')}
                        title="가운데 정렬" 
                        style={{ background: "rgba(255,255,255,0.05)", border: "1px solid rgba(255,255,255,0.1)", color: "#e4e4e7", width: 28, height: 28, borderRadius: 4, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", transition: "all 0.1s" }}
                        onMouseEnter={e => e.currentTarget.style.background = "rgba(255,255,255,0.15)"}
                        onMouseLeave={e => e.currentTarget.style.background = "rgba(255,255,255,0.05)"}
                      >
                        <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
                          <rect x="2" y="7" width="12" height="2" rx="0.5"/>
                          <rect x="4" y="3" width="3" height="10" rx="1"/>
                          <rect x="9" y="5" width="3" height="6" rx="1"/>
                        </svg>
                      </button>
                      <button 
                        onClick={() => handleAlign('vertical', 'bottom')}
                        title="아래쪽 정렬" 
                        style={{ background: "rgba(255,255,255,0.05)", border: "1px solid rgba(255,255,255,0.1)", color: "#e4e4e7", width: 28, height: 28, borderRadius: 4, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", transition: "all 0.1s" }}
                        onMouseEnter={e => e.currentTarget.style.background = "rgba(255,255,255,0.15)"}
                        onMouseLeave={e => e.currentTarget.style.background = "rgba(255,255,255,0.05)"}
                      >
                        <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
                          <rect x="2" y="12" width="12" height="2" rx="0.5"/>
                          <rect x="4" y="2" width="3" height="8" rx="1"/>
                          <rect x="9" y="5" width="3" height="5" rx="1"/>
                        </svg>
                      </button>
                    </div>
                  </div>
                </div>
                <div style={{ fontSize: 15, color: "#e4e4e7", fontWeight: 800, textTransform: "uppercase", marginBottom: 16 }}>변형</div>
                <AnimPropRow label="위치 X" value={Math.round((selClip.x / 100) * comp.w)} min={-comp.w} max={comp.w * 2} step={1} unit="px"
                  keyframed={hasKeyframeAt(selClip, "x", clamp(time - selClip.ts, 0, selClip.dur))}
                  onToggleKeyframe={() => toggleClipKeyframe(selClip, "x")}
                  onPrevKeyframe={() => jumpToKeyframe(selClip, "x", "prev")}
                  onNextKeyframe={() => jumpToKeyframe(selClip, "x", "next")}
                  onChange={v => updateClip(selClip.id, { x: (v / comp.w) * 100 })} onCommit={snap} />
                <AnimPropRow label="위치 Y" value={Math.round((selClip.y / 100) * comp.h)} min={-comp.h} max={comp.h * 2} step={1} unit="px"
                  keyframed={hasKeyframeAt(selClip, "y", clamp(time - selClip.ts, 0, selClip.dur))}
                  onToggleKeyframe={() => toggleClipKeyframe(selClip, "y")}
                  onPrevKeyframe={() => jumpToKeyframe(selClip, "y", "prev")}
                  onNextKeyframe={() => jumpToKeyframe(selClip, "y", "next")}
                  onChange={v => updateClip(selClip.id, { y: (v / comp.h) * 100 })} onCommit={snap} />
                <AnimPropRow label="비율" value={Math.round(selClip.scale)} min={10} max={500} step={1} unit="%"
                  keyframed={hasKeyframeAt(selClip, "scale", clamp(time - selClip.ts, 0, selClip.dur))}
                  onToggleKeyframe={() => toggleClipKeyframe(selClip, "scale")}
                  onPrevKeyframe={() => jumpToKeyframe(selClip, "scale", "prev")}
                  onNextKeyframe={() => jumpToKeyframe(selClip, "scale", "next")}
                  onChange={v => updateClip(selClip.id, { scale: v })} onCommit={snap} />
                <AnimPropRow label="회전" value={Math.round((selClip.rotation || 0) * 10) / 10} min={-180} max={180} step={0.1} unit="°"
                  keyframed={hasKeyframeAt(selClip, "rotation", clamp(time - selClip.ts, 0, selClip.dur))}
                  onToggleKeyframe={() => toggleClipKeyframe(selClip, "rotation")}
                  onPrevKeyframe={() => jumpToKeyframe(selClip, "rotation", "prev")}
                  onNextKeyframe={() => jumpToKeyframe(selClip, "rotation", "next")}
                  onChange={v => updateClip(selClip.id, { rotation: v })} onCommit={snap} />
                <AnimPropRow label="불투명도" value={Math.round(selClip.opacity * 100)} min={0} max={100} step={1} unit="%"
                  keyframed={hasKeyframeAt(selClip, "opacity", clamp(time - selClip.ts, 0, selClip.dur))}
                  onToggleKeyframe={() => toggleClipKeyframe(selClip, "opacity")}
                  onPrevKeyframe={() => jumpToKeyframe(selClip, "opacity", "prev")}
                  onNextKeyframe={() => jumpToKeyframe(selClip, "opacity", "next")}
                  onChange={v => updateClip(selClip.id, { opacity: v / 100 })} onCommit={snap} />
              </>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", height: 200, opacity: 0.25 }}>
                <div style={{ fontSize: 32, marginBottom: 8 }}>⚙️</div>
                <div style={{ fontSize: 11, textAlign: "center", lineHeight: 1.5 }}>클립이나 그래픽을<br />선택하세요</div>
              </div>
            )}
          </div>
        </div>
      </div>
      {previewPortal}
      {/* ── STATUS BAR ── */}
      <div style={{ height: 32, borderTop: `1px solid ${BORDER}`, background: "#0a0a0a", display: "flex", alignItems: "center", justifyContent: "space-between", padding: "0 16px", flexShrink: 0 }}>
        <div style={{ display: "flex", gap: 16, fontSize: 12, color: "#52525b" }}>
          <span style={{ color: ACCENT, fontWeight: 700 }}>HM Studio Pro</span>
          <span>컴포지션 {comp.w}×{comp.h} @ {comp.fps}fps</span>
          <span>클립: {clips.length}개</span>
          <span>그래픽: {graphics.length}개</span>
        </div>
        <div style={{ display: "flex", gap: 16, fontSize: 12, color: "#52525b" }}>
          <span>{fmt(time)} / {fmt(totalDur)}</span>
          <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <span style={{ width: 8, height: 8, borderRadius: "50%", background: renderStatus === "done" ? ACCENT2 : renderStatus === "rendering" ? "#38bdf8" : renderStatus === "queued" ? ACCENT : "#52525b", display: "inline-block" }} />
            렌더 서버: {renderStatus === "idle" ? "대기" : renderStatus === "queued" ? "큐잉" : renderStatus === "rendering" ? "렌더 중" : "완료"}
          </span>
        </div>
      </div>

      {/* ── AE TEMPLATE PANEL (float) ── */}
      {editingTemplate && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.5)", zIndex: 160, display: "flex", alignItems: "center", justifyContent: "center" }}>
          <div style={{ width: 520, maxHeight: "80vh", overflowY: "auto", background: "#111", border: `1px solid ${ACCENT2}55`, borderRadius: 12, padding: 16, boxShadow: "0 20px 48px rgba(0,0,0,0.55)" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
              <div>
                <div style={{ fontSize: 13, fontWeight: 800, color: ACCENT2 }}>템플릿 등록 설정</div>
                <div style={{ fontSize: 10, color: "#52525b", marginTop: 2 }}>Lottie JSON 기준 · live text면 내부 텍스트 직접 수정</div>
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
                  <input type="text" value={editingTemplate.name} onFocus={e => e.target.select()} onChange={e => updateTemplateAsset(editingTemplate.id, { name: e.target.value })} style={{ width: "100%", background: "#18181b", border: `1px solid ${BORDER}`, borderRadius: 6, color: "#fff", padding: "6px 8px", fontSize: 11, boxSizing: "border-box" }} />
                </div>
                <div style={{ marginBottom: 8 }}>
                  <div style={{ fontSize: 10, color: "#71717a", marginBottom: 3 }}>메인 컴프명</div>
                  <input type="text" value={editingTemplate.compName || ""} onFocus={e => e.target.select()} onChange={e => updateTemplateAsset(editingTemplate.id, { compName: e.target.value })} style={{ width: "100%", background: "#18181b", border: `1px solid ${BORDER}`, borderRadius: 6, color: "#fff", padding: "6px 8px", fontSize: 11, boxSizing: "border-box" }} />
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
                  <input type="text" value={f.label} onFocus={e => e.target.select()} onChange={e => updateTemplateFieldDef(editingTemplate.id, f.id, { label: e.target.value })} placeholder={`필드 ${idx + 1} 이름`} style={{ background: "#18181b", border: `1px solid ${BORDER}`, borderRadius: 6, color: "#fff", padding: "6px 8px", fontSize: 11 }} />
                  <input type="text" value={f.value} onFocus={e => e.target.select()} onChange={e => updateTemplateFieldDef(editingTemplate.id, f.id, { value: e.target.value })} placeholder="기본값" style={{ background: "#18181b", border: `1px solid ${BORDER}`, borderRadius: 6, color: "#fff", padding: "6px 8px", fontSize: 11 }} />
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
          {importedAE.length > 0 && (
            <div>
              <div style={{ fontSize: 10, color: "#52525b", marginBottom: 6 }}>불러온 템플릿 (Lottie)</div>
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
      {/* ── HM STUDIO EXPORT VIEW ── */}
      {isExportView && (
        <div style={{ position: "fixed", inset: 0, background: "#0c0c0c", color: "#e4e4e7", display: "flex", flexDirection: "column", zIndex: 999999, fontFamily: "'Inter', sans-serif", overflow: "hidden" }}>
          {/* Top Bar */}
          <div style={{ height: 48, background: "#141414", borderBottom: "1px solid #27272a", display: "flex", alignItems: "center", justifyContent: "space-between", padding: "0 20px", flexShrink: 0 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
              <span style={{ fontWeight: 800, fontSize: 16, letterSpacing: "-0.02em" }}>HM STUDIO</span>
            </div>
            <div style={{ display: "flex", gap: 16 }}>
              <button onClick={() => setIsExportView(false)} style={{ background: "none", border: "none", color: "#71717a", fontSize: 24, cursor: "pointer" }}>×</button>
            </div>
          </div>

          <div style={{ display: "none" }}>
            <span style={{ color: "#38bdf8", fontSize: 14 }}>📥</span>
            <span style={{ fontSize: 11, color: "#a1a1aa" }}>내보내기 엔진 활성화됨</span>
          </div>

          <div style={{ flex: 1, display: "flex", overflow: "hidden" }}>
            {/* Center Area */}
            <div style={{ 
              flex: 1, 
              position: "relative",
              display: "flex",
              flexDirection: "column",
              background: '#0c0c0e', 
              borderRight: "1px solid #27272a", 
              overflow: "hidden" 
            }}>
              {/* Modern Preview Header Bar for Export */}
              <div style={{
                height: 38,
                background: '#121214',
                borderBottom: `1px solid #27272a`,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                padding: '0 16px',
                fontSize: 12,
                fontWeight: 600,
                color: '#a1a1aa',
                userSelect: 'none',
                width: '100%',
                boxSizing: 'border-box',
                flexShrink: 0
              }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={{ color: ACCENT, fontSize: 14 }}>📥</span>
                  <span style={{ color: '#e4e4e7', fontWeight: 800, fontSize: 13 }}>대기열 렌더 모니터</span>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <span style={{ color: '#38bdf8', fontSize: 13, fontWeight: 800, background: 'rgba(56,189,248,0.1)', padding: '4px 10px', borderRadius: 6, border: '1px solid rgba(56,189,248,0.2)', letterSpacing: '0.02em' }}>
                    🖥️ {comp.w} × {comp.h} ({comp.w === 3840 ? '4K UHD' : comp.w === 1920 ? 'FHD' : 'HD'})
                  </span>
                </div>
              </div>
              
              <div style={{
                flex: 1,
                position: 'relative',
                background: '#000',
                overflow: 'hidden',
                paddingBottom: 154,
                boxSizing: 'border-box'
              }}>
                <div 
                  ref={exportStageContainerRef} 
                  style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", padding: 0, boxSizing: "border-box" }}
                >
                <div 
                  ref={exportStageRef} 
                  style={{ 
                    position: "relative", 
                    width: (() => {
                      const compW = Number(comp?.w || 1920);
                      const compH = Number(comp?.h || 1080);
                      const maxW = exportStageParentDim?.w || 800;
                      const maxH = exportStageParentDim?.h || 600;
                      const compRatio = compH > 0 ? compW / compH : 16/9;
                      const parentRatio = maxH > 0 ? maxW / maxH : 4/3;
                      const val = compRatio > parentRatio ? maxW : maxH * compRatio;
                      return `${Math.round(val)}px`;
                    })(),
                    height: (() => {
                      const compW = Number(comp?.w || 1920);
                      const compH = Number(comp?.h || 1080);
                      const maxW = exportStageParentDim?.w || 800;
                      const maxH = exportStageParentDim?.h || 600;
                      const compRatio = compH > 0 ? compW / compH : 16/9;
                      const parentRatio = maxH > 0 ? maxW / maxH : 4/3;
                      const val = compRatio > parentRatio ? maxW / compRatio : maxH;
                      return `${Math.round(val)}px`;
                    })(),
                    background: comp.bg, 
                    overflow: "hidden",
                    boxShadow: '0 10px 30px rgba(0,0,0,0.5)',
                    display: "flex", 
                    alignItems: "center", 
                    justifyContent: "center",
                    '--stage-scale': exportStageWidth / comp.w
                  } as any}
                >
                  
                  {previewLayers.length > 0 && (
                    <div style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }}>
                      {previewLayers.map(layer => {
                        if (layer.__kind === 'clip') {
                          const clip = layer;
                          const clipScale = lerp(clip.kf?.scale, time - clip.ts, clip.scale) / 100;
                          const clipLeft = lerp(clip.kf?.x, time - clip.ts, clip.x);
                          const clipTop = lerp(clip.kf?.y, time - clip.ts, clip.y);
                          const clipRot = lerp(clip.kf?.rotation, time - clip.ts, clip.rotation ?? 0);
                          const clipOpacity = lerp(clip.kf?.opacity, time - clip.ts, clip.opacity);
                          const assetW = (clip.sourceW || comp.w);
                          const assetH = (clip.sourceH || comp.h);
                          const assetWPct = (assetW / comp.w) * 100;
                          const assetHPct = (assetH / comp.h) * 100;
                          return (
                            <div key={`export-${clip.id}`} style={{ position: 'absolute', left: `${clipLeft}%`, top: `${clipTop}%`, width: `${assetWPct}%`, height: `${assetHPct}%`, transform: `translate(-50%,-50%) scale(${clipScale}) rotate(${clipRot}deg)`, transformOrigin: 'center center', zIndex: layerZMap.get(layerKey(layer)) || 1, display: clip.type === 'audio' ? 'none' : 'block' }}>
                              {clip.type === 'image' ? (
                                <img 
                                  src={resolvePlaybackUrl(clip)}
                                  style={{ width: '100%', height: '100%', objectFit: 'fill', opacity: clipOpacity, pointerEvents: 'none', display: 'block' }} 
                                />
                              ) : (
                                <video 
                                  src={resolvePlaybackUrl(clip)} 
                                  playsInline 
                                  muted={false}
                                  preload='auto' 
                                  style={{ width: '100%', height: '100%', objectFit: 'fill', opacity: clipOpacity, pointerEvents: 'none', display: 'block' }} 
                                   ref={getMediaElementRef("export-" + clip.id)}
                                />
                              )}
                            </div>
                          );
                        }
                        const g = layer;
                        return <GraphicEl key={`export-${g.id}`} g={g} time={time} renderZ={layerZMap.get(layerKey(layer)) || 1} selected={false} editing={false} onEdit={() => {}} onEndEdit={() => {}} onChange={() => {}} />;
                      })}
                      {/* Audio Clips Hidden Sync inside Export View */}
                      <div style={{ display: 'none' }}>
                        {clips.filter(c => c.type === 'audio' && time >= c.ts && time < c.ts + c.dur).map(c => (
                          <audio 
                            key={`export-audio-${c.id}`} 
                            src={resolvePlaybackUrl(c)}
                            playsInline
                            ref={getMediaElementRef("export-" + c.id)}
                          />
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              </div>
            </div>
            <div style={{ position: "absolute", left: 0, right: 0, bottom: 0, height: 154, background: "#0c0c0c", borderTop: "1px solid #27272a", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: "12px 20px", boxSizing: "border-box", gap: 10, zIndex: 20 }}>
                {/* Row 1: Play Bar (Fully centered, taking up maxWidth: 720 with zero side overlap risk) */}
                <div style={{ display: "flex", alignItems: "center", justifyContent: "center", width: "100%", maxWidth: 720 }}>
                  <div style={{ position: "relative", flex: 1, height: 82, display: "flex", alignItems: "center" }}>
                    <div style={{ position: "absolute", left: `${totalDur > 0 ? ((renderIn || 0) / totalDur) * 100 : 0}%`, top: 36, bottom: 20, width: 2, transform: "translateX(-50%)", background: "#22c55e", pointerEvents: "none", zIndex: 2 }} />
                    <div style={{ position: "absolute", left: `${totalDur > 0 ? ((renderIn || 0) / totalDur) * 100 : 0}%`, top: 30, transform: "translateX(-50%)", width: 0, height: 0, borderLeft: "6px solid transparent", borderRight: "6px solid transparent", borderTop: "10px solid #22c55e", pointerEvents: "none", zIndex: 3 }} />
                    <div
                      onMouseDown={e => {
                        e.preventDefault();
                        e.stopPropagation();
                        const track = e.currentTarget.parentElement;
                        if (!track || totalDur <= 0) return;
                        const rect = track.getBoundingClientRect();
                        snap();
                        const move = (mv) => {
                          const next = clamp(((mv.clientX - rect.left) / rect.width) * totalDur, 0, renderOut == null ? totalDur : renderOut);
                          setRenderIn(next);
                        };
                        const up = () => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up); };
                        window.addEventListener('mousemove', move);
                        window.addEventListener('mouseup', up);
                        move(e);
                      }}
                      style={{ position: "absolute", left: `${totalDur > 0 ? ((renderIn || 0) / totalDur) * 100 : 0}%`, top: 0, transform: "translateX(-50%)", background: "#22c55e", color: "#000", fontSize: 14, fontWeight: 900, padding: "7px 12px", borderRadius: 6, cursor: "ew-resize", whiteSpace: "nowrap", zIndex: 4 }}
                    >렌더범위(시작)</div>
                    <div style={{ position: "absolute", left: `${totalDur > 0 ? (((renderOut == null ? totalDur : renderOut) || 0) / totalDur) * 100 : 100}%`, top: 36, bottom: 20, width: 2, transform: "translateX(-50%)", background: "#f43f5e", pointerEvents: "none", zIndex: 2 }} />
                    <div style={{ position: "absolute", left: `${totalDur > 0 ? (((renderOut == null ? totalDur : renderOut) || 0) / totalDur) * 100 : 100}%`, top: 30, transform: "translateX(-50%)", width: 0, height: 0, borderLeft: "6px solid transparent", borderRight: "6px solid transparent", borderTop: "10px solid #f43f5e", pointerEvents: "none", zIndex: 3 }} />
                    <div
                      onMouseDown={e => {
                        e.preventDefault();
                        e.stopPropagation();
                        const track = e.currentTarget.parentElement;
                        if (!track || totalDur <= 0) return;
                        const rect = track.getBoundingClientRect();
                        snap();
                        const move = (mv) => {
                          const next = clamp(((mv.clientX - rect.left) / rect.width) * totalDur, renderIn || 0, totalDur);
                          setRenderOut(next);
                        };
                        const up = () => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up); };
                        window.addEventListener('mousemove', move);
                        window.addEventListener('mouseup', up);
                        move(e);
                      }}
                      style={{ position: "absolute", left: `${totalDur > 0 ? (((renderOut == null ? totalDur : renderOut) || 0) / totalDur) * 100 : 100}%`, top: 0, transform: "translateX(-50%)", background: "#f43f5e", color: "#fff", fontSize: 14, fontWeight: 900, padding: "7px 12px", borderRadius: 6, cursor: "ew-resize", whiteSpace: "nowrap", zIndex: 4 }}
                    >렌더범위(끝)</div>
                    <div style={{ position: "absolute", left: `${totalDur > 0 ? ((renderIn || 0) / totalDur) * 100 : 0}%`, width: `${totalDur > 0 ? Math.max(0, (((renderOut == null ? totalDur : renderOut) - (renderIn || 0)) / totalDur) * 100) : 100}%`, top: 50, height: 6, background: "rgba(34,197,94,0.28)", borderRadius: 999, pointerEvents: "none" }} />
                    <input
                      type="range"
                      min={0}
                      max={totalDur}
                      step={1 / Math.max(1, comp.fps || 30)}
                      value={clamp(time, 0, totalDur)}
                      onChange={e => setTime(Number(e.target.value))}
                      style={{ width: "100%", accentColor: "#f59e0b", position: "relative", zIndex: 1, marginTop: 34 }}
                    />
                  </div>
                </div>

                {/* Row 2: Playback Controls and Right-aligned Large Time Indicator */}
                <div style={{ display: "flex", alignItems: "center", justifyContent: "center", width: "100%", maxWidth: 720, position: "relative" }}>
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 16 }}>
                    <button onClick={() => { setTime(renderIn || 0); setPlaying(false); }} style={{ background: "none", border: "none", color: "#71717a", fontSize: 16, cursor: "pointer" }}>⏮</button>
                    <button onClick={() => setTime(t => Math.max(renderIn || 0, t - 5))} style={{ background: "none", border: "none", color: "#71717a", fontSize: 14, cursor: "pointer" }}>◁◁</button>
                    <button onClick={togglePlayback} style={{ width: 40, height: 40, borderRadius: 10, background: "#f59e0b", border: "none", color: "#000", fontSize: 18, cursor: "pointer", fontWeight: 700 }}>
                      {playing ? '⏸' : '▶'}
                    </button>
                    <button onClick={() => setTime(t => Math.min(renderOut == null ? totalDur : renderOut, t + 5))} style={{ background: "none", border: "none", color: "#71717a", fontSize: 14, cursor: "pointer" }}>▷▷</button>
                    <button onClick={() => { setTime(renderOut == null ? totalDur : renderOut); setPlaying(false); }} style={{ background: "none", border: "none", color: "#71717a", fontSize: 16, cursor: "pointer" }}>⏭</button>
                  </div>

                  <span style={{ position: "absolute", right: 0, fontSize: 14, fontWeight: 700, color: "#a1a1aa", fontVariantNumeric: "tabular-nums" }}>
                    {fmt(time)} / {fmt(renderOut == null ? totalDur : renderOut)}
                  </span>
                </div>
              </div>
            </div>

            {/* Right Sidebar */}
            <div style={{ width: 340, minWidth: 340, background: "#141414", padding: 24, flexShrink: 0, overflowY: "auto", display: "flex", flexDirection: "column" }}>
              <div style={{ marginBottom: 32 }}>
                <div style={{ fontSize: 13, fontWeight: 800, marginBottom: 16, display: "flex", alignItems: "center", gap: 10 }}><span>📄</span> 파일 요약</div>
                <div style={{ marginBottom: 16 }}>
                  <div style={{ fontSize: 10, color: "#71717a", marginBottom: 6 }}>저장 파일명</div>
                  <input type="text" value={exportSettings.filename} onFocus={e => e.target.select()} onChange={e => setExportSettings(s => ({ ...s, filename: e.target.value }))}
                    style={{ width: "100%", background: "#1c1c1e", border: "1px solid #27272a", borderRadius: 6, color: "#fff", padding: "10px", fontSize: 12, outline: "none" }} />
                </div>
                <div>
                  <div style={{ fontSize: 10, color: "#71717a", marginBottom: 6 }}>저장 위치</div>
                  <div style={{ display: "flex", gap: 8 }}>
                    <input 
                      type="text" 
                      value={exportSettings.path} 
                      onFocus={e => e.target.select()}
                      onChange={e => setExportSettings(s => ({ ...s, path: e.target.value }))}
                      placeholder="서버 절대 경로 입력 (예: C:\Exports)"
                      style={{ 
                        flex: 1, 
                        background: "#1c1c1e", 
                        border: "1px solid #27272a", 
                        borderRadius: 6, 
                        color: exportSettings.path?.startsWith('📁') ? "#52525b" : "#fff", 
                        padding: "10px", 
                        fontSize: 11, 
                        outline: "none"
                      }}
                      readOnly={exportSettings.path?.startsWith('📁')}
                    />
                    <button onClick={pickExportDirectory} style={{ padding: "0 12px", background: "#1c1c1e", border: "1px solid #27272a", borderRadius: 6, color: "#a1a1aa", fontSize: 10, cursor: "pointer" }}>찾아보기</button>
                  </div>
                </div>
              </div>
              <div style={{ marginBottom: 32 }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
                  <div style={{ fontSize: 13, fontWeight: 800, display: "flex", alignItems: "center", gap: 10 }}><span style={{ color: "#f59e0b" }}>⚙️</span> 인코더 설정</div>
                  {isCustom && <button onClick={saveCustomPreset} style={{ padding: "6px 12px", background: "rgba(59, 130, 246, 0.2)", color: "#3b82f6", border: "1px solid #3b82f6", borderRadius: 6, fontSize: 11, fontWeight: 700, cursor: "pointer" }}>설정 저장</button>}
                </div>
                <div style={{ display: "flex", gap: 12 }}>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: 10, color: "#71717a", marginBottom: 6 }}>너비</div>
                    <input type="number" value={exportSettings.width} onFocus={e => e.target.select()} onChange={e => setExportSettings(s => ({ ...s, width: Number(e.target.value) }))} readOnly={!isCustom}
                      style={{ width: "100%", background: isCustom ? "#1c1c1e" : "#0c0c0c", border: "1px solid #27272a", borderRadius: 6, color: isCustom ? "#fff" : "#71717a", padding: "10px", fontSize: 12, outline: "none" }} />
                  </div>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: 10, color: "#71717a", marginBottom: 6 }}>높이</div>
                    <input type="number" value={exportSettings.height} onFocus={e => e.target.select()} onChange={e => setExportSettings(s => ({ ...s, height: Number(e.target.value) }))} readOnly={!isCustom}
                      style={{ width: "100%", background: isCustom ? "#1c1c1e" : "#0c0c0c", border: "1px solid #27272a", borderRadius: 6, color: isCustom ? "#fff" : "#71717a", padding: "10px", fontSize: 12, outline: "none" }} />
                  </div>
                </div>
              </div>
            </div>
          </div>

          {/* Bottom Bar - RENDER QUEUE */}
          <div style={{ minHeight: 80, maxHeight: 200, background: "#0a0a0a", borderTop: "1px solid #27272a", display: "flex", padding: "12px 24px", alignItems: "center", justifyContent: "space-between", flexShrink: 0 }}>
            <div style={{ display: "flex", flexDirection: "column", gap: 8, flex: 1, overflow: "hidden", marginRight: 40 }}>
              <div style={{ fontSize: 12, fontWeight: 800, color: "#71717a", display: "flex", alignItems: "center", gap: 8 }}>
                <span>📊</span> 렌더 대기열 ({renderQueue.length}개)
                {renderQueue.length > 0 && (
                  <button onClick={clearRenderQueue} style={{ marginLeft: 12, padding: "2px 8px", background: "#1c1c1e", border: "1px solid #3f3f46", borderRadius: 4, color: "#a1a1aa", fontSize: 10, cursor: "pointer", transition: "all 0.2s" }}>
                    목록 비우기
                  </button>
                )}
              </div>
              <div style={{ display: "flex", gap: 12, overflowX: "auto", paddingBottom: 4 }}>
                {renderQueue.length === 0 ? (
                  <span style={{ fontSize: 11, color: "#3f3f46" }}>대기 중인 작업이 없습니다.</span>
                ) : (
                  renderQueue.map(item => {
                    const isDone = item.status === 'completed';
                    const isFailed = item.status === 'failed';
                    const isActive = !isDone && !isFailed;
                    const displayProgress = isDone ? 100 : Math.max(0, Number(item.progress || 0));
                    const statusLabel = isDone ? "✓ 완료" : isFailed ? "✗ 실패" : `${displayProgress.toFixed(1)}%`;
                    const borderColor = isDone ? "#22c55e55" : isFailed ? "#ef444455" : "#3b82f655";
                    const bgColor = isDone ? "#0a140a" : isFailed ? "#1a0a0a" : "#0a1218";
                    return (
                      <div key={item.id} style={{ minWidth: 280, background: bgColor, border: `1px solid ${borderColor}`, borderRadius: 8, padding: "10px 14px" }}>
                        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
                          <span style={{ fontSize: 11, fontWeight: 700, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1 }}>{item.name}</span>
                          <div style={{ display: "flex", alignItems: "center" }}>
                            {isActive && (
                              <>
                                <style>{`
                                  @keyframes hm-spin {
                                    0% { transform: rotate(-90deg); }
                                    100% { transform: rotate(270deg); }
                                  }
                                `}</style>
                                <svg width="14" height="14" viewBox="0 0 20 20" style={{ transform: "rotate(-90deg)", marginRight: 6, animation: "hm-spin 2s linear infinite" }}>
                                  <circle
                                    cx="10"
                                    cy="10"
                                    r="8"
                                    stroke="rgba(59, 130, 246, 0.15)"
                                    strokeWidth="2.5"
                                    fill="transparent"
                                  />
                                  <circle
                                    cx="10"
                                    cy="10"
                                    r="8"
                                    stroke="#3b82f6"
                                    strokeWidth="2.5"
                                    fill="transparent"
                                    strokeDasharray={50.26}
                                    strokeDashoffset={50.26 - (Math.max(2, displayProgress) / 100) * 50.26}
                                    strokeLinecap="round"
                                    style={{ transition: "stroke-dashoffset 0.3s ease" }}
                                  />
                                </svg>
                              </>
                            )}
                            <span style={{ fontSize: 10, color: isDone ? "#22c55e" : isFailed ? "#ef4444" : "#3b82f6", fontWeight: 700 }}>{statusLabel}</span>
                            <button onClick={() => deleteRenderJob(item.id)} title="작업 삭제" style={{ background: "none", border: "none", color: "#ef4444", fontSize: 14, fontWeight: 900, cursor: "pointer", marginLeft: 8, padding: 0, lineHeight: 1 }}>✕</button>
                          </div>
                        </div>
                        {item.statusText && <div style={{ fontSize: 9, color: "#71717a", marginBottom: 4 }}>{item.statusText}</div>}
                        {isActive && (
                          <div style={{ height: 4, background: "#27272a", borderRadius: 2, overflow: "hidden" }}>
                            <div style={{ width: `${displayProgress}%`, height: "100%", background: "#3b82f6", borderRadius: 2, transition: "width 0.3s ease" }} />
                          </div>
                        )}
                        {isDone && (
                          <div style={{ fontSize: 10, color: "#22c55e", marginTop: 4 }}>✓ 렌더링이 완료되었습니다.</div>
                        )}
                        {isFailed && item.error && (
                          <div style={{ fontSize: 9, color: "#ef4444", marginTop: 2 }}>{item.error}</div>
                        )}
                      </div>
                    );
                  })
                )}
              </div>
            </div>
            <div>
              <button 
                onClick={() => { startActualRender(); }}
                disabled={renderStatus === 'rendering'}
                style={{ 
                  padding: "16px 48px", 
                  background: renderStatus === 'rendering' ? "#52525b" : "#f59e0b", 
                  color: "#000", border: "none", borderRadius: 8, fontSize: 15, fontWeight: 900, 
                  cursor: renderStatus === 'rendering' ? "not-allowed" : "pointer", 
                  boxShadow: renderStatus === 'rendering' ? "none" : "0 4px 20px rgba(245, 158, 11, 0.3)",
                  opacity: renderStatus === 'rendering' ? 0.6 : 1
                }}>
                {renderStatus === 'rendering' ? '렌더링 중...' : '렌더 시작 ▶'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function LoginScreenComponent({
  loginId,
  setLoginId,
  loginPw,
  setLoginPw,
  isLoggingIn,
  loginError,
  handleLoginSubmit
}: {
  loginId: string;
  setLoginId: (val: string) => void;
  loginPw: string;
  setLoginPw: (val: string) => void;
  isLoggingIn: boolean;
  loginError: string;
  handleLoginSubmit: (e?: React.FormEvent) => void;
}) {
  return (
    <div style={{
      width: '100vw', height: '100vh', background: 'linear-gradient(135deg, #2d4d44 0%, #0f1a18 100%)',
      display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#e4e4e7', fontFamily: "'Inter', sans-serif"
    }}>
      <div style={{
        width: 1000, height: 600, background: '#121616', borderRadius: 12, display: 'flex', overflow: 'hidden',
        boxShadow: '0 24px 48px rgba(0,0,0,0.5)', border: '1px solid rgba(255,255,255,0.05)'
      }}>
        {/* Left Side */}
        <div style={{ flex: 1, padding: '60px', display: 'flex', flexDirection: 'column', justifyContent: 'space-between', borderRight: '1px solid rgba(255,255,255,0.05)' }}>
          <div>
            <img src="/HMStudio_logo.png" alt="HMStudio Logo" style={{ height: 95, margin: "0 0 12px 0", padding: 0, display: 'block', objectFit: 'contain' }} />
            <h1 style={{ fontSize: 44, fontWeight: 900, lineHeight: 1.1, margin: 0, letterSpacing: '-0.02em', color: '#fff' }}>
              HANMAC<br />STUDIO
            </h1>
            <p style={{ marginTop: 40, fontSize: 18, color: '#a1a1aa', lineHeight: 1.6, maxWidth: 480 }}>
              한맥가족 임직원들을 위한 쉽고 간편한 영상 편집 솔루션.<br />
              한맥가족만의 전용 디자인 템플릿으로 누구나 전문가처럼<br />
              영상을 완성할 수 있습니다.
            </p>
          </div>
          <div>
            <div style={{ fontSize: 14, color: '#71717a', fontWeight: 600 }}>v1.0.0</div>
            
            <div style={{ marginTop: 60 }}>
              <div style={{ fontSize: 13, color: '#a1a1aa', fontWeight: 600, marginBottom: 16 }}>한맥가족사</div>
              <div style={{ display: 'flex', gap: 24, flexWrap: 'nowrap', opacity: 0.6 }}>
                {['HANMAC', 'SAMAN', 'JANGHEON', 'PTC', 'HALLA', 'BARON'].map(id => (
                  <span key={id} style={{ fontSize: 12, fontWeight: 800 }}>{id}</span>
                ))}
              </div>
            </div>
          </div>
        </div>

        {/* Right Side - Login Form */}
        <div style={{ width: 420, padding: '60px', display: 'flex', flexDirection: 'column', justifyContent: 'center', background: '#161b1b' }}>
          <h2 style={{ fontSize: 32, fontWeight: 800, margin: 0, marginBottom: 8 }}>LOG-IN</h2>
          <p style={{ fontSize: 14, color: '#71717a', marginBottom: 40 }}>사번과 비밀번호를 입력하십시오.</p>
          
          <form onSubmit={handleLoginSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
            <div>
              <label style={{ display: 'block', fontSize: 11, fontWeight: 700, color: '#52525b', marginBottom: 8, letterSpacing: '0.05em' }}>
                사번 (EMPLOYEE ID)
              </label>
              <input 
                type="text" 
                placeholder="ID Number"
                value={loginId}
                onChange={e => setLoginId(e.target.value)}
                style={{
                  width: '100%', height: 48, background: '#0d1111', border: '1px solid #27272a',
                  borderRadius: 6, padding: '0 16px', color: '#fff', fontSize: 14, outline: 'none'
                }}
              />
            </div>
            <div>
              <label style={{ display: 'block', fontSize: 11, fontWeight: 700, color: '#52525b', marginBottom: 8, letterSpacing: '0.05em' }}>
                비번 (PASSWORD)
              </label>
              <input 
                type="password" 
                placeholder="••••••••"
                value={loginPw}
                onChange={e => setLoginPw(e.target.value)}
                style={{
                  width: '100%', height: 48, background: '#0d1111', border: '1px solid #27272a',
                  borderRadius: 6, padding: '0 16px', color: '#fff', fontSize: 14, outline: 'none'
                }}
              />
            </div>
            
            {loginError && <div style={{ fontSize: 12, color: '#ef4444' }}>{loginError}</div>}

            <button 
              type="submit"
              disabled={isLoggingIn}
              style={{
                width: '100%', height: 48, background: '#ff9000', color: '#000', border: 'none',
                borderRadius: 6, fontSize: 15, fontWeight: 800, cursor: 'pointer', marginTop: 8,
                transition: 'all 0.2s', opacity: isLoggingIn ? 0.7 : 1
              }}
            >
              {isLoggingIn ? "인증 중..." : "로그인"}
            </button>

            <div style={{ textAlign: 'center', marginTop: 16 }}>
              <button type="button" style={{ background: 'none', border: 'none', color: '#71717a', fontSize: 12, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, width: '100%' }}>
                <span>📱</span> 휴대폰으로 로그인
              </button>
            </div>
          </form>
        </div>
      </div>
      <div style={{ position: 'absolute', bottom: 40, left: 40, fontSize: 12, color: 'rgba(255,255,255,0.2)', letterSpacing: '0.1em' }}>
        © 2026 HANMAC STUDIO. ALL RIGHTS RESERVED.
      </div>
    </div>
  );
}

