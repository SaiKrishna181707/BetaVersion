import type { ProductIntelligence, ProductIntelligenceRequest } from '@synthetic-beta/contracts';
import { lookup } from 'node:dns/promises';
import { get } from 'node:https';
import { isIP } from 'node:net';

const PRIVATE_HOST = /^(localhost|127\.|10\.|192\.168\.|169\.254\.|0\.|\[?::1\]?)/i;
const MAX_PAGE_BYTES = 250_000;
const MAX_REDIRECTS = 4;
const MAX_PAGES = 4;
const MAX_PAGE_TEXT = 16_000;
const MAX_TOTAL_PROMPT_TEXT = 48_000;
const DISCOVERY_PATH = /(?:^|\/)(?:about(?:-us)?|product(?:s)?|features?|pricing|solutions?|platform|services?|how-it-works)(?:\/|$)/i;

interface PublicPage {
  url: string;
  html: string;
  title: string;
  description: string;
  text: string;
}

export class ProductIntelligenceServiceError extends Error {
  readonly code = 'PRODUCT_INTELLIGENCE_UNAVAILABLE';

  constructor(message: string) {
    super(message);
    this.name = 'ProductIntelligenceServiceError';
  }
}

export function isPrivateAddress(address: string): boolean {
  if (isIP(address) === 6) {
    // Only native global unicast; reject mapped IPv4, local, multicast and documentation space.
    return !/^[23][0-9a-f]{3}:/i.test(address) || /^2001:(db8|0):/i.test(address);
  }
  if (isIP(address) !== 4) return true;
  const parts = address.split('.').map(Number);
  if (parts.length !== 4 || parts.some(part => !Number.isInteger(part))) return true;
  return parts[0] === 10 || parts[0] === 127 || parts[0] === 0 || parts[0]! >= 224
    || parts[0] === 169 && parts[1] === 254 || parts[0] === 100 && parts[1]! >= 64 && parts[1]! <= 127
    || parts[0] === 192 && [0, 168].includes(parts[1]!)
    || parts[0] === 198 && [18, 19, 51].includes(parts[1]!)
    || parts[0] === 203 && parts[1] === 0 && parts[2] === 113
    || parts[0] === 172 && parts[1]! >= 16 && parts[1]! <= 31;
}

function normalizeHostname(value: string): string {
  return value.trim().replace(/\.$/, '').toLowerCase();
}

/** Allows canonical apex/www/subdomain redirects without permitting look-alike external hosts. */
export function isSameFirstPartySite(left: string, right: string): boolean {
  const a = normalizeHostname(left);
  const b = normalizeHostname(right);
  return a === b || a.endsWith(`.${b}`) || b.endsWith(`.${a}`);
}

export async function assertPublicNetworkTarget(urlValue: string): Promise<void> {
  const url = new URL(urlValue);
  if (url.protocol !== 'https:' || url.username || url.password) throw new Error('A public HTTPS target is required.');
  const resolved = await lookup(url.hostname, { all: true });
  if (resolved.length === 0 || resolved.some(entry => isPrivateAddress(entry.address))) {
    throw new Error('Website resolved to a private or unavailable network address.');
  }
}

