import express from 'express';
import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import { spawn, execSync } from 'child_process';
import os from 'os';
import crypto from 'crypto';
import multer from 'multer';
import ffmpegPath from 'ffmpeg-static';
import dotenv from 'dotenv';
import { WebSocket } from 'ws';

dotenv.config();

const app = express();
app.use(express.json({ limit: '500mb' }));

// For local testing, allow CORS
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') {
    res.sendStatus(200);
  } else {
    next();
  }
});

function getInternalIP() {
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]!) {
      if (net.family === 'IPv4' && !net.internal) return net.address;
    }
  }
  return 'localhost';
}

const ROOT = process.cwd();
const APP_PORT = Number(process.env.PORT || 3001);
const AE_RENDER_ROOT = process.env.AE_RENDER_ROOT 
  ? path.resolve(process.env.AE_RENDER_ROOT)
  : process.platform === 'win32'
  ? path.join(os.homedir(), 'Desktop', 'HMStudio_AE_Render_Server')
  : path.join(ROOT, '.runtime', 'HMStudio_AE_Render_Server');

const ASSET_DIR = path.join(AE_RENDER_ROOT, 'assets');
const TEMPLATE_DIR = path.join(AE_RENDER_ROOT, 'templates');
const JOB_DIR = path.join(AE_RENDER_ROOT, 'jobs');
const RENDER_DIR = path.join(AE_RENDER_ROOT, 'renders');
const PREVIEW_DIR = path.join(AE_RENDER_ROOT, 'previews');
const LOG_DIR = path.join(AE_RENDER_ROOT, 'logs');
const TEMP_DIR = path.join(AE_RENDER_ROOT, 'temp');

const ALL_DIRS = [AE_RENDER_ROOT, ASSET_DIR, TEMPLATE_DIR, JOB_DIR, RENDER_DIR, PREVIEW_DIR, LOG_DIR, TEMP_DIR];

function ensureDirs() {
  for (const dir of ALL_DIRS) {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  }
}

type RenderJobRecord = {
  id: string;
  status: 'queued' | 'preparing' | 'rendering' | 'completed' | 'failed';
  progress: number;
  currentFrame?: number;
  totalFrames?: number;
  statusText?: string;
  createdAt: string;
  updatedAt: string;
  payload: Record<string, any>;
  downloadUrl?: string;
  previewUrl?: string;
  error?: string;
  elapsedSeconds?: number;
  outputSizeMB?: number;
};

const renderJobs = new Map<string, RenderJobRecord>();

function nowIso() {
  return new Date().toISOString();
}

function safeName(name: string) {
  return name.replace(/[^a-zA-Z0-9._가-힣-]+/g, '_');
}

function jobJsonPath(id: string) {
  return path.join(JOB_DIR, `${id}.json`);
}

function refreshJobFromDisk(job: RenderJobRecord) {
  const mp4 = path.join(RENDER_DIR, `${job.id}.mp4`);
  const previewPng = path.join(PREVIEW_DIR, `${job.id}.png`);
  const errorLog = path.join(LOG_DIR, `${job.id}.error.txt`);

  if (fs.existsSync(mp4)) {
    job.status = 'completed';
    job.progress = 100;
    job.downloadUrl = `/api/render-jobs/${job.id}/download`;
  }
  if (fs.existsSync(previewPng)) {
    job.previewUrl = `/ae-previews/${job.id}.png`;
  }
  if (fs.existsSync(errorLog) && !fs.existsSync(mp4)) {
    job.status = 'failed';
    job.progress = 100;
    try {
      job.error = fs.readFileSync(errorLog, 'utf8').slice(0, 1000);
    } catch {}
  }
  job.updatedAt = nowIso();
}

async function saveJob(job: RenderJobRecord) {
  await fsp.writeFile(jobJsonPath(job.id), JSON.stringify(job, null, 2), 'utf8');
}

function clearOldJobsOnStartup() {
  renderJobs.clear();
  const dirsToClear = [JOB_DIR, RENDER_DIR, PREVIEW_DIR, LOG_DIR];
  for (const dir of dirsToClear) {
    if (fs.existsSync(dir)) {
      const files = fs.readdirSync(dir);
      for (const f of files) {
        try { fs.unlinkSync(path.join(dir, f)); } catch {}
      }
    }
  }
  console.log('Cleared old render jobs on startup.');
}

ensureDirs();
clearOldJobsOnStartup();


