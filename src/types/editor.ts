export interface Keyframe {
  time: number; // Time relative to the clip's start (0 to duration)
  value: number;
  easing?: 'linear' | 'ease-in' | 'ease-out' | 'ease-in-out';
}

export interface VideoClip {
  id: string;
  file: File;
  url: string;
  name: string;
  duration: number;
  originalDuration: number;
  startTime: number; // Start time in the original video
  endTime: number;   // End time in the original video
  timelineStart: number; // Start time on the editor timeline
  thumbnail?: string;
  track: number; // 1, 2, 3 for V1, V2, V3
  opacity: number;
  scale: number;
  x: number;
  y: number;
  rotation: number;
  keyframes?: Record<string, Keyframe[]>; // e.g., { opacity: [...], scale: [...] }
  serverFileName?: string;
  serverFilePath?: string;
}

export interface AudioClip {
  id: string;
  file: File;
  url: string;
  name: string;
  duration: number;
  timelineStart: number;
  track: number; // 1, 2, 3 for A1, A2, A3
  volume: number;
}

export interface MogrtEditableField {
  id: string;
  label: string;
  value: string;
  multiline?: boolean;
}

export interface GraphicLayer {
  id: string;
  type: 'text' | 'rectangle' | 'circle' | 'mogrt_lower_third' | 'mogrt_instance';
  content: string;
  timelineStart: number;
  duration: number;
  x: number;
  y: number;
  width: number;
  height: number;
  opacity: number;
  scale: number;
  color: string;
  fontSize?: number;
  fontFamily?: string;
  fontWeight?: string;
  textAlign?: 'left' | 'center' | 'right';
  rotation?: number;

  badgeText?: string;
  strokeColor?: string;
  strokeWidth?: number;
  shadowColor?: string;
  shadowX?: number;
  shadowY?: number;
  shadowBlur?: number;
  badgeBgColor?: string;
  badgeTextColor?: string;
  lineHeight?: number;
  letterSpacing?: number;
  templateAssetId?: string;
  templateName?: string;
  templateMainCompName?: string;
  sourceFileName?: string;
  mogrtFields?: MogrtEditableField[];
  adobePreviewStatus?: 'draft' | 'preview-requested' | 'preview-ready' | 'final-requested' | 'rendered';
  adobePreviewImageUrl?: string;
  adobePreviewUpdatedAt?: string;

  track: number; // Usually same as video tracks or separate
  keyframes?: Record<string, Keyframe[]>;
}

export interface EditorState {
  clips: VideoClip[];
  audioClips: AudioClip[];
  graphics: GraphicLayer[];
  currentTime: number;
  isPlaying: boolean;
  totalDuration: number;
  selectedClipId: string | null;
  selectedGraphicId: string | null;
  selectedAudioId: string | null;
}


