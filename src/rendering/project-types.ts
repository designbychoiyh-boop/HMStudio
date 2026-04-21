export type CompositionSettings = {
  w: number;
  h: number;
  fps: number;
  bg: string;
};

export type RenderRange = {
  in: number;
  out: number;
};

export type BaseLayer = {
  id: string;
  ts: number;
  dur: number;
  x: number;
  y: number;
  scale: number;
  rotation?: number;
  opacity: number;
  visible?: boolean;
  layerOrder?: number;
  kf?: Record<string, Array<{ t: number; v: number }>> | null;
};

export type VideoLayer = BaseLayer & {
  type: 'video';
  name: string;
  url?: string;
  serverUrl?: string | null;
  storedPath?: string | null;
  sourceW?: number;
  sourceH?: number;
  startT?: number;
  endT?: number;
};

export type TextLayer = BaseLayer & {
  type: 'text';
  content: string;
  width: number;
  height: number;
  color: string;
  fontSize: number;
  fontFamily: string;
  fontWeight?: string;
  textAlign?: 'left' | 'center' | 'right';
};

export type ShapeLayer = BaseLayer & {
  type: 'rectangle' | 'circle';
  width: number;
  height: number;
  color: string;
};

export type TemplateField = {
  id: string;
  label: string;
  value: string;
  x?: number;
  y?: number;
  w?: number;
  h?: number;
  fontSize?: number;
  fontFamily?: string;
  color?: string;
  textAlign?: 'left' | 'center' | 'right';
  strokeColor?: string;
  strokeWidth?: number;
};

export type AETemplateLayer = BaseLayer & {
  type: 'ae_template';
  compName?: string;
  templateKind?: 'vector_subtitle' | 'multi_png_title' | 'lottie' | 'svg';
  width: number;
  height: number;
  templateW?: number;
  templateH?: number;
  cropBounds?: { x: number; y: number; w: number; h: number };
  fields?: TemplateField[];
  vectorModel?: any;
  multiTitleModel?: any;
  lottieData?: any;
  glyphChars?: string[];
};

export type TimelineLayer = VideoLayer | TextLayer | ShapeLayer | AETemplateLayer;

export type ProjectState = {
  composition: CompositionSettings;
  renderRange: RenderRange;
  layers: TimelineLayer[];
};