let renderWorkerRunning = false;

async function moveFile(src: string, dest: string) {
  try {
    // Ensure destination directory exists
    const destDir = path.dirname(dest);
    if (!fs.existsSync(destDir)) {
      fs.mkdirSync(destDir, { recursive: true });
    }
    
    // Check if destination exists and delete it (overwrite)
    if (fs.existsSync(dest)) {
      await fsp.unlink(dest).catch(() => {});
    }

    await fsp.rename(src, dest);
  } catch (err: any) {
    if (err.code === 'EXDEV') {
      await fsp.copyFile(src, dest);
      await fsp.unlink(src).catch(() => {});
    } else {
      throw err;
    }
  }
}

function findLocalFfmpeg() {
  const base = path.join(ROOT, '.runtime', 'ffmpeg');
  if (!fs.existsSync(base)) return null;
  const exe = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
  const full = path.join(base, exe);
  return fs.existsSync(full) ? full : null;
}

function ffmpegBin() {
  if (process.env.FFMPEG_PATH) return process.env.FFMPEG_PATH;
  const local = findLocalFfmpeg();
  if (local) return local;
  try {
    execSync('ffmpeg -version', { stdio: 'ignore' });
    return 'ffmpeg';
  } catch (e) {
    if (ffmpegPath) return ffmpegPath;
    return 'ffmpeg';
  }
}

function ffprobeBin() {
  const bin = ffmpegBin();
  if (bin === 'ffmpeg') return 'ffprobe';
  return bin.replace(/ffmpeg(\.exe)?$/i, 'ffprobe$1');
}

function hasAudioStream(filePath: string): boolean {
  try {
    const bin = ffprobeBin();
    const out = execSync(`"${bin}" -v error -select_streams a -show_entries stream=index -of csv=p=0 "${filePath}"`, { encoding: 'utf8' });
    return out.trim().length > 0;
  } catch (e) {
    return false;
  }
}

function findLocalChrome() {
  const base = path.join(ROOT, '.runtime', 'chrome');
  if (!fs.existsSync(base)) return null;
  try {
    // Recursively look for chrome.exe in .runtime/chrome
    const walk = (dir: string): string | null => {
      const files = fs.readdirSync(dir);
      for (const f of files) {
        const full = path.join(dir, f);
        if (fs.statSync(full).isDirectory()) {
          const res = walk(full);
          if (res) return res;
        } else if (f === 'chrome.exe' || f === 'chrome' || f === 'google-chrome') {
          return full;
        }
      }
      return null;
    };
    return walk(base);
  } catch {
    return null;
  }
}

function browserBin() {
  const candidates = [
    process.env.CHROME_PATH,
    process.env.BROWSER_PATH,
    findLocalChrome(),
    process.platform === 'win32' ? 'C:/Program Files/Google/Chrome/Application/chrome.exe' : '',
    process.platform === 'win32' ? 'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe' : '',
    process.platform === 'win32' ? 'C:/Program Files/Microsoft/Edge/Application/msedge.exe' : '',
    process.platform === 'darwin' ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : '',
    process.platform === 'darwin' ? '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge' : '',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium-browser',
    '/usr/bin/chromium',
  ].filter(Boolean) as string[];
  return candidates.find(file => fs.existsSync(file)) || null;
}

function runProcess(bin: string, args: string[], logFile?: string) {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let log = '';
    child.stdout.on('data', d => { log += String(d); });
    child.stderr.on('data', d => { log += String(d); });
    child.on('error', reject);
    child.on('close', async code => {
      if (logFile) {
        try { await fsp.writeFile(logFile, log, 'utf8'); } catch {}
      }
      if (code === 0) resolve();
      else reject(new Error(log || `process exited with code ${code}`));
    });
  });
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

async function waitForDebugger(port: number, timeoutMs = 10000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (res.ok) return;
    } catch {}
    await sleep(100);
  }
  throw new Error('headless browser debugger did not start');
}

type CdpClient = {
  ws: WebSocket;
  send: (method: string, params?: Record<string, any>) => Promise<any>;
  close: () => void;
};