async function readPublicHtml(urlValue: string, firstPartyHost: string, redirects = 0): Promise<{ html: string; finalUrl: string }> {
  const url = new URL(urlValue);
  if (url.protocol !== 'https:' || url.username || url.password || !isSameFirstPartySite(url.hostname, firstPartyHost)) {
    throw new Error('Website attempted to leave the authorized first-party HTTPS site.');
  }
  const addresses = await lookup(url.hostname, { all: true });
  if (!addresses.length || addresses.some(entry => isPrivateAddress(entry.address))) {
    throw new Error('Website resolved to a private network.');
  }
  const address = addresses[0]!;
  return new Promise((resolve, reject) => {
    const request = get(url, {
      family: address.family,
      lookup: (_host, _options, callback) => callback(null, address.address, address.family),
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; CentopusProductResearch/1.0; +https://centopus.ai)',
        Accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.2',
        'Accept-Language': 'en-US,en;q=0.8',
      },
    }, response => {
      const status = response.statusCode ?? 500;
      if ([301, 302, 303, 307, 308].includes(status) && response.headers.location) {
        response.resume();
        if (redirects >= MAX_REDIRECTS) {
          reject(new Error('Website redirected too many times.'));
          return;
        }
        const target = new URL(response.headers.location, url);
        if (target.protocol !== 'https:' || target.username || target.password
          || !isSameFirstPartySite(target.hostname, firstPartyHost)) {
          reject(new Error('Website redirected outside the authorized first-party HTTPS site.'));
          return;
        }
        target.hash = '';
        readPublicHtml(target.toString(), firstPartyHost, redirects + 1).then(resolve, reject);
        return;
      }
      if (status < 200 || status >= 300) {
        response.resume();
        reject(new Error(`Website retrieval failed with HTTP ${status}.`));
        return;
      }
      const contentType = String(response.headers['content-type'] || '').toLowerCase();
      if (contentType && !contentType.includes('text/html') && !contentType.includes('application/xhtml+xml')) {
        response.resume();
        reject(new Error('Website did not return an HTML page.'));
        return;
      }

      let size = 0;
      const chunks: Buffer[] = [];
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        resolve({ html: Buffer.concat(chunks, size).toString('utf8'), finalUrl: url.toString() });
      };
      response.on('data', (chunk: Buffer) => {
        if (settled) return;
        const remaining = MAX_PAGE_BYTES - size;
        if (remaining <= 0) {
          finish();
          response.destroy();
          return;
        }
        const accepted = chunk.length > remaining ? chunk.subarray(0, remaining) : chunk;
        chunks.push(accepted);
        size += accepted.length;
        if (size >= MAX_PAGE_BYTES) {
          finish();
          response.destroy();
        }
      });
      response.on('end', finish);
      response.on('error', error => { if (!settled) reject(error); });
    });
    const timer = setTimeout(() => request.destroy(new Error('Website retrieval timed out.')), 10_000);
    request.on('close', () => clearTimeout(timer));
    request.on('error', reject);
  });
}

