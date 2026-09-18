import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLocalBrowserSessionExecutor, defaultSandboxAccount } from '../../services/agent-worker/src/browser/local-executor';

test('the local browser executor reports itself available and names its kind', () => {
  const executor = createLocalBrowserSessionExecutor({ artifacts_root: '.artifacts' });
  assert.equal(executor.kind, 'local-playwright');
  assert.equal(executor.available, true);
});

test('the sandbox account stays a documented, disposable placeholder', () => {
  const account = defaultSandboxAccount();
  assert.equal(account.email, process.env.L1_SANDBOX_EMAIL ?? 'tester@sandbox.test');
  assert.ok(account.password.length > 0);
});
