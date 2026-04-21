import React, { useEffect, useMemo, useRef } from 'react';
import { WebGLCompositor } from './webgl-compositor';
import { legacySceneToProjectState } from './legacy-adapter';

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
  const threshold = 0.25 / Math.max(1, Number(fps || 30));
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
  const drawTokenRef = useRef(0);

  const project = useMemo(() => legacySceneToProjectState({ composition, clips, graphics }), [composition, clips, graphics]);

  useEffect(() => {
    if (!canvasRef.current) return;
    compositorRef.current?.dispose?.();
    compositorRef.current = new WebGLCompositor(canvasRef.current, project.composition.w, project.composition.h);
    return () => {
      compositorRef.current?.dispose?.();
      compositorRef.current = null;
    };
  }, [project.composition.w, project.composition.h]);

  useEffect(() => {
    const map = videosRef.current;
    const wanted = new Set(clips.map(clip => clip.id));
    for (const [id, video] of map.entries()) {
      if (!wanted.has(id)) {
        try { video.pause(); } catch { }
        map.delete(id);
      }
    }
    clips.forEach(clip => {
      if (map.has(clip.id)) return;
      const video = document.createElement('video');
      video.crossOrigin = 'anonymous';
      video.muted = true;
      video.playsInline = true;
      video.preload = 'auto';
      video.src = clip.serverUrl || clip.url;
      map.set(clip.id, video);
    });
  }, [clips]);

  useEffect(() => {
    let cancelled = false;
    const token = ++drawTokenRef.current;
    const draw = async () => {
      const compositor = compositorRef.current;
      if (!compositor) return;
      await waitForVisibleVideos(videosRef.current, project.layers, time, project.composition.fps);
      if (cancelled || token !== drawTokenRef.current) return;
      compositor.resize(project.composition.w, project.composition.h);
      compositor.render(project, time, { videos: videosRef.current });
      onReady?.();
    };
    draw();
    return () => { cancelled = true; };
  }, [project, time, onReady]);

  return (
    <canvas
      ref={canvasRef}
      width={project.composition.w}
      height={project.composition.h}
      style={{ width: '100vw', height: '100vh', display: 'block', background: project.composition.bg }}
    />
  );
}
