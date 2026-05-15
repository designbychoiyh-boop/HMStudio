import express from 'express';
import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import { spawn, execSync, exec, execFileSync, spawnSync } from 'child_process';
import os from 'os';
import crypto from 'crypto';
import multer from 'multer';
import ffmpegPath from 'ffmpeg-static';
import dotenv from 'dotenv';
import { WebSocket } from 'ws';
import zlib from 'zlib';

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

const ROOT = process.env.NODE_ENV === 'production' ? path.join(__dirname, '..') : process.cwd();
const APP_PATH = ROOT;
const APP_PORT = Number(process.env.PORT || 3001);
const AE_RENDER_ROOT = process.env.AE_RENDER_ROOT 
  ? path.resolve(process.env.AE_RENDER_ROOT)
  : process.platform === 'win32'
  ? path.join(os.homedir(), 'Desktop', 'HMStudio_AE_Render_Server')
  : path.join(ROOT, '.runtime', 'HMStudio_AE_Render_Server');

const ASSET_DIR = path.join(AE_RENDER_ROOT, 'assets');
const TEMPLATE_DIR = path.join(AE_RENDER_ROOT, 'templates');
const JOB_DIR = path.join(AE_RENDER_ROOT, 'jobs');
const resolveExternalTemplateDir = () => {
  const candidates = [
    process.env.EXE_DIR ? path.join(process.env.EXE_DIR, 'Template_Json') : null,
    path.join(ROOT, 'Template_Json'),
    (process as any).resourcesPath ? path.join((process as any).resourcesPath, 'Template_Json') : null,
    process.env.APP_PATH ? path.join(process.env.APP_PATH, 'Template_Json') : null,
  ].filter(Boolean) as string[];
  return candidates.find(dir => fs.existsSync(dir)) || candidates[0] || path.join(ROOT, 'Template_Json');
};
const EXTERNAL_TEMPLATE_DIR = resolveExternalTemplateDir();
const RENDER_DIR = path.join(AE_RENDER_ROOT, 'renders');
const PREVIEW_DIR = path.join(AE_RENDER_ROOT, 'previews');
const LOG_DIR = path.join(AE_RENDER_ROOT, 'logs');
const TEMP_DIR = path.join(AE_RENDER_ROOT, 'temp');
const RUNTIME_BASE = path.join(os.homedir(), '.hmstudio_runtime');
const FFMPEG_RUNTIME_DIR = path.join(RUNTIME_BASE, 'ffmpeg');

function ffmpegExeName() {
  return process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
}

function resolveBundledFfmpeg() {
  const candidates = [];
  if (ffmpegPath) {
    candidates.push(ffmpegPath);
    if (ffmpegPath.includes('app.asar') && !ffmpegPath.includes('app.asar.unpacked')) {
      candidates.push(ffmpegPath.replace('app.asar', 'app.asar.unpacked'));
    }
  }
  candidates.push(path.join(ROOT, 'node_modules', 'ffmpeg-static', ffmpegExeName()));

  for (const candidate of candidates) {
    if (candidate && fs.existsSync(candidate)) return candidate;
  }
  return null;
}

function verifyFfmpegExecutable(filePath: string) {
  if (!fs.existsSync(filePath)) throw new Error(`FFmpeg copy failed: ${filePath}`);
  execFileSync(filePath, ['-version'], { stdio: 'ignore' });
}
const ALL_DIRS = [AE_RENDER_ROOT, ASSET_DIR, TEMPLATE_DIR, JOB_DIR, RENDER_DIR, PREVIEW_DIR, LOG_DIR, TEMP_DIR];

function ensureDirs() {
  for (const dir of ALL_DIRS) {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  }
}

