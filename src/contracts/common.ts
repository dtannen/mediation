/* ============================================================
   V2 Standard IPC Envelope (Spec Section 7.0)
   ============================================================ */

export interface IpcError {
  code: string;
  message: string;
  details?: Record<string, unknown>;
}

export interface IpcSuccessResponse<T = Record<string, unknown>> {
  success: true;
  data: T;
}

export interface IpcErrorResponse {
  success: false;
  error: IpcError;
}

export type IpcResponse<T = Record<string, unknown>> = IpcSuccessResponse<T> | IpcErrorResponse;

/** @deprecated Use IpcResponse instead — kept for backward compat during migration */
export type IpcResult<T extends Record<string, unknown> = Record<string, never>> =
  | ({ ok: true } & T)
  | { ok: false; error: IpcError };

export function toIpcError(err: unknown, fallbackCode = 'internal_error'): IpcError {
  if (err && typeof err === 'object') {
    const asRecord = err as Record<string, unknown>;
    const code = typeof asRecord.code === 'string' && asRecord.code.trim()
      ? asRecord.code.trim()
      : fallbackCode;
    const message = typeof asRecord.message === 'string' && asRecord.message.trim()
      ? asRecord.message
      : String(err);
    const result: IpcError = { code, message };
    if (asRecord.details && typeof asRecord.details === 'object') {
      result.details = asRecord.details as Record<string, unknown>;
    }
    return result;
  }

  if (typeof err === 'string') {
    return {
      code: fallbackCode,
      message: err,
    };
  }

  return {
    code: fallbackCode,
    message: err instanceof Error ? err.message : String(err),
  };
}

export function normalizeIpcError(err: unknown): IpcError {
  return toIpcError(err, 'internal_error');
}

/** Standard success wrapper matching Section 7.0 */
export function ipcSuccess<T>(data: T): IpcSuccessResponse<T> {
  return { success: true, data };
}

/** Standard error wrapper matching Section 7.0 */
export function ipcError(err: unknown): IpcErrorResponse {
  return { success: false, error: toIpcError(err) };
}