async function connectCdp(wsUrl: string): Promise<CdpClient> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const pending = new Map<number, { resolve: (value: any) => void; reject: (reason?: any) => void }>();
    let id = 0;
    ws.on('message', raw => {
      try {
        const msg = JSON.parse(String(raw));
        if (msg.id && pending.has(msg.id)) {
          const task = pending.get(msg.id)!;
          pending.delete(msg.id);
          if (msg.error) task.reject(new Error(msg.error.message || 'CDP error'));
          else task.resolve(msg.result);
        }
      } catch {}
    });
    ws.on('open', () => {
      resolve({
        ws,
        send(method, params = {}) {
          return new Promise((res, rej) => {
            const nextId = ++id;
            pending.set(nextId, { resolve: res, reject: rej });
            ws.send(JSON.stringify({ id: nextId, method, params }));
          });
        },
        close() {
          try { ws.close(); } catch {}
        },
      });
    });
    ws.on('error', reject);
  });
}

async function waitForRenderReady(client: CdpClient, timeoutMs = 10000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const result = await client.send('Runtime.evaluate', { expression: "document.documentElement.getAttribute('data-render-ready')", returnByValue: true });
      if (result?.result?.value === '1') return;
    } catch {}
    await sleep(100);
  }
  throw new Error('render page did not become ready in time');
}

async function launchRenderSession(browserPath: string, width: number, height: number, url: string) {
  const debugPort = 9333 + Math.floor(Math.random() * 2000);
  const browser = spawn(browserPath, [
    `--remote-debugging-port=${debugPort}`,
    '--headless=new',
    '--enable-gpu',
    '--ignore-gpu-blocklist',
    '--enable-features=Vulkan,UseSkiaRenderer,CanvasOopRasterization',
    '--use-gl=angle',
    '--use-angle=default',
    '--enable-webgl',
    '--enable-accelerated-2d-canvas',
    '--enable-accelerated-video-decode',
    '--enable-zero-copy',
    '--hide-scrollbars',
    '--autoplay-policy=no-user-gesture-required',
    '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    '--run-all-compositor-stages-before-draw',
    `--window-size=${width},${height}`,
    'about:blank',
  ], { stdio: ['ignore', 'ignore', 'ignore'] });
  await waitForDebugger(debugPort, 15000);
  const targetRes = await fetch(`http://127.0.0.1:${debugPort}/json/new?${encodeURIComponent(url)}`, { method: 'PUT' });
  const targetText = await targetRes.text();
  if (!targetRes.ok) throw new Error(targetText || 'failed to create render tab');
  const target = JSON.parse(targetText) as { webSocketDebuggerUrl: string };
  const client = await connectCdp(target.webSocketDebuggerUrl);
  await client.send('Page.enable');
  await client.send('Runtime.enable');
  await client.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false, screenWidth: width, screenHeight: height });
  await waitForRenderReady(client, 15000);
  return {
    browser,
    client,
    async dispose() {
      client.close();
      try { browser.kill(); } catch {}
    },
  };
}

async function setRenderTime(client: CdpClient, ts: number) {
  await client.send('Runtime.evaluate', { expression: `window.__HM_SET_RENDER_TIME ? window.__HM_SET_RENDER_TIME(${ts}) : Promise.resolve()`, awaitPromise: true, returnByValue: true });
  await waitForRenderReady(client, 10000);
}

async function captureFrameBuffer(client: CdpClient, width: number, height: number): Promise<Buffer> {
  // Use JPEG 100 quality for massive speedup over PNG, avoiding heavy compression bottlenecks
  // Use 'clip' to capture ONLY the exact composition area, removing any black bars/letterboxing
  const result = await client.send('Page.captureScreenshot', { 
    format: 'jpeg', 
    quality: 100,
    clip: { x: 0, y: 0, width, height, scale: 1 }
  });
  return Buffer.from(result.data, 'base64');
}

