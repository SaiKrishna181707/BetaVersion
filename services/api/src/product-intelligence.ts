import type { ProductIntelligence, ProductIntelligenceRequest } from '@synthetic-beta/contracts';
import { lookup } from 'node:dns/promises';

const PRIVATE_HOST = /^(localhost|127\.|10\.|192\.168\.|169\.254\.|0\.|\[?::1\]?)/i;
const MAX_PAGE_BYTES = 250_000;

function isPrivateAddress(address: string): boolean {
  if (address === '::1' || address.startsWith('fe80:') || address.startsWith('fc') || address.startsWith('fd')) return true;
  const parts = address.split('.').map(Number);
  if (parts.length !== 4 || parts.some(part => !Number.isInteger(part))) return false;
  return parts[0] === 10 || parts[0] === 127 || parts[0] === 0 || parts[0] === 169 && parts[1] === 254
    || parts[0] === 192 && parts[1] === 168 || parts[0] === 172 && (parts[1] ?? 0) >= 16 && (parts[1] ?? 0) <= 31;
}

export async function assertPublicNetworkTarget(urlValue: string): Promise<void> {
  const url = new URL(urlValue);
  const resolved = await lookup(url.hostname, { all: true });
  if (resolved.length === 0 || resolved.some(entry => isPrivateAddress(entry.address))) {
    throw new Error('Website resolved to a private or unavailable network address.');
  }
}

export function validateProductIntelligenceRequest(input: unknown): ProductIntelligenceRequest {
  const data = typeof input === 'object' && input !== null ? input as Record<string, unknown> : {};
  const company_name = typeof data.company_name === 'string' ? data.company_name.trim() : '';
  const website_url = typeof data.website_url === 'string' ? data.website_url.trim() : '';
  if (company_name.length < 2 || company_name.length > 120) {
    throw new Error('Company name must be 2-120 characters.');
  }
  let url: URL;
  try { url = new URL(website_url); } catch { throw new Error('Enter a complete public website URL.'); }
  if (url.protocol !== 'https:' || url.username || url.password || PRIVATE_HOST.test(url.hostname)) {
    throw new Error('Website must be a public HTTPS URL without embedded credentials.');
  }
  url.hash = '';
  return { company_name, website_url: url.toString() };
}

function stripHtml(html: string): { title: string; text: string } {
  const title = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.replace(/\s+/g, ' ').trim() ?? '';
  const text = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&#39;/g, "'")
    .replace(/&quot;/gi, '"')
    .replace(/\s+/g, ' ')
    .trim();
  return { title, text: text.slice(0, 24_000) };
}

function stringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value)) throw new Error(`Gemini response is missing ${field}.`);
  const values = value.filter((entry): entry is string => typeof entry === 'string')
    .map(entry => entry.trim()).filter(Boolean).slice(0, 5);
  if (values.length === 0) throw new Error(`Gemini response is missing ${field}.`);
  return values;
}

export function parseGeminiIntelligence(
  request: ProductIntelligenceRequest,
  sourceTitle: string,
  raw: string,
  analyzedAt = new Date().toISOString(),
): ProductIntelligence {
  const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  const data = JSON.parse(cleaned) as Record<string, unknown>;
  const required = (field: string, max: number) => {
    const value = typeof data[field] === 'string' ? data[field].trim() : '';
    if (!value || value.length > max) throw new Error(`Gemini response is missing ${field}.`);
    return value;
  };
  return {
    company_name: request.company_name,
    website_url: request.website_url,
    product_name: required('product_name', 120),
    category: required('category', 120),
    summary: required('summary', 1200),
    target_audience: required('target_audience', 1000),
    suggested_objectives: stringArray(data.suggested_objectives, 'suggested_objectives'),
    value_propositions: stringArray(data.value_propositions, 'value_propositions'),
    source_title: sourceTitle,
    analyzed_at: analyzedAt,
  };
}

export async function buildProductIntelligence(
  input: unknown,
  apiKey: string | undefined,
  model = 'gemini-2.5-flash',
): Promise<ProductIntelligence> {
  const request = validateProductIntelligenceRequest(input);
  if (!apiKey) throw new Error('GEMINI_API_KEY is not configured on the API Lambda.');

  await assertPublicNetworkTarget(request.website_url);

  const pageResponse = await fetch(request.website_url, {
    headers: { 'User-Agent': 'SyntheticBetaProductResearch/1.0' },
    redirect: 'error',
    signal: AbortSignal.timeout(10_000),
  });
  if (!pageResponse.ok) throw new Error(`Website retrieval failed with HTTP ${pageResponse.status}.`);
  const length = Number(pageResponse.headers.get('content-length') || 0);
  if (length > MAX_PAGE_BYTES) throw new Error('Website response is too large to analyze safely.');
  const page = stripHtml((await pageResponse.text()).slice(0, MAX_PAGE_BYTES));
  if (page.text.length < 80) throw new Error('The public page did not contain enough readable product information.');

  const prompt = `Analyze this first-party public product page for a synthetic usability test. Return only JSON with keys product_name, category, summary, target_audience, suggested_objectives (3 concise observable tasks), and value_propositions (up to 5). Do not invent capabilities absent from the page.\nCompany: ${request.company_name}\nURL: ${request.website_url}\nPage title: ${page.title}\nPage text: ${page.text}`;
  const geminiResponse = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { responseMimeType: 'application/json', temperature: 0.2 },
      }),
      signal: AbortSignal.timeout(25_000),
    },
  );
  if (!geminiResponse.ok) throw new Error(`Gemini analysis failed with HTTP ${geminiResponse.status}.`);
  const payload = await geminiResponse.json() as { candidates?: { content?: { parts?: { text?: string }[] } }[] };
  const raw = payload.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!raw) throw new Error('Gemini returned no product intelligence.');
  return parseGeminiIntelligence(request, page.title, raw);
}
