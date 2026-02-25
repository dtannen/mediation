export const DOMAIN_ERROR_CODES = [
  'invalid_topic',
  'invalid_party_count',
  'duplicate_party_id',
  'missing_consent',
  'case_not_found',
  'invalid_invite_token',
  'party_not_found',
  'party_not_joined',
  'invalid_phase',
  'missing_private_summary',
  'invalid_transition',
  'invalid_group_message',
  'draft_not_found',
  'draft_closed',
  'draft_not_pending',
  'invalid_intent',
  'invalid_compose_message',
  'invalid_suggested_text',
  'invalid_approved_text',
  'missing_party',
] as const;

export type DomainErrorCode = (typeof DOMAIN_ERROR_CODES)[number];

export class DomainError extends Error {
  readonly code: DomainErrorCode | string;

  constructor(code: DomainErrorCode | string, message: string) {
    super(message);
    this.code = code;
    this.name = 'DomainError';
  }
}
