import type { ProductIntelligence, ProductIntelligenceRequest } from '@centopus/contracts';
import { lookup } from 'node:dns/promises';
import { get } from 'node:https';
import { isIP } from 'node:net';

const PRIVATE_HOST = /^(localhost|127\.|10\.|192\.168\.|169\.254\.|0\.|\[?::1\]?)/i;
const MAX_PAGE_BYTES = 250_000;
const MAX_REDIRECTS = 4;

export function isPrivateAddress(address: string): boolean {
  if (isIP(address) === 6) {
    // Only native global unicast; reject mapped IPv4, local, multicast and documentation space.
    return !/^[23][0-9a-f]{3}:/i.test(address) || /^2001:(db8|0):/i.test(address);
  }
  if (isIP(address) !== 4) return true;
  const parts = address.split('.').map(Number);
  if (parts.length !== 4 || parts.some(part => !Number.isInteger(part))) return false;
  return parts[0] === 10 || parts[0] === 127 || parts[0] === 0 || parts[0]! >= 224
    || parts[0] === 169 && parts[1] === 254 || parts[0] === 100 && parts[1]! >= 64 && parts[1]! <= 127
    || parts[0] === 192 && [0, 168].includes(parts[1]!)
    || parts[0] === 198 && [18, 19, 51].includes(parts[1]!)
    || parts[0] === 203 && parts[1] === 0 && parts[2] === 113
    || parts[0] === 172 && parts[1]! >= 16 && parts[1]! <= 31;
}

export async function assertPublicNetworkTarget(urlValue: string): Promise<void> {
  const url = new URL(urlValue);
  if (url.protocol !== 'https:' || url.username || url.password) throw new Error('A public HTTPS target is required.');
  const resolved = await lookup(url.hostname, { all: true });
  if (resolved.length === 0 || resolved.some(entry => isPrivateAddress(entry.address))) {
    throw new Error('Website resolved to a private or unavailable network address.');
  }
}

/** Pin every connection to a checked address and bound bytes while streaming, before allocation. */
async function readPublicPage(urlValue: string, redirects = 0): Promise<string> {
  const url = new URL(urlValue);
  const addresses = await lookup(url.hostname, { all: true });
  if (!addresses.length || addresses.some(entry => isPrivateAddress(entry.address))) throw new Error('Website resolved to a private network.');
  const address = addresses[0]!;
  return new Promise((resolve, reject) => {
    const request = get(url, { family: address.family, lookup: (_host, _options, callback) => callback(null, address.address, address.family),
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; CentopusProductResearch/1.0; +https://centopus.ai)',
        Accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.5',
        'Accept-Language': 'en-US,en;q=0.8',
      } }, response => {
      const status = response.statusCode ?? 500;
      if ([301, 302, 303, 307, 308].includes(status) && response.headers.location) {
        response.resume();
        if (redirects >= MAX_REDIRECTS) { reject(new Error('Website redirected too many times.')); return; }
        const target = new URL(response.headers.location, url).toString();
        readPublicPage(target, redirects + 1).then(resolve, reject);
        return;
      }
      if (status < 200 || status >= 300) {
        response.resume(); reject(new Error(`Website retrieval failed with HTTP ${response.statusCode}.`)); return;
      }
      let size = 0;
      const chunks: Buffer[] = [];
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        resolve(Buffer.concat(chunks, size).toString('utf8'));
      };
      response.on('data', (chunk: Buffer) => {
        if (settled) return;
        const remaining = MAX_PAGE_BYTES - size;
        if (remaining <= 0) { finish(); response.destroy(); return; }
        const accepted = chunk.length > remaining ? chunk.subarray(0, remaining) : chunk;
        chunks.push(accepted);
        size += accepted.length;
        // A large page is useful input, not an exceptional condition. Stop after a bounded sample.
        if (size >= MAX_PAGE_BYTES) { finish(); response.destroy(); }
      });
      response.on('end', finish);
      response.on('error', error => { if (!settled) reject(error); });
    });
    const timer = setTimeout(() => request.destroy(new Error('Website retrieval timed out.')), 10000);
    request.on('close', () => clearTimeout(timer));
    request.on('error', reject);
  });
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

export function stripHtml(html: string): { title: string; text: string } {
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

export function fallbackProductIntelligence(
  request: ProductIntelligenceRequest,
  sourceTitle = '',
  analyzedAt = new Date().toISOString(),
): ProductIntelligence {
  const hostname = new URL(request.website_url).hostname.replace(/^www\./i, '');
  const productName = sourceTitle.split(/[|\u2013\u2014]/)[0]?.trim().slice(0, 120) || request.company_name;
  return {
    company_name: request.company_name,
    website_url: request.website_url,
    product_name: productName,
    category: 'Digital product or service',
    summary: `${request.company_name} is the product or organization represented by ${hostname}. The public page could not be fully analyzed, so this prefilled setup is intentionally conservative and remains editable.`,
    target_audience: `People evaluating, purchasing, or using ${request.company_name}.`,
    suggested_objectives: [
      `Understand what ${request.company_name} offers`,
      'Find relevant product or service information',
      'Locate support or contact information',
    ],
    value_propositions: [`Official product information available at ${hostname}`],
    source_title: sourceTitle || hostname,
    analyzed_at: analyzedAt,
  };
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

  let page = { title: '', text: '' };
  try {
    page = stripHtml(await readPublicPage(request.website_url));
  } catch {
    // DNS/private-network validation already ran above. Retrieval failures should not block setup.
  }

  const prompt = `Analyze this public product identity for a synthetic usability test. Return only JSON with keys product_name, category, summary, target_audience, suggested_objectives (3 concise observable tasks), and value_propositions (up to 5). Prefer the supplied first-party page text. If it is sparse, stay conservative and use only the company name, URL, title, and well-established public context; do not invent capabilities.\nCompany: ${request.company_name}\nURL: ${request.website_url}\nPage title: ${page.title || '(unavailable)'}\nPage text: ${page.text || '(unavailable)'}`;
  try {
    const geminiResponse = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
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
  } catch {
    return fallbackProductIntelligence(request, page.title);
  }
}
