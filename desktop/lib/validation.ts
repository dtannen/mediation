import path from 'node:path';

export const PROFILE_ID_RE = /^[a-zA-Z0-9_-]{1,128}$/;
export const PROFILE_DEVICE_ID_RE = /^dev_[a-f0-9]{32}$/;
export const SAFE_URL_SCHEMES = new Set(['https:', 'http:', 'mailto:']);
export const SHARE_TOKEN_RE = /^[A-Za-z0-9_-]{16,512}$/;

export function parseIsoDateOrNull(value: unknown): string | null {
  if (typeof value !== 'string' || value.trim() === '') {
    return null;
  }
  const date = new Date(value.trim());
  if (Number.isNaN(date.getTime())) {
    return null;
  }
  return date.toISOString();
}

export function isPathWithin(baseDir: string, targetPath: string): boolean {
  const base = path.resolve(baseDir);
  const target = path.resolve(targetPath);
  const rel = path.relative(base, target);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

export function isAllowedUrl(url: string): boolean {
  if (typeof url !== 'string' || url.trim() === '') {
    return false;
  }
  try {
    const parsed = new URL(url);
    return SAFE_URL_SCHEMES.has(parsed.protocol);
  } catch {
    return false;
  }
}

const BLOCKED_PATH_ROOTS = new Set(
  process.platform === 'win32'
    ? ['C:\\Windows', 'C:\\Program Files', 'C:\\Program Files (x86)']
    : ['/', '/etc', '/usr', '/bin', '/sbin', '/lib', '/var', '/System', '/Library'],
);

export function isSafeUserPath(absPath: string): boolean {
  const resolved = path.resolve(absPath);
  const lower = resolved.toLowerCase();
  for (const blocked of BLOCKED_PATH_ROOTS) {
    const blockedLower = blocked.toLowerCase();
    if (lower === blockedLower || lower.startsWith(blockedLower + path.sep)) {
      return false;
    }
  }
  return true;
}
