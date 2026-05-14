import React, { useEffect, useMemo, useRef, useState } from 'react';
import { legacySceneToProjectState } from './legacy-adapter';
import { lerpKeyframe } from './interpolate';
import { rasterizeCachedMultiPngTitleCanvas, rasterizeTemplateToCanvas, preloadTemplateImages } from './template-canvas';
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

// [FIX] Use canvas renderer instead of svg renderer for Lottie.
// The svg renderer serializes the DOM via XMLSerializer which triggers browser
// security restrictions: cross-origin images and font-loaded glyphs are tainted
// and come out blank. The canvas renderer draws directly to an offscreen canvas,
// bypassing the taint restriction and faithfully reproducing text & image layers.
type LottieItem = {
  anim: any;
  canvas: HTMLCanvasElement;
  container: HTMLDivElement;
  isCached: boolean;
  frameCache: Map<number, ImageData>;
  isLoaded: boolean;
  hasWaitedForLoad: boolean;
};

function animationDataForRender(layer: any) {
  const data = layer?.lottieData;
  if (!data) return data;
  const clone = JSON.parse(JSON.stringify(data));
  if (layer.templateKind === 'multi_png_title') {
    const hiddenIndices = new Set<number>();
    const customHide = clone.__customHide || {};
    if (Array.isArray(customHide.imageLayerIndices)) {
      customHide.imageLayerIndices.forEach((idx: any) => Number.isFinite(Number(idx)) && hiddenIndices.add(Number(idx)));
    }
    if (Array.isArray(customHide.textLayerIndices)) {
      customHide.textLayerIndices.forEach((idx: any) => Number.isFinite(Number(idx)) && hiddenIndices.add(Number(idx)));
    }
    if (Array.isArray(layer.multiTitleModel?.pairs)) {
      layer.multiTitleModel.pairs.forEach((pair: any) => {
        if (Number.isFinite(Number(pair.imageLayerIndex))) hiddenIndices.add(Number(pair.imageLayerIndex));
        if (Number.isFinite(Number(pair.textLayerIndex))) hiddenIndices.add(Number(pair.textLayerIndex));
        if (Array.isArray(pair.relatedImageLayerIndices)) {
          pair.relatedImageLayerIndices.forEach((idx: any) => Number.isFinite(Number(idx)) && hiddenIndices.add(Number(idx)));
        }
      });
    }
    hiddenIndices.forEach(idx => {
      const target = clone.layers?.[idx];
      if (!target) return;
      target.ks = target.ks || {};
      target.ks.o = { a: 0, k: 0, ix: 11 };
      if (target.ty === 5 && Array.isArray(target?.t?.d?.k)) {
        target.t.d.k = target.t.d.k.map((kf: any) => {
          if (kf?.s && typeof kf.s === 'object') kf.s.t = '';
          return kf;
        });
      }
    });
  }
  return clone;
}

async function syncLottieToTime(item: LottieItem, layer: any, time: number, fps: number) {
  try {
    const local = Math.max(0, Number(time || 0) - Number(layer.ts || 0));
    const lottieFps = layer.lottieData?.fr || fps || 30;
    const frame = Math.round(local * lottieFps);
    const totalFrames = item.anim.totalFrames || 0;
    const clampedFrame = Math.min(frame, Math.max(0, totalFrames - 1));

    const ctx = item.canvas.getContext('2d');
    if (!ctx) return;

    // Seek lottie-web to frame; canvas renderer paints synchronously
    item.anim.goToAndStop(clampedFrame, true);

    // Give the canvas renderer one microtask to flush its draw calls
    await new Promise<void>(resolve => setTimeout(resolve, 0));
  } catch (err) {
    console.warn('[RenderStage] syncLottieToTime failed:', err);
  }
}

