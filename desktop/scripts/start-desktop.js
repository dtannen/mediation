const { spawn } = require('node:child_process');
const electronBinary = require('electron');

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

const child = spawn(electronBinary, ['dist-desktop/desktop/main.js'], {
  stdio: 'inherit',
  env,
});

let signalForwarded = false;

function forwardSignal(signal) {
  if (child.exitCode != null || child.signalCode != null) {
    return;
  }

  if (!signalForwarded) {
    signalForwarded = true;
    try {
      child.kill(signal);
    } catch {
      // best-effort
    }

    const forceKillTimer = setTimeout(() => {
      if (child.exitCode == null && child.signalCode == null) {
        try {
          child.kill('SIGKILL');
        } catch {
          // best-effort
        }
      }
    }, 5_000);
    if (typeof forceKillTimer.unref === 'function') {
      forceKillTimer.unref();
    }
    return;
  }

  try {
    child.kill('SIGKILL');
  } catch {
    // best-effort
  }
}

process.on('SIGINT', () => {
  forwardSignal('SIGINT');
});

process.on('SIGTERM', () => {
  forwardSignal('SIGTERM');
});

child.on('exit', (code, signal) => {
  if (signal) {
    if (signal === 'SIGINT') {
      process.exitCode = 130;
      return;
    }
    if (signal === 'SIGTERM') {
      process.exitCode = 143;
      return;
    }
    process.exitCode = 1;
    return;
  }

  process.exitCode = typeof code === 'number' ? code : 0;
});

child.on('error', (err) => {
  process.stderr.write(`[start-desktop] failed to launch Electron: ${err.message}\n`);
  process.exitCode = 1;
});
