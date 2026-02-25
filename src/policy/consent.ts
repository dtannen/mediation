import type { ConsentGrant } from '../domain/types';

export interface ShareCandidate {
  partyId: string;
  text: string;
  tags: string[];
}

export interface ShareResult {
  allowed: boolean;
  text: string;
  reason?: string;
}

function allTagsAllowed(candidateTags: string[], allowedTags: string[]): boolean {
  if (allowedTags.length === 0) {
    return true;
  }
  const allowSet = new Set(allowedTags.map((tag) => tag.trim()).filter(Boolean));
  return candidateTags.every((tag) => allowSet.has(tag));
}

function toParaphrasedSummary(text: string): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (!normalized) {
    return '';
  }
  const words = normalized.split(' ');
  const clipped = words.slice(0, 36).join(' ');
  return words.length > 36 ? `${clipped}...` : clipped;
}

export function enforceShareGrant(grant: ConsentGrant, candidate: ShareCandidate): ShareResult {
  if (!grant.allowSummaryShare) {
    return {
      allowed: false,
      text: '',
      reason: `party '${candidate.partyId}' disallowed sharing from private intake`,
    };
  }

  if (!allTagsAllowed(candidate.tags, grant.allowedTags)) {
    return {
      allowed: false,
      text: '',
      reason: `party '${candidate.partyId}' disallowed one or more content tags`,
    };
  }

  if (grant.allowDirectQuote) {
    return {
      allowed: true,
      text: candidate.text,
    };
  }

  return {
    allowed: true,
    text: toParaphrasedSummary(candidate.text),
  };
}
