import React, { useEffect, useMemo, useRef, useState } from 'react';
import { legacySceneToProjectState } from './legacy-adapter';
import { lerpKeyframe } from './interpolate';
import { rasterizeTemplateToCanvas } from './template-canvas';
// @ts-ignore
import lottie from 'lottie-web';

function wait(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function nextPaint() {
  return new Promise<void>(resolve => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  });
}

function resolveMediaSrc(clip: any) {
  return clip?.serverUrl || clip?.url || '';
}

function fallbackMediaSrc(clip: any, currentSrc: string) {
  if (clip?.serverUrl && clip?.url && currentSrc === clip.serverUrl) return clip.url;
  if (clip?.url && clip?.serverUrl && currentSrc === clip.url) return clip.serverUrl;
  return '';
}

async function waitForVideoFrame(video: HTMLVideoElement) {
  if ('requestVideoFrameCallback' in video) {
    await new Promise<void>(resolve => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        resolve();
      };
      try {
        // @ts-ignore
        video.requestVideoFrameCallback(() => finish());
      } catch {
        setTimeout(finish, 60);
      }
      setTimeout(finish, 250);
    });
    return;
  }
  await wait(60);
}

async function ensureVideoReady(video: HTMLVideoElement) {
  if (video.readyState >= 2 && video.videoWidth > 0 && video.videoHeight > 0) return;
  await new Promise<void>(resolve => {
    let done = false;
    const finish = () => {
      if (done) return;
      if ((video.readyState < 2 || !video.videoWidth || !video.videoHeight) && !video.error) return;
      done = true;
      cleanup();
      resolve();
    };
    const cleanup = () => {
      video.removeEventListener('loadedmetadata', finish);
      video.removeEventListener('loadeddata', finish);
      video.removeEventListener('canplay', finish);
      video.removeEventListener('error', finish);
    };
    video.addEventListener('loadedmetadata', finish);
    video.addEventListener('loadeddata', finish);
    video.addEventListener('canplay', finish);
    video.addEventListener('error', finish);
    try { video.load(); } catch { }
    setTimeout(() => { done = true; cleanup(); resolve(); }, 5000);
  });
}

async function syncVideoToTime(video: HTMLVideoElement, layer: any, time: number, fps = 30) {
  await ensureVideoReady(video);
  try { video.pause(); } catch { }

  const localRaw = Math.max(0, Number(time || 0) - Number(layer.ts || 0) + Number(layer.startT || 0));
  const duration = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : Number(layer.endT || layer.dur || localRaw + 1);
  const maxTime = Math.max(0, duration - 1 / Math.max(1, fps));
  const local = Math.min(localRaw, maxTime);
  const threshold = Math.max(0.0005, 1 / Math.max(1, fps) / 8);

  if (Math.abs((video.currentTime || 0) - local) > threshold) {
    await new Promise<void>(resolve => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        cleanup();
        resolve();
      };
      const cleanup = () => {
        video.removeEventListener('seeked', finish);
        video.removeEventListener('loadeddata', finish);
        video.removeEventListener('canplay', finish);
        video.removeEventListener('error', finish);
      };
      video.addEventListener('seeked', finish, { once: true });
      video.addEventListener('loadeddata', finish, { once: true });
      video.addEventListener('canplay', finish, { once: true });
      video.addEventListener('error', finish, { once: true });
      try { video.currentTime = local; } catch { finish(); }
      setTimeout(finish, 1500);
    });
  }

  await waitForVideoFrame(video);
}

async function waitForVisibleVideos(videos: Map<string, HTMLVideoElement>, layers: any[], time: number, fps: number) {
  const active = layers.filter(layer => layer.type === 'video' && layer.visible !== false && time >= Number(layer.ts || 0) && time < Number(layer.ts || 0) + Number(layer.dur || 0));
  for (const layer of active) {
    const video = videos.get(layer.id);
    if (!video) continue;
    await syncVideoToTime(video, layer, time, fps);
  }
}

async function waitForVisibleImages(images: Map<string, HTMLImageElement>, layers: any[], time: number) {
  const active = layers.filter(layer => layer.type === 'image' && layer.visible !== false && time >= Number(layer.ts || 0) && time < Number(layer.ts || 0) + Number(layer.dur || 0));
  for (const layer of active) {
    const img = images.get(layer.id);
    if (!img) continue;
    if (img.complete && img.naturalWidth > 0) continue;
    await new Promise<void>(resolve => {
      let done = false;
      const finish = () => { if (done) return; done = true; resolve(); };
      img.addEventListener('load', finish, { once: true });
      img.addEventListener('error', finish, { once: true });
      setTimeout(finish, 3000);
    });
  }
}

