export interface DeploymentConfig {
  controlAccount: string; agentAccount: string; region: string; prefix: string;
  webOrigin: string; externalId: string; geminiSecretArn?: string;
  existingStateTable?: string; existingArtifactBucket?: string; alarmEmail?: string;
}

export function loadDeploymentConfig(env: NodeJS.ProcessEnv): DeploymentConfig {
  for (const key of ['CENTOPUS_CONTROL_ACCOUNT', 'CENTOPUS_AGENT_ACCOUNT']) {
    if (!/^\d{12}$/.test(env[key] ?? '')) throw new Error(`${key} must be an explicitly configured AWS account.`);
  }
  if (env.CENTOPUS_CONTROL_ACCOUNT === env.CENTOPUS_AGENT_ACCOUNT) throw new Error('Control and agent accounts must be distinct.');
  const webOrigin = env.AMPLIFY_ORIGIN ?? '';
  const url = new URL(webOrigin);
  if (url.protocol !== 'https:' || url.origin !== webOrigin) throw new Error('AMPLIFY_ORIGIN must be an HTTPS origin without a trailing slash.');
  if (!env.CROSS_ACCOUNT_EXTERNAL_ID || env.CROSS_ACCOUNT_EXTERNAL_ID.length < 16) throw new Error('Set CROSS_ACCOUNT_EXTERNAL_ID (at least 16 characters).');
  const prefix = env.CENTOPUS_PREFIX ?? 'centopus';
  if (!/^[a-z][a-z0-9-]{2,25}$/.test(prefix)) throw new Error('Invalid CENTOPUS_PREFIX.');
  return { controlAccount: env.CENTOPUS_CONTROL_ACCOUNT!, agentAccount: env.CENTOPUS_AGENT_ACCOUNT!,
    region: env.AWS_REGION ?? 'us-east-1', prefix, webOrigin, externalId: env.CROSS_ACCOUNT_EXTERNAL_ID,
    geminiSecretArn: env.GEMINI_SECRET_ARN, existingStateTable: env.STATE_TABLE,
    existingArtifactBucket: env.ARTIFACT_BUCKET, alarmEmail: env.ALARM_EMAIL };
}

/** Only used for offline synthesis/tests. These are explicitly fictitious accounts. */
export const validationConfig: DeploymentConfig = {
  controlAccount: '111111111111', agentAccount: '222222222222', region: 'us-east-1',
  prefix: 'centopus-validation', webOrigin: 'https://centopus.example.com', externalId: 'offline-validation-only',
};
