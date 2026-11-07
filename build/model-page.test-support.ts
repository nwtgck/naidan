import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { IncomingMessage, ServerResponse } from 'node:http';
import { Socket } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { vi } from 'vitest';
import { createServer, type ViteDevServer } from 'vite';
import { createModelPageDevPlugin } from './model-page-dev';
import { createDocumentMetadataHtmlPlugin } from './document-metadata-html';

const repository = fileURLToPath(new URL('..', import.meta.url));

export async function createModelPageFixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'naidan-model-page-'));
  try {
    for (const file of [
      'src/features/llama-cpp-browser/model-launch/page-entries.ts',
      'src/features/llama-cpp-browser/model-launch/page-url.ts',
      'src/features/llama-cpp-browser/model-launch/document-metadata.ts',
      'src/features/llama-cpp-browser/hugging-face/model-repositories.ts',
      'src/logic/document-metadata.ts',
      'src/utils/exact-object.ts',
    ]) {
      await mkdir(path.dirname(path.join(root, file)), { recursive: true });
      await cp(path.join(repository, file), path.join(root, file));
    }
    await symlink(path.join(repository, 'node_modules'), path.join(root, 'node_modules'), 'dir');
    await writeFile(path.join(root, 'package.json'), '{"type":"module"}');
    await writeFile(path.join(root, 'index.html'), '<!doctype html><html lang="en"><head><meta charset="UTF-8"><meta name="referrer" content="no-referrer"><!-- naidan-document-metadata --><link rel="icon" href="./favicon.svg"></head><body><div id="app"></div><script type="module" src="/entry.ts"></script></body></html>');
    await writeFile(path.join(root, 'entry.ts'), 'import "./style.css"; document.querySelector("#app").setAttribute("data-booted", "yes");');
    await writeFile(path.join(root, 'style.css'), 'body { margin: 0; }');
    return { root, [Symbol.asyncDispose]: () => rm(root, { recursive: true, force: true }) };
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}

export async function createModelPageDev({ root }: { root: string }) {
  const server = await createServer({
    configFile: false,
    root,
    logLevel: 'silent',
    server: { middlewareMode: true, ws: false },
    optimizeDeps: { noDiscovery: true, include: [] },
    css: { postcss: { plugins: [] } },
    plugins: [createDocumentMetadataHtmlPlugin(), createModelPageDevPlugin(), {
      name: 'model-page-test-fallthrough',
      configureServer(server) {
        server.middlewares.use((_request, response) => {
          response.statusCode = 418;
          response.end('downstream');
        });
      },
    }],
  });
  return { server, [Symbol.asyncDispose]: () => server.close() };
}

export async function requestModelPage({ server, method, url }: { server: ViteDevServer, method: string, url: string }) {
  const socket = new Socket();
  const request = new IncomingMessage(socket);
  request.method = method;
  request.url = url;
  request.headers.host = 'localhost';
  const response = new ServerResponse(request);
  let body: unknown;
  await new Promise<void>((resolve, reject) => {
    vi.spyOn(response, 'end').mockImplementation(chunk => {
      body = chunk;
      resolve();
      return response;
    });
    server.middlewares(request, response, error => reject(error ?? new Error('Model page middleware ended without a response')));
  }).finally(() => socket.destroy());
  return { status: response.statusCode, contentType: response.getHeader('Content-Type'), length: response.getHeader('Content-Length'), location: response.getHeader('Location'), body };
}

export async function replacePageSource({ root, file, before, after }: { root: string, file: string, before: string, after: string }): Promise<string> {
  const absolute = path.join(root, file);
  const source = await readFile(absolute, 'utf8');
  if (!source.includes(before)) {
    throw new Error('Missing fixture replacement');
  }
  await writeFile(absolute, source.replaceAll(before, after));
  return absolute;
}
