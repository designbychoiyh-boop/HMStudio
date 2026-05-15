import { app, BrowserWindow, ipcMain, dialog, protocol, net, screen } from 'electron';
import path from 'path';
import fs from 'fs';
import fsp from 'fs/promises';
import { spawn, spawnSync, execSync, exec, fork } from 'child_process';
import os from 'os';
import crypto from 'crypto';
import ffmpegStaticPath from 'ffmpeg-static';

// Configure Chromium command line switches to disable background throttling and force hardware acceleration for hidden windows
if (app) {
  app.commandLine.appendSwitch('enable-gpu');
  app.commandLine.appendSwitch('ignore-gpu-blocklist');
  app.commandLine.appendSwitch('enable-webgl');
  app.commandLine.appendSwitch('enable-accelerated-2d-canvas');
  app.commandLine.appendSwitch('disable-background-timer-throttling');
  app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
  app.commandLine.appendSwitch('disable-renderer-backgrounding');
}

// Define directories in Main Process
const ROOT = (app && app.isPackaged) ? path.dirname(process.execPath) : process.cwd();
const APP_PORT = 3001; // Port used for Vite development server (fallback)
const AE_RENDER_ROOT = process.env.AE_RENDER_ROOT 
  ? path.resolve(process.env.AE_RENDER_ROOT)
  : process.env.PORTABLE_EXECUTABLE_DIR
  ? path.join(process.env.PORTABLE_EXECUTABLE_DIR, 'HMStudio_AE_Render_Server')
  : (app && app.isPackaged)
  ? path.join(path.dirname(process.execPath), 'HMStudio_AE_Render_Server')
  : process.platform === 'win32'
  ? path.join(os.homedir(), 'Desktop', 'HMStudio_AE_Render_Server')
  : path.join(ROOT, '.runtime', 'HMStudio_AE_Render_Server');

const ASSET_DIR = path.join(AE_RENDER_ROOT, 'assets');
const TEMPLATE_DIR = path.join(AE_RENDER_ROOT, 'templates');
const JOB_DIR = path.join(AE_RENDER_ROOT, 'jobs');
const resolveExternalTemplateDir = () => {
  const candidates = [
    process.env.PORTABLE_EXECUTABLE_DIR ? path.join(process.env.PORTABLE_EXECUTABLE_DIR, 'Template_Json') : null,
    path.join(ROOT, 'Template_Json'),
    (process as any).resourcesPath ? path.join((process as any).resourcesPath, 'Template_Json') : null,
  ].filter(Boolean) as string[];
  return candidates.find(dir => fs.existsSync(dir)) || candidates[0] || path.join(ROOT, 'Template_Json');
};
const EXTERNAL_TEMPLATE_DIR = resolveExternalTemplateDir();
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

// Ensure folders exist immediately
ensureDirs();

// Register local-file as a privileged protocol before app is ready
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'local-file',
    privileges: {
      secure: true,
      standard: true,
      bypassCSP: true,
      allowServiceWorkers: true,
      supportFetchAPI: true,
      corsEnabled: true,
      stream: true
    }
  }
]);

let mainWindow: BrowserWindow | null = null;
let serverProcess: any = null;

function startBackendServer() {
  if (app.isPackaged) {
    const serverDir = __dirname.includes('app.asar') ? __dirname.replace('app.asar', 'app.asar.unpacked') : __dirname;
    const appRoot = path.join(serverDir, '..');
    const serverPath = path.join(serverDir, 'server.js');
    if (fs.existsSync(serverPath)) {
      console.log(`[Main] Launching background express server from: ${serverPath}`);
      const exeDir = process.env.PORTABLE_EXECUTABLE_DIR || path.dirname(process.execPath);
      serverProcess = fork(serverPath, [], {
        cwd: appRoot,
        env: {
          ...process.env,
          PORT: String(APP_PORT),
          NODE_ENV: 'production',
          ELECTRON_RUN_AS_NODE: '1',
          APP_PATH: appRoot,
          EXE_DIR: exeDir,
          NODE_PATH: [path.join(appRoot, 'node_modules'), path.join(app.getAppPath(), 'node_modules')].join(path.delimiter)
        },
        stdio: ['inherit', 'inherit', 'inherit', 'ipc']
      });

      serverProcess.on('error', (err) => {
        console.error('[Main] Failed to start backend server:', err);
      });

      serverProcess.on('exit', (code) => {
        console.error(`[Main] Backend server exited with code ${code}`);
      });
    } else {
      console.error(`[Main] Backend server not found at: ${serverPath}`);
    }
  }
}

// Clean up background server process upon application exit
app.on('quit', () => {
  if (serverProcess) {
    serverProcess.kill();
  }
});

// Track active background render windows & FFmpeg processes
type ActiveRenderSession = {
  ffmpegProc: any;
  renderWin: BrowserWindow;
  frameCount: number;
  currentFrame: number;
  pendingFrameKey?: string;
  forceTransparentFirstGraphicsFrame?: boolean;
  frameCache: Map<string, Buffer>;
  resolvePromise: () => void;
  rejectPromise: (err: Error) => void;
};
const activeRenders = new Map<string, ActiveRenderSession>();

function writeRawFrame(session: ActiveRenderSession, buffer: Buffer) {
  return new Promise<void>((resolve, reject) => {
    session.ffmpegProc.stdin.once('error', reject);
    const done = () => {
      session.ffmpegProc.stdin.off('error', reject);
      resolve();
    };
    if (!session.ffmpegProc.stdin.write(buffer)) {
      session.ffmpegProc.stdin.once('drain', done);
    } else {
      done();
    }
  });
}

function bgraToRgbaInPlace(buffer: Buffer) {
  for (let i = 0; i + 3 < buffer.length; i += 4) {
    const b = buffer[i];
    buffer[i] = buffer[i + 2];
    buffer[i + 2] = b;
  }
  return buffer;
}

async function captureWindowRgba(renderWin: BrowserWindow, width: number, height: number) {
  let image = await renderWin.webContents.capturePage({ x: 0, y: 0, width, height });
  const size = image.getSize();
  if (size.width !== width || size.height !== height) {
    image = image.resize({ width, height, quality: 'best' });
  }
  return bgraToRgbaInPlace(Buffer.from(image.toBitmap()));
}

