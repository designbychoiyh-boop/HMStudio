import { app, BrowserWindow, ipcMain, dialog, protocol, net, screen } from 'electron';
import path from 'path';
import fs from 'fs';
import fsp from 'fs/promises';
import { spawn, execSync, exec, fork } from 'child_process';
import os from 'os';
import crypto from 'crypto';
import ffmpegStaticPath from 'ffmpeg-static';

// Define directories in Main Process
const ROOT = (app && app.isPackaged) ? path.dirname(process.execPath) : process.cwd();
const APP_PORT = 3001; // Port used for Vite development server (fallback)
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
  resolvePromise: () => void;
  rejectPromise: (err: Error) => void;
};
const activeRenders = new Map<string, ActiveRenderSession>();

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

  if (fs.existsSync(mp4)) {
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
    let out = '';
    try {
      execSync(`"${bin}" -i "${filePath}"`, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e: any) {
      out = (e.stderr || '').toString() + (e.stdout || '').toString();
    }
    return out.toLowerCase().includes('audio:');
  } catch (e) {
    return false;
  }
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
  record.statusText = `?뚮뜑 ?붿쭊 以鍮?以?.. (${frameCount}?꾨젅??`;
  record.totalFrames = frameCount;
  record.currentFrame = 0;
  record.updatedAt = nowIso();
  await saveJob(record);

  const bin = ffmpegBin();
  if (!bin) {
    throw new Error('FFmpeg ?ㅽ뻾 ?뚯씪??李얠쓣 ???놁뒿?덈떎.');
  }

  let encoder = 'hevc_nvenc';
  try {
    const encoders = execSync(`"${bin}" -encoders`, { encoding: 'utf8' });
    if (!encoders.includes('hevc_nvenc')) {
      encoder = 'libx264';
    }
  } catch (e) {
    encoder = 'libx264';
  }

  // Raw RGBA pixel stream configuration for FFmpeg!
  const ffmpegArgs = [
    '-y',
    '-f', 'rawvideo',
    '-pix_fmt', 'rgba', // Browser getImageData is RGBA
    '-s', `${width}x${height}`,
    '-framerate', String(fps),
    '-i', '-', // Standard input pipe
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

  // Background window for high-performance frame drawing
  const renderWin = new BrowserWindow({
    width,
    height,
    show: false, // Background/invisible window
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      webSecurity: false,
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
      resolvePromise: async () => {
        try {
          renderWin.close();
          await ffmpegPromise;
          
          // Audio mixing and thumbnail generation
          record.progress = 96.00;
          record.statusText = '?몄퐫???꾨즺, ?ㅻ뵒???⑹꽦 以?..';
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
              const overlapIn = Math.max(clip.ts, renderIn);
              const overlapOut = Math.min(clip.ts + clip.dur, renderOut);
              const overlapDur = overlapOut - overlapIn;
              
              if (overlapDur <= 0) continue;

              const trimStart = (clip.startT || 0) + Math.max(0, renderIn - clip.ts);
              const delayMs = Math.max(0, Math.round((clip.ts - renderIn) * 1000));
              const label = `aud${idx}`;
              
              filterComplex += `[${idx + aStartIdx}:a]atrim=start=${trimStart.toFixed(3)}:duration=${overlapDur.toFixed(3)},asetpts=PTS-STARTPTS,adelay=${delayMs}|${delayMs}[${label}];`;
              amixLabels.push(`[${label}]`);
              mixCount++;
            }

            if (mixCount > 0) {
              filterComplex += `${amixLabels.join('')}amix=inputs=${mixCount}[outa]`;
              finalPassArgs.push('-filter_complex', filterComplex);
              finalPassArgs.push('-map', '0:v');
              finalPassArgs.push('-map', '[outa]');
              finalPassArgs.push('-c:v', 'copy');
              finalPassArgs.push('-c:a', 'aac', '-b:a', '192k');
              
              const finalPassTemp = path.join(RENDER_DIR, `${jobId}_final.mp4`);
              finalPassArgs.push(finalPassTemp);

              try {
                execSync(`"${bin}" ${finalPassArgs.map(arg => `"${arg}"`).join(' ')}`);
                if (fs.existsSync(finalPassTemp)) {
                  await moveFile(finalPassTemp, outputPath);
                  await fsp.unlink(tempOutputPath).catch(() => {});
                }
              } catch (err: any) {
                console.warn('Audio pass failed, falling back to silent video:', err);
                await moveFile(tempOutputPath, outputPath);
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
          record.statusText = `?꾨즺 (${frameCount}?꾨젅?? ${totalElapsed}珥? ${outputSizeMB}MB)`;
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
        record.statusText = '?ㅽ뙣';
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
      // Note: we can use either the active running dev server or direct file path.
      const url = `http://localhost:${APP_PORT}/?renderJob=${jobId}&renderTs=${encodeURIComponent(renderIn.toFixed(6))}`;
      await renderWin.loadURL(url);

      record.status = 'rendering';
      record.progress = 10.00;
      record.statusText = `?꾨젅??罹≪쿂 ?쒖옉... (0/${frameCount})`;
      await saveJob(record);

      // Main frame orchestration loop!
      for (let i = 0; i < frameCount; i++) {
        const ts = renderIn + i / fps;
        
        // Execute frame shift in the background browser window
        // This blocks until the React renderer successfully captures pixels and sends them via IPC!
        await renderWin.webContents.executeJavaScript(`window.__HM_SET_RENDER_TIME(${ts})`);

        // Update main process job state
        record.currentFrame = i + 1;
        record.progress = Number((10 + ((i + 1) / frameCount) * 85).toFixed(2));
        record.statusText = `?꾨젅??罹≪쿂 以?(${i + 1}/${frameCount})`;
        record.updatedAt = nowIso();
        await saveJob(record);
      }

      // Close write stream and signal completion
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

  // ?꾨━酉??앹뾽 李??앹꽦 ?쒖뼱 (?ㅼ쨷 紐⑤땲?????
  mainWindow.webContents.setWindowOpenHandler(({ url, frameName }) => {
    if (frameName === 'hmstudio-preview-monitor') {
      const displays = screen.getAllDisplays();
      const mainBounds = mainWindow ? mainWindow.getBounds() : { x: winX, y: winY, width: winWidth, height: winHeight };
      const mainDisplay = screen.getDisplayMatching(mainBounds);
      const externalDisplay = displays.find(d => d.id !== mainDisplay.id);
      // 硫붿씤 ?덈룄?곌? 媛 ?덈뒗 紐⑤땲?곌? ?꾨땶 ?ㅻⅨ ?붿뒪?뚮젅??寃??      const externalDisplay = displays.find(d => d.id !== mainDisplay.id);

      let targetBounds;
      if (externalDisplay) {
        // 蹂댁“ 紐⑤땲?곌? 議댁옱?섎㈃ ?대떦 紐⑤땲???꾩껜 ?곸뿭??留욎떠 ??ㅽ겕由곗쑝濡??ㅽ뻾
        targetBounds = {
          x: externalDisplay.bounds.x,
          y: externalDisplay.bounds.y,
          width: externalDisplay.bounds.width,
          height: externalDisplay.bounds.height,
        };
      } else {
        // ?깃? 紐⑤땲?곗씪 寃쎌슦 二?紐⑤땲???곗륫 ?덈컲??諛곗튂
        targetBounds = {
          x: scrX + Math.floor(scrW / 2),
          y: scrY,
          width: Math.floor(scrW / 2),
          height: scrH,
        };
      }

      return {
        action: 'allow',
        overrideBrowserWindowOptions: {
          x: targetBounds.x,
          y: targetBounds.y,
          width: targetBounds.width,
          height: targetBounds.height,
          fullscreen: !!externalDisplay, // 蹂댁“ 紐⑤땲?곌? ?덉쓣 ?뚮쭔 ?꾩껜 ?붾㈃
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

  // ?앹꽦???꾨━酉?李쎌뿉 ?꾩떆濡?3珥덇컙 ?대룞 諛??ш린 怨좎젙 ??Lock)??嫄몄뼱
  // ?꾨줎?몄뿏?쒖쓽 遺?뺥솗??moveTo, resizeTo ?몄텧???섑빐 李쎌씠 ????꾩긽???먯쿇 李⑤떒?⑸땲??
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
      }, 500); // 由ъ븸???쇱슦???대룞 ?쒓컙??諛곕젮??500ms ???덉쟾??議곗옉
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
        title: '?뚮뜑留곸쓣 ??ν븷 ?대뜑瑜??좏깮?섏꽭??'
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
      return { success: !!successful, message: successful ? undefined : '?ъ썝踰덊샇 ?먮뒗 鍮꾨?踰덊샇媛 ?щ컮瑜댁? ?딆뒿?덈떎.' };
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
    title: '誘몃뵒???뚯씪(?숈쁺?? ?ㅻ뵒?? ?대?吏)???좏깮?섏꽭??',
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
ipcMain.handle('frame-captured', async (event, { jobId, width, height, buffer }) => {
  const session = activeRenders.get(jobId);
  if (!session) return { ok: false, error: 'Render session inactive' };

  return new Promise<void>((resolve, reject) => {
    const nodeBuffer = Buffer.from(buffer);
    
    // Direct backpressure handling
    if (!session.ffmpegProc.stdin.write(nodeBuffer)) {
      session.ffmpegProc.stdin.once('drain', () => {
        resolve();
      });
    } else {
      resolve();
    }
  });
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
      }, 500); // 由ъ븸???섏씠吏 濡쒕뱶 ?덉갑???꾪빐 500ms ?ъ쑀瑜??〓땲??
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
