import { createServer, type IncomingMessage } from 'node:http';
import { readFile, realpath } from 'node:fs/promises';
import { resolve, relative, isAbsolute, sep } from 'node:path';

type ApiHandler = (request: {
  httpMethod: string;
  path: string;
  body?: string | null;
}) => Promise<{ statusCode: number; headers: Record<string, string>; body: string }>;

export interface ApiServerOptions {
  handler: ApiHandler;
  port: number;
  host?: string;
  /** Origins allowed to call the API from a browser. Defaults to the local dev front end. */
  allowed_origins?: readonly string[];
  artifacts_root?: string;
}

export interface RunningApiServer {
  url: string;
  close(): Promise<void>;
}

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    request.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > 1_000_000) {
        reject(new Error('Request body is too large.'));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    request.on('error', reject);
  });
}

/**
 * A thin HTTP binding for the API handler, used for local development and for the smoke
 * test. In AWS the same handler runs behind API Gateway, which supplies the same request
 * shape, so the two paths cannot drift.
 */
export async function startApiServer(options: ApiServerOptions): Promise<RunningApiServer> {
  const host = options.host ?? '127.0.0.1';
  const origins = options.allowed_origins ?? ['http://127.0.0.1:5173', 'http://localhost:5173'];

  const server = createServer((request, reply) => {
    void (async () => {
      const url = new URL(request.url ?? '/', `http://${request.headers.host ?? host}`);
      const origin = request.headers.origin;
      const allowOrigin = typeof origin === 'string' && origins.includes(origin) ? origin : origins[0] ?? '';
      const baseHeaders: Record<string, string> = {
        'Access-Control-Allow-Origin': allowOrigin,
        'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Vary': 'Origin',
      };
      if (request.method === 'GET' && url.pathname.startsWith('/artifacts/') && options.artifacts_root !== undefined) {
        try {
          const root = await realpath(options.artifacts_root);
          const file = await realpath(resolve(root, decodeURIComponent(url.pathname.slice('/artifacts/'.length))));
          const name = relative(root, file);
          if (isAbsolute(name) || name === '..' || name.startsWith(`..${sep}`) || !/\.(png|zip|json)$/.test(name)) throw new Error('Invalid evidence path');
          reply.writeHead(200, { ...baseHeaders, 'Content-Type': name.endsWith('.png') ? 'image/png' : name.endsWith('.zip') ? 'application/zip' : 'application/json', 'Cache-Control': 'no-store' });
          reply.end(await readFile(file));
        } catch {
          reply.writeHead(404, baseHeaders);
          reply.end();
        }
        return;
      }
      if (request.method === 'OPTIONS') {
        reply.writeHead(204, baseHeaders);
        reply.end();
        return;
      }
      let body: string | null = null;
      try {
        body = await readBody(request);
      } catch (cause) {
        reply.writeHead(413, { ...baseHeaders, 'Content-Type': 'application/json' });
        reply.end(JSON.stringify({ code: 'PAYLOAD_TOO_LARGE', message: cause instanceof Error ? cause.message : '' }));
        return;
      }
      const result = await options.handler({
        httpMethod: request.method ?? 'GET',
        path: url.pathname.replace(/\/+$/, '') || '/',
        body,
      });
      reply.writeHead(result.statusCode, { ...baseHeaders, ...result.headers });
      reply.end(result.body);
    })().catch(cause => {
      reply.writeHead(500, { 'Content-Type': 'application/json' });
      reply.end(JSON.stringify({ code: 'INTERNAL_ERROR', message: cause instanceof Error ? cause.message : '' }));
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port, host, () => resolve());
  });
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : options.port;
  return {
    url: `http://${host}:${port}`,
    close: () => new Promise<void>((resolve, reject) => {
      server.close(error => (error ? reject(error) : resolve()));
    }),
  };
}