// Render jobs mapping
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
  return name.replace(/[^a-zA-Z0-9._-]+/g, '_');
}

function jobJsonPath(id: string) {
  return path.join(JOB_DIR, `${id}.json`);
}

function refreshJobFromDisk(job: RenderJobRecord) {
  const output = job.payload?.output || {};
  const mp4 = output.outputPath || path.join(RENDER_DIR, output.fileName || `${job.id}.mp4`);
  const previewJpg = output.previewPath || path.join(PREVIEW_DIR, `${job.id}.jpg`);
  const errorLog = output.errorPath || path.join(LOG_DIR, `${job.id}.error.txt`);
  const isActiveStatus = job.status === 'queued' || job.status === 'preparing' || job.status === 'rendering';

  if (!isActiveStatus && fs.existsSync(mp4)) {
    job.status = 'completed';
    job.progress = 100;
    job.downloadUrl = `local-file://${mp4.replace(/\\/g, '/')}`;
  }
  if (fs.existsSync(previewJpg)) {
    job.previewUrl = `local-file://${previewJpg.replace(/\\/g, '/')}`;
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
  if (!renderJobs.has(job.id)) return;
  await fsp.writeFile(jobJsonPath(job.id), JSON.stringify(job, null, 2), 'utf8');
}

// Synchronously load jobs on startup
function loadJobsFromDisk() {
  ensureDirs();
  try {
    if (fs.existsSync(JOB_DIR)) {
      const files = fs.readdirSync(JOB_DIR).filter(f => f.endsWith('.json'));
      for (const f of files) {
        try {
          const content = fs.readFileSync(path.join(JOB_DIR, f), 'utf8');
          const job = JSON.parse(content) as RenderJobRecord;
          renderJobs.set(job.id, job);
        } catch {}
      }
    }
  } catch (err) {
    console.error('Failed to load jobs from disk:', err);
  }
}

loadJobsFromDisk();

// FFmpeg / Chrome finders
function findLocalFfmpeg() {
  const base = path.join(os.homedir(), '.hmstudio_runtime', 'ffmpeg');
  if (!fs.existsSync(base)) return null;
  const exe = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
  const full = path.join(base, exe);
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
    if (ffmpegStaticPath && fs.existsSync(ffmpegStaticPath)) return ffmpegStaticPath;
    return null;
  }
}