async function renderJob(record: RenderJobRecord) {
  const output = record.payload?.output || {};
  const outputPath = output.outputPath || path.join(RENDER_DIR, `${record.id}.mp4`);
  const outDir = path.dirname(outputPath);
  if (!fs.existsSync(outDir)) {
    fs.mkdirSync(outDir, { recursive: true });
  }
  const tempOutputPath = path.join(RENDER_DIR, `${record.id}_tmp.mp4`);
  const previewPath = output.previewPath || path.join(PREVIEW_DIR, `${record.id}.jpg`);
  const logPath = output.logPath || path.join(LOG_DIR, `${record.id}.log.txt`);
  const errorPath = output.errorPath || path.join(LOG_DIR, `${record.id}.error.txt`);
  const comp = record.payload?.composition || {};
  const width = Math.max(2, Number(comp.w || 1920));
  const height = Math.max(2, Number(comp.h || 1080));
  const fps = Math.max(1, Number(comp.fps || 30));
  const range = record.payload?.renderRange || {};
  const renderIn = Math.max(0, Number(range.in || 0));
  const renderOut = Math.max(renderIn + 0.1, Number(range.out || 5));
  const duration = renderOut - renderIn;
  const frameCount = Math.max(1, Math.ceil(duration * fps));
  
  console.log(`[Render ${record.id}] PARAMS: in=${renderIn}, out=${renderOut}, dur=${duration}, fps=${fps}, totalFrames=${frameCount}`);
  const frameDir = path.join(TEMP_DIR, record.id);
  const browserPath = browserBin();
  const renderStartedAt = Date.now();

  console.log(`[Render ${record.id}] START: ${width}x${height} @ ${fps}fps, range=${renderIn.toFixed(2)}-${renderOut.toFixed(2)}s, frames=${frameCount}`);

  record.status = 'preparing';
  record.progress = 2.00;
  record.statusText = `브라우저 시작 중... (${frameCount}프레임)`;
  record.totalFrames = frameCount;
  record.currentFrame = 0;
  record.updatedAt = nowIso();
  await saveJob(record);

  if (!browserPath) {
    record.status = 'failed';
    record.progress = -1;
    record.error = 'Chrome 또는 Edge 실행 파일을 찾지 못했습니다. CHROME_PATH를 지정해 주세요.';
    record.updatedAt = nowIso();
    await fsp.writeFile(errorPath, record.error, 'utf8').catch(() => {});
    await saveJob(record);
    return;
  }

  let session: Awaited<ReturnType<typeof launchRenderSession>> | null = null;
  try {
    const url = `http://localhost:${APP_PORT}/?renderJob=${record.id}&renderTs=${encodeURIComponent(renderIn.toFixed(6))}`;
    session = await launchRenderSession(browserPath, width, height, url);

    console.log(`[Render ${record.id}] Browser launched in ${Date.now() - renderStartedAt}ms`);
    record.status = 'rendering';
    record.progress = 10.00;
    record.statusText = `프레임 캡처 시작... (0/${frameCount})`;
    record.updatedAt = nowIso();
    await saveJob(record);

    const bin = ffmpegBin();
    let encoder = 'hevc_nvenc';
    try {
      const encoders = execSync(`"${bin}" -encoders`, { encoding: 'utf8' });
      if (!encoders.includes('hevc_nvenc')) {
        console.warn('[Render] hevc_nvenc not supported, falling back to libx264');
        encoder = 'libx264';
      }
    } catch (e) {
      encoder = 'libx264';
    }

    const ffmpegArgs = [
      '-y',
      '-f', 'image2pipe',
      '-vcodec', 'mjpeg',
      '-framerate', String(fps),
      '-i', '-',
      '-c:v', encoder,
      ...(encoder === 'hevc_nvenc' ? ['-preset', 'p7', '-cq', '12'] : ['-preset', 'slow', '-crf', '12']),
      '-b:v', '0',
      '-pix_fmt', 'yuv420p',
      '-movflags', '+faststart',
      tempOutputPath,
    ];

    const logStream = fs.createWriteStream(logPath, { flags: 'a' });
    const ffmpegProc = spawn(bin, ffmpegArgs);
    ffmpegProc.stdout.pipe(logStream);
    ffmpegProc.stderr.pipe(logStream);

    const ffmpegPromise = new Promise((resolve, reject) => {
      ffmpegProc.on('close', (code) => {
        if (code === 0) resolve(code);
        else reject(new Error(`FFmpeg exited with code ${code}`));
      });
      ffmpegProc.on('error', reject);
    });

    let ffmpegCrashed = false;
    ffmpegProc.on('exit', (code) => {
      if (code !== 0 && code !== null) ffmpegCrashed = true;
    });

    for (let i = 0; i < frameCount; i++) {
      if (ffmpegCrashed) {
        throw new Error('인코딩 프로세스(FFmpeg)가 비정상적으로 종료되었습니다.');
      }
      const ts = renderIn + i / fps;
      const t1 = Date.now();
      
      if (i > 0) {
        await setRenderTime(session.client, Number(ts.toFixed(6)));
      }
      const t2 = Date.now();
      const frameBuffer = await captureFrameBuffer(session.client, width, height);
      const t3 = Date.now();
      
      if (!ffmpegProc.stdin.writable) {
         throw new Error('FFmpeg 입력 파이프가 닫혔습니다.');
      }

      if (!ffmpegProc.stdin.write(frameBuffer)) {
        await new Promise(r => ffmpegProc.stdin.once('drain', r));
      }
      const t4 = Date.now();

      if (i === Math.floor(frameCount / 2)) {
        await fsp.writeFile(previewPath, frameBuffer).catch(() => {});
      }

      if (i < 10 || i % 30 === 0) console.log(`[Render ${record.id}] Frame ${i}/${frameCount}: setTime ${t2 - t1}ms, capture ${t3 - t2}ms, pipe ${t4 - t3}ms, elapsed ${((Date.now() - renderStartedAt) / 1000).toFixed(1)}s`);
      
      const elapsed = ((Date.now() - renderStartedAt) / 1000).toFixed(0);
      record.progress = Number((10 + ((i + 1) / frameCount) * 85).toFixed(2));
      record.currentFrame = i + 1;
      record.statusText = `프레임 캡처 중 (${i + 1}/${frameCount}) - ${elapsed}초 경과`;
      record.updatedAt = nowIso();
      await saveJob(record);
    }

    console.log(`[Render ${record.id}] All ${frameCount} frames piped in ${((Date.now() - renderStartedAt) / 1000).toFixed(1)}s, waiting for FFmpeg...`);
    ffmpegProc.stdin.end();
    await ffmpegPromise;
    console.log(`[Render ${record.id}] FFmpeg finished in ${((Date.now() - renderStartedAt) / 1000).toFixed(1)}s`);

    // --- Final Pass: Audio Mixing & Thumbnail ---
    record.progress = 96.00;
    record.statusText = '인코딩 완료, 오디오 합성 및 썸네일 삽입 중...';
    record.updatedAt = nowIso();
    await saveJob(record);

    const audioClips = (record.payload?.clips || []).filter((c: any) => {
      if (!c.storedPath || !fs.existsSync(c.storedPath)) return false;
      return hasAudioStream(c.storedPath);
    });
    const hasAudio = audioClips.length > 0;
    
    if (hasAudio || fs.existsSync(previewPath)) {
      const finalPassArgs = ['-y'];
      
      // Input 0: Rendered Video (No audio)
      finalPassArgs.push('-i', tempOutputPath);
      
      // Inputs 1+: Audio sources
      const audioInputs = [];
      for (const c of audioClips) {
        audioInputs.push(c);
        finalPassArgs.push('-i', c.storedPath);
      }
      
      // Input N: Preview image (if exists)
      if (fs.existsSync(previewPath)) {
        finalPassArgs.push('-i', previewPath);
      }
 
      const vIdx = 0;
      const aStartIdx = 1;
      const imgIdx = aStartIdx + audioInputs.length;

      let filterComplex = '';
      if (hasAudio) {
        let audioFilters = '';
        const amixLabels = [];
        let mixCount = 0;

        for (let idx = 0; idx < audioInputs.length; idx++) {
          const clip = audioInputs[idx];
          
          // Calculate overlap with render range
          const overlapIn = Math.max(clip.ts, renderIn);
          const overlapOut = Math.min(clip.ts + clip.dur, renderOut);
          const overlapDur = overlapOut - overlapIn;
          
          if (overlapDur <= 0) continue;

          const trimStart = (clip.startT || 0) + Math.max(0, renderIn - clip.ts);
          const delayMs = Math.max(0, Math.round((clip.ts - renderIn) * 1000));
          
          const label = `aud${idx}`;
          // Trim -> Reset PTS -> Delay
          audioFilters += `[${idx + aStartIdx}:a]atrim=start=${trimStart.toFixed(3)}:duration=${overlapDur.toFixed(3)},asetpts=PTS-STARTPTS,adelay=${delayMs}|${delayMs}[${label}];`;
          amixLabels.push(`[${label}]`);
          mixCount++;
        }
        
        if (mixCount > 0) {
          filterComplex = `${audioFilters}${amixLabels.join('')}amix=inputs=${mixCount}[outa]`;
        }
      }

      finalPassArgs.push('-map', '0:v'); // Video from input 0
      
      const actuallyHasAudio = filterComplex.length > 0;
      if (actuallyHasAudio) {
        finalPassArgs.push('-filter_complex', filterComplex);
        finalPassArgs.push('-map', '[outa]');
      }
      
      if (fs.existsSync(previewPath)) {
        finalPassArgs.push('-map', `${imgIdx}:v`);
        finalPassArgs.push('-disposition:v:1', 'attached_pic');
      }

      finalPassArgs.push('-c:v', 'copy');
      if (actuallyHasAudio) finalPassArgs.push('-c:a', 'aac', '-b:a', '192k');
      const finalPassTemp = path.join(RENDER_DIR, `${record.id}_final.mp4`);
      finalPassArgs.push(finalPassTemp);

      console.log(`[Render ${record.id}] Final pass command: "${ffmpegBin()}" ${finalPassArgs.join(' ')}`);
      
      await new Promise((resolve, reject) => {
        const finalProc = spawn(ffmpegBin(), finalPassArgs);
        let err = '';
        finalProc.stderr.on('data', d => {
          const msg = d.toString();
          if (msg.includes('Error')) console.error(`[Render ${record.id}] Final pass stderr: ${msg}`);
          err += msg;
        });
        finalProc.on('close', code => {
          if (code === 0) resolve(true);
          else reject(new Error(`Final pass failed (code ${code}): ${err.slice(-200)}`));
        });
      });

      console.log(`[Render ${record.id}] Moving final file to: ${outputPath}`);
      try {
        await moveFile(finalPassTemp, outputPath);
        await fsp.unlink(tempOutputPath).catch(() => {});
        console.log(`[Render ${record.id}] SUCCESSFULLY SAVED TO: ${outputPath}`);
      } catch (err: any) {
        console.error(`[Render ${record.id}] FAILED TO MOVE FINAL FILE: ${err.message}`);
        throw err;
      }
    } else {
      // No audio and no preview, just move the file
      console.log(`[Render ${record.id}] No final pass needed. Moving temp file to: ${outputPath}`);
      try {
        await moveFile(tempOutputPath, outputPath);
        console.log(`[Render ${record.id}] SUCCESSFULLY SAVED TO: ${outputPath}`);
      } catch (err: any) {
        console.error(`[Render ${record.id}] FAILED TO MOVE TEMP FILE: ${err.message}`);
        throw err;
      }
    }

    const totalElapsed = ((Date.now() - renderStartedAt) / 1000).toFixed(1);
    const outputSize = fs.existsSync(outputPath) ? fs.statSync(outputPath).size : 0;
    const outputSizeMB = (outputSize / (1024 * 1024)).toFixed(1);
    console.log(`[Render ${record.id}] COMPLETED: ${frameCount} frames, ${totalElapsed}s, ${outputSizeMB}MB`);

    record.status = 'completed';
    record.progress = 100.00;
    record.statusText = `완료 (${frameCount}프레임, ${totalElapsed}초, ${outputSizeMB}MB)`;
    record.elapsedSeconds = Number(totalElapsed);
    record.outputSizeMB = Number(outputSizeMB);
    record.downloadUrl = `/api/render-jobs/${record.id}/download`;
    if (fs.existsSync(previewPath)) record.previewUrl = `/ae-previews/${record.id}.jpg`;
    record.updatedAt = nowIso();
    await saveJob(record);
  } catch (err: any) {
    record.status = 'failed';
    record.progress = -1;
    record.statusText = '실패';
    record.error = String(err?.message || err || 'render failed');
    record.updatedAt = nowIso();
    await fsp.writeFile(errorPath, record.error, 'utf8').catch(() => {});
    await saveJob(record);
  } finally {
    if (session) await session.dispose();
  }
}

