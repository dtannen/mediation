const { spawn } = require('node:child_process');
const electronBinary = require('electron');

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
if (typeof process.execPath === 'string' && process.execPath.trim()) {
  env.MEDIATION_NODE_PATH = process.execPath.trim();
}

const passthroughArgs = [];
let profileFromArg = '';
const rawArgs = process.argv.slice(2);

for (let i = 0; i < rawArgs.length; i += 1) {
  const value = rawArgs[i];
  if (value.startsWith('--mediation-profile=')) {
    profileFromArg = value.slice('--mediation-profile='.length).trim();
    continue;
  }
  if (value.startsWith('--profile=')) {
    profileFromArg = value.slice('--profile='.length).trim();
    continue;
  }
  if ((value === '--mediation-profile' || value === '--profile') && i + 1 < rawArgs.length) {
    profileFromArg = String(rawArgs[i + 1] || '').trim();
    i += 1;
    continue;
  }
  passthroughArgs.push(value);
}

if (profileFromArg && !env.MEDIATION_PROFILE) {
  env.MEDIATION_PROFILE = profileFromArg;
}

const child = spawn(electronBinary, ['dist-desktop/desktop/main.js', ...passthroughArgs], {
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