function browserBin() {
  const candidates = [
    process.env.CHROME_PATH,
    process.env.BROWSER_PATH,
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

function hasAudioStream(filePath: string): boolean {
  try {
    const bin = ffmpegBin();
    const probe = spawnSync(bin, ['-i', filePath], { encoding: 'utf8' });
    const out = `${probe.stderr || ''}${probe.stdout || ''}`;
    return out.toLowerCase().includes('audio:');
  } catch (e) {
    return false;
  }
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

async function moveFile(src: string, dest: string) {
  try {
    const destDir = path.dirname(dest);
    if (!fs.existsSync(destDir)) {
      fs.mkdirSync(destDir, { recursive: true });
    }
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

// Core Rendering Loop running on Electron Main process using Direct Pixel Stream
let renderWorkerRunning = false;

async function executeRenderJob(record: RenderJobRecord) {
  const jobId = record.id;
  const output = record.payload?.output || {};
  const outputPath = output.outputPath || path.join(RENDER_DIR, output.fileName || `${jobId}.mp4`);
  
  const tempOutputPath = path.join(RENDER_DIR, `${jobId}_tmp.mp4`);
  const previewPath = output.previewPath || path.join(PREVIEW_DIR, `${jobId}.jpg`);
  const logPath = output.logPath || path.join(LOG_DIR, `${jobId}.log.txt`);
  const errorPath = output.errorPath || path.join(LOG_DIR, `${jobId}.error.txt`);
  
  const comp = record.payload?.composition || {};
  const width = Math.max(2, Number(comp.w || 1920));
  const height = Math.max(2, Number(comp.h || 1080));
  const fps = Math.max(1, Number(comp.fps || 30));
  const range = record.payload?.renderRange || {};
  const renderIn = Math.max(0, Number(range.in || 0));
  const renderOut = Math.max(renderIn + 0.1, Number(range.out || 5));
  const duration = renderOut - renderIn;
  const frameCount = Math.max(1, Math.ceil(duration * fps));

  const renderStartedAt = Date.now();
  console.log(`[Render ${jobId}] Starting raw pixel render loop: ${width}x${height} @ ${fps}fps, total frames=${frameCount}`);

  record.status = 'preparing';
  record.progress = 2.00;
  record.statusText = `렌더링 준비 중... (${frameCount} 프레임)`;
  record.totalFrames = frameCount;
  record.currentFrame = 0;
  record.updatedAt = nowIso();
  await saveJob(record);

  const bin = ffmpegBin();
  if (!bin) {
    throw new Error('FFmpeg 실행 파일을 찾을 수 없습니다.');
  }

  let encoder = 'h264_nvenc';
  try {
    const encoders = execSync(`"${bin}" -encoders`, { encoding: 'utf8' });
    if (!encoders.includes('h264_nvenc')) {
      encoder = 'libx264';
    }
  } catch (e) {
    encoder = 'libx264';
  }

  // [AUTO-RESOLVE] & Hybrid Checks
  let clips = record.payload?.clips || [];
  const graphics = record.payload?.graphics || [];
  const safeName = (n: string) => String(n || '').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_');
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
  const resolveAssetPathLoose = (clip: any) => {
    const rawName = String(clip?.name || '');
    const ext = path.extname(rawName).toLowerCase();
    const exts = ext ? [ext] : ['.mp4', '.mov', '.mkv', '.avi', '.webm'];
    const tokens = rawName.match(/\d{3,}/g) || [];
    if (!tokens.length) return null;
    const dirs = [
      ASSET_DIR,
      path.join(os.homedir(), 'Desktop'),
      path.join(os.homedir(), 'Downloads'),
      ROOT,
    ];
    for (const dir of dirs) {
      try {
        if (!fs.existsSync(dir)) continue;
        const files = fs.readdirSync(dir);
        const match = files.find(f => {
          const lower = f.toLowerCase();
          if (!exts.some(e => lower.endsWith(e))) return false;
          return tokens.some(token => lower.includes(token.toLowerCase()));
        });
        if (match) return path.join(dir, match);
      } catch {}
    }
    return null;
  };
  clips = clips.map((c: any) => {
    let resolvedPath = c.storedPath;
    if (!resolvedPath || !fs.existsSync(resolvedPath)) {
      resolvedPath = resolveAssetPathFromUrl(c.serverUrl || c.url || c.src || c.path);
    }
    if (!resolvedPath || !fs.existsSync(resolvedPath)) {
      resolvedPath = resolveAssetPathFromName(c.name);
    }
    if (!resolvedPath || !fs.existsSync(resolvedPath)) {
      resolvedPath = resolveAssetPathLoose(c);
    }
    if (!resolvedPath || !fs.existsSync(resolvedPath)) {
      if (fs.existsSync(ASSET_DIR)) {
        const files = fs.readdirSync(ASSET_DIR);
        const cleanName = safeName(c.name).replace(/\.[^/.]+$/, '');
        const cleanExt = path.extname(c.name).toLowerCase();
        const match = files.find(f => f.toLowerCase().endsWith(cleanExt) && f.toLowerCase().replace(/_+/g, '_').includes(cleanName.replace(/_+/g, '_').replace(/^_|_$/g, '').toLowerCase()));
        if (match) resolvedPath = path.join(ASSET_DIR, match);
        else {
          const parts = c.name.split('_');
          const lastPart = parts[parts.length - 1];
          if (lastPart && lastPart.length > 5) {
            const match2 = files.find(f => f.toLowerCase().endsWith(lastPart.toLowerCase()));
            if (match2) resolvedPath = path.join(ASSET_DIR, match2);
          }
        }
      }
    }
    return { ...c, storedPath: resolvedPath };
  });
  if (record.payload) record.payload.clips = clips;

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
  const hasGraphics = graphics.some((g: any) => g.visible !== false);
  const requiresDomTemplateCapture = graphics.some((g: any) => (
    g?.visible !== false
    && g?.type === 'ae_template'
    && g?.templateKind !== 'multi_png_title'
    && g?.templateKind !== 'vector_subtitle'
  ));
  const usePageCapture = requiresDomTemplateCapture;
  const canRunHybrid = !hasComplexClips && (videoClips.length > 0 || imageClips.length > 0);
  const lottiePrecacheFrames: { ts: number; layerId: string; frame: number }[] = [];
  const lottiePrecacheSeen = new Set<string>();
  const getLottieFrameInfo = (layer: any) => {
    const lottieFps = Math.max(1, Number(layer.lottieData?.fr || fps || 30));
    const ip = Number(layer.lottieData?.ip || 0);
    const op = Number(layer.lottieData?.op || 0);
    const framesFromOp = op > ip ? Math.ceil(op - ip) : 0;
    const framesFromDuration = Math.ceil(Math.max(0, Number(layer.templateDuration || 0)) * lottieFps);
    const framesFromLayer = Math.ceil(Math.max(0, Number(layer.dur || 0)) * lottieFps);
    const fullFrameCount = Math.max(1, framesFromOp || framesFromDuration || framesFromLayer);
    const animationFrameCount = fullFrameCount;
    return {
      lottieFps,
      animationFrameCount,
      animationDuration: animationFrameCount / lottieFps,
    };
  };
  const hasTransformKeyframes = (layer: any) => {
    const kf = layer?.kf || {};
    return Object.values(kf).some((value: any) => Array.isArray(value) && value.length > 0);
  };
  const graphicsFrameKey = (ts: number, frameIndex: number) => {
    if (!canRunHybrid || !hasGraphics) return `dynamic:${frameIndex}`;

    const parts: string[] = [];
    for (const layer of graphics) {
      if (layer?.visible === false) continue;

      const layerStart = Number(layer.ts || 0);
      const layerDur = Math.max(0, Number(layer.dur || 0));
      if (ts < layerStart || ts >= layerStart + layerDur) continue;

      if (layer.type !== 'ae_template' || !layer.lottieData || hasTransformKeyframes(layer)) {
        return `dynamic:${frameIndex}`;
      }

      const { lottieFps, animationFrameCount, animationDuration } = getLottieFrameInfo(layer);
      const local = Math.max(0, ts - layerStart);
      if (local < animationDuration - 0.0001) {
        return `dynamic:${frameIndex}`;
      }
      const lottieFrame = Math.min(Math.floor(local * lottieFps), animationFrameCount - 1);
      parts.push(`${layer.id}:${lottieFrame}`);
    }

    return parts.length ? parts.sort().join('|') : 'empty';
  };

  for (const layer of graphics) {
    if (layer?.type !== 'ae_template' || !layer.lottieData || layer.visible === false) continue;

    const layerStart = Number(layer.ts || 0);
    const layerDur = Math.max(0, Number(layer.dur || 0));
    const layerEnd = layerStart + layerDur;
    const overlapIn = Math.max(renderIn, layerStart);
    const overlapOut = Math.min(renderOut, layerEnd);
    if (overlapOut <= overlapIn) continue;

    const { lottieFps, animationFrameCount, animationDuration } = getLottieFrameInfo(layer);
    const firstFrame = Math.min(
      animationFrameCount - 1,
      Math.max(0, Math.floor((overlapIn - layerStart) * lottieFps))
    );
    const animatedOverlapOut = Math.min(overlapOut, layerStart + animationDuration);
    const lastAnimatedFrame = Math.min(
      animationFrameCount - 1,
      Math.max(0, Math.ceil((animatedOverlapOut - layerStart) * lottieFps) - 1)
    );

    for (let frame = firstFrame; frame <= lastAnimatedFrame; frame++) {
      const key = `${layer.id}:${frame}`;
      if (lottiePrecacheSeen.has(key)) continue;
      lottiePrecacheSeen.add(key);
      lottiePrecacheFrames.push({
        ts: layerStart + frame / lottieFps,
        layerId: String(layer.id),
        frame,
      });
    }

    if (overlapOut > layerStart + animationDuration || overlapIn >= layerStart + animationDuration) {
      const frame = animationFrameCount - 1;
      const key = `${layer.id}:${frame}`;
      if (!lottiePrecacheSeen.has(key)) {
        lottiePrecacheSeen.add(key);
        lottiePrecacheFrames.push({
          ts: layerStart + frame / lottieFps,
          layerId: String(layer.id),
          frame,
        });
      }
    }
  }

  if (canRunHybrid) console.log(`[Render ${jobId}] Hybrid pipeline enabled (Videos:${videoClips.length} Images:${imageClips.length} Graphics:${hasGraphics})`);

  // Raw RGBA pixel stream configuration for FFmpeg!
  let ffmpegArgs = [
    '-y',
    '-f', 'rawvideo',
    '-pix_fmt', 'rgba', // Browser getImageData is RGBA
    '-s', `${width}x${height}`,
    '-framerate', String(fps),
  ];

  if (canRunHybrid) {
    if (hasGraphics) ffmpegArgs.push('-i', '-'); // Input 0: Browser graphics via stdin
    ffmpegArgs.push('-f', 'lavfi', '-i', `color=c=black:s=${width}x${height}:d=${duration.toFixed(6)}:r=${fps}`); // Input 1 (or 0 if !hasGraphics)
    for (const clip of videoClips) {
      const clipIn = Math.max(clip.ts, renderIn);
      const overlapDur = Math.min(clip.ts + clip.dur, renderOut) - clipIn;
      const trimStart = (clip.startT || 0) + Math.max(0, renderIn - clip.ts);
      ffmpegArgs.push('-ss', trimStart.toFixed(6), '-t', overlapDur.toFixed(6), '-i', clip.storedPath);
    }
    for (const clip of imageClips) {
      const clipIn = Math.max(clip.ts, renderIn);
      const overlapDur = Math.min(clip.ts + clip.dur, renderOut) - clipIn;
      ffmpegArgs.push('-loop', '1', '-t', overlapDur.toFixed(6), '-i', clip.storedPath);
    }
    let filterComplex = '';
    let lastV = hasGraphics ? '1:v' : '0:v';
    let currentInputIdx = hasGraphics ? 2 : 1;
    for (let idx = 0; idx < videoClips.length; idx++) {
      const clip = videoClips[idx];
      const relTs = Math.max(0, clip.ts - renderIn);
      const overlapDur = Math.min(clip.ts + clip.dur, renderOut) - Math.max(clip.ts, renderIn);
      const dLabel = `dv${idx}`, oLabel = `ov${idx}`;
      filterComplex += `[${currentInputIdx}:v]scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,setpts=PTS-STARTPTS+${relTs.toFixed(6)}/TB[${dLabel}];[${lastV}][${dLabel}]overlay=0:0:enable='between(t,${relTs.toFixed(6)},${(relTs + overlapDur).toFixed(6)})'[${oLabel}];`;
      lastV = oLabel; currentInputIdx++;
    }
    for (let idx = 0; idx < imageClips.length; idx++) {
      const clip = imageClips[idx];
      const relTs = Math.max(0, clip.ts - renderIn);
      const overlapDur = Math.min(clip.ts + clip.dur, renderOut) - Math.max(clip.ts, renderIn);
      const dLabel = `di${idx}`, oLabel = `oi${idx}`;
      filterComplex += `[${currentInputIdx}:v]scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2[${dLabel}];[${lastV}][${dLabel}]overlay=0:0:enable='between(t,${relTs.toFixed(6)},${(relTs + overlapDur).toFixed(6)})'[${oLabel}];`;
      lastV = oLabel; currentInputIdx++;
    }
    if (hasGraphics) filterComplex += `[${lastV}][0:v]overlay=0:0:enable='gte(t,${(1 / Math.max(1, fps)).toFixed(6)})'[outv]`;
    else filterComplex = filterComplex.replace(/;$/, '');
    
    if (filterComplex) ffmpegArgs.push('-filter_complex', filterComplex, '-map', hasGraphics ? '[outv]' : `[${lastV}]`);
    else ffmpegArgs.push('-map', hasGraphics ? '0:v' : '1:v');
  } else {
    ffmpegArgs.push('-i', '-', '-map', '0:v');
  }

  ffmpegArgs.push('-c:v', encoder);
  if (encoder === 'h264_nvenc') {
    ffmpegArgs.push('-preset', 'p3', '-tune', 'hq', '-rc', 'vbr', '-cq', '18', '-b:v', '0', '-maxrate', '50M', '-bufsize', '100M');
  } else {
    ffmpegArgs.push('-preset', 'veryfast', '-crf', '18', '-threads', '0');
  }
  ffmpegArgs.push('-pix_fmt', 'yuv420p', '-movflags', '+faststart', tempOutputPath);

  const logStream = fs.createWriteStream(logPath, { flags: 'a' });
  const ffmpegProc = spawn(bin, ffmpegArgs);
  ffmpegProc.stdout.pipe(logStream);
  ffmpegProc.stderr.pipe(logStream);

  // Background window for high-performance frame drawing
  const renderWin = new BrowserWindow({
    width,
    height,
    show: false, // Background/invisible window
    paintWhenInitiallyHidden: true,
    transparent: true,
    frame: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      webSecurity: false,
      backgroundThrottling: false,
    }
  });

  const ffmpegPromise = new Promise<void>((resolve, reject) => {
    ffmpegProc.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`FFmpeg exited with code ${code}`));
    });
    ffmpegProc.on('error', reject);
  });

  return new Promise<void>(async (resolve, reject) => {
    activeRenders.set(jobId, {
      ffmpegProc,
      renderWin,
      frameCount,
      currentFrame: 0,
      forceTransparentFirstGraphicsFrame: canRunHybrid && hasGraphics,
      frameCache: new Map(),
      resolvePromise: async () => {
        try {
          renderWin.close();
          await ffmpegPromise;
          
          // Audio mixing and thumbnail generation
          record.progress = 96.00;
          record.statusText = '3단계. 오디오 믹싱 진행 중...';
          await saveJob(record);

          // Extract single thumbnail JPG using FFmpeg
          try {
            console.log(`[Render ${jobId}] Extracting preview thumbnail...`);
            const extractArgs = [
              '-y',
              '-i', tempOutputPath,
              '-ss', String((duration / 2).toFixed(3)),
              '-vframes', '1',
              previewPath
            ];
            execSync(`"${bin}" ${extractArgs.map(arg => `"${arg}"`).join(' ')}`);
          } catch (err) {
            console.error('Failed to extract preview thumbnail:', err);
          }

          // Audio mixing pass
          const audioClips = (record.payload?.clips || []).filter((c: any) => {
            if (c.type === 'image') return false;
            if (!c.storedPath || !fs.existsSync(c.storedPath)) return false;
            return hasAudioStream(c.storedPath);
          });
          const hasAudio = audioClips.length > 0;

          if (hasAudio) {
            console.log(`[Render ${jobId}] Blending audio tracks into video...`);
            const finalPassArgs = ['-y'];
            finalPassArgs.push('-i', tempOutputPath);
            
            for (const c of audioClips) {
              finalPassArgs.push('-i', c.storedPath);
            }

            const aStartIdx = 1;
            let filterComplex = '';
            const amixLabels = [];
            let mixCount = 0;

            for (let idx = 0; idx < audioClips.length; idx++) {
              const clip = audioClips[idx];
              const clipTs = Number(clip.ts || 0);
              const rawDur = Number(clip.dur);
              const clipDur = Number.isFinite(rawDur) && rawDur > 0 ? rawDur : Math.max(0.1, renderOut - clipTs);
              const overlapIn = Math.max(clipTs, renderIn);
              const overlapOut = Math.min(clipTs + clipDur, renderOut);
              const overlapDur = overlapOut - overlapIn;
              
              if (overlapDur <= 0) continue;

              const trimStart = Number(clip.startT || 0) + Math.max(0, renderIn - clipTs);
              const delayMs = Math.max(0, Math.round((clipTs - renderIn) * 1000));
              const label = `aud${idx}`;

              // [FIX] Use adelay=delays=X:all=1 to handle all channel layouts
              // (stereo-only adelay=X|X breaks 5.1ch and multichannel clips).
              // Also add aresample=async=1 to prevent PTS drift accumulation.
              filterComplex += `[${idx + aStartIdx}:a]atrim=start=${trimStart.toFixed(3)}:duration=${overlapDur.toFixed(3)},asetpts=PTS-STARTPTS,adelay=delays=${delayMs}:all=1,aresample=async=1:first_pts=0[${label}];`;
              amixLabels.push(`[${label}]`);
              mixCount++;
            }

            if (mixCount > 0) {
              let audioMixFilter: string;
              if (mixCount === 1) {
                // [FIX] Bypass amix entirely for single track to prevent -3dB attenuation
                audioMixFilter = filterComplex + `${amixLabels[0]}anull[outa]`;
              } else {
                // [FIX] normalize=0 prevents automatic volume reduction based on input count.
                // duration=longest ensures the mix covers the full render range.
                audioMixFilter = filterComplex + `${amixLabels.join('')}amix=inputs=${mixCount}:normalize=0:duration=longest[outa]`;
              }
              finalPassArgs.push('-filter_complex', audioMixFilter);
              finalPassArgs.push('-map', '0:v');
              finalPassArgs.push('-map', '[outa]');
              finalPassArgs.push('-c:v', 'copy');
              finalPassArgs.push('-c:a', 'aac', '-b:a', '192k');
              finalPassArgs.push('-movflags', '+faststart');
              
              const finalPassTemp = path.join(RENDER_DIR, `${jobId}_final.mp4`);
              finalPassArgs.push(finalPassTemp);

              try {
                const finalPass = spawnSync(bin, finalPassArgs, { encoding: 'utf8' });
                if (finalPass.status !== 0) {
                  throw new Error(`${finalPass.stderr || finalPass.stdout || 'FFmpeg audio pass failed'}`);
                }
                if (fs.existsSync(finalPassTemp)) {
                  await moveFile(finalPassTemp, outputPath);
                  await fsp.unlink(tempOutputPath).catch(() => {});
                }
              } catch (err: any) {
                console.error('Audio pass failed:', err);
                throw err;
              }
            } else {
              await moveFile(tempOutputPath, outputPath);
            }
          } else {
            await moveFile(tempOutputPath, outputPath);
          }

          const totalElapsed = ((Date.now() - renderStartedAt) / 1000).toFixed(1);
          const outputSize = fs.existsSync(outputPath) ? fs.statSync(outputPath).size : 0;
          const outputSizeMB = (outputSize / (1024 * 1024)).toFixed(1);

          record.status = 'completed';
          record.progress = 100.00;
          record.statusText = `완료 (${frameCount}프레임, ${totalElapsed}초, ${outputSizeMB}MB)`;
          record.elapsedSeconds = Number(totalElapsed);
          record.outputSizeMB = Number(outputSizeMB);
          record.downloadUrl = `local-file://${outputPath.replace(/\\/g, '/')}`;
          if (fs.existsSync(previewPath)) record.previewUrl = `local-file://${previewPath.replace(/\\/g, '/')}`;
          record.updatedAt = nowIso();
          await saveJob(record);
          activeRenders.delete(jobId);
          resolve();
        } catch (err: any) {
          activeRenders.delete(jobId);
          reject(err);
        }
      },
      rejectPromise: async (err: Error) => {
        try { ffmpegProc.kill(); } catch {}
        try { renderWin.close(); } catch {}
        record.status = 'failed';
        record.progress = -1;
        record.statusText = '렌더링 실패';
        record.error = String(err.message || err);
        record.updatedAt = nowIso();
        await fsp.writeFile(errorPath, record.error, 'utf8').catch(() => {});
        await saveJob(record);
        activeRenders.delete(jobId);
        reject(err);
      }
    });

    try {
      // Load the app render stage in the background window
      const captureGraphicsOnly = canRunHybrid && hasGraphics;
      const url = `http://localhost:${APP_PORT}/?renderJob=${jobId}&renderTs=${encodeURIComponent(renderIn.toFixed(6))}`
        + (captureGraphicsOnly ? '&transparent=1&onlyGraphics=1' : '')
        + (usePageCapture ? '&fullPageCapture=1' : '');
      await renderWin.loadURL(url);

      record.status = 'rendering';
      record.progress = 5.00;
      record.statusText = `1단계. Lottie 자막 템플릿 프리캐싱 중... (0/${lottiePrecacheFrames.length})`;
      await saveJob(record);

      // Wait for precaching to finish (Lottie files, fonts, images loaded)
      // The React app sets data-render-ready="1" on documentElement when ready.
      let waitTime = 0;
      while (waitTime < 15000) {
        try {
          const isReady = await renderWin.webContents.executeJavaScript(`document.documentElement.getAttribute('data-render-ready')`);
          if (isReady === '1') break;
        } catch {}
        await new Promise(r => setTimeout(r, 200));
        waitTime += 200;
      }

      // Step 1: Pre-cache only the actual Lottie animation frames.
      // Hold sections reuse the cached final frame instead of rendering the whole composition range.
      await renderWin.webContents.executeJavaScript(`if (window.isPrecachingRef) { window.isPrecachingRef.current = true; }`);
      for (let i = 0; i < lottiePrecacheFrames.length; i++) {
        const precacheFrame = lottiePrecacheFrames[i];
        try {
          await renderWin.webContents.executeJavaScript(`window.__HM_PRECACHE_FRAME(${precacheFrame.ts})`);
        } catch (precacheErr) {
          console.error(`[Render ${jobId}] Lottie precache ${precacheFrame.layerId}:${precacheFrame.frame} error:`, precacheErr);
        }
        record.progress = Number((5 + ((i + 1) / Math.max(1, lottiePrecacheFrames.length)) * 15).toFixed(2)); // 5% to 20%
        record.statusText = `1단계. Lottie 자막 템플릿 프리캐싱 중... (${i + 1}/${lottiePrecacheFrames.length})`;
        record.updatedAt = nowIso();
        await saveJob(record);
      }
      await renderWin.webContents.executeJavaScript(`if (window.isPrecachingRef) { window.isPrecachingRef.current = false; }`);

      // Step 2: Send start-client-render so App.tsx registers __onElectronFrameReady
      // before the frame loop begins.
      if (!usePageCapture) {
        renderWin.webContents.send('start-client-render', {
          jobId,
          fps,
          totalFrames: frameCount,
        });
      }

      // Start the FFmpeg capture loop
      record.progress = 20.00;
      record.statusText = `2단계. FFmpeg 영상 합성 진행 중... (0/${frameCount})`;
      await saveJob(record);

      let lastSavedAt = 0;
      for (let i = 0; i < frameCount; i++) {
        const ts = renderIn + i / fps;
        const frameKey = graphicsFrameKey(ts, i);
        const session = activeRenders.get(jobId);
        const cachedFrame = session?.frameCache.get(frameKey);
        if (session && cachedFrame && frameKey !== `dynamic:${i}`) {
          await writeRawFrame(session, cachedFrame);
        } else {
          if (session) session.pendingFrameKey = frameKey;
          try {
            await renderWin.webContents.executeJavaScript(
              `window.__HM_SET_RENDER_TIME(${ts})`
            );
            if (usePageCapture && session) {
              await renderWin.webContents.executeJavaScript(`new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))`);
              const capturedFrame = await captureWindowRgba(renderWin, width, height);
              if (frameKey && !frameKey.startsWith('dynamic:') && !session.frameCache.has(frameKey)) {
                session.frameCache.set(frameKey, Buffer.from(capturedFrame));
              }
              await writeRawFrame(session, capturedFrame);
            }
          } catch (frameErr) {
            // executeJavaScript can throw if the window is destroyed mid-render
            console.error(`[Render ${jobId}] Frame ${i} executeJavaScript error:`, frameErr);
            throw frameErr;
          } finally {
            if (session) session.pendingFrameKey = undefined;
          }
        }

        record.currentFrame = i + 1;
        record.progress = Number((20 + ((i + 1) / frameCount) * 75).toFixed(2)); // 20% to 95%
        record.statusText = `2단계. FFmpeg 영상 합성 진행 중... (${i + 1}/${frameCount})`;
        record.updatedAt = nowIso();
        const nowMs = Date.now();
        if (nowMs - lastSavedAt > 1000 || i === frameCount - 1) {
          await saveJob(record);
          lastSavedAt = nowMs;
        }
      }

      // All frames written \u2014 close FFmpeg stdin and finalise.
      ffmpegProc.stdin.end();
      const session = activeRenders.get(jobId);
      if (session) {
        await session.resolvePromise();
      }
    } catch (err: any) {
      const session = activeRenders.get(jobId);
      if (session) {
        await session.rejectPromise(err);
      } else {
        reject(err);
      }
    }
  });
}

