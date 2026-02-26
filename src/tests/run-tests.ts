import { runDomainTests } from './domain.test';
import { runConsentTests } from './consent.test';
import { runTransportTests } from './transport.test';
import { runPersistenceTests } from './persistence.test';

async function main(): Promise<void> {
  const suites = [
    await runDomainTests(),
    await runConsentTests(),
    await runTransportTests(),
    await runPersistenceTests(),
  ];

  const passed = suites.reduce((sum, suite) => sum + suite.passed, 0);
  const failed = suites.reduce((sum, suite) => sum + suite.failed, 0);

  process.stdout.write(`\nTest Summary: passed=${passed} failed=${failed}\n`);

  if (failed > 0) {
    process.exitCode = 1;
  }
}

void main();
