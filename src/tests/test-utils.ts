import assert from 'node:assert/strict';

export interface TestCase {
  name: string;
  run: () => Promise<void> | void;
}

export async function runCases(suiteName: string, cases: TestCase[]): Promise<{ passed: number; failed: number }> {
  let passed = 0;
  let failed = 0;

  for (const testCase of cases) {
    try {
      await testCase.run();
      passed += 1;
      process.stdout.write(`[PASS] ${suiteName}: ${testCase.name}\n`);
    } catch (err) {
      failed += 1;
      process.stdout.write(`[FAIL] ${suiteName}: ${testCase.name}\n`);
      if (err instanceof Error) {
        process.stdout.write(`${err.stack || err.message}\n`);
      } else {
        process.stdout.write(`${String(err)}\n`);
      }
    }
  }

  return { passed, failed };
}

export function assertDomainErrorCode(err: unknown, expectedCode: string): void {
  const code = err && typeof err === 'object' && 'code' in err
    ? String((err as { code: unknown }).code)
    : '';
  assert.equal(code, expectedCode, `expected DomainError code '${expectedCode}', got '${code}'`);
}
