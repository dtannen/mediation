export type MediationCommandName =
  | 'case.list'
  | 'case.get'
  | 'case.join'
  | 'case.append_private'
  | 'case.set_consent'
  | 'case.set_private_summary'
  | 'case.set_ready'
  | 'case.send_group'
  | 'case.create_draft'
  | 'case.append_draft'
  | 'case.run_draft_suggestion'
  | 'case.submit_suggestion'
  | 'case.approve_draft'
  | 'case.reject_draft'
  | 'case.resolve'
  | 'case.close';

export interface GatewayAuthContext {
  requesterUid: string;
  requesterDeviceId: string;
  grantId: string;
  role: 'owner' | 'collaborator';
  grantStatus: 'active' | 'revoked';
}

export interface MediationCommandEnvelope {
  type: 'mediation.command';
  schema_version: 1;
  request_id: string;
  command: MediationCommandName;
  case_id?: string;
  party_id?: string;
  payload: Record<string, unknown>;
}

export interface NormalizedError {
  code: string;
  message: string;
  recoverable: boolean;
}

export interface MediationResultEnvelope {
  type: 'mediation.result';
  schema_version: 1;
  request_id: string;
  ok: true;
  case?: Record<string, unknown>;
  cases?: Record<string, unknown>[];
  draft_id?: string;
  suggestion?: Record<string, unknown>;
  remote_version?: number;
  replayed?: boolean;
}

export interface MediationErrorEnvelope {
  type: 'mediation.result';
  schema_version: 1;
  request_id: string;
  ok: false;
  error: NormalizedError;
}

export type MediationResult = MediationResultEnvelope | MediationErrorEnvelope;

export interface MediationEventEnvelope {
  type: 'mediation.event';
  schema_version: 1;
  event: 'case.updated' | 'party.disconnected' | 'access.revoked' | 'access.left' | 'case.removed';
  case_id?: string;
  party_id?: string;
  reason?: string;
  case?: Record<string, unknown>;
  remote_version?: number;
}

type CommandRequirement = {
  requiresCaseId: boolean;
  requiresPartyId: boolean;
  mutating: boolean;
};

export const COMMAND_REQUIREMENTS: Record<MediationCommandName, CommandRequirement> = {
  'case.list': { requiresCaseId: false, requiresPartyId: false, mutating: false },
  'case.get': { requiresCaseId: true, requiresPartyId: false, mutating: false },
  'case.join': { requiresCaseId: true, requiresPartyId: true, mutating: true },
  'case.append_private': { requiresCaseId: true, requiresPartyId: true, mutating: true },
  'case.set_consent': { requiresCaseId: true, requiresPartyId: true, mutating: true },
  'case.set_private_summary': { requiresCaseId: true, requiresPartyId: true, mutating: true },
  'case.set_ready': { requiresCaseId: true, requiresPartyId: true, mutating: true },
  'case.send_group': { requiresCaseId: true, requiresPartyId: true, mutating: true },
  'case.create_draft': { requiresCaseId: true, requiresPartyId: true, mutating: true },
  'case.append_draft': { requiresCaseId: true, requiresPartyId: true, mutating: true },
  'case.run_draft_suggestion': { requiresCaseId: true, requiresPartyId: true, mutating: true },
  'case.submit_suggestion': { requiresCaseId: true, requiresPartyId: true, mutating: true },
  'case.approve_draft': { requiresCaseId: true, requiresPartyId: true, mutating: true },
  'case.reject_draft': { requiresCaseId: true, requiresPartyId: true, mutating: true },
  'case.resolve': { requiresCaseId: true, requiresPartyId: true, mutating: true },
  'case.close': { requiresCaseId: true, requiresPartyId: true, mutating: true },
};

function normalizedString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function makeError(code: string, message: string, recoverable = false): MediationErrorEnvelope {
  return {
    type: 'mediation.result',
    schema_version: 1,
    request_id: '',
    ok: false,
    error: { code, message, recoverable },
  };
}

function hasDisallowedIdentityField(payload: Record<string, unknown>): boolean {
  const forbidden = [
    'actor_uid',
    'actor_device_id',
    'grant_id',
    'actorUid',
    'actorDeviceId',
    'grantId',
  ];
  return forbidden.some((field) => Object.prototype.hasOwnProperty.call(payload, field));
}

function knownCommand(value: unknown): value is MediationCommandName {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(COMMAND_REQUIREMENTS, value);
}

export function validateAndNormalizeCommand(raw: unknown): {
  ok: true;
  envelope: MediationCommandEnvelope;
} | {
  ok: false;
  error: MediationErrorEnvelope;
} {
  if (!raw || typeof raw !== 'object') {
    return { ok: false, error: makeError('invalid_payload', 'command envelope must be an object') };
  }

  const record = raw as Record<string, unknown>;
  if (record.type !== 'mediation.command') {
    return { ok: false, error: makeError('invalid_payload', 'type must be mediation.command') };
  }
  if (record.schema_version !== 1) {
    return { ok: false, error: makeError('invalid_payload', 'schema_version must be 1') };
  }

  const requestId = normalizedString(record.request_id);
  if (!requestId) {
    return { ok: false, error: makeError('invalid_payload', 'request_id is required') };
  }

  if (!knownCommand(record.command)) {
    return { ok: false, error: makeError('invalid_payload', 'unknown command') };
  }

  const command = record.command;
  const req = COMMAND_REQUIREMENTS[command];
  const caseId = normalizedString(record.case_id);
  const partyId = normalizedString(record.party_id);
  const payload = (record.payload && typeof record.payload === 'object')
    ? (record.payload as Record<string, unknown>)
    : {};

  if (Object.prototype.hasOwnProperty.call(payload, 'party_id')) {
    const err = makeError('invalid_payload', 'party_id must be provided at envelope level');
    err.request_id = requestId;
    return { ok: false, error: err };
  }
  if (hasDisallowedIdentityField(payload)) {
    const err = makeError('invalid_payload', 'payload contains disallowed identity fields');
    err.request_id = requestId;
    return { ok: false, error: err };
  }

  if (req.requiresCaseId && !caseId) {
    const err = makeError('missing_case_id', 'case_id is required for this command');
    err.request_id = requestId;
    return { ok: false, error: err };
  }

  if (req.requiresPartyId && !partyId) {
    const err = makeError('missing_party_id', 'party_id is required for this command');
    err.request_id = requestId;
    return { ok: false, error: err };
  }

  return {
    ok: true,
    envelope: {
      type: 'mediation.command',
      schema_version: 1,
      request_id: requestId,
      command,
      ...(caseId ? { case_id: caseId } : {}),
      ...(partyId ? { party_id: partyId } : {}),
      payload,
    },
  };
}