async function ensureSystemBins() {
  console.log('[Setup] Checking system dependencies...');
  
  // 1. FFmpeg
  const ffmpeg = findLocalFfmpeg();
  if (!ffmpeg) {
    console.log('[Setup] Local FFmpeg not found. Auto-installing...');
    try {
      const targetDir = FFMPEG_RUNTIME_DIR;
      if (!fs.existsSync(targetDir)) fs.mkdirSync(targetDir, { recursive: true });
      const source = resolveBundledFfmpeg();
      if (!source) throw new Error('ffmpeg-static executable not found');
      const destination = path.join(targetDir, ffmpegExeName());
      fs.copyFileSync(source, destination);
      if (process.platform !== 'win32') fs.chmodSync(destination, 0o755);
      verifyFfmpegExecutable(destination);
      console.log(`[Setup] FFmpeg installed to ${destination}`);
    } catch (err) {
      console.error('[Setup] FFmpeg auto-install failed:', err);
    }
  } else {
    console.log('[Setup] FFmpeg found:', ffmpeg);
  }

  // 2. Chrome (Optional: user might prefer to do this manually if it's large, but let's follow the prompt)
  const chrome = findLocalChrome();
  if (!chrome) {
    console.log('[Setup] Local Chrome not found. It will be installed on first request or you can trigger it via UI.');
    // We won't auto-install chrome on startup because it's heavy and might block startup for too long.
    // But we'll make sure the directory exists.
    const chromeDir = path.join(RUNTIME_BASE, 'chrome');
    if (!fs.existsSync(chromeDir)) fs.mkdirSync(chromeDir, { recursive: true });
  } else {
    console.log('[Setup] Chrome found:', chrome);
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
  return String(name || '').replace(/[^a-zA-Z0-9._-]+/g, '_');
}

function jobJsonPath(id: string) {
  return path.join(JOB_DIR, `${id}.json`);
}

function refreshJobFromDisk(job: RenderJobRecord) {
  const output = job.payload?.output || {};
  const mp4 = output.outputPath || path.join(RENDER_DIR, output.fileName || `${job.id}.mp4`);
  const previewPng = output.previewPath || path.join(PREVIEW_DIR, `${job.id}.png`);
  const errorLog = output.errorPath || path.join(LOG_DIR, `${job.id}.error.txt`);
  const isActiveStatus = job.status === 'queued' || job.status === 'preparing' || job.status === 'rendering';

  if (!isActiveStatus && fs.existsSync(mp4)) {
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
  if (!renderJobs.has(job.id)) {
    return;
  }
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
// clearOldJobsOnStartup(); // Disabled to prevent accidental deletion of renders on restart



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
  const base = FFMPEG_RUNTIME_DIR;
  if (!fs.existsSync(base)) return null;
  const full = path.join(base, ffmpegExeName());
  return fs.existsSync(full) ? full : null;
}

function ffmpegBin() {
  if (process.env.FFMPEG_PATH && fs.existsSync(process.env.FFMPEG_PATH)) return process.env.FFMPEG_PATH;
  const local = findLocalFfmpeg();
  if (local) return local;
  try {
    execSync('ffmpeg -version', { stdio: 'ignore' });
    return 'ffmpeg';
  } catch (e) {
    if (ffmpegPath && fs.existsSync(ffmpegPath)) return ffmpegPath;
    return null;
  }
}


function hasAudioStream(filePath: string): boolean {
  try {
    const bin = ffmpegBin();
    let out = '';
    try {
      // ffmpeg -i always exits with code 1 because no output is specified,
      // so we must catch the error to read the stderr output.
      execFileSync(bin, ['-i', filePath], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e: any) {
      out = (e.stderr || '').toString() + (e.stdout || '').toString();
    }
    return out.toLowerCase().includes('audio:');
  } catch (e) {
    return false;
  }
}

function findLocalChrome() {
  const base = path.join(RUNTIME_BASE, 'chrome');
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
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-extensions',
    '--disable-dev-shm-usage',
    `--user-data-dir=${path.join(TEMP_DIR, `chrome-profile-${debugPort}`)}`,
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
  await client.send('Emulation.setDefaultBackgroundColorOverride', { color: { r: 0, g: 0, b: 0, a: 0 } }).catch(() => {});
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

const PNG_CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    table[n] = c >>> 0;
  }
  return table;
})();

function pngCrc(type: Buffer, data: Buffer) {
  let c = 0xffffffff;
  for (const byte of type) c = PNG_CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  for (const byte of data) c = PNG_CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(typeText: string, data: Buffer) {
  const type = Buffer.from(typeText, 'ascii');
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  type.copy(out, 4);
  data.copy(out, 8);
  out.writeUInt32BE(pngCrc(type, data), 8 + data.length);
  return out;
}

function createTransparentPng(width: number, height: number) {
  const w = Math.max(1, Math.round(width));
  const h = Math.max(1, Math.round(height));
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  const rowBytes = w * 4 + 1;
  const raw = Buffer.alloc(rowBytes * h);
  for (let y = 0; y < h; y++) raw[y * rowBytes] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw, { level: 1 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

function maxSecondsKeyframeTime(kfs: any): number {
  if (!Array.isArray(kfs)) return 0;
  return kfs.reduce((max: number, kf: any) => {
    const t = Number(kf?.t);
    return Number.isFinite(t) ? Math.max(max, t) : max;
  }, 0);
}

function isLottieKeyframeArray(value: any): value is any[] {
  return Array.isArray(value)
    && value.length > 0
    && value.some(item => item && typeof item === 'object' && Number.isFinite(Number(item.t)) && ('s' in item || 'e' in item));
}

function stableRenderValue(value: any): any {
  if (value === undefined) return null;
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(stableRenderValue);
  const out: any = {};
  for (const key of Object.keys(value).sort()) {
    if (key === 'i' || key === 'o' || key === 'n' || key === 'mn') continue;
    out[key] = stableRenderValue(value[key]);
  }
  return out;
}

function renderValuesDiffer(a: any, b: any): boolean {
  return JSON.stringify(stableRenderValue(a)) !== JSON.stringify(stableRenderValue(b));
}

function keyframeStartValue(kf: any): any {
  if (!kf || typeof kf !== 'object') return null;
  if ('s' in kf) return kf.s;
  if ('e' in kf) return kf.e;
  return null;
}

function keyframeEndValue(kf: any, nextKf?: any): any {
  if (!kf || typeof kf !== 'object') return null;
  if ('e' in kf) return kf.e;
  if (nextKf && typeof nextKf === 'object' && 's' in nextKf) return nextKf.s;
  if ('s' in kf) return kf.s;
  return null;
}

function maxLottieChangingKeyframeFrame(value: any, seen = new WeakSet<object>()): number {
  if (!value || typeof value !== 'object') return 0;
  if (seen.has(value)) return 0;
  seen.add(value);
  let max = 0;
  if (Array.isArray(value)) {
    for (const item of value) max = Math.max(max, maxLottieChangingKeyframeFrame(item, seen));
    return max;
  }
  const k = value.k;
  if (isLottieKeyframeArray(k)) {
    const frames = [...k].filter(kf => Number.isFinite(Number(kf?.t))).sort((a, b) => Number(a.t) - Number(b.t));
    for (let i = 0; i < frames.length; i++) {
      const current = frames[i];
      const next = frames[i + 1];
      const currentT = Number(current.t);
      if (i > 0 && renderValuesDiffer(keyframeStartValue(frames[i - 1]), keyframeStartValue(current))) {
        max = Math.max(max, currentT);
      }
      if (!next) continue;
      const nextT = Number(next.t);
      const startValue = keyframeStartValue(current);
      const endValue = keyframeEndValue(current, next);
      const nextValue = keyframeStartValue(next);
      const segmentChanges = renderValuesDiffer(startValue, endValue);
      const holdJumpChanges = Number(current.h) === 1 && renderValuesDiffer(startValue, nextValue);
      if (segmentChanges || holdJumpChanges) max = Math.max(max, nextT);
    }
  }
  for (const key of Object.keys(value)) {
    if (key === 'p' && typeof value[key] === 'string') continue;
    max = Math.max(max, maxLottieChangingKeyframeFrame(value[key], seen));
  }
  return max;
}

function getTemplateAnimationEndSeconds(graphic: any, fps: number): number {
  const safeFps = Math.max(1, Number(fps || 30));
  let end = 0;
  if (graphic?.templateKind === 'multi_png_title') {
    const pairs = Array.isArray(graphic?.multiTitleModel?.pairs) ? graphic.multiTitleModel.pairs : [];
    for (const pair of pairs) {
      end = Math.max(
        end,
        maxSecondsKeyframeTime(pair?.imageOpacity),
        maxSecondsKeyframeTime(pair?.textOpacity),
        maxSecondsKeyframeTime(pair?.imageScaleX)
      );
      for (const track of pair?.imageOpacityTracks || []) end = Math.max(end, maxSecondsKeyframeTime(track));
      for (const track of pair?.imageScaleXTracks || []) end = Math.max(end, maxSecondsKeyframeTime(track));
    }
  }
  const lottieFr = Math.max(1, Number(graphic?.lottieData?.fr || safeFps));
  const ip = Number(graphic?.lottieData?.ip || 0);
  const op = Number(graphic?.lottieData?.op || 0);
  const lottieFrames = op > ip
    ? Math.ceil(op - ip)
    : Math.ceil(Math.max(0, Number(graphic?.templateDuration || graphic?.dur || 0)) * lottieFr);
  if (lottieFrames > 0) end = Math.max(end, lottieFrames / lottieFr);
  const fallbackDur = Number(graphic?.templateDuration || 0);
  if (end <= 0 && fallbackDur > 0) end = Math.min(fallbackDur, 2.0);
  return Math.ceil(Math.max(0, end) * safeFps) / safeFps;
}

function getHybridGraphicsAnimationDuration(graphics: any[], renderIn: number, duration: number, fps: number): number {
  let endRelative = 0;
  for (const g of graphics) {
    if (g?.visible === false || g?.type !== 'ae_template') continue;
    const layerStart = Number(g.ts || 0);
    const layerDur = Math.max(0, Number(g.dur || duration));
    const animEnd = Math.min(layerDur || duration, getTemplateAnimationEndSeconds(g, fps) || Math.min(layerDur || duration, 2.0));
    endRelative = Math.max(endRelative, layerStart + animEnd - renderIn);
  }
  if (endRelative <= 0) return Math.min(duration, 2.0);
  return Math.min(duration, Math.ceil(endRelative * Math.max(1, fps)) / Math.max(1, fps));
}

async function renderJob(record: RenderJobRecord) {
  const output = record.payload?.output || {};
  const outputPath = output.outputPath || path.join(RENDER_DIR, output.fileName || `${record.id}.mp4`);
  console.log(`[Render ${record.id}] Final outputPath resolved to: ${outputPath}`);


  const outDir = path.dirname(outputPath);
  try {
    if (!fs.existsSync(outDir)) {
      console.log(`[Render ${record.id}] Creating output directory: ${outDir}`);
      fs.mkdirSync(outDir, { recursive: true });
    }
  } catch (err: any) {
    console.error(`[Render ${record.id}] Failed to create output directory ${outDir}:`, err);
    // Continue anyway, moveFile will also try to create it
  }
  const tempOutputPath = path.join(RENDER_DIR, `${record.id}_tmp.mp4`);
  const previewPath = output.previewPath || path.join(PREVIEW_DIR, `${record.id}.jpg`);
  const logPath = output.logPath || path.join(LOG_DIR, `${record.id}.log.txt`);
  const errorPath = output.errorPath || path.join(LOG_DIR, `${record.id}.error.txt`);

  // Delete existing files to prevent immediate 1-second short-circuit from refreshJobFromDisk
  try {
    if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
  } catch {}
  try {
    if (fs.existsSync(tempOutputPath)) fs.unlinkSync(tempOutputPath);
  } catch {}
  try {
    if (fs.existsSync(errorPath)) fs.unlinkSync(errorPath);
  } catch {}
  try {
    if (fs.existsSync(previewPath)) fs.unlinkSync(previewPath);
  } catch {}

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
  record.statusText = `렌더 준비 중... (총 ${frameCount}프레임, 하이브리드 검사 중)`;
  record.totalFrames = frameCount;
  record.currentFrame = 0;
  record.updatedAt = nowIso();
  await saveJob(record);

  if (!browserPath) {
    record.status = 'failed';
    record.progress = -1;
    record.error = 'Chrome 또는 Edge 브라우저를 찾을 수 없습니다. CHROME_PATH 환경 변수를 설정해 주세요.';
    record.updatedAt = nowIso();
    await fsp.writeFile(errorPath, record.error, 'utf8').catch(() => {});
    await saveJob(record);
    return;
  }

  const rlog = (msg: string) => { const line = `[${new Date().toISOString()}] ${msg}`; console.log(line); try { fs.appendFileSync(logPath, line + '\n'); } catch {} };
  let hybridRenderSuccess = false;
  let clips = record.payload?.clips || [];
  const resolveAssetPathFromUrl = (ref: any) => {
    const raw = typeof ref === 'string' ? ref : '';
    if (!raw) return null;
    try {
      const pathname = raw.startsWith('http://') || raw.startsWith('https://') ? new URL(raw).pathname : raw;
      const cleanPath = pathname.split('?')[0].split('#')[0].replace(/\\/g, '/');
      const marker = '/assets/';
      const lower = cleanPath.toLowerCase();
      const markerIdx = lower.lastIndexOf(marker);
      if (markerIdx < 0 && !lower.startsWith(marker)) return null;
      const filePart = markerIdx >= 0 ? cleanPath.slice(markerIdx + marker.length) : cleanPath.slice(marker.length);
      const fileName = path.basename(decodeURIComponent(filePart));
      if (!fileName) return null;
      const candidate = path.join(ASSET_DIR, fileName);
      return fs.existsSync(candidate) ? candidate : null;
    } catch {
      return null;
    }
  };
  const resolveAssetPathFromName = (name: any) => {
    const fileName = String(name || '');
    if (!fileName) return null;
    const dirs = [
      ASSET_DIR,
      path.join(os.homedir(), 'Desktop'),
      path.join(os.homedir(), 'Downloads'),
      ROOT,
    ];
    const cleanName = safeName(fileName).replace(/\.[^/.]+$/, '').toLowerCase();
    const ext = path.extname(fileName).toLowerCase();
    for (const dir of dirs) {
      try {
        if (!fs.existsSync(dir)) continue;
        const direct = path.join(dir, fileName);
        if (fs.existsSync(direct)) return direct;
        const files = fs.readdirSync(dir);
        const exact = files.find(f => f.toLowerCase() === fileName.toLowerCase());
        if (exact) return path.join(dir, exact);
        if (ext) {
          const fuzzy = files.find(f => {
            const lower = f.toLowerCase();
            if (!lower.endsWith(ext)) return false;
            const fClean = safeName(f).replace(/\.[^/.]+$/, '').toLowerCase();
            return cleanName && fClean.includes(cleanName);
          });
          if (fuzzy) return path.join(dir, fuzzy);
        }
      } catch {}
    }
    return null;
  };
  
  // Auto-resolve missing or null storedPath / url from ASSET_DIR
  clips = clips.map((c: any) => {
    let resolvedPath = c.storedPath;
    let resolvedUrl = c.serverUrl || c.url;
    
    const pathExists = resolvedPath && fs.existsSync(resolvedPath);
    if (!pathExists) {
      const directAssetPath = resolveAssetPathFromUrl(resolvedUrl || c.src || c.path);
      if (directAssetPath) {
        resolvedPath = directAssetPath;
        resolvedUrl = `/assets/${path.basename(directAssetPath)}`;
      }
    }
    if (!resolvedPath || !fs.existsSync(resolvedPath)) {
      const directNamePath = resolveAssetPathFromName(c.name);
      if (directNamePath) {
        resolvedPath = directNamePath;
        resolvedUrl = c.serverUrl || c.url || resolvedUrl;
      }
    }
    if (!resolvedPath || !fs.existsSync(resolvedPath)) {
      console.log(`[Auto-Resolve] Clip "${c.name}" has missing/null storedPath. Searching ASSET_DIR: ${ASSET_DIR}`);
      if (fs.existsSync(ASSET_DIR)) {
        const files = fs.readdirSync(ASSET_DIR);
        const cleanName = safeName(c.name).replace(/\.[^/.]+$/, "");
        const cleanExt = path.extname(c.name).toLowerCase();
        
        const match = files.find(f => {
          const lowerF = f.toLowerCase();
          if (!lowerF.endsWith(cleanExt)) return false;
          
          const cleanPart = cleanName.replace(/_+/g, '_').replace(/^_|_$/g, '');
          const fClean = lowerF.replace(/_+/g, '_');
          
          return cleanPart && fClean.includes(cleanPart.toLowerCase());
        });
        
        if (match) {
          resolvedPath = path.join(ASSET_DIR, match);
          resolvedUrl = `/assets/${match}`;
          console.log(`[Auto-Resolve] Resolved clip "${c.name}" to "${resolvedPath}"`);
        } else {
          // Suffix fallback
          const parts = c.name.split('_');
          const lastPart = parts[parts.length - 1];
          if (lastPart && lastPart.length > 5) {
            const match2 = files.find(f => f.toLowerCase().endsWith(lastPart.toLowerCase()));
            if (match2) {
              resolvedPath = path.join(ASSET_DIR, match2);
              resolvedUrl = `/assets/${match2}`;
              console.log(`[Auto-Resolve] Suffix fallback resolved clip "${c.name}" to "${resolvedPath}"`);
            }
          }
        }
      }
    }
    return {
      ...c,
      storedPath: resolvedPath,
      serverUrl: resolvedUrl,
      url: resolvedUrl
    };
  });

  if (record.payload) {
    record.payload.clips = clips;
  }

  const graphics = record.payload?.graphics || [];
  
  const hasClipKeyframes = (clip: any) => !!(clip?.kf && Object.values(clip.kf).some((value: any) => Array.isArray(value) && value.length > 0));
  const isDefaultOpacity = (clip: any) => {
    const opacity = Number(clip?.opacity ?? 1);
    return Math.abs(opacity - 1) <= 0.0001 || Math.abs(opacity - 100) <= 0.0001;
  };
  const isDefaultTransform = (clip: any) => (
    Math.abs(Number(clip.rotation || 0)) <= 0.0001
    && Math.abs(Number(clip.scale ?? 100) - 100) <= 0.0001
    && Math.abs(Number(clip.x ?? 50) - 50) <= 0.0001
    && Math.abs(Number(clip.y ?? 50) - 50) <= 0.0001
    && isDefaultOpacity(clip)
  );
  const isVideoClip = (c: any) => c?.type === 'video' || c?.type === 'clip' || !c?.type;
  const videoClips = clips.filter((c: any) => isVideoClip(c) && c.storedPath && fs.existsSync(c.storedPath));
  const isSimpleImage = (c: any) => c.type === 'image' && c.storedPath && fs.existsSync(c.storedPath) && !hasClipKeyframes(c) && !Number(c.rotation || 0) && isDefaultOpacity(c);
  const imageClips = clips.filter(isSimpleImage);
  const isBasicVideoForHybrid = (clip: any) => {
    if (clip.visible === false || !isVideoClip(clip)) return false;
    if (!clip.storedPath || !fs.existsSync(clip.storedPath)) return false;
    if (hasClipKeyframes(clip) || !isDefaultTransform(clip)) return false;
    const srcW = Math.round(Number(clip.sourceW || width));
    const srcH = Math.round(Number(clip.sourceH || height));
    return srcW === Math.round(width) && srcH === Math.round(height);
  };
  const hasComplexClips = clips.some((c: any) => {
    if (c.visible === false || c.type === 'audio') return false;
    if (c.type === 'image') return !isSimpleImage(c);
    if (isVideoClip(c)) return !isBasicVideoForHybrid(c);
    return false;
  });
  const hasComplexGraphics = graphics.some((g: any) => g.visible !== false && g.type !== 'ae_template');
  const hasGraphics = graphics.some((g: any) => g.visible !== false);
  const normalizedVideoClips = videoClips
    .map((clip: any) => {
      const start = Math.max(Number(clip.ts || 0), renderIn);
      const end = Math.min(Number(clip.ts || 0) + Math.max(0, Number(clip.dur || 0)), renderOut);
      return { ...clip, __renderStart: start, __renderEnd: end, __renderDur: end - start };
    })
    .filter((clip: any) => clip.__renderDur > 0.001)
    .sort((a: any, b: any) => Number(a.__renderStart || 0) - Number(b.__renderStart || 0));
  const isBasicVideoClip = (clip: any) => {
    if (clip.visible === false) return false;
    if (clip.type && clip.type !== 'video' && clip.type !== 'clip') return false;
    if (!clip.storedPath || !fs.existsSync(clip.storedPath)) return false;
    if (hasClipKeyframes(clip)) return false;
    if (Math.abs(Number(clip.rotation || 0)) > 0.0001) return false;
    if (!isDefaultOpacity(clip)) return false;
    if (Math.abs(Number(clip.scale ?? 100) - 100) > 0.0001) return false;
    if (Math.abs(Number(clip.x ?? 50) - 50) > 0.0001) return false;
    if (Math.abs(Number(clip.y ?? 50) - 50) > 0.0001) return false;
    const srcW = Math.round(Number(clip.sourceW || width));
    const srcH = Math.round(Number(clip.sourceH || height));
    return srcW === Math.round(width) && srcH === Math.round(height);
  };
  const areSequentialVideos = normalizedVideoClips.length > 0 && normalizedVideoClips.every(isBasicVideoClip)
    && normalizedVideoClips.every((clip: any, idx: number) => {
      if (idx === 0) return Math.abs(Number(clip.__renderStart || 0) - renderIn) <= 0.05;
      const prev = normalizedVideoClips[idx - 1];
      return Math.abs(Number(clip.__renderStart || 0) - Number(prev.__renderEnd || 0)) <= 0.05;
    })
    && Math.abs(Number(normalizedVideoClips[normalizedVideoClips.length - 1].__renderEnd || 0) - renderOut) <= 0.05
    && imageClips.length === 0;

  // [DEBUG] Detailed hybrid render decision logging
  rlog(`[Render ${record.id}] ===== HYBRID RENDER DECISION =====`);
  rlog(`[Render ${record.id}]   clips total: ${clips.length}`);
  rlog(`[Render ${record.id}]   videoClips (with valid storedPath): ${videoClips.length}`);
  videoClips.forEach((c: any, i: number) => rlog(`[Render ${record.id}]     video[${i}]: name="${c.name}" storedPath="${c.storedPath}" ts=${c.ts} dur=${c.dur}`));
  rlog(`[Render ${record.id}]   imageClips (simple): ${imageClips.length}`);
  imageClips.forEach((c: any, i: number) => rlog(`[Render ${record.id}]     image[${i}]: name="${c.name}" storedPath="${c.storedPath}" ts=${c.ts} dur=${c.dur}`));
  rlog(`[Render ${record.id}]   hasComplexClips: ${hasComplexClips}`);
  rlog(`[Render ${record.id}]   graphics total: ${graphics.length}`);
  graphics.forEach((g: any, i: number) => rlog(`[Render ${record.id}]     graphic[${i}]: type=${g.type} visible=${g.visible} templateKind=${g.templateKind || 'N/A'} id=${g.id}`));
  rlog(`[Render ${record.id}]   hasGraphics: ${hasGraphics}`);
  rlog(`[Render ${record.id}]   hasComplexGraphics: ${hasComplexGraphics}`);

  const canRunHybrid = !hasComplexClips;
  const canConcatSequentialVideos = canRunHybrid && areSequentialVideos && normalizedVideoClips.length > 1;
  rlog(`[Render ${record.id}]   canRunHybrid: ${canRunHybrid}`);
  rlog(`[Render ${record.id}]   canConcatSequentialVideos: ${canConcatSequentialVideos}`);
  rlog(`[Render ${record.id}] ==================================`);

  if (canRunHybrid) {
    rlog(`[Render ${record.id}] TRIGGERED ADVANCED HYBRID RENDER PATH!`);
    record.statusText = `하이브리드 렌더 시작 (영상:${videoClips.length} 이미지:${imageClips.length} 그래픽:${graphics.length})`;
    record.updatedAt = nowIso();
    await saveJob(record);
    rlog(`[Render ${record.id}]   ??Stage 1 (Browser transparent capture): ${hasGraphics ? 'WILL RUN' : 'SKIPPED (no graphics)'}`);
    rlog(`[Render ${record.id}]   ??Stage 2 (FFmpeg overlay): WILL RUN`);
    const hybridDir = path.join(TEMP_DIR, `hybrid_${record.id}`);
    if (!fs.existsSync(hybridDir)) {
      fs.mkdirSync(hybridDir, { recursive: true });
    }
    
    let transSession = null;
    try {
      let staticFramePath = null;
      let introFrameCount = 0;
      let introDuration = 0;

      if (hasGraphics) {
        rlog(`[Hybrid Render] Stage 1: Launching transparent browser session for graphics capture...`);
        const transparentUrl = `http://localhost:${APP_PORT}/?renderJob=${record.id}&renderTs=${encodeURIComponent(renderIn.toFixed(6))}&transparent=1&onlyGraphics=1`;
        rlog(`[Hybrid Render] Stage 1 URL: ${transparentUrl}`);
        transSession = await launchRenderSession(browserPath, width, height, transparentUrl);
        rlog(`[Hybrid Render] Stage 1: Browser session launched successfully`);

        // [FIX] Warm up: set to first frame and wait for render-ready signal
        // (replaces the unreliable fixed sleep(500) heuristic)
        await setRenderTime(transSession.client, Number(renderIn.toFixed(6)));
        await waitForRenderReady(transSession.client, 8000);
        rlog(`[Hybrid Render] Stage 1: Browser warm-up complete, ready to capture frames`);

        const payloadIntroDuration = getHybridGraphicsAnimationDuration(graphics, renderIn, duration, fps);
        introDuration = Math.min(duration, payloadIntroDuration || 2.0);
        rlog(`[Hybrid Render] Template precache duration from keyframes: ${introDuration.toFixed(3)}s`);

        // [FIX] Read actual Lottie animation duration from the browser context
        // and fall back to the payload duration instead of a hardcoded 2 seconds.
        try {
          const lottieDurResult = await transSession.client.send('Runtime.evaluate', {
            expression: `(() => {
              try {
                const instances = window.__HM_LOTTIE_INSTANCES;
                if (instances && instances.length > 0) {
                  const anim = instances[0];
                  if (anim && anim.totalFrames > 0 && anim.frameRate > 0) {
                    return anim.totalFrames / anim.frameRate;
                  }
                }
                // fallback: read from lottie-web internal registry
                const keys = Object.keys(window).filter(k => k.startsWith('lottie'));
                return null;
              } catch(e) { return null; }
            })()`,
            returnByValue: true,
            awaitPromise: false,
          });
          const detectedDur = lottieDurResult?.result?.value;
          if (typeof detectedDur === 'number' && detectedDur > 0) {
            introDuration = Math.min(duration, introDuration > 0 ? Math.min(introDuration, detectedDur) : detectedDur);
            rlog(`[Hybrid Render] Lottie introDuration detected from browser: ${introDuration.toFixed(3)}s`);
          } else {
            rlog(`[Hybrid Render] Could not detect Lottie duration, using payload fallback: ${introDuration.toFixed(3)}s`);
          }
        } catch (e) {
          rlog(`[Hybrid Render] Lottie duration detection failed, using payload fallback: ${introDuration.toFixed(3)}s - ${e}`);
        }

        introFrameCount = Math.max(1, Math.ceil(introDuration * fps));

        record.statusText = `1단계. 자막 템플릿 캐시 생성 중... (0/${introFrameCount})`;
        record.updatedAt = nowIso();
        await saveJob(record);

        rlog(`[Hybrid Render] Rendering intro transparent WebP sequence (${introFrameCount} frames)...`);
        let lastPrecacheSavedAt = Date.now();
        
        for (let i = 0; i < introFrameCount; i++) {
          const ts = renderIn + i / fps;
          const framePath = path.join(hybridDir, `frame_${String(i).padStart(3, '0')}.png`);
          if (i === 0) {
            await fsp.writeFile(framePath, createTransparentPng(width, height));
            rlog(`[Hybrid Render] Forced frame_000.png to transparent to prevent subtitle first-frame flash`);
          } else {
            await setRenderTime(transSession.client, Number(ts.toFixed(6)));

            const result = await transSession.client.send('Page.captureScreenshot', {
              format: 'png',
              clip: { x: 0, y: 0, width, height, scale: 1 },
              fromSurface: true,
            });
            const frameBuffer = Buffer.from(result.data, 'base64');
            await fsp.writeFile(framePath, frameBuffer);
          }
          
          record.progress = Number((10 + (i / introFrameCount) * 40).toFixed(2));
          record.currentFrame = i;
          record.statusText = `1단계. 자막 템플릿 캐시 생성 중... (${i + 1}/${introFrameCount})`;
          record.updatedAt = nowIso();
          const saveNow = Date.now();
          if (saveNow - lastPrecacheSavedAt > 1000 || i === introFrameCount - 1) {
            await saveJob(record);
            lastPrecacheSavedAt = saveNow;
          }
        }
        
        if (duration > introDuration) {
          rlog(`[Hybrid Render] Rendering static hold frame (WebP)...`);
          const ts = renderIn + introDuration;
          await setRenderTime(transSession.client, Number(ts.toFixed(6)));

          // [FIX] WebP lossless + fromSurface for static hold frame
          const result = await transSession.client.send('Page.captureScreenshot', {
            format: 'png',
            clip: { x: 0, y: 0, width, height, scale: 1 },
            fromSurface: true,
          });
          const staticBuffer = Buffer.from(result.data, 'base64');
          staticFramePath = path.join(hybridDir, 'static.png');
          await fsp.writeFile(staticFramePath, staticBuffer);
        }
        
        await transSession.dispose();
        transSession = null;
        rlog(`[Hybrid Render] Stage 1: COMPLETED - Browser session disposed`);
      } else {
        rlog(`[Hybrid Render] Stage 1: SKIPPED (no visible graphics in project)`);
      }
      
      rlog(`[Hybrid Render] Stage 2: Starting FFmpeg hardware-accelerated overlay composition...`);
      record.statusText = '2단계. FFmpeg 렌더 진행 중... (인코딩 시작)';
      record.progress = 60.0;
      record.updatedAt = nowIso();
      await saveJob(record);
      
      const bin = ffmpegBin();
      let encoder = 'h264_nvenc';
      try {
        const encoders = execFileSync(bin, ['-encoders'], { encoding: 'utf8' });
        if (!encoders.includes('h264_nvenc')) {
          encoder = 'libx264';
        }
      } catch (e) {
        encoder = 'libx264';
      }
      
      const hybridArgs = ['-y'];
      let filterComplex = '';
      let lastV = '0:v';
      let currentInputIdx = 0;

      if (canConcatSequentialVideos) {
        rlog(`[Hybrid Render] Stage 2: Using sequential video concat path (${normalizedVideoClips.length} clips)`);
        for (const clip of normalizedVideoClips) {
          const trimStart = Number(clip.startT || 0) + Math.max(0, Number(clip.__renderStart || 0) - Number(clip.ts || 0));
          hybridArgs.push('-ss', trimStart.toFixed(6), '-t', Number(clip.__renderDur || 0).toFixed(6), '-i', clip.storedPath);
        }
        const concatLabels: string[] = [];
        for (let idx = 0; idx < normalizedVideoClips.length; idx++) {
          const label = `catv_${idx}`;
          filterComplex += `[${idx}:v]fps=${fps},scale=${width}:${height},setsar=1,setpts=PTS-STARTPTS[${label}];`;
          concatLabels.push(`[${label}]`);
        }
        filterComplex += `${concatLabels.join('')}concat=n=${normalizedVideoClips.length}:v=1:a=0[basev];`;
        lastV = 'basev';
        currentInputIdx = normalizedVideoClips.length;
      } else {
        // Input 0: base black canvas
        hybridArgs.push('-f', 'lavfi', '-i', `color=c=black:s=${width}x${height}:d=${duration.toFixed(6)}:r=${fps}`);
        lastV = '0:v';
        currentInputIdx = 1;

        // Inputs 1 to M: video clips
        for (const clip of videoClips) {
          const clipIn = Math.max(clip.ts, renderIn);
          const clipOut = Math.min(clip.ts + clip.dur, renderOut);
          const overlapDur = clipOut - clipIn;
          const trimStart = (clip.startT || 0) + Math.max(0, renderIn - clip.ts);
          
          hybridArgs.push('-ss', trimStart.toFixed(6), '-t', overlapDur.toFixed(6), '-i', clip.storedPath);
        }
        
        // Inputs M+1 to M+N: simple image clips
        for (const clip of imageClips) {
          const clipIn = Math.max(clip.ts, renderIn);
          const clipOut = Math.min(clip.ts + clip.dur, renderOut);
          const overlapDur = clipOut - clipIn;
          
          hybridArgs.push('-loop', '1', '-t', overlapDur.toFixed(6), '-i', clip.storedPath);
        }

        // Process background videos
        for (let idx = 0; idx < videoClips.length; idx++) {
          const clip = videoClips[idx];
          const relativeTs = Math.max(0, clip.ts - renderIn);
          const overlapDur = Math.min(clip.ts + clip.dur, renderOut) - Math.max(clip.ts, renderIn);
          
          const delayedLabel = `v_delay_${idx}`;
          const nextLabel = `v_step_${idx}`;
          
          filterComplex += `[${currentInputIdx}:v]scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,setsar=1,setpts=PTS-STARTPTS+${relativeTs.toFixed(6)}/TB[${delayedLabel}];`;
          filterComplex += `[${lastV}][${delayedLabel}]overlay=0:0:enable='between(t,${relativeTs.toFixed(6)},${(relativeTs + overlapDur).toFixed(6)})'[${nextLabel}];`;
          
          lastV = nextLabel;
          currentInputIdx++;
        }
        
        // Process simple images
        for (let idx = 0; idx < imageClips.length; idx++) {
          const clip = imageClips[idx];
          const relativeTs = Math.max(0, clip.ts - renderIn);
          const overlapDur = Math.min(clip.ts + clip.dur, renderOut) - Math.max(clip.ts, renderIn);
          
          const scale = (clip.scale ?? 100) / 100;
          const srcW = clip.sourceW || width;
          const srcH = clip.sourceH || height;
          const finalW = Math.round(srcW * scale);
          const finalH = Math.round(srcH * scale);
          const xPct = clip.x ?? 50;
          const yPct = clip.y ?? 50;
          const fx = Math.round((xPct / 100) * width - finalW / 2);
          const fy = Math.round((yPct / 100) * height - finalH / 2);
          
          const delayedLabel = `img_delay_${idx}`;
          const nextLabel = `img_step_${idx}`;
          
          filterComplex += `[${currentInputIdx}:v]scale=${finalW}:${finalH},setpts=PTS-STARTPTS+${relativeTs.toFixed(6)}/TB[${delayedLabel}];`;
          filterComplex += `[${lastV}][${delayedLabel}]overlay=${fx}:${fy}:enable='between(t,${relativeTs.toFixed(6)},${(relativeTs + overlapDur).toFixed(6)})'[${nextLabel}];`;
          
          lastV = nextLabel;
          currentInputIdx++;
        }
      }
      
      // Subtitle template inputs (if present)
      if (hasGraphics) {
        hybridArgs.push('-framerate', String(fps), '-start_number', '0', '-i', path.join(hybridDir, 'frame_%03d.png'));
        if (staticFramePath && fs.existsSync(staticFramePath)) {
          hybridArgs.push('-loop', '1', '-i', staticFramePath);
        }
      }
      
      // Process subtitle templates (if present)
      if (hasGraphics) {
        const subIntroIdx = currentInputIdx;
        const subIntroLabel = `sub_intro`;
        filterComplex += `[${subIntroIdx}:v]setpts=PTS-STARTPTS[${subIntroLabel}];`;
        
        const finalSubLabel = `sub_step`;
        const subOverlayStart = Math.min(introDuration, 1 / Math.max(1, fps));
        filterComplex += `[${lastV}][${subIntroLabel}]overlay=0:0:enable='between(t,${subOverlayStart.toFixed(6)},${introDuration.toFixed(6)})'[${finalSubLabel}];`;
        lastV = finalSubLabel;
        currentInputIdx++;
        
        if (staticFramePath && fs.existsSync(staticFramePath)) {
          const subStaticIdx = currentInputIdx;
          const subStaticLabel = `sub_static`;
          filterComplex += `[${subStaticIdx}:v]setpts=PTS-STARTPTS[${subStaticLabel}];`;
          
          const lastOutLabel = `outv`;
          filterComplex += `[${lastV}][${subStaticLabel}]overlay=0:0:enable='gt(t,${introDuration.toFixed(6)})'[${lastOutLabel}];`;
          lastV = lastOutLabel;
        }
      }
      
      // Trim filter complex trailing semicolon
      if (filterComplex.endsWith(';')) {
        filterComplex = filterComplex.slice(0, -1);
      }
      
      if (filterComplex.length > 0) {
        hybridArgs.push('-filter_complex', filterComplex);
        hybridArgs.push('-map', `[${lastV}]`);
      } else {
        hybridArgs.push('-map', '0:v');
      }
      
      hybridArgs.push('-c:v', encoder);
      // [FIX] NVENC uses p1~p7 preset scale, not libx264's slow/medium/fast strings.
      // Using 'slow' on nvenc causes unpredictable fallback behavior.
      if (encoder.endsWith('_nvenc')) {
        hybridArgs.push('-preset', 'p3', '-tune', 'hq', '-rc', 'vbr', '-cq', '18', '-b:v', '0', '-maxrate', '50M', '-bufsize', '100M');
      } else {
        hybridArgs.push('-preset', 'veryfast', '-crf', '18', '-threads', '0');
      }
      hybridArgs.push('-pix_fmt', 'yuv420p');
      hybridArgs.push('-t', duration.toFixed(6));
      hybridArgs.push('-movflags', '+faststart');
      hybridArgs.push(tempOutputPath);
      
      rlog(`[Hybrid Render] Stage 2: FFmpeg command:`);
      rlog(`[Hybrid Render]   ${bin} ${hybridArgs.join(' ')}`);
      if (filterComplex) {
        rlog(`[Hybrid Render]   filter_complex: ${filterComplex}`);
      }
      
      let lastHybridProgressSavedAt = Date.now();
      await new Promise<void>((resolve, reject) => {
        const p = spawn(bin, hybridArgs);
        let err = '';
        let progressLog = '';
        p.stderr.on('data', d => {
          const chunk = d.toString();
          err += chunk;
          progressLog += chunk;
          if (progressLog.includes('frame=') || progressLog.includes('time=')) {
            const lines = progressLog.split('\r');
            const last = lines[lines.length - 1] || lines[lines.length - 2] || '';
            if (last.includes('frame=')) {
              rlog(`[Hybrid Render] Stage 2 progress: ${last.trim()}`);
              // Parse current frame from FFmpeg progress for UI
              const frameMatch = last.match(/frame=\s*(\d+)/);
              if (frameMatch) {
                const ffFrame = parseInt(frameMatch[1], 10);
                const ffTotal = Math.ceil(duration * fps);
                record.statusText = `2단계. FFmpeg 렌더 진행 중... (${ffFrame}/${ffTotal})`;
                record.currentFrame = ffFrame;
                record.progress = Number((60 + Math.min(ffFrame / Math.max(1, ffTotal), 1) * 35).toFixed(2));
                record.updatedAt = nowIso();
                const saveNow = Date.now();
                if (saveNow - lastHybridProgressSavedAt > 1000 || ffFrame >= ffTotal) {
                  lastHybridProgressSavedAt = saveNow;
                  saveJob(record).catch(() => {});
                }
              }
            }
            progressLog = '';
          }
        });
        p.on('close', code => {
          if (code === 0) {
            rlog(`[Hybrid Render] Stage 2: FFmpeg overlay encoding COMPLETED (exit code 0)`);
            resolve();
          } else {
            rlog(`[Hybrid Render] Stage 2: FFmpeg FAILED (exit code ${code})`);
            rlog(`[Hybrid Render] Stage 2: FFmpeg stderr (last 500 chars): ${err.slice(-500)}`);
            reject(new Error(`FFmpeg hybrid overlay failed (code ${code}): ${err.slice(-500)}`));
          }
        });
        p.on('error', (spawnErr) => {
          rlog(`[Hybrid Render] Stage 2: FFmpeg spawn error: ${spawnErr}`);
          reject(spawnErr);
        });
      });
      
      // Verify output file exists and has content
      if (!fs.existsSync(tempOutputPath)) {
        throw new Error(`Hybrid render completed but output file does not exist: ${tempOutputPath}`);
      }
      const outputStat = fs.statSync(tempOutputPath);
      if (outputStat.size < 1024) {
        throw new Error(`Hybrid render output file is suspiciously small (${outputStat.size} bytes): ${tempOutputPath}`);
      }
      rlog(`[Hybrid Render] Stage 2: Output file verified: ${tempOutputPath} (${(outputStat.size / 1024 / 1024).toFixed(1)}MB)`);
      
      const previewSec = (duration / 2).toFixed(3);
      const previewArgs = ['-y', '-ss', previewSec, '-i', tempOutputPath, '-vframes', '1', '-q:v', '2', previewPath];
      await new Promise<void>((resolve) => {
        const p = spawn(bin, previewArgs);
        p.on('close', () => resolve());
      });
      
      hybridRenderSuccess = true;
      const hybridElapsed = ((Date.now() - renderStartedAt) / 1000).toFixed(1);
      rlog(`[Hybrid Render] COMPLETED SUCCESSFULLY in ${hybridElapsed}s`);
      record.statusText = `하이브리드 렌더 완료 (${hybridElapsed}초)`;
      record.progress = 95.0;
      record.updatedAt = nowIso();
      await saveJob(record);
    } catch (err: any) {
      rlog(`[Hybrid Render] FAILED, FALLING BACK TO STANDARD CAPTURE`);
      rlog(`[Hybrid Render]   Error: ${err.message}`);
      rlog(`[Hybrid Render]   Stack: ${err.stack || 'N/A'}`);
      record.statusText = `하이브리드 렌더 실패: ${(err.message || '').slice(0, 80)} - 프레임 캡처 방식으로 전환 중...`;
      record.updatedAt = nowIso();
      await saveJob(record).catch(() => {});
      if (transSession) {
        await transSession.dispose().catch(() => {});
      }
      try {
        if (fs.existsSync(hybridDir)) {
          const files = fs.readdirSync(hybridDir);
          for (const f of files) fs.unlinkSync(path.join(hybridDir, f));
          fs.rmdirSync(hybridDir);
        }
      } catch {}
    } finally {
      // [FIX] Always clean up temporary PNG/WebP frame sequence after hybrid render
      // (success path previously left hundreds of MB of frames on disk)
      if (hybridRenderSuccess) {
        fsp.rm(hybridDir, { recursive: true, force: true })
          .catch(e => console.warn('[Hybrid] tempdir cleanup failed:', e));
      }
    }
  }

  let session: Awaited<ReturnType<typeof launchRenderSession>> | null = null;
  let ffmpegProc: any = null;
  try {
    if (!hybridRenderSuccess) {
      rlog(`[Render ${record.id}] STANDARD CAPTURE PATH (frame-by-frame browser screenshot)`);
      if (canRunHybrid) {
        rlog(`[Render ${record.id}] NOTE: Hybrid was attempted but FAILED, falling back to slow standard capture`);
        record.statusText = '하이브리드 렌더 실패, 프레임 캡처 방식으로 전환 중...';
        record.updatedAt = nowIso();
        await saveJob(record);
      } else {
        rlog(`[Render ${record.id}] Hybrid was not eligible (hasComplexClips=${hasComplexClips}), using standard capture`);
      }
      const url = `http://localhost:${APP_PORT}/?renderJob=${record.id}&renderTs=${encodeURIComponent(renderIn.toFixed(6))}`;
      session = await launchRenderSession(browserPath, width, height, url);

      console.log(`[Render ${record.id}] Browser launched in ${Date.now() - renderStartedAt}ms`);
      record.status = 'rendering';
      record.progress = 10.00;
      record.statusText = `1단계. 프레임 캡처 준비 중... (0/${frameCount})`;
      record.updatedAt = nowIso();
      await saveJob(record);

      const bin = ffmpegBin();
      let encoder = 'h264_nvenc';
      try {
        const encoders = execFileSync(bin, ['-encoders'], { encoding: 'utf8' });
        if (!encoders.includes('h264_nvenc')) {
          console.warn('[Render] h264_nvenc not supported, falling back to libx264');
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
        // [FIX] NVENC preset system: p1(fast)~p7(quality). 'slow' is a libx264 term,
        // not valid for nvenc and causes undefined fallback behavior.
        ...(encoder.endsWith('_nvenc')
          ? ['-preset', 'p3', '-tune', 'hq', '-rc', 'vbr', '-cq', '18', '-b:v', '0', '-maxrate', '50M', '-bufsize', '100M']
          : ['-preset', 'veryfast', '-crf', '18', '-threads', '0']),
        '-pix_fmt', 'yuv420p',
        '-movflags', '+faststart',
        tempOutputPath,
      ];

      const logStream = fs.createWriteStream(logPath, { flags: 'a' });
      ffmpegProc = spawn(bin, ffmpegArgs);
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

      let lastSavedAt = 0;
      for (let i = 0; i < frameCount; i++) {
        if (!renderJobs.has(record.id)) {
          console.log(`[Render ${record.id}] Job was removed from queue. Aborting...`);
          throw new Error('cancelled');
        }
        if (ffmpegCrashed) {
          throw new Error('렌더링 중 비디오 인코더(FFmpeg)가 비정상 종료되었습니다. 자세한 내용은 로그를 확인해 주세요.');
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
           throw new Error('FFmpeg 입력 스트림을 사용할 수 없습니다.');
        }

        if (!ffmpegProc.stdin.write(frameBuffer)) {
          await new Promise(r => ffmpegProc.stdin.once('drain', r));
        }
        const t4 = Date.now();

        if (i === Math.floor(frameCount / 2)) {
          await fsp.writeFile(previewPath, frameBuffer).catch(() => {});
        }

        if (i < 10 || i % 30 === 0) console.log(`[Render ${record.id}] Frame ${i}/${frameCount}: setTime ${t2 - t1}ms, capture ${t3 - t2}ms, pipe ${t4 - t3}ms, elapsed ${((Date.now() - renderStartedAt) / 1000).toFixed(1)}s`);
        
        record.progress = Number((10 + ((i + 1) / frameCount) * 85).toFixed(2));
        record.currentFrame = i + 1;
        // Stage 1: first 20% of frames = pre-caching (Lottie warm-up), rest = stage 2 FFmpeg pipe
        const precacheFrames = Math.ceil(frameCount * 0.2);
        if (i < precacheFrames) {
          record.statusText = `1단계. 프레임 캡처 준비 중... (${i + 1}/${precacheFrames})`;
        } else {
          record.statusText = `2단계. FFmpeg 렌더 진행 중... (${i + 1 - precacheFrames}/${frameCount - precacheFrames})`;
        }
        record.updatedAt = nowIso();
        // [FIX] Debounce saveJob to once per second ??30fps x 30s = 900 fsync calls
        // was adding measurable I/O latency per frame on every write.
        const nowMs = Date.now();
        if (nowMs - lastSavedAt > 1000) {
          await saveJob(record);
          lastSavedAt = nowMs;
        }
      }

      console.log(`[Render ${record.id}] All ${frameCount} frames piped in ${((Date.now() - renderStartedAt) / 1000).toFixed(1)}s, waiting for FFmpeg...`);
      ffmpegProc.stdin.end();
      await ffmpegPromise;
      console.log(`[Render ${record.id}] FFmpeg finished in ${((Date.now() - renderStartedAt) / 1000).toFixed(1)}s`);
    }

    // --- Final Pass: Audio Mixing & Thumbnail ---
    record.progress = 96.00;
    record.statusText = '3단계. 오디오 합성 중...';
    record.updatedAt = nowIso();
    await saveJob(record);

    const audioClips = (record.payload?.clips || []).filter((c: any) => {
      if (c.type === 'image') return false;
      if (!c.storedPath || !fs.existsSync(c.storedPath)) return false;
      return hasAudioStream(c.storedPath);
    });
    const hasAudio = audioClips.length > 0;
    
    if (hasAudio) {
      const finalPassArgs = ['-y'];
      
      // Input 0: Rendered Video (No audio)
      finalPassArgs.push('-i', tempOutputPath);
      
      // Inputs 1+: Audio sources
      const audioInputs = [];
      for (const c of audioClips) {
        audioInputs.push(c);
        finalPassArgs.push('-i', c.storedPath);
      }
 
      const vIdx = 0;
      const aStartIdx = 1;

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
          // Trim -> Reset PTS -> Delay using modern all=1 option for robust multi-channel support
          audioFilters += `[${idx + aStartIdx}:a]atrim=start=${trimStart.toFixed(3)}:duration=${overlapDur.toFixed(3)},asetpts=PTS-STARTPTS,adelay=delays=${delayMs}:all=1,aresample=async=1:first_pts=0[${label}];`;
          amixLabels.push(`[${label}]`);
          mixCount++;
        }
        
        if (mixCount > 0) {
          if (mixCount === 1) {
            // Bypass amix filter to prevent attenuation when there is only 1 audio stream
            filterComplex = `${audioFilters}${amixLabels[0]}anull[outa]`;
          } else {
            // Mix multiple audios with normalize=0 to preserve full volume
            filterComplex = `${audioFilters}${amixLabels.join('')}amix=inputs=${mixCount}:normalize=0:duration=longest[outa]`;
          }
        }
      }

      const actuallyHasAudio = filterComplex.length > 0;
      if (actuallyHasAudio) {
        finalPassArgs.push('-filter_complex', filterComplex);
      }

      finalPassArgs.push('-map', '0:v'); // Video from input 0
      
      if (actuallyHasAudio) {
        finalPassArgs.push('-map', '[outa]');
      }

      finalPassArgs.push('-c:v', 'copy');
      if (actuallyHasAudio) finalPassArgs.push('-c:a', 'aac', '-b:a', '192k', '-shortest');
      finalPassArgs.push('-t', duration.toFixed(6));
      finalPassArgs.push('-movflags', '+faststart');
      const finalPassTemp = path.join(RENDER_DIR, `${record.id}_final.mp4`);
      finalPassArgs.push(finalPassTemp);

      try {
        console.log(`[Render ${record.id}] Starting final pass to: ${outputPath}`);
        
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

        if (fs.existsSync(finalPassTemp)) {
          await moveFile(finalPassTemp, outputPath);
          await fsp.unlink(tempOutputPath).catch(() => {});
          console.log(`[Render ${record.id}] SUCCESSFULLY SAVED TO: ${outputPath}`);
        } else {
          throw new Error('Final pass finished but output file missing');
        }
      } catch (err: any) {
        console.warn(`[Render ${record.id}] Final pass failed; refusing to save a muted fallback: ${err.message}`);
        throw err;
      }
    } else {
      console.log(`[Render ${record.id}] No audio/preview needed. Saving to: ${outputPath}`);
      await moveFile(tempOutputPath, outputPath);
      console.log(`[Render ${record.id}] SAVED TO: ${outputPath}`);
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
    if (ffmpegProc) {
      try { ffmpegProc.kill(); } catch {}
    }
    record.status = 'failed';
    record.progress = -1;
    record.statusText = '렌더 실패';
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
app.use('/external-templates', express.static(EXTERNAL_TEMPLATE_DIR));
app.use(express.static(path.join(ROOT, 'dist'), { etag: false, lastModified: false, setHeaders: (res) => res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private') }));

app.get('/api/templates', async (_req, res) => {
  try {
    if (!fs.existsSync(EXTERNAL_TEMPLATE_DIR)) {
      return res.json([]);
    }
    const files = await fsp.readdir(EXTERNAL_TEMPLATE_DIR);
    const jsonFiles = files.filter(f => f.toLowerCase().endsWith('.json'));
    
    const templates = jsonFiles.map(file => ({
      name: file.replace(/\.json$/i, ''),
      path: `/external-templates/${file}`
    }));
    
    res.json(templates);
  } catch (err) {
    console.error("Error reading external templates:", err);
    res.status(500).json({ error: "Failed to read templates" });
  }
});

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
    const encoders = execFileSync(bin, ['-encoders'], { encoding: 'utf8' });
    if (encoders.includes('h264_nvenc')) {
      hasGpu = true;
      encoder = 'h264_nvenc';
    }
  } catch (e) {}

  const browserPath = browserBin();

  // For FFmpeg, we consider it "found" for the setup flow only if it's in the system path or local .runtime folder.
  // If it's only in node_modules (bundled), we want to encourage a proper "install" to .runtime + PATH.
  const isFound = !!bin && (hasSystemFfmpeg || (bin ? (bin.includes('.runtime') || bin.includes('.hmstudio_runtime')) : false));

  res.json({
    ffmpeg: {
      path: bin,
      found: isFound,
      hasSystem: hasSystemFfmpeg,
      isLocal: bin ? (bin.includes('.runtime') || bin.includes('.hmstudio_runtime')) : false,
      isBundled: bin ? bin.includes('node_modules') : false
    },
    gpu: {
      supported: hasGpu,
      encoder: encoder
    },
    browser: {
      path: browserPath,
      found: !!browserPath,
      hasSystem: browserPath ? !(browserPath.includes('.runtime') || browserPath.includes('.hmstudio_runtime')) : false,
      isLocal: browserPath ? (browserPath.includes('.runtime') || browserPath.includes('.hmstudio_runtime')) : false
    },
    platform: process.platform,
    arch: process.arch
  });
});


app.post('/api/system/install-ffmpeg', async (_req, res) => {
  try {
    const targetDir = FFMPEG_RUNTIME_DIR;
    if (!fs.existsSync(targetDir)) fs.mkdirSync(targetDir, { recursive: true });
    
    console.log('[Setup] Installing local FFmpeg...');
    const source = resolveBundledFfmpeg();
    if (!source) throw new Error('ffmpeg-static executable not found');
    
    const destination = path.join(targetDir, ffmpegExeName());
    
    fs.copyFileSync(source, destination);
    if (process.platform !== 'win32') fs.chmodSync(destination, 0o755);
    verifyFfmpegExecutable(destination);

    // Set User PATH environment variable on Windows for convenience
    if (process.platform === 'win32') {
      try {
        const binDir = targetDir;
        const psCommand = `$u=[Environment]::GetEnvironmentVariable('Path','User'); if($u -notlike '*${binDir}*'){$n=$u+';'+'${binDir}';[Environment]::SetEnvironmentVariable('Path',$n,'User')}`;
        execFileSync('powershell', ['-NoProfile', '-Command', psCommand]);
        console.log('[Setup] FFmpeg added to User PATH');
      } catch (e) {
        console.warn('[Setup] Could not update PATH:', e);
      }
    }
    
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
    const installPath = path.join(RUNTIME_BASE, 'chrome');
    fs.mkdirSync(installPath, { recursive: true });
    
    const cmd = `npx @puppeteer/browsers install chrome@stable --path "${installPath}"`;
    const npxCmd = process.platform === 'win32' ? 'npx.cmd' : 'npx';
    execFileSync(npxCmd, ['@puppeteer/browsers', 'install', 'chrome@stable', '--path', installPath], { stdio: 'inherit' });
    
    const newPath = browserBin();
    res.json({ ok: true, path: newPath });
  } catch (err: any) {
    console.error('Failed to install chrome:', err);
    res.status(500).json({ ok: false, error: String(err.message || err) });
  }
});

app.post('/api/system/browse-folder', async (_req, res) => {
  const psCommand = `
    $shell = New-Object -ComObject Shell.Application;
    $folder = $shell.BrowseForFolder(0, '?????춯?삳궚?????繞③뇡?????臾딅ご???ルㅎ臾??琉얠돪??', 0x00000010 + 0x00000040, 0);
    if ($folder) {
      Write-Output $folder.Self.Path;
    }
  `;
  
  const fullCommand = `powershell -Sta -NoProfile -Command "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; ${psCommand.replace(/\n/g, ' ')}"`;
  
  exec(fullCommand, { encoding: 'utf8' }, (error, stdout, stderr) => {
    if (error) {
      console.error('Folder picker error:', error);
      res.status(500).json({ ok: false, error: error.message });
      return;
    }
    
    const result = stdout.trim();
    console.log(`[System] Folder picker stdout: "${stdout}"`);
    console.log(`[System] Folder picker result: "${result}"`);
    if (result) {
      res.json({ ok: true, path: result });
    } else {
      res.json({ ok: false, message: 'Canceled' });
    }
  });
});


app.get('/api/system/assets', (_req, res) => {
  try {
    if (!fs.existsSync(ASSET_DIR)) {
      return res.json({ ok: true, files: [] });
    }
    const files = fs.readdirSync(ASSET_DIR);
    res.json({ ok: true, files });
  } catch (err: any) {
    res.status(500).json({ ok: false, error: err.message });
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
  const endpoints = [
    'http://erp.hanmaceng.co.kr/intranet/sys/popup/login_ok.php',
    'http://erp.samaneng.com/intranet/sys/popup/login_ok.php',
    'http://erp.jangheon.co.kr/intranet/sys/popup/login_ok.php',
    'http://erp.pre-cast.co.kr/intranet/sys/popup/login_ok.php',
    'http://intranet.hallasanup.com/intranet/sys/popup/login_ok.php',
    'http://erp.baroncs.co.kr/intranet/sys/popup/login_ok.php',
  ];

  try {
    const results = await Promise.all(endpoints.map(async (url) => {
      try {
        const response = await fetch(url, {
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
        return { success: text.trim() === '1', url };
      } catch (e) {
        return { success: false, url };
      }
    }));

    const successful = results.find(r => r.success);
    if (successful) {
      res.json({ success: true });
    } else {
      res.json({ success: false, message: '사번 또는 비밀번호가 일치하지 않습니다.' });
    }
  } catch (err) {
    console.error('Login Proxy Error:', err);
    res.status(500).json({ success: false, message: '서버와 통신 중 오류가 발생했습니다.' });
  }
});

app.post('/api/render-jobs/delete', async (req, res) => {
  const { id } = req.body || {};
  if (id && renderJobs.has(id)) {
    renderJobs.delete(id);
    const jobFile = path.join(JOB_DIR, id + '.json');
    if (fs.existsSync(jobFile)) {
      try { fs.unlinkSync(jobFile); } catch {}
    }
  }
  res.json({ ok: true });
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

app.post('/api/file-exists', async (req, res) => {
  const targetPath = typeof req.body?.path === 'string' ? req.body.path : '';
  res.json({ exists: !!targetPath && fs.existsSync(targetPath) });
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
        outputPath: req.body.output?.outputPath || path.join(RENDER_DIR, safeProjectName),

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
  const fileName = job?.payload?.output?.fileName || `${id}.mp4`;
  const output = job?.payload?.output || {};
  const mp4 = output.outputPath || path.join(RENDER_DIR, output.fileName || `${id}.mp4`);

  if (!fs.existsSync(mp4)) return res.status(404).end();
  res.download(mp4, output.fileName || `${id}.mp4`);

});

app.get('/api/render-jobs/:id/download/:filename', (req, res) => {
  const job = renderJobs.get(req.params.id);
  const output = job?.payload?.output || {};
  const mp4 = output.outputPath || path.join(RENDER_DIR, output.fileName || `${req.params.id}.mp4`);

  if (!fs.existsSync(mp4)) return res.status(404).end();
  res.download(mp4, req.params.filename);
});

app.get('/api/render-jobs/:id/log', (req, res) => {
  const logFile = path.join(LOG_DIR, `${req.params.id}.log.txt`);
  if (!fs.existsSync(logFile)) return res.status(404).end();
  res.sendFile(logFile);
});

app.get('*', (_req, res) => {
  const index = path.join(APP_PATH, 'dist', 'index.html');
  if (fs.existsSync(index)) res.sendFile(index);
  else res.status(404).send('Vite dev server or build missing');
});

app.listen(APP_PORT, async () => {
  ensureDirs();
  await ensureSystemBins(); // Run installation logic on startup
  console.log(`?? Server running on http://localhost:${APP_PORT}`);
  console.log(`???Network access: http://${getInternalIP()}:${APP_PORT}`);
  console.log(`?獄?AE render root: ${AE_RENDER_ROOT}`);
});