async function syncLottieToTime(lottieItem: { anim: any, canvas: HTMLCanvasElement, isLoaded?: boolean }, layer: any, time: number, fps: number) {
  try {
    const local = Math.max(0, Number(time || 0) - Number(layer.ts || 0));
    const frame = local * (layer.lottieData?.fr || fps || 30);
    lottieItem.anim.goToAndStop(frame, true);
    await wait(0);
  } catch (err) {
    console.warn('[RenderStage] syncLottieToTime failed:', err);
  }
}

async function waitForVisibleLotties(lotties: Map<string, { anim: any, canvas: HTMLCanvasElement, isLoaded?: boolean }>, layers: any[], time: number, fps: number) {
  const active = layers.filter(layer => layer.type === 'ae_template' && layer.lottieData && layer.templateKind !== 'vector_subtitle' && layer.templateKind !== 'multi_png_title' && layer.visible !== false && time >= Number(layer.ts || 0) && time < Number(layer.ts || 0) + Number(layer.dur || 0));
  for (const layer of active) {
    let item = lotties.get(layer.id);
    if (!item) {
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(2, Math.round(layer.templateW || layer.width || 1000));
      canvas.height = Math.max(2, Math.round(layer.templateH || layer.height || 200));
      canvas.style.background = 'transparent';
      const ctx = canvas.getContext('2d', { alpha: true });
      ctx?.clearRect(0, 0, canvas.width, canvas.height);

      const animData = JSON.parse(JSON.stringify(layer.lottieData));
      const anim = lottie.loadAnimation({
        container: null,
        renderer: 'canvas',
        loop: false,
        autoplay: false,
        animationData: animData,
        rendererSettings: {
          canvas,
          context: ctx || undefined,
          clearCanvas: true,
          progressiveLoad: false,
          hideOnTransparent: true,
          preserveAspectRatio: 'xMidYMid meet'
        }
      });

      const entry: { anim: any, canvas: HTMLCanvasElement, isLoaded?: boolean } = { anim, canvas, isLoaded: false };
      anim.addEventListener('DOMLoaded', () => { entry.isLoaded = true; });
      anim.addEventListener('data_ready', () => { entry.isLoaded = true; });
      anim.addEventListener('loaded_images', () => { entry.isLoaded = true; });
      lotties.set(layer.id, entry);
      item = entry;
    }

    let waitCount = 0;
    while (!item.isLoaded && waitCount < 200) {
      await wait(10);
      waitCount++;
    }

    const ctx = item.canvas.getContext('2d', { alpha: true });
    ctx?.clearRect(0, 0, item.canvas.width, item.canvas.height);
    await syncLottieToTime(item, layer, time, fps);
  }
}

function drawLayerImage(ctx: CanvasRenderingContext2D, source: CanvasImageSource, srcW: number, srcH: number, compW: number, compH: number, layer: any, localTime: number) {
  const x = lerpKeyframe(layer.kf?.x as any, localTime, layer.x);
  const y = lerpKeyframe(layer.kf?.y as any, localTime, layer.y);
  const scale = lerpKeyframe(layer.kf?.scale as any, localTime, layer.scale) / 100;
  const rotation = ((lerpKeyframe(layer.kf?.rotation as any, localTime, layer.rotation || 0) || 0) * Math.PI) / 180;
  const opacity = Math.max(0, Math.min(1, lerpKeyframe(layer.kf?.opacity as any, localTime, layer.opacity ?? 1)));

  ctx.save();
  ctx.globalAlpha = opacity;
  ctx.translate((x / 100) * compW, (y / 100) * compH);
  ctx.rotate(rotation);
  ctx.scale(scale, scale);
  try {
    ctx.drawImage(source, -srcW / 2, -srcH / 2, srcW, srcH);
  } catch (err) {
    console.warn('[RenderStage] drawImage failed:', err);
  }
  ctx.restore();
}