async function processRenderQueue() {
  if (renderWorkerRunning) return;
  renderWorkerRunning = true;
  try {
    while (true) {
      const next = Array.from(renderJobs.values())
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
        .find(job => job.status === 'queued');
      if (!next) break;
      try {
        await executeRenderJob(next);
      } catch (err) {
        console.error('Render job failed:', err);
      }
    }
  } finally {
    renderWorkerRunning = false;
  }
}

// Create main window
async function createWindow() {
  const primaryDisplay = screen.getPrimaryDisplay();
  const { width: scrW, height: scrH, x: scrX, y: scrY } = primaryDisplay.workArea;

  const winWidth = 1440;
  const winHeight = 900;
  const winX = scrX + Math.floor((scrW - winWidth) / 2);
  const winY = scrY + Math.floor((scrH - winHeight) / 2);

  mainWindow = new BrowserWindow({
    x: winX,
    y: winY,
    width: winWidth,
    height: winHeight,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      webSecurity: false, // Bypasses CORS for local files
      nodeIntegration: false,
      contextIsolation: true,
    },
  });

  // ?袁ⓥ봺????밸씜 筌???밴쉐 ??뽯선 (??쇱㉦ 筌뤴뫀???????
  mainWindow.webContents.setWindowOpenHandler(({ url, frameName, features }) => {
    if (frameName === 'hmstudio-preview-monitor') {
      const parsedFeatures: Record<string, string> = {};
      features.split(',').forEach(f => {
        const [k, v] = f.split('=');
        if (k && v) parsedFeatures[k] = v;
      });

      const targetX = parseInt(parsedFeatures.left || parsedFeatures.screenX || '0');
      const targetY = parseInt(parsedFeatures.top || parsedFeatures.screenY || '0');
      const targetWidth = parseInt(parsedFeatures.width || '1920');
      const targetHeight = parseInt(parsedFeatures.height || '1080');

      return {
        action: 'allow',
        overrideBrowserWindowOptions: {
          x: targetX,
          y: targetY,
          width: targetWidth,
          height: targetHeight,
          fullscreen: parsedFeatures.fullscreen === 'yes',
          autoHideMenuBar: true,
          webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            webSecurity: false,
            nodeIntegration: false,
            contextIsolation: true,
          }
        }
      };
    }
    return { action: 'allow' };
  });

  // ??諛댁뎽???熬곣뱿遊??嶺뚢돦?⑵굢??熬곣뫖六삣슖?3?貫?껇??????????????μ쪠????Lock)??濾곌쑬梨룟젆?
  // ?熬곣뫁夷?筌뤾쑬???戮곕꺄 ?酉쒓텢?筌먐쇰꼪??moveTo, resizeTo ?筌뤾쑵?????臾먰돵 嶺뚢돦????????熬곣뫕留???????嶺뚢뼰維???紐껊퉵??
  mainWindow.webContents.on('did-create-window', (childWindow, { frameName }) => {
    if (frameName === 'hmstudio-preview-monitor') {
      let allowMoving = false;
      setTimeout(() => {
        allowMoving = true;
      }, 3000);

      childWindow.on('will-move', (event) => {
        if (!allowMoving) {
          event.preventDefault();
        }
      });

      childWindow.on('will-resize', (event) => {
        if (!allowMoving) {
          event.preventDefault();
        }
      });
    }
  });

  // Wait for the backend server to be ready if we are packaged
  if (app.isPackaged) {
    const waitForServer = async () => {
      const start = Date.now();
      while (Date.now() - start < 15000) {
        try {
          const res = await net.fetch(`http://127.0.0.1:${APP_PORT}/api/render-server/status`);
          if (res.ok) return true;
        } catch (e) {}
        await new Promise(r => setTimeout(r, 200));
      }
      return false;
    };
    const ready = await waitForServer();
    if (!ready) console.error('[Main] Express server took too long to start.');
  }

  // Load either local dev server or index file
  if (app.isPackaged) {
    mainWindow.loadURL(`http://127.0.0.1:${APP_PORT}`);
  } else {
    mainWindow.loadURL(`http://localhost:${APP_PORT}`);
  }

  mainWindow.webContents.session.webRequest.onCompleted({ urls: ['*://*/api/login'] }, (details) => {
    if (details.statusCode === 200 && mainWindow) {
      setTimeout(() => {
        if (mainWindow) {
          mainWindow.maximize();
          mainWindow.focus();
        }
      }, 500); // ?洹먮봾留????源녿뮡?????????蹂?뜟???꾩룄????500ms ?????깆쓧???브퀗???
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// IPC Handling (API equivalents)
ipcMain.handle('api-request', async (event, { url, init }) => {
  const cleanUrl = url.replace(/^\/api/, '');
  const method = init?.method?.toUpperCase() || 'GET';
  const body = init?.body ? (typeof init.body === 'string' ? JSON.parse(init.body) : init.body) : null;

  console.log(`[IPC Request] Method: ${method}, URL: ${cleanUrl}`);

  try {
    if (cleanUrl === '/templates') {
      if (!fs.existsSync(EXTERNAL_TEMPLATE_DIR)) return [];
      const files = await fsp.readdir(EXTERNAL_TEMPLATE_DIR);
      const jsonFiles = files.filter(f => f.toLowerCase().endsWith('.json'));
      return jsonFiles.map(file => ({
        name: file.replace(/\.json$/i, ''),
        path: `/external-templates/${file}`
      }));
    }

    if (cleanUrl === '/render-server/status') {
      return {
        ok: true,
        renderer: 'electron-native',
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
      };
    }

    if (cleanUrl === '/system-status') {
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
      const isFound = !!bin && (hasSystemFfmpeg || (bin ? (bin.includes('.runtime') || bin.includes('.hmstudio_runtime')) : false));

      return {
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
          found: true, // Inside Electron, Chromium is always found and built-in!
          hasSystem: true,
          isLocal: false
        },
        platform: process.platform,
        arch: process.arch
      };
    }

    if (cleanUrl === '/system/browse-folder') {
      const result = await dialog.showOpenDialog(mainWindow!, {
        properties: ['openDirectory'],
        title: '?????춯?삳궚?????繞③뇡?????臾딅ご???ルㅎ臾??琉얠돪??'
      });
      if (result.canceled) return { ok: false, message: 'Canceled' };
      return { ok: true, path: result.filePaths[0] };
    }

    if (cleanUrl === '/system/install-ffmpeg') {
      const targetDir = path.join(os.homedir(), '.hmstudio_runtime', 'ffmpeg');
      if (!fs.existsSync(targetDir)) fs.mkdirSync(targetDir, { recursive: true });
      const exe = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
      const destination = path.join(targetDir, exe);
      if (ffmpegStaticPath) {
        let actualSource = ffmpegStaticPath;
        if (actualSource.includes('app.asar') && !actualSource.includes('app.asar.unpacked')) {
          actualSource = actualSource.replace('app.asar', 'app.asar.unpacked');
        }
        fs.copyFileSync(actualSource, destination);
        if (process.platform !== 'win32') fs.chmodSync(destination, 0o755);
      }
      return { ok: true, path: destination };
    }

    if (cleanUrl === '/system/install-chrome') {
      // Built-in chromium inside Electron bypasses Chrome installations completely!
      return { ok: true, path: 'built-in' };
    }

    if (cleanUrl === '/login') {
      const { userId, password } = body;
      const endpoints = [
        'http://erp.hanmaceng.co.kr/intranet/sys/popup/login_ok.php',
        'http://erp.samaneng.com/intranet/sys/popup/login_ok.php',
        'http://erp.jangheon.co.kr/intranet/sys/popup/login_ok.php',
        'http://erp.pre-cast.co.kr/intranet/sys/popup/login_ok.php',
        'http://intranet.hallasanup.com/intranet/sys/popup/login_ok.php',
        'http://erp.baroncs.co.kr/intranet/sys/popup/login_ok.php',
      ];
      
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
          return { success: text.trim() === '1' };
        } catch {
          return { success: false };
        }
      }));

      const successful = results.find(r => r.success);
      if (successful && mainWindow) {
        setTimeout(() => {
          if (mainWindow) {
            mainWindow.maximize();
            mainWindow.focus();
          }
        }, 800);
      }
      return { success: !!successful, message: successful ? undefined : '사번 또는 비밀번호가 일치하지 않습니다.' };
    }

    if (cleanUrl === '/render-jobs') {
      const jobs = Array.from(renderJobs.values()).map(job => {
        refreshJobFromDisk(job);
        return job;
      }).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      await Promise.all(jobs.map(saveJob));
      return { jobs };
    }

    if (cleanUrl === '/render-jobs/clear') {
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
      return { ok: true };
    }

    if (cleanUrl === '/render-jobs/delete') {
      const { id } = body || {};
      if (id && renderJobs.has(id)) {
        const active = activeRenders.get(id);
        if (active) {
          await active.rejectPromise(new Error('cancelled'));
        }
        renderJobs.delete(id);
        const jobFile = path.join(JOB_DIR, `${id}.json`);
        if (fs.existsSync(jobFile)) {
          try { fs.unlinkSync(jobFile); } catch {}
        }
      }
      return { ok: true };
    }

    if (cleanUrl === '/file-exists') {
      const targetPath = typeof body?.path === 'string' ? body.path : '';
      return { exists: !!targetPath && fs.existsSync(targetPath) };
    }

    if (cleanUrl === '/render-jobs/start') {
      const id = crypto.randomBytes(8).toString('hex');
      const safeProjectName = safeName(String(body?.projectName || `render_${id}`)).replace(/\.[^.]+$/, '') + '.mp4';
      const record: RenderJobRecord = {
        id,
        status: 'queued',
        progress: 0,
        createdAt: nowIso(),
        updatedAt: nowIso(),
        payload: {
          ...body,
          output: {
            ...(body.output || {}),
            fileName: safeProjectName,
            outputPath: body.output?.outputPath || path.join(RENDER_DIR, safeProjectName),
            previewPath: body.output?.previewPath || path.join(PREVIEW_DIR, `${id}.jpg`),
            logPath: body.output?.logPath || path.join(LOG_DIR, `${id}.log.txt`),
            errorPath: body.output?.errorPath || path.join(LOG_DIR, `${id}.error.txt`),
          },
        },
      };
      renderJobs.set(id, record);
      await saveJob(record);
      void processRenderQueue();
      return record;
    }

    // Direct job lookup handler
    if (cleanUrl.startsWith('/render-jobs/')) {
      const jobId = cleanUrl.replace(/^\/render-jobs\//, '');
      const job = renderJobs.get(jobId);
      if (!job) return { error: 'Job not found' };
      refreshJobFromDisk(job);
      await saveJob(job);
      return job;
    }

    throw new Error(`Unsupported IPC API endpoint: ${cleanUrl}`);
  } catch (err: any) {
    console.error(`[IPC Error] endpoint: ${cleanUrl}`, err);
    return { error: err.message || 'Unknown IPC processing error' };
  }
});