function decodeEntities(value: string): string {
  return value
    .replace(/&nbsp;|&#160;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;|&#34;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>');
}

export function stripHtml(html: string): { title: string; description: string; text: string } {
  const title = decodeEntities(
    html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.replace(/\s+/g, ' ').trim() ?? '',
  ).slice(0, 200);
  const descriptionMatch = html.match(
    /<meta[^>]+(?:name|property)=["'](?:description|og:description)["'][^>]+content=["']([^"']*)["'][^>]*>/i,
  ) ?? html.match(
    /<meta[^>]+content=["']([^"']*)["'][^>]+(?:name|property)=["'](?:description|og:description)["'][^>]*>/i,
  );
  const description = decodeEntities(descriptionMatch?.[1]?.trim() ?? '').slice(0, 600);
  const text = decodeEntities(html
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|noscript|svg|template|nav|header|footer|aside)\b[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
  const combined = [description, text].filter(Boolean).join(' ');
  return { title, description, text: combined.slice(0, MAX_PAGE_TEXT) };
}

function pagePriority(pathname: string): number {
  const path = pathname.toLowerCase();
  if (/pricing/.test(path)) return 100;
  if (/features?/.test(path)) return 95;
  if (/products?/.test(path)) return 90;
  if (/solutions?|platform/.test(path)) return 80;
  if (/about(?:-us)?/.test(path)) return 70;
  if (/services?|how-it-works/.test(path)) return 60;
  return 0;
}

/** Deterministic discovery of a small, safe set of same-site first-party pages. */
export function discoverFirstPartyUrls(html: string, baseUrl: string, limit = MAX_PAGES - 1): string[] {
  const base = new URL(baseUrl);
  const candidates = new Map<string, number>();
  const hrefPattern = /<a\b[^>]*\bhref\s*=\s*["']([^"'#]+)["'][^>]*>/gi;
  let match: RegExpExecArray | null;
  while ((match = hrefPattern.exec(html)) !== null) {
    try {
      const candidate = new URL(decodeEntities(match[1]!), base);
      if (candidate.protocol !== 'https:' || candidate.username || candidate.password) continue;
      if (!isSameFirstPartySite(candidate.hostname, base.hostname)) continue;
      candidate.hash = '';
      candidate.search = '';
      if (candidate.pathname === '/' || !DISCOVERY_PATH.test(candidate.pathname)) continue;
      if (/\.(?:pdf|zip|jpe?g|png|gif|webp|svg|mp4|mp3|xml|json)$/i.test(candidate.pathname)) continue;
      const normalized = candidate.toString();
      candidates.set(normalized, Math.max(candidates.get(normalized) ?? 0, pagePriority(candidate.pathname)));
    } catch {
      // Ignore malformed first-party links; they are not sent to Gemini.
    }
  }
  return [...candidates.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, Math.max(0, limit))
    .map(([url]) => url);
}

async function crawlFirstPartyPages(request: ProductIntelligenceRequest): Promise<{ pages: PublicPage[]; canonicalUrl: string }> {
  const initialHost = new URL(request.website_url).hostname;
  const home = await readPublicHtml(request.website_url, initialHost);
  const canonicalUrl = new URL(home.finalUrl);
  canonicalUrl.hash = '';
  canonicalUrl.search = '';

  const homeExtracted = stripHtml(home.html);
  const pages: PublicPage[] = [{
    url: canonicalUrl.toString(),
    html: home.html,
    ...homeExtracted,
  }];
  const seen = new Set([canonicalUrl.toString()]);
  const queue = discoverFirstPartyUrls(home.html, canonicalUrl.toString(), MAX_PAGES - 1);

  while (queue.length && pages.length < MAX_PAGES) {
    const next = queue.shift()!;
    if (seen.has(next)) continue;
    seen.add(next);
    try {
      const fetched = await readPublicHtml(next, canonicalUrl.hostname);
      const finalUrl = new URL(fetched.finalUrl);
      finalUrl.hash = '';
      finalUrl.search = '';
      const normalizedFinal = finalUrl.toString();
      if (seen.has(normalizedFinal) && normalizedFinal !== next) continue;
      seen.add(normalizedFinal);
      const extracted = stripHtml(fetched.html);
      if (extracted.text.length < 80) continue;
      pages.push({ url: normalizedFinal, html: fetched.html, ...extracted });
      for (const discovered of discoverFirstPartyUrls(fetched.html, normalizedFinal, MAX_PAGES)) {
        if (!seen.has(discovered) && !queue.includes(discovered)) queue.push(discovered);
      }
    } catch {
      // Secondary pages are best-effort. The successful homepage remains authoritative input.
    }
  }

  return { pages, canonicalUrl: canonicalUrl.toString() };
}

export function validateProductIntelligenceRequest(input: unknown): ProductIntelligenceRequest {
  const data = typeof input === 'object' && input !== null ? input as Record<string, unknown> : {};
  const company_name = typeof data.company_name === 'string' ? data.company_name.trim() : '';
  const website_url = typeof data.website_url === 'string' ? data.website_url.trim() : '';
  if (company_name.length < 2 || company_name.length > 120) {
    throw new Error('Company name must be 2-120 characters.');
  }
  let url: URL;
  try {
    url = new URL(website_url);
  } catch {
    throw new Error('Enter a complete public website URL.');
  }
  if (url.protocol !== 'https:' || url.username || url.password || PRIVATE_HOST.test(url.hostname)) {
    throw new Error('Website must be a public HTTPS URL without embedded credentials.');
  }
  url.hash = '';
  return { company_name, website_url: url.toString() };
}

/**
 * Retained for callers that explicitly want a blank editable shape. Production
 * product intelligence no longer silently falls back to invented product facts.
 */
export function fallbackProductIntelligence(
  request: ProductIntelligenceRequest,
  sourceTitle = '',
  analyzedAt = new Date().toISOString(),
): ProductIntelligence {
  const hostname = new URL(request.website_url).hostname.replace(/^www\./i, '');
  return {
    company_name: request.company_name,
    website_url: request.website_url,
    product_name: sourceTitle.split(/[|\u2013\u2014]/)[0]?.trim().slice(0, 120) || request.company_name,
    category: '',
    summary: '',
    what_product_does: '',
    target_audience: '',
    suggested_objectives: [],
    key_features: [],
    value_propositions: [],
    pages_crawled: [],
    source_title: sourceTitle || hostname,
    analyzed_at: analyzedAt,
  };
}

function stringArray(value: unknown, field: string, maxItems = 6, allowEmpty = false): string[] {
  if (!Array.isArray(value)) throw new Error(`Gemini response is missing ${field}.`);
  const values = value
    .filter((entry): entry is string => typeof entry === 'string')
    .map(entry => entry.trim())
    .filter(Boolean)
    .slice(0, maxItems);
  if (!allowEmpty && values.length === 0) throw new Error(`Gemini response is missing ${field}.`);
  return values;
}

export function parseGeminiIntelligence(
  request: ProductIntelligenceRequest,
  sourceTitle: string,
  raw: string,
  analyzedAt = new Date().toISOString(),
  pagesCrawled: string[] = [],
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
    what_product_does: required('what_product_does', 1200),
    target_audience: required('target_audience', 1000),
    suggested_objectives: stringArray(data.suggested_objectives, 'suggested_objectives', 5),
    key_features: stringArray(data.key_features, 'key_features', 8, true),
    value_propositions: stringArray(data.value_propositions, 'value_propositions', 6, true),
    pages_crawled: pagesCrawled,
    source_title: sourceTitle,
    analyzed_at: analyzedAt,
  };
}

function promptCorpus(pages: PublicPage[]): string {
  let remaining = MAX_TOTAL_PROMPT_TEXT;
  const chunks: string[] = [];
  for (const [index, page] of pages.entries()) {
    if (remaining <= 0) break;
    const header = `SOURCE ${index + 1}\nURL: ${page.url}\nTITLE: ${page.title || '(untitled)'}\nCONTENT:\n`;
    const room = Math.max(0, remaining - header.length);
    const body = page.text.slice(0, room);
    chunks.push(header + body);
    remaining -= header.length + body.length;
  }
  return chunks.join('\n\n');
}

async function requestGemini(
  apiKey: string,
  model: string,
  prompt: string,
): Promise<string> {
  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          responseMimeType: 'application/json',
          temperature: 0.1,
          maxOutputTokens: 2400,
          responseSchema: {
            type: 'OBJECT',
            properties: {
              product_name: { type: 'STRING' },
              category: { type: 'STRING' },
              summary: { type: 'STRING' },
              what_product_does: { type: 'STRING' },
              target_audience: { type: 'STRING' },
              key_features: { type: 'ARRAY', items: { type: 'STRING' } },
              value_propositions: { type: 'ARRAY', items: { type: 'STRING' } },
              suggested_objectives: { type: 'ARRAY', items: { type: 'STRING' } },
            },
            required: [
              'product_name',
              'category',
              'summary',
              'what_product_does',
              'target_audience',
              'key_features',
              'value_propositions',
              'suggested_objectives',
            ],
          },
        },
      }),
      signal: AbortSignal.timeout(25_000),
    },
  );
  if (!response.ok) throw new Error(`Gemini analysis failed with HTTP ${response.status}.`);
  const payload = await response.json() as { candidates?: { content?: { parts?: { text?: string }[] } }[] };
  const raw = payload.candidates?.[0]?.content?.parts?.map(part => part.text || '').join('').trim();
  if (!raw) throw new Error('Gemini returned no product intelligence.');
  return raw;
}