function makeTextCanvas(layer: any) {
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(2, Math.round(layer.width || 400));
  canvas.height = Math.max(2, Math.round(layer.height || 120));
  const ctx = canvas.getContext('2d', { alpha: true })!;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = layer.color || '#ffffff';
  ctx.font = `${layer.fontWeight || '700'} ${layer.fontSize || 48}px ${layer.fontFamily || "Pretendard, 'Noto Sans KR', sans-serif"}`;
  ctx.textAlign = (layer.textAlign || 'center') as CanvasTextAlign;
  ctx.textBaseline = 'middle';
  const tx = layer.textAlign === 'left' ? 0 : layer.textAlign === 'right' ? canvas.width : canvas.width / 2;
  ctx.fillText(layer.content || '', tx, canvas.height / 2);
  return canvas;
}

function makeShapeCanvas(layer: any) {
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(2, Math.round(layer.width || 200));
  canvas.height = Math.max(2, Math.round(layer.height || 200));
  const ctx = canvas.getContext('2d', { alpha: true })!;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = layer.color || '#ffffff';
  if (layer.type === 'circle') {
    ctx.beginPath();
    ctx.arc(canvas.width / 2, canvas.height / 2, Math.min(canvas.width, canvas.height) / 2, 0, Math.PI * 2);
    ctx.fill();
  } else {
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  }
  return canvas;
}

function renderCanvas2D(ctx: CanvasRenderingContext2D, project: any, time: number, resources: { videos: Map<string, HTMLVideoElement>; images: Map<string, HTMLImageElement>; templates: Record<string, HTMLCanvasElement> }) {
  const comp = project.composition;
  ctx.save();
  ctx.globalCompositeOperation = 'source-over';
  ctx.globalAlpha = 1;
  ctx.clearRect(0, 0, comp.w, comp.h);
  ctx.fillStyle = comp.bg || '#000000';
  ctx.fillRect(0, 0, comp.w, comp.h);
  ctx.restore();

  const ordered = [...project.layers]
    .filter((layer: any) => layer.visible !== false && time >= Number(layer.ts || 0) && time < Number(layer.ts || 0) + Number(layer.dur || 0))
    .sort((a: any, b: any) => Number(a.layerOrder || 0) - Number(b.layerOrder || 0));

  for (const layer of ordered) {
    const localTime = time - Number(layer.ts || 0);
    if (layer.type === 'video') {
      const video = resources.videos.get(layer.id);
      if (!video || video.readyState < 2 || !video.videoWidth || !video.videoHeight) continue;
      const srcW = video.videoWidth || layer.sourceW || comp.w;
      const srcH = video.videoHeight || layer.sourceH || comp.h;
      drawLayerImage(ctx, video, srcW, srcH, comp.w, comp.h, layer, localTime);
    } else if (layer.type === 'image') {
      const img = resources.images.get(layer.id);
      if (!img || !img.naturalWidth) continue;
      const srcW = img.naturalWidth || layer.sourceW || comp.w;
      const srcH = img.naturalHeight || layer.sourceH || comp.h;
      drawLayerImage(ctx, img, srcW, srcH, comp.w, comp.h, layer, localTime);
    } else if (layer.type === 'text') {
      const canvas = makeTextCanvas(layer);
      drawLayerImage(ctx, canvas, canvas.width, canvas.height, comp.w, comp.h, layer, localTime);
    } else if (layer.type === 'rectangle' || layer.type === 'circle') {
      const canvas = makeShapeCanvas(layer);
      drawLayerImage(ctx, canvas, canvas.width, canvas.height, comp.w, comp.h, layer, localTime);
    } else if (layer.type === 'ae_template') {
      if (layer.templateKind === 'vector_subtitle' || layer.templateKind === 'multi_png_title') continue;
      const canvas = resources.templates[layer.id] || rasterizeTemplateToCanvas(layer, localTime, 1);
      drawLayerImage(ctx, canvas, canvas.width, canvas.height, comp.w, comp.h, layer, localTime);
    }
  }
}

