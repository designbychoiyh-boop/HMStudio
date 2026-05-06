import React, { useEffect, useMemo, useRef, useState } from 'react';
import { WebGLCompositor } from './webgl-compositor';
import { legacySceneToProjectState } from './legacy-adapter';
// @ts-ignore
import lottie from 'lottie-web';

function wait(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
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
      // @ts-ignore
      video.requestVideoFrameCallback(() => finish());
      setTimeout(finish, 120);
    });
    return;
  }
  await wait(30);
}

async function ensureVideoReady(video: HTMLVideoElement) {
  if (video.readyState >= 2) return;
  await new Promise<void>(resolve => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      cleanup();
      resolve();
    };
    const cleanup = () => {
      video.removeEventListener('loadeddata', finish);
      video.removeEventListener('canplay', finish);
      video.removeEventListener('error', finish);
    };
    video.addEventListener('loadeddata', finish, { once: true });
    video.addEventListener('canplay', finish, { once: true });
    video.addEventListener('error', finish, { once: true });
    setTimeout(finish, 400);
  });
}

async function syncVideoToTime(video: HTMLVideoElement, layer: any, time: number, fps = 30) {
  const local = Math.max(0, Number(time || 0) - Number(layer.ts || 0) + Number(layer.startT || 0));
  const threshold = 0.001; // Tighter threshold for frame-perfect rendering
  await ensureVideoReady(video);
  try { video.pause(); } catch { }
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
      setTimeout(finish, 300);
    });
  }
  await waitForVideoFrame(video);
}

async function waitForVisibleVideos(videos: Map<string, HTMLVideoElement>, layers: any[], time: number, fps: number) {
  const active = layers.filter(layer => layer.type === 'video' && layer.visible !== false && time >= Number(layer.ts || 0) && time < Number(layer.ts || 0) + Number(layer.dur || 0));
  if (!active.length) return;
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
      setTimeout(finish, 500);
    });
  }
}

async function syncLottieToTime(lottieItem: { anim: any, canvas: HTMLCanvasElement }, layer: any, time: number, fps: number) {
  const local = Math.max(0, time - (layer.ts || 0));
  const frame = local * (layer.lottieData?.fr || fps || 30);
  lottieItem.anim.goToAndStop(frame, true);
}

async function waitForVisibleLotties(lotties: Map<string, { anim: any, canvas: HTMLCanvasElement }>, layers: any[], time: number, fps: number) {
  const active = layers.filter(layer => layer.type === 'ae_template' && layer.lottieData && layer.visible !== false && time >= Number(layer.ts || 0) && time < Number(layer.ts || 0) + Number(layer.dur || 0));
  for (const layer of active) {
    let item = lotties.get(layer.id);
    if (!item) {
      const canvas = document.createElement('canvas');
      canvas.width = layer.templateW || layer.width || 1000;
      canvas.height = layer.templateH || layer.height || 200;
      const anim = lottie.loadAnimation({
        container: null,
        renderer: 'canvas',
        loop: false,
        autoplay: false,
        animationData: layer.lottieData,
        rendererSettings: {
          canvas: canvas,
          preserveAspectRatio: 'xMidYMid meet'
        }
      });
      item = { anim, canvas };
      lotties.set(layer.id, item);
    }
    await syncLottieToTime(item, layer, time, fps);
  }
}

export function WebGLRenderStage({ composition, clips, graphics, time, onReady }: {
  composition: { w: number; h: number; fps: number; bg: string };
  clips: any[];
  graphics: any[];
  time: number;
  onReady?: () => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const compositorRef = useRef<WebGLCompositor | null>(null);
  const videosRef = useRef<Map<string, HTMLVideoElement>>(new Map());
  const imagesRef = useRef<Map<string, HTMLImageElement>>(new Map());
  const lottiesRef = useRef<Map<string, { anim: any, canvas: HTMLCanvasElement }>>(new Map());
  const drawTokenRef = useRef(0);
  const [imageLoadTick, setImageLoadTick] = useState(0);

  const project = useMemo(() => legacySceneToProjectState({ composition, clips, graphics }), [composition, clips, graphics]);

  useEffect(() => {
    if (!canvasRef.current) return;
    compositorRef.current?.dispose?.();
    compositorRef.current = new WebGLCompositor(canvasRef.current, project.composition.w, project.composition.h);
    return () => {
      compositorRef.current?.dispose?.();
      compositorRef.current = null;
      // Cleanup lotties
      lottiesRef.current.forEach(item => item.anim.destroy());
      lottiesRef.current.clear();
    };
  }, [project.composition.w, project.composition.h]);

  useEffect(() => {
    const map = videosRef.current;
    const imgMap = imagesRef.current;
    const wantedVideos = new Set(clips.filter(c => c.type !== 'image' && c.type !== 'audio').map(c => c.id));
    const wantedImages = new Set(clips.filter(c => c.type === 'image').map(c => c.id));
    
    // Cleanup old videos
    for (const [id, video] of map.entries()) {
      if (!wantedVideos.has(id)) {
        try { video.pause(); } catch { }
        map.delete(id);
      }
    }
    // Cleanup old images
    for (const [id] of imgMap.entries()) {
      if (!wantedImages.has(id)) {
        imgMap.delete(id);
      }
    }
    // Add new videos
    clips.forEach(clip => {
      if (clip.type === 'image' || clip.type === 'audio') return;
      if (map.has(clip.id)) return;
      const video = document.createElement('video');
      video.crossOrigin = 'anonymous';
      video.muted = true;
      video.playsInline = true;
      video.preload = 'auto';
      video.src = clip.serverUrl || clip.url;
      map.set(clip.id, video);
    });
    // Add new images
    clips.forEach(clip => {
      if (clip.type !== 'image') return;
      if (imgMap.has(clip.id)) return;
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.src = clip.serverUrl || clip.url;
      // When image loads, trigger a re-render so it appears on canvas
      img.onload = () => {
        setImageLoadTick(t => t + 1);
      };
      imgMap.set(clip.id, img);
    });
  }, [clips]);

  useEffect(() => {
    let cancelled = false;
    const token = ++drawTokenRef.current;
    const draw = async () => {
      const compositor = compositorRef.current;
      if (!compositor) return;
      
      // Sync resources
      await Promise.all([
        waitForVisibleVideos(videosRef.current, project.layers, time, project.composition.fps),
        waitForVisibleImages(imagesRef.current, project.layers, time),
        waitForVisibleLotties(lottiesRef.current, project.layers, time, project.composition.fps)
      ]);

      if (cancelled || token !== drawTokenRef.current) return;

      const activeImages = project.layers.filter(l => l.type === 'image' && time >= l.ts && time < l.ts + l.dur);
      if (activeImages.length > 0) {
        console.log(`[RenderStage] Active Images: ${activeImages.length}, Loaded Resources: ${imagesRef.current.size}`);
      }

      const templateCanvases: Record<string, HTMLCanvasElement> = {};
      lottiesRef.current.forEach((item, id) => {
        const layer = project.layers.find(l => l.id === id);
        if (layer && time >= layer.ts && time < layer.ts + layer.dur) {
          templateCanvases[id] = item.canvas;
        }
      });

      compositor.resize(project.composition.w, project.composition.h);
      compositor.render(project, time, { 
        videos: videosRef.current,
        images: imagesRef.current,
        templates: templateCanvases
      });
      
      // Ensure WebGL flush and DOM update before signaling ready
      requestAnimationFrame(() => {
        onReady?.();
      });
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