export async function buildProductIntelligence(
  input: unknown,
  apiKey: string | undefined,
  model = 'gemini-2.5-flash',
): Promise<ProductIntelligence> {
  const request = validateProductIntelligenceRequest(input);
  if (!apiKey) throw new ProductIntelligenceServiceError('GEMINI_API_KEY is not configured on the API Lambda.');

  await assertPublicNetworkTarget(request.website_url);

  let crawl: { pages: PublicPage[]; canonicalUrl: string };
  try {
    crawl = await crawlFirstPartyPages(request);
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : 'Public website retrieval failed.';
    throw new ProductIntelligenceServiceError(`Could not read the public website: ${detail}`);
  }

  const canonicalRequest = { ...request, website_url: crawl.canonicalUrl };
  const pagesCrawled = crawl.pages.map(page => page.url);
  const corpus = promptCorpus(crawl.pages);
  const prompt = `You are extracting product facts for a synthetic usability test from FIRST-PARTY PUBLIC WEB PAGES.

Return ONLY the requested JSON object. Every product fact must be supported by the supplied sources. Do not use prior knowledge to fill gaps. If a list has no supported items, return an empty list. Keep statements concise and concrete. The suggested objectives must be 3 observable, browser-testable tasks that are plausible from the supplied public product information; do not invent login-only capabilities or transactions that are not shown.

Company supplied by operator: ${request.company_name}
Canonical public URL: ${crawl.canonicalUrl}

${corpus}`;

  let lastError: unknown;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const raw = await requestGemini(
        apiKey,
        model,
        attempt === 0 ? prompt : `${prompt}\n\nVALIDATION RETRY: ensure every required JSON key is present and values are supported by the source text.`,
      );
      return parseGeminiIntelligence(
        canonicalRequest,
        crawl.pages[0]?.title || new URL(crawl.canonicalUrl).hostname,
        raw,
        new Date().toISOString(),
        pagesCrawled,
      );
    } catch (cause) {
      lastError = cause;
    }
  }

  const detail = lastError instanceof Error ? lastError.message : 'Gemini analysis failed.';
  throw new ProductIntelligenceServiceError(`Product analysis service failed: ${detail}`);
}