async function processRenderJobs() {
  if (renderWorkerRunning) return;
  renderWorkerRunning = true;
  try {
    while (true) {
      const next = Array.from(renderJobs.values())
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
        .find(job => job.status === 'queued');
      if (!next) break;
      await renderJob(next);
    }
  } finally {
    renderWorkerRunning = false;
  }
}

const assetStorage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, ASSET_DIR),
  filename: (_req, file, cb) => cb(null, `${Date.now()}_${crypto.randomBytes(4).toString('hex')}_${safeName(file.originalname)}`),
});
const templateStorage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, TEMPLATE_DIR),
  filename: (_req, file, cb) => cb(null, `${Date.now()}_${crypto.randomBytes(4).toString('hex')}_${safeName(file.originalname)}`),
});

const uploadAsset = multer({ storage: assetStorage });
const uploadTemplate = multer({ storage: templateStorage });


app.use((req, res, next) => {
  res.header('Cross-Origin-Embedder-Policy', 'require-corp');
  res.header('Cross-Origin-Opener-Policy', 'same-origin');
  next();
});

app.use('/ae-renders', express.static(RENDER_DIR));
app.use('/ae-previews', express.static(PREVIEW_DIR));
app.use('/assets', express.static(ASSET_DIR));
app.use(express.static(path.join(ROOT, 'dist')));

