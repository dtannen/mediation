export interface IpcError {
  code: string;
  message: string;
  recoverable: boolean;
  status?: number;
  details?: Record<string, unknown>;
}

export type IpcResult<T extends Record<string, unknown> = Record<string, never>> =
  | ({ ok: true } & T)
  | { ok: false; error: IpcError };

export function toIpcError(err: unknown, fallbackCode = 'unknown'): IpcError {
  if (err && typeof err === 'object') {
    const asRecord = err as Record<string, unknown>;
    const code = typeof asRecord.code === 'string' && asRecord.code.trim()
      ? asRecord.code.trim()
      : fallbackCode;
    const message = typeof asRecord.message === 'string' && asRecord.message.trim()
      ? asRecord.message
      : String(err);
    const recoverable = asRecord.recoverable === false ? false : true;
    const result: IpcError = { code, message, recoverable };
    if (typeof asRecord.status === 'number' && Number.isFinite(asRecord.status)) {
      result.status = asRecord.status;
    }
    if (asRecord.details && typeof asRecord.details === 'object') {
      result.details = asRecord.details as Record<string, unknown>;
    }
    return result;
  }

  if (typeof err === 'string') {
    return {
      code: fallbackCode,
      message: err,
      recoverable: true,
    };
  }

  return {
    code: fallbackCode,
    message: err instanceof Error ? err.message : String(err),
    recoverable: true,
  };
}

export function normalizeIpcError(err: unknown): IpcError {
  return toIpcError(err, 'unknown');
}