// Media Import file picker handler
ipcMain.handle('open-media-dialog', async () => {
  const result = await dialog.showOpenDialog(mainWindow!, {
    properties: ['openFile', 'multiSelections'],
    title: '亦껋꼶梨띌?????逾????됯껀?? ???논꺏?? ????嶺뚯솘?)????ルㅎ臾??琉얠돪??',
    filters: [
      { name: 'Media Files', extensions: ['mp4', 'mov', 'webm', 'avi', 'mkv', 'mp3', 'wav', 'm4a', 'aac', 'ogg', 'png', 'jpg', 'jpeg', 'webp', 'gif'] }
    ]
  });

  if (result.canceled) return [];

  return result.filePaths.map(filePath => {
    const stat = fs.statSync(filePath);
    const ext = path.extname(filePath).toLowerCase();
    let type = 'video/mp4';
    if (['.mp3', '.wav', '.m4a', '.aac', '.ogg'].includes(ext)) {
      type = 'audio/mpeg';
    } else if (['.png', '.jpg', '.jpeg', '.webp', '.gif'].includes(ext)) {
      type = 'image/png';
    }
    return {
      name: path.basename(filePath),
      size: stat.size,
      type: type,
      path: filePath
    };
  });
});

// IPC handler to write raw frames into FFmpeg stdin
ipcMain.handle('frame-captured', async (event, { jobId, frame, width, height, buffer }) => {
  const session = activeRenders.get(jobId);
  if (!session) return { ok: false, error: 'Render session inactive' };

  // Write raw RGBA bytes into FFmpeg stdin with backpressure.
  // ipcMain.handle returning { ok: true } is what resolves the renderer's
  // ipcRenderer.invoke('frame-captured') call, which in turn allows
  // __HM_SET_RENDER_TIME's Promise to resolve, which unblocks main.ts's
  // await executeJavaScript(...) for that frame. Serial, no deadlock.
  let nodeBuffer = Buffer.from(buffer);
  if (session.forceTransparentFirstGraphicsFrame && Number(frame || 0) === 0) {
    nodeBuffer = Buffer.alloc(Math.max(1, Number(width || 0)) * Math.max(1, Number(height || 0)) * 4);
  }
  const frameKey = session.pendingFrameKey;
  if (frameKey && !frameKey.startsWith('dynamic:') && !session.frameCache.has(frameKey)) {
    session.frameCache.set(frameKey, Buffer.from(nodeBuffer));
  }
  await writeRawFrame(session, nodeBuffer);

  return { ok: true };
});

// Register custom protocol handler for local files
app.whenReady().then(() => {
  protocol.handle('local-file', (request) => {
    let filePath = decodeURIComponent(request.url.replace('local-file://', ''));
    if (process.platform === 'win32' && filePath.startsWith('/')) {
      filePath = filePath.slice(1);
    }
    return net.fetch('file:///' + filePath);
  });

  startBackendServer();
  createWindow();

  ipcMain.on('login-success', () => {
    if (mainWindow) {
      setTimeout(() => {
        if (mainWindow) {
          mainWindow.maximize();
          mainWindow.focus();
        }
      }, 500); // ?洹먮봾留????瑜곷턄嶺뚯솘? ?β돦裕녻キ?????빼???熬곥굥??500ms ????????蹂λ퉵??
    }
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