app.get('/api/render-server/status', (_req, res) => {
  res.json({
    ok: true,
    renderer: 'after-effects-2025',
    os: process.platform,
    rootFolder: AE_RENDER_ROOT,
    folders: {
      assets: ASSET_DIR,
      templates: TEMPLATE_DIR,
      jobs: JOB_DIR,
      renders: RENDER_DIR,
      previews: PREVIEW_DIR,
      logs: LOG_DIR,
      temp: TEMP_DIR,
    },
    jobCount: renderJobs.size,
    timestamp: nowIso(),
  });
});

app.post('/api/uploads/video', uploadAsset.single('file'), (req, res) => {
  if (!req.file) {
    res.status(400).json({ ok: false, message: 'file missing' });
    return;
  }
  res.json({
    ok: true,
    fileName: req.file.filename,
    originalName: req.file.originalname,
    storedPath: req.file.path,
    url: `/assets/${req.file.filename}`,
  });
});

app.post('/api/templates/aep', uploadTemplate.single('file'), (req, res) => {
  if (!req.file) {
    res.status(400).json({ ok: false, message: 'file missing' });
    return;
  }
  res.json({
    ok: true,
    templateId: crypto.randomBytes(6).toString('hex'),
    fileName: req.file.filename,
    originalName: req.file.originalname,
    storedPath: req.file.path,
  });
});