export function WebGLRenderStage({ composition, clips, graphics, time, onReady }: {
  composition: { w: number; h: number; fps: number; bg: string };
  clips: any[];
  graphics: any[];
  time: number;
  onReady?: (canvas: HTMLCanvasElement) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const videosRef = useRef<Map<string, HTMLVideoElement>>(new Map());
  const imagesRef = useRef<Map<string, HTMLImageElement>>(new Map());
  const lottiesRef = useRef<Map<string, { anim: any, canvas: HTMLCanvasElement, isLoaded?: boolean }>>(new Map());
  const drawTokenRef = useRef(0);
  const [imageLoadTick, setImageLoadTick] = useState(0);

  const project = useMemo(() => legacySceneToProjectState({ composition, clips, graphics }), [composition, clips, graphics]);

  useEffect(() => {
    return () => {
      lottiesRef.current.forEach(item => item.anim.destroy());
      lottiesRef.current.clear();
      videosRef.current.forEach(video => { try { video.pause(); } catch { } });
      videosRef.current.clear();
      imagesRef.current.clear();
    };
  }, []);

  useEffect(() => {
    const videoMap = videosRef.current;
    const imageMap = imagesRef.current;
    const wantedVideos = new Set(clips.filter(c => c.type !== 'image' && c.type !== 'audio').map(c => c.id));
    const wantedImages = new Set(clips.filter(c => c.type === 'image').map(c => c.id));

    for (const [id, video] of videoMap.entries()) {
      if (!wantedVideos.has(id)) {
        try { video.pause(); } catch { }
        video.removeAttribute('src');
        try { video.load(); } catch { }
        videoMap.delete(id);
      }
    }
    for (const [id] of imageMap.entries()) {
      if (!wantedImages.has(id)) imageMap.delete(id);
    }

    clips.forEach(clip => {
      if (clip.type === 'image' || clip.type === 'audio') return;
      const src = resolveMediaSrc(clip);
      const existing = videoMap.get(clip.id);
      if (existing && existing.dataset.src === src) return;
      if (existing) {
        try { existing.pause(); } catch { }
        existing.removeAttribute('src');
        try { existing.load(); } catch { }
        videoMap.delete(clip.id);
      }
      const video = document.createElement('video');
      video.crossOrigin = 'anonymous';
      video.muted = true;
      video.defaultMuted = true;
      video.playsInline = true;
      video.preload = 'auto';
      video.dataset.src = src;
      video.src = src;
      video.addEventListener('loadeddata', () => setImageLoadTick(t => t + 1));
      video.addEventListener('seeked', () => setImageLoadTick(t => t + 1));
      video.addEventListener('error', () => {
        const fallback = fallbackMediaSrc(clip, video.dataset.src || '');
        if (!fallback || fallback === video.dataset.src) return;
        video.dataset.src = fallback;
        video.src = fallback;
        try { video.load(); } catch { }
      });
      try { video.load(); } catch { }
      videoMap.set(clip.id, video);
    });

    clips.forEach(clip => {
      if (clip.type !== 'image') return;
      const src = resolveMediaSrc(clip);
      const existing = imageMap.get(clip.id);
      if (existing && existing.dataset.src === src) return;
      if (existing) imageMap.delete(clip.id);
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = () => setImageLoadTick(t => t + 1);
      img.onerror = () => {
        const fallback = fallbackMediaSrc(clip, img.dataset.src || '');
        if (!fallback || fallback === img.dataset.src) return;
        img.dataset.src = fallback;
        img.src = fallback;
      };
      img.dataset.src = src;
      img.src = src;
      imageMap.set(clip.id, img);
    });
  }, [clips]);

  useEffect(() => {
    let cancelled = false;
    const token = ++drawTokenRef.current;

    const draw = async () => {
      const canvas = canvasRef.current;
      const ctx = canvas?.getContext('2d', { alpha: false });
      if (!canvas || !ctx) return;

      canvas.width = project.composition.w;
      canvas.height = project.composition.h;

      try {
        await waitForVisibleVideos(videosRef.current, project.layers, time, project.composition.fps);
        await waitForVisibleImages(imagesRef.current, project.layers, time);
        await waitForVisibleLotties(lottiesRef.current, project.layers, time, project.composition.fps);
      } catch (err) {
        console.warn('[RenderStage] Resource sync failed, rendering available layers:', err);
      }

      if (cancelled || token !== drawTokenRef.current) return;

      const templateCanvases: Record<string, HTMLCanvasElement> = {};
      lottiesRef.current.forEach((item, id) => {
        const layer = project.layers.find((l: any) => l.id === id);
        if (layer && time >= layer.ts && time < layer.ts + layer.dur) templateCanvases[id] = item.canvas;
      });

      renderCanvas2D(ctx, project, time, {
        videos: videosRef.current,
        images: imagesRef.current,
        templates: templateCanvases
      });

      await nextPaint();
      if (!cancelled && token === drawTokenRef.current && canvas) onReady?.(canvas);
    };

    draw();
    return () => { cancelled = true; };
  }, [project, time, onReady, imageLoadTick]);

  return (
    <canvas
      ref={canvasRef}
      width={project.composition.w}
      height={project.composition.h}
      style={{ width: '100%', height: '100%', objectFit: 'contain', display: 'block', background: project.composition.bg }}
    />
  );
}