async function waitForVisibleLotties(
  lotties: Map<string, LottieItem>,
  layers: any[],
  time: number,
  fps: number
) {
  const active = layers.filter(
    layer =>
      layer.type === 'ae_template' &&
      layer.lottieData &&
      layer.visible !== false &&
      time >= Number(layer.ts || 0) &&
      time < Number(layer.ts || 0) + Number(layer.dur || 0)
  );

  for (const layer of active) {
    let item = lotties.get(layer.id);

    if (!item) {
      const animData = animationDataForRender(layer);
      const w = Math.max(2, Number(animData.w || 1000));
      const h = Math.max(2, Number(animData.h || 1000));

      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      const renderContext = canvas.getContext('2d', { alpha: true });
      const container = document.createElement('div');
      container.style.position = 'fixed';
      container.style.left = '-10000px';
      container.style.top = '-10000px';
      container.style.width = `${w}px`;
      container.style.height = `${h}px`;
      container.style.opacity = '0';
      container.style.pointerEvents = 'none';
      document.body.appendChild(container);

      // [FIX] canvas renderer: Lottie draws directly to an HTMLCanvasElement.
      // Images referenced via asset.u+asset.p paths are loaded normally (same-origin
      // or CORS-enabled), and text glyphs are rasterised by the browser's own canvas
      // text API; none of this goes through XMLSerializer, so nothing gets tainted.
      const anim = lottie.loadAnimation({
        container,
        renderer: 'canvas',
        loop: false,
        autoplay: false,
        animationData: animData,
        rendererSettings: {
          context: renderContext,
          clearCanvas: true,
          preserveAspectRatio: 'xMidYMid meet',
        },
      });

      const entry: LottieItem = {
        anim,
        canvas,
        container,
        isCached: false,
        frameCache: new Map(),
        isLoaded: false,
        hasWaitedForLoad: false,
      };

      // lottie-web canvas renderer event timing varies in headless Chrome.
      // Mark all known ready signals, then fall back after one bounded wait below.
      const markLoaded = () => { entry.isLoaded = true; };
      anim.addEventListener('DOMLoaded', markLoaded);
      anim.addEventListener('data_ready', markLoaded);
      anim.addEventListener('loaded_images', markLoaded);
      anim.addEventListener('config_ready', markLoaded);

      lotties.set(layer.id, entry);
      if (typeof window !== 'undefined') {
        const list = ((window as any).__HM_LOTTIE_INSTANCES ||= []);
        if (!list.includes(anim)) list.push(anim);
      }
      item = entry;
    }

    if (!item.isLoaded && !item.hasWaitedForLoad) {
      // Wait once for lottie-web to initialise. Some canvas-renderer builds never
      // emit DOMLoaded in headless mode, so repeating this per frame costs seconds.
      let waitCount = 0;
      while (!item.isLoaded && waitCount < 100) {
        await wait(10);
        waitCount++;
      }
      item.hasWaitedForLoad = true;
    }

    await syncLottieToTime(item, layer, time, fps);
    item.isLoaded = true;
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
  const isTransparentParam = typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('transparent') === '1';
  if (comp.bg !== 'transparent' && !isTransparentParam) {
    ctx.fillStyle = comp.bg || '#000000';
    ctx.fillRect(0, 0, comp.w, comp.h);
  }
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
      if (layer.templateKind === 'multi_png_title') {
        if (localTime < 1 / Math.max(1, Number(comp.fps || 30))) continue;
        const cachedCanvas = rasterizeCachedMultiPngTitleCanvas(layer, localTime, 1, comp.fps || 30);
        drawLayerImage(ctx, cachedCanvas, cachedCanvas.width, cachedCanvas.height, comp.w, comp.h, layer, localTime);
        continue;
      }
      if (layer.templateKind === 'vector_subtitle') {
        const fallback = rasterizeTemplateToCanvas(layer, localTime, 1);
        drawLayerImage(ctx, fallback, fallback.width, fallback.height, comp.w, comp.h, layer, localTime);
        continue;
      }
      const lottieCanvas = resources.templates[layer.id];
      if (lottieCanvas) {
        drawLayerImage(ctx, lottieCanvas, lottieCanvas.width, lottieCanvas.height, comp.w, comp.h, layer, localTime);
      } else {
        const fallback = rasterizeTemplateToCanvas(layer, localTime, 1);
        drawLayerImage(ctx, fallback, fallback.width, fallback.height, comp.w, comp.h, layer, localTime);
      }
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
  const lottiesRef = useRef<Map<string, LottieItem>>(new Map());
  const drawTokenRef = useRef(0);
  const [imageLoadTick, setImageLoadTick] = useState(0);

  const project = useMemo(() => legacySceneToProjectState({ composition, clips, graphics }), [composition, clips, graphics]);

  useEffect(() => {
    return () => {
      lottiesRef.current.forEach(item => {
        try { item.anim.destroy(); } catch {}
        try { item.container.remove(); } catch {}
        try { item.canvas.width = 0; } catch {}
      });
      lottiesRef.current.clear();
      videosRef.current.forEach(video => { try { video.pause(); } catch { } });
      videosRef.current.clear();
      imagesRef.current.clear();
    };
  }, []);

  // Destroy Lottie instances for layers that are no longer in the graphics list
  useEffect(() => {
    const activeLottieIds = new Set(
      graphics
        .filter((g: any) => g.type === 'ae_template' && g.lottieData)
        .map((g: any) => g.id)
    );
    for (const [id, item] of lottiesRef.current.entries()) {
      if (!activeLottieIds.has(id)) {
        try {
          const list = (window as any).__HM_LOTTIE_INSTANCES;
          if (Array.isArray(list)) {
            const idx = list.indexOf(item.anim);
            if (idx >= 0) list.splice(idx, 1);
          }
        } catch {}
        try { item.anim.destroy(); } catch {}
        try { item.container.remove(); } catch {}
        try { item.canvas.width = 0; } catch {}
        lottiesRef.current.delete(id);
      }
    }
  }, [graphics]);

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
      const ctx = canvas?.getContext('2d', { alpha: true });
      if (!canvas || !ctx) return;

      canvas.width = project.composition.w;
      canvas.height = project.composition.h;

      try {
        await preloadTemplateImages(project.layers);
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

      const isRender = typeof window !== 'undefined' && (
        new URLSearchParams(window.location.search).has('renderJob') ||
        document.documentElement.getAttribute('data-render-ready') !== null
      );
      if (!isRender) {
        await nextPaint();
      }
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