app.get('/api/render-jobs', async (_req, res) => {
  const jobs = Array.from(renderJobs.values()).map(job => {
    refreshJobFromDisk(job);
    return job;
  }).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  await Promise.all(jobs.map(saveJob));
  res.json({ jobs });
});

app.get('/api/system-status', async (_req, res) => {
  const bin = ffmpegBin();
  let hasSystemFfmpeg = false;
  try {
    execSync('ffmpeg -version', { stdio: 'ignore' });
    hasSystemFfmpeg = true;
  } catch (e) {}

  let hasGpu = false;
  let encoder = 'libx264';
  try {
    const encoders = execSync(`"${bin}" -encoders`, { encoding: 'utf8' });
    if (encoders.includes('hevc_nvenc')) {
      hasGpu = true;
      encoder = 'hevc_nvenc';
    }
  } catch (e) {}

  const browserPath = browserBin();

  res.json({
    ffmpeg: {
      path: bin,
      hasSystem: hasSystemFfmpeg,
      isLocal: bin ? bin.includes('.runtime') : false,
      isBundled: bin ? bin.includes('node_modules') : false
    },
    gpu: {
      supported: hasGpu,
      encoder: encoder
    },
    browser: {
      path: browserPath,
      found: !!browserPath,
      hasSystem: browserPath ? !browserPath.includes('.runtime') : false,
      isLocal: browserPath ? browserPath.includes('.runtime') : false
    },
    platform: process.platform,
    arch: process.arch
  });
});

