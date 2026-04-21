import { FFmpeg } from '@ffmpeg/ffmpeg';
import { toBlobURL, fetchFile } from '@ffmpeg/util';

let ffmpeg: FFmpeg | null = null;

export const getFFmpeg = async () => {
  if (ffmpeg) return ffmpeg;

  ffmpeg = new FFmpeg();
  
  const baseURL = 'https://unpkg.com/@ffmpeg/core@0.12.6/dist/esm';
  
  await ffmpeg.load({
    coreURL: await toBlobURL(`${baseURL}/ffmpeg-core.js`, 'text/javascript'),
    wasmURL: await toBlobURL(`${baseURL}/ffmpeg-core.wasm`, 'application/wasm'),
  });

  return ffmpeg;
};

export const extractThumbnail = async (file: File, time: number = 1): Promise<string> => {
  console.log("extractThumbnail called for", file.name);
  const ffmpeg = await getFFmpeg();
  const inputName = 'input.mp4';
  const outputName = 'thumbnail.jpg';

  console.log("Writing file to FFmpeg FS...");
  await ffmpeg.writeFile(inputName, await fetchFile(file));
  
  console.log("Executing FFmpeg command for thumbnail...");
  // Extract one frame at the specified time
  await ffmpeg.exec([
    '-ss', time.toString(),
    '-i', inputName,
    '-vframes', '1',
    '-q:v', '2',
    outputName
  ]);

  console.log("Reading thumbnail from FFmpeg FS...");
  const data = await ffmpeg.readFile(outputName);
  const blob = new Blob([data], { type: 'image/jpeg' });
  const url = URL.createObjectURL(blob);
  console.log("Thumbnail URL created:", url);
  return url;
};

export const getVideoDuration = (file: File): Promise<number> => {
  return new Promise((resolve) => {
    const video = document.createElement('video');
    const url = URL.createObjectURL(file);
    video.preload = 'metadata';
    video.onloadedmetadata = () => {
      URL.revokeObjectURL(url);
      resolve(video.duration);
    };
    video.src = url;
  });
};


export const extractAudioWaveform = async (file: File, samples: number = 120): Promise<number[]> => {
  const fallback = () => Array.from({ length: samples }, (_, i) => 0.25 + 0.55 * Math.abs(Math.sin((i / Math.max(1, samples - 1)) * Math.PI * 3.2)));

  try {
    const AudioCtx = window.AudioContext || (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioCtx) return fallback();

    const ctx = new AudioCtx();
    try {
      const buffer = await file.arrayBuffer();
      const audioBuffer = await ctx.decodeAudioData(buffer.slice(0));
      const channel = audioBuffer.getChannelData(0);
      if (!channel?.length) return fallback();

      const blockSize = Math.max(1, Math.floor(channel.length / samples));
      const waveform = Array.from({ length: samples }, (_, index) => {
        const start = index * blockSize;
        const end = Math.min(channel.length, start + blockSize);
        let sum = 0;
        for (let i = start; i < end; i += 1) sum += Math.abs(channel[i]);
        const avg = sum / Math.max(1, end - start);
        return Math.max(0.08, Math.min(1, avg * 3.2));
      });

      return waveform.some(v => v > 0.1) ? waveform : fallback();
    } finally {
      await ctx.close().catch(() => {});
    }
  } catch (error) {
    console.warn('Waveform extraction failed:', error);
    return fallback();
  }
};
