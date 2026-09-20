import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const CURRENT_MAIN_SUBJECT = 'repo:SaiKrishna181707/centopus:ref:refs/heads/main';

function loadPolicy(name: string) {
  return JSON.parse(readFileSync(new URL(`../../infra/policies/${name}`, import.meta.url), 'utf8')) as {
    Statement?: Array<{
      Action?: string;
      Principal?: { Federated?: string };
      Condition?: {
        StringEquals?: Record<string, string>;
        StringLike?: Record<string, string | string[]>;
      };
    }>;
  };
}

test('production GitHub OIDC trust policies are pinned to the renamed repository main branch', () => {
  for (const file of [
    'backend-deploy-role-trust-policy.json',
    'amplify-deploy-role-trust-policy.json',
  ]) {
    const policy = loadPolicy(file);
    const statement = policy.Statement?.[0];
    assert.ok(statement, `${file} must contain a trust statement`);
    assert.equal(statement.Action, 'sts:AssumeRoleWithWebIdentity');
    assert.equal(
      statement.Principal?.Federated,
      'arn:aws:iam::643700104680:oidc-provider/token.actions.githubusercontent.com',
    );
    assert.equal(
      statement.Condition?.StringEquals?.['token.actions.githubusercontent.com:aud'],
      'sts.amazonaws.com',
    );

    const rawSubjects = statement.Condition?.StringLike?.['token.actions.githubusercontent.com:sub'];
    const subjects = Array.isArray(rawSubjects) ? rawSubjects : rawSubjects ? [rawSubjects] : [];
    assert.ok(subjects.includes(CURRENT_MAIN_SUBJECT), `${file} must authorize the current main-branch OIDC subject`);
    assert.ok(subjects.every(subject => !subject.includes('*')), `${file} must not wildcard repositories or branches`);
    assert.ok(subjects.every(subject => subject.endsWith(':ref:refs/heads/main')), `${file} must stay main-only`);
    assert.doesNotMatch(JSON.stringify(policy), /BetaVersion/i, `${file} must not retain the pre-rename repository subject`);
  }
});

test('production deploy workflows request only short-lived GitHub OIDC credentials', () => {
  const backend = readFileSync(new URL('../../.github/workflows/deploy-backend.yml', import.meta.url), 'utf8');
  const frontend = readFileSync(new URL('../../.github/workflows/deploy-amplify.yml', import.meta.url), 'utf8');

  for (const [name, workflow] of [['backend', backend], ['frontend', frontend]] as const) {
    assert.match(workflow, /id-token:\s*write/);
    assert.match(workflow, /contents:\s*read/);
    assert.doesNotMatch(workflow, /AWS_ACCESS_KEY_ID|AWS_SECRET_ACCESS_KEY|aws-access-key-id|aws-secret-access-key/i,
      `${name} deployment must not use long-lived static AWS credentials`);
  }

  assert.match(backend, /CentopusBackendGitHubDeployRole/);
  assert.match(frontend, /CentopusAmplifyGitHubDeployRole/);
});