app.post('/api/system/install-ffmpeg', async (_req, res) => {
  try {
    const targetDir = path.join(ROOT, '.runtime', 'ffmpeg');
    if (!fs.existsSync(targetDir)) fs.mkdirSync(targetDir, { recursive: true });
    
    console.log('[Setup] Installing local FFmpeg...');
    const source = ffmpegPath;
    if (!source) throw new Error('ffmpeg-static path not found');
    
    const exe = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
    const destination = path.join(targetDir, exe);
    
    fs.copyFileSync(source, destination);
    if (process.platform !== 'win32') fs.chmodSync(destination, 0o755);
    
    console.log(`[Setup] FFmpeg installed to ${destination}`);
    res.json({ ok: true, path: destination });
  } catch (err: any) {
    console.error('[Setup] FFmpeg installation failed:', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/api/system/install-chrome', async (_req, res) => {
  try {
    console.log('Installing Chrome/Chromium via puppeteer...');
    const installPath = path.join(ROOT, '.runtime', 'chrome');
    fs.mkdirSync(installPath, { recursive: true });
    
    const cmd = `npx @puppeteer/browsers install chrome@stable --path "${installPath}"`;
    execSync(cmd, { stdio: 'inherit' });
    
    const newPath = browserBin();
    res.json({ ok: true, path: newPath });
  } catch (err: any) {
    console.error('Failed to install chrome:', err);
    res.status(500).json({ ok: false, error: String(err.message || err) });
  }
});

app.get('/api/render-jobs/:id', async (req, res) => {
  const job = renderJobs.get(req.params.id);
  if (!job) {
    res.status(404).json({ ok: false, message: 'Job not found' });
    return;
  }
  refreshJobFromDisk(job);
  await saveJob(job);
  res.json(job);
});

app.post('/api/login', async (req, res) => {
  const { userId, password } = req.body;
  try {
    const response = await fetch('http://erp.baroncs.co.kr/intranet/sys/popup/login_ok.php', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      },
      body: new URLSearchParams({
        user_id: userId,
        user_pw: password,
        user_ip: '127.0.0.1',
        user_contact_area: 'OUT',
        checksaveid: '1',
        is_ajax: '1',
        browser: 'Mozilla/5.0',
      }),
    });

    const text = await response.text();
    if (text.trim() === '1') {
      res.json({ success: true });
    } else {
      res.json({ success: false, message: '사원번호 또는 비밀번호가 올바르지 않습니다.' });
    }
  } catch (err) {
    console.error('Login Proxy Error:', err);
    res.status(500).json({ success: false, message: '로그인 서버에 접속할 수 없습니다.' });
  }
});

app.post('/api/render-jobs/clear', async (_req, res) => {
  renderJobs.clear();
  const dirsToClear = [JOB_DIR, RENDER_DIR, PREVIEW_DIR, LOG_DIR];
  for (const dir of dirsToClear) {
    if (fs.existsSync(dir)) {
      const files = fs.readdirSync(dir);
      for (const f of files) {
        try { fs.unlinkSync(path.join(dir, f)); } catch {}
      }
    }
  }
  res.json({ ok: true });
});

app.post('/api/render-jobs/start', async (req, res) => {
  const id = crypto.randomBytes(8).toString('hex');
  const safeProjectName = safeName(String(req.body?.projectName || `render_${id}`)).replace(/\.[^.]+$/, '') + '.mp4';
  const record: RenderJobRecord = {
    id,
    status: 'queued',
    progress: 0,
    createdAt: nowIso(),
    updatedAt: nowIso(),
    payload: {
      ...req.body,
      output: {
        ...(req.body.output || {}),
        fileName: safeProjectName,
        outputPath: req.body.output?.outputPath || path.join(RENDER_DIR, `${id}.mp4`),
        previewPath: req.body.output?.previewPath || path.join(PREVIEW_DIR, `${id}.png`),
        logPath: req.body.output?.logPath || path.join(LOG_DIR, `${id}.log.txt`),
        errorPath: req.body.output?.errorPath || path.join(LOG_DIR, `${id}.error.txt`),
      },
    },
  };
  renderJobs.set(id, record);
  await saveJob(record);
  void processRenderJobs();
  res.json(record);
});

app.get('/api/render-jobs/:id/download', (req, res) => {
  const id = req.params.id;
  const job = renderJobs.get(id);
  const mp4 = path.join(RENDER_DIR, `${id}.mp4`);
  if (!fs.existsSync(mp4)) return res.status(404).end();
  const fileName = job?.payload?.output?.fileName || `${id}.mp4`;
  res.download(mp4, fileName);
});

app.get('/api/render-jobs/:id/download/:filename', (req, res) => {
  const mp4 = path.join(RENDER_DIR, `${req.params.id}.mp4`);
  if (!fs.existsSync(mp4)) return res.status(404).end();
  res.download(mp4, req.params.filename);
});

app.get('/api/render-jobs/:id/log', (req, res) => {
  const logFile = path.join(LOG_DIR, `${req.params.id}.log.txt`);
  if (!fs.existsSync(logFile)) return res.status(404).end();
  res.sendFile(logFile);
});

app.get('*', (_req, res) => {
  const index = path.join(ROOT, 'dist', 'index.html');
  if (fs.existsSync(index)) res.sendFile(index);
  else res.status(404).send('Vite dev server or build missing');
});

app.listen(APP_PORT, () => {
  console.log(`🚀 Server running on http://localhost:${APP_PORT}`);
  console.log(`🏠 Network access: http://${getInternalIP()}:${APP_PORT}`);
  console.log(`📂 AE render root: ${AE_RENDER_ROOT}`);
});
