import type { AETemplateLayer, ProjectState, ShapeLayer, TextLayer, TimelineLayer, VideoLayer } from './project-types';

export type LegacySceneInput = {
  composition?: { w?: number; h?: number; fps?: number; bg?: string };
  renderRange?: { in?: number; out?: number };
  clips?: any[];
  graphics?: any[];
};

function baseLayerFromLegacy(layer: any) {
  return {
    id: String(layer.id),
    ts: Number(layer.ts || 0),
    dur: Math.max(0.01, Number(layer.dur || 0.01)),
    x: Number(layer.x || 50),
    y: Number(layer.y || 50),
    scale: Number(layer.scale || 100),
    rotation: Number(layer.rotation || 0),
    opacity: Number(layer.opacity ?? 1),
    visible: layer.visible !== false,
    layerOrder: Number(layer.layerOrder ?? 0),
    kf: layer.kf || null,
  };
}

function mapClip(clip: any): VideoLayer {
  return {
    ...baseLayerFromLegacy(clip),
    type: 'video',
    name: clip.name || 'clip',
    url: clip.url,
    serverUrl: clip.serverUrl || null,
    storedPath: clip.storedPath || null,
    sourceW: Number(clip.sourceW || 1920),
    sourceH: Number(clip.sourceH || 1080),
    startT: Number(clip.startT || 0),
    endT: Number(clip.endT || clip.dur || 0),
  };
}

function mapGraphic(graphic: any): TimelineLayer | null {
  const base = baseLayerFromLegacy(graphic);
  if (graphic.type === 'text') {
    const out: TextLayer = {
      ...base,
      type: 'text',
      content: String(graphic.content || ''),
      width: Number(graphic.width || 400),
      height: Number(graphic.height || 120),
      color: String(graphic.color || '#ffffff'),
      fontSize: Number(graphic.fontSize || 48),
      fontFamily: String(graphic.fontFamily || "Pretendard, 'Noto Sans KR', sans-serif"),
      fontWeight: graphic.fontWeight || '700',
      textAlign: graphic.textAlign || 'center',
    };
    return out;
  }
  if (graphic.type === 'rectangle' || graphic.type === 'circle') {
    const out: ShapeLayer = {
      ...base,
      type: graphic.type,
      width: Number(graphic.width || 200),
      height: Number(graphic.height || 200),
      color: String(graphic.color || '#ffffff'),
    };
    return out;
  }
  if (graphic.type === 'ae_template') {
    const out: AETemplateLayer = {
      ...base,
      type: 'ae_template',
      compName: graphic.compName,
      templateKind: graphic.templateKind || 'lottie',
      width: Number(graphic.width || graphic.templateW || 1000),
      height: Number(graphic.height || graphic.templateH || 200),
      templateW: Number(graphic.templateW || graphic.width || 1000),
      templateH: Number(graphic.templateH || graphic.height || 200),
      cropBounds: graphic.cropBounds || undefined,
      fields: Array.isArray(graphic.fields) ? graphic.fields.map((f: any) => ({
        id: String(f.id),
        label: String(f.label || ''),
        value: String(f.value || ''),
        x: typeof f.x === 'number' ? f.x : undefined,
        y: typeof f.y === 'number' ? f.y : undefined,
        w: typeof f.w === 'number' ? f.w : undefined,
        h: typeof f.h === 'number' ? f.h : undefined,
        fontSize: typeof f.fontSize === 'number' ? f.fontSize : undefined,
        fontFamily: f.fontFamily,
        color: f.color,
        textAlign: f.textAlign,
        strokeColor: f.strokeColor,
        strokeWidth: typeof f.strokeWidth === 'number' ? f.strokeWidth : undefined,
      })) : [],
      vectorModel: graphic.vectorModel,
      multiTitleModel: graphic.multiTitleModel,
      lottieData: graphic.lottieData,
      glyphChars: graphic.glyphChars,
    };
    return out;
  }
  return null;
}

export function legacySceneToProjectState(input: LegacySceneInput): ProjectState {
  const composition = {
    w: Math.max(1, Number(input.composition?.w || 1920)),
    h: Math.max(1, Number(input.composition?.h || 1080)),
    fps: Math.max(1, Number(input.composition?.fps || 30)),
    bg: String(input.composition?.bg || '#000000'),
  };
  const clips = Array.isArray(input.clips) ? input.clips.map(mapClip) : [];
  const graphics = Array.isArray(input.graphics) ? input.graphics.map(mapGraphic).filter(Boolean) as TimelineLayer[] : [];
  const layers = [...clips, ...graphics].sort((a, b) => Number(a.layerOrder || 0) - Number(b.layerOrder || 0));
  const maxOut = Math.max(
    0,
    ...layers.map(layer => Number(layer.ts || 0) + Number(layer.dur || 0)),
  );
  return {
    composition,
    renderRange: {
      in: Math.max(0, Number(input.renderRange?.in || 0)),
      out: Math.max(0.01, Number(input.renderRange?.out || maxOut || 5)),
    },
    layers,
  };
}
