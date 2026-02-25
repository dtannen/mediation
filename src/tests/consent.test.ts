import assert from 'node:assert/strict';
import { enforceShareGrant } from '../policy/consent';
import { runCases } from './test-utils';

export async function runConsentTests(): Promise<{ passed: number; failed: number }> {
  return runCases('consent', [
    {
      name: 'share denied when allowSummaryShare is false',
      run: () => {
        const result = enforceShareGrant(
          {
            allowSummaryShare: false,
            allowDirectQuote: true,
            allowedTags: [],
          },
          {
            partyId: 'party_a',
            text: 'private summary',
            tags: ['summary'],
          },
        );

        assert.equal(result.allowed, false);
        assert.equal(result.text, '');
      },
    },
    {
      name: 'tags filter denies non-allowed tags',
      run: () => {
        const result = enforceShareGrant(
          {
            allowSummaryShare: true,
            allowDirectQuote: true,
            allowedTags: ['summary'],
          },
          {
            partyId: 'party_a',
            text: 'private summary',
            tags: ['summary', 'private'],
          },
        );

        assert.equal(result.allowed, false);
        assert.equal(result.text, '');
      },
    },
    {
      name: 'direct quote returns original text',
      run: () => {
        const text = 'This is the exact text we want to quote directly.';
        const result = enforceShareGrant(
          {
            allowSummaryShare: true,
            allowDirectQuote: true,
            allowedTags: [],
          },
          {
            partyId: 'party_a',
            text,
            tags: ['summary'],
          },
        );

        assert.equal(result.allowed, true);
        assert.equal(result.text, text);
      },
    },
    {
      name: 'paraphrase clips to first 36 words with ellipsis',
      run: () => {
        const words = Array.from({ length: 40 }, (_, i) => `w${i + 1}`);
        const text = words.join(' ');

        const result = enforceShareGrant(
          {
            allowSummaryShare: true,
            allowDirectQuote: false,
            allowedTags: [],
          },
          {
            partyId: 'party_a',
            text,
            tags: ['summary'],
          },
        );

        assert.equal(result.allowed, true);
        assert.equal(result.text, `${words.slice(0, 36).join(' ')}...`);
      },
    },
  ]);
}
