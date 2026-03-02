export const DOMAIN_ERROR_CODES = [
  'invalid_topic',
  'invalid_party_count',
  'duplicate_party_id',
  'missing_consent',
  'case_not_found',
  'case_not_visible',
  'party_not_found',
  'party_not_joined',
  'invalid_phase',
  'missing_private_summary',
  'invalid_transition',
  'invalid_group_message',
  'draft_not_found',
  'draft_closed',
  'draft_already_active',
  'draft_not_pending',
  'invalid_intent',
  'invalid_compose_message',
  'invalid_suggested_text',
  'invalid_approved_text',
  'missing_party',
  'template_not_found',
  'template_inactive',
  'template_version_not_found',
  'template_in_use',
  'invalid_template_category',
  'main_topic_required',
  'main_topic_not_configured',
  'draft_readiness_required',
  'invalid_phase_transition',
  'no_coach_exchanges',
  'context_budget_exceeded',
  'admin_override_required',
  'unauthorized_admin_action',
  'invalid_payload',
  'internal_error',
] as const;

export type DomainErrorCode = (typeof DOMAIN_ERROR_CODES)[number];

export class DomainError extends Error {
  readonly code: DomainErrorCode | string;
  /** Structured metadata surfaced as IPC error.details (Section 7.0) */
  readonly details?: Record<string, unknown>;

  constructor(code: DomainErrorCode | string, message: string, details?: Record<string, unknown>) {
    super(message);
    this.code = code;
    this.name = 'DomainError';
    if (details) {
      this.details = details;
    }
  }
}
