import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('./public', import.meta.url)));
const port = Number(process.env.PORT ?? 4174);
const host = process.env.HOST ?? '127.0.0.1';

const contentTypes = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
};

function notFound(response) {
  response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  response.end('Not found');
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);
  const requested = url.pathname === '/' ? '/index.html' : url.pathname;
  const candidate = resolve(join(root, normalize(requested)));

  // Serve only from inside demo-target/public.
  if (!candidate.startsWith(root)) {
    notFound(response);
    return;
  }

  try {
    const body = await readFile(candidate);
    response.writeHead(200, {
      'Content-Type': contentTypes[extname(candidate)] ?? 'application/octet-stream',
      'Cache-Control': 'no-store',
    });
    response.end(body);
  } catch {
    notFound(response);
  }
});

server.listen(port, host, () => {
  console.log(`Centopus demo target: http://${host}:${port}`);
  console.log('Authorized, local, disposable. No external network calls, no real data.');
});
