const { spawn } = require('child_process');

console.log('\x1b[36m%s\x1b[0m', '🚀 Starting HMStudio Electron Development Environment...');

// 1. Start the Vite development server (port 3001)
const isWin = process.platform === 'win32';
const npmCmd = isWin ? 'npm.cmd' : 'npm';

const viteProcess = spawn(npmCmd, ['run', 'dev'], {
  stdio: ['pipe', 'pipe', 'inherit'],
  shell: true
});

let electronStarted = false;

// 2. Read Vite's stdout to detect when the local server is ready
viteProcess.stdout.on('data', (data) => {
  const output = data.toString();
  process.stdout.write(output);

  // Once Vite is ready (usually prints the port or ready notice), start Electron
  if (!electronStarted && (output.includes('3001') || output.includes('localhost') || output.includes('ready in'))) {
    electronStarted = true;
    console.log('\n\x1b[32m%s\x1b[0m', '⚡ Vite Server is ready! Launching Electron app window...\n');

    const electronProcess = spawn(npmCmd, ['run', 'electron:dev'], {
      stdio: 'inherit',
      shell: true
    });

    // Handle Electron exit
    electronProcess.on('exit', (code) => {
      console.log(`\n\x1b[33m%s\x1b[0m`, `🛑 Electron window closed (exit code ${code}). Cleaning up servers...`);
      viteProcess.kill();
      process.exit(code || 0);
    });
  }
});

// Handle termination signals to cleanly exit both processes
const cleanup = () => {
  console.log('\n\x1b[31m%s\x1b[0m', '👋 Terminating background dev servers...');
  try { viteProcess.kill(); } catch (e) {}
  process.exit(0);
};

process.on('SIGINT', cleanup);
process.on('SIGTERM', cleanup);
process.on('exit', cleanup);
