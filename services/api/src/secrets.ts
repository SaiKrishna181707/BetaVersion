import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';

const client = new SecretsManagerClient({ region: process.env.AWS_REGION || 'us-east-1' });
let cached: Promise<string> | null = null;

export function getGeminiApiKey(): Promise<string> {
  const direct = process.env.GEMINI_API_KEY;
  if (direct && direct.trim().length > 0) return Promise.resolve(direct.trim());
  if (cached) return cached;
  cached = (async () => {
    const secretArn = process.env.GEMINI_SECRET_ARN;
    if (!secretArn) throw new Error('GEMINI_SECRET_ARN is not configured on the API Lambda.');
    const result = await client.send(new GetSecretValueCommand({ SecretId: secretArn }));
    const value = result.SecretString;
    if (!value) throw new Error('Gemini secret has no string value.');
    try {
      const parsed = JSON.parse(value) as { GEMINI_API_KEY?: unknown };
      if (typeof parsed.GEMINI_API_KEY === 'string' && parsed.GEMINI_API_KEY.length > 0) return parsed.GEMINI_API_KEY;
    } catch { /* raw secret strings are supported */ }
    if (value.trim()) return value.trim();
    throw new Error('Gemini secret is empty.');
  })().catch(cause => { cached = null; throw cause; });
  return cached;
}
