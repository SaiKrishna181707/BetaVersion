import { BedrockRuntimeClient, ConverseCommand } from '@aws-sdk/client-bedrock-runtime';

export interface JsonModelRequest {
  system: string;
  prompt: string;
  modelId?: string;
  maxTokens?: number;
  temperature?: number;
}

export type JsonModel = <T>(request: JsonModelRequest) => Promise<T>;

const clients = new Map<string, BedrockRuntimeClient>();

function client(region: string): BedrockRuntimeClient {
  const existing = clients.get(region);
  if (existing) return existing;
  const created = new BedrockRuntimeClient({ region });
  clients.set(region, created);
  return created;
}

export function parseModelJson<T>(value: string): T {
  const cleaned = value.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('Nova returned no JSON object.');
  return JSON.parse(cleaned.slice(start, end + 1)) as T;
}

/** Shared low-latency Bedrock boundary. Prompts require JSON; callers still validate every field. */
export const invokeNovaJson: JsonModel = async <T>(request: JsonModelRequest): Promise<T> => {
  const region = process.env.BEDROCK_REGION || process.env.AWS_REGION || 'us-east-1';
  const modelId = request.modelId || process.env.NOVA_TEXT_MODEL_ID || 'amazon.nova-micro-v1:0';
  const result = await client(region).send(new ConverseCommand({
    modelId,
    system: [{ text: request.system }],
    messages: [{ role: 'user', content: [{ text: request.prompt }] }],
    inferenceConfig: {
      maxTokens: request.maxTokens ?? 2400,
      temperature: request.temperature ?? 0.2,
      topP: 0.9,
    },
  }));
  const text = result.output?.message?.content?.map(block => 'text' in block ? block.text || '' : '').join('').trim();
  if (!text) throw new Error('Nova returned an empty response.');
  return parseModelJson<T>(text);
};
