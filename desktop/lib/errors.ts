export interface GatewayNormalizedError {
  code: string;
  message: string;
  recoverable: boolean;
  status?: number;
  details?: Record<string, unknown>;
}

export function normalizeGatewaySendError(err: unknown): GatewayNormalizedError {
  const asRecord = err && typeof err === 'object' ? err as Record<string, unknown> : null;
  const status = asRecord && typeof asRecord.status === 'number' ? asRecord.status : undefined;
  const details = asRecord && asRecord.details && typeof asRecord.details === 'object'
    ? asRecord.details as Record<string, unknown>
    : undefined;

  const code = asRecord && typeof asRecord.code === 'string' && asRecord.code.trim()
    ? asRecord.code.trim()
    : (status ? `http_${status}` : 'send_failed');

  const message = err instanceof Error
    ? err.message
    : (typeof asRecord?.message === 'string' ? asRecord.message : String(err));

  return {
    code,
    message: message || 'failed to send message',
    recoverable: true,
    ...(status ? { status } : {}),
    ...(details ? { details } : {}),
  };
}

export function invalidProfileIdErrorResponse(): { ok: false; error: { code: string; field: string; message: string } } {
  return {
    ok: false,
    error: {
      code: 'invalid_profile_id',
      field: 'profileId',
      message: 'profileId is invalid',
    },
  };
}
