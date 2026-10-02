import type { TestPlugin } from './fixtures';
import { smokeTests } from './smoke.test';
import { engineTests } from './engine.test';
import { traceTests } from './trace.test';

export function attachCliTests(plugin: TestPlugin): void {
  Object.defineProperty(plugin, 'runCliSuite', { value: async (suite: string, runId: string) => {
    if (plugin.app.vault.getName() !== 'OpenCC-Selection-Converter-Test') throw new Error('Wrong test vault');
    if (!/^[a-f0-9-]{36}$/.test(runId)) throw new Error('Invalid test run ID');
    const suites = { smoke: smokeTests(plugin), engine: engineTests(plugin), trace: traceTests(plugin) };
    const tests = suite === 'all' ? Object.values(suites).flat() : suites[suite as keyof typeof suites] ?? [];
    const checks: {name: string; pass: boolean; error?: string}[] = [];
    if (!tests.length) checks.push({ name: suite, pass: false, error: 'Unknown or empty suite' });
    for (const test of tests) {
      try { await test.run(); checks.push({ name: test.name, pass: true }); }
      catch (error) { checks.push({ name: test.name, pass: false, error: String(error) }); }
    }
    const adapter = plugin.app.vault.adapter;
    const folder = '.opencc-test-results';
    if (!await adapter.exists(folder)) await adapter.mkdir(folder);
    await adapter.write(`${folder}/${runId}.json`, JSON.stringify({
      runId, suite, checks,
      errors: checks.filter(check => !check.pass).map(check => ({ name: check.name, error: check.error })),
      passed: checks.filter(check => check.pass).length,
      failed: checks.filter(check => !check.pass).length,
    }, null, 2));
  } });
}
