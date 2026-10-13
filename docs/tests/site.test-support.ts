import { cp, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { IncomingMessage, ServerResponse } from 'node:http';
import type { Socket } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Duplex } from 'node:stream';
import { createServer } from 'vite';
import { JSDOM } from 'jsdom';
import { createDocsDevBridge } from '../../build/docs-dev-bridge';

const repository = fileURLToPath(new URL('../..', import.meta.url));

export async function createSiteFixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'naidan-docs-'));
  try {
    await cp(path.join(repository, 'docs'), path.join(root, 'docs'), {
      recursive: true,
      filter: source => !['dist', '.cache', 'tests'].includes(path.basename(source)),
    });
    await symlink(path.join(repository, 'node_modules'), path.join(root, 'node_modules'), 'dir');
    await writeFile(path.join(root, 'package.json'), JSON.stringify({ type: 'module' }));
    await writeFile(path.join(root, 'index.html'), '<!doctype html><html><head><title>App fixture</title></head><body>APP-ONLY</body></html>');
    await cp(path.join(repository, 'tsconfig.node.json'), path.join(root, 'tsconfig.node.json'));
    await mkdir(path.join(root, 'build'));
    await cp(path.join(repository, 'build/docs-dev-bridge.ts'), path.join(root, 'build/docs-dev-bridge.ts'));
    return {
      root,
      docs: path.join(root, 'docs'),
      [Symbol.asyncDispose]: () => rm(root, { recursive: true, force: true }),
    };
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}

class MemorySocket extends Duplex {
  readonly chunks: Buffer[] = [];

  override _read(): void {}

  override _write(...[chunk, , done]: Parameters<Duplex['_write']>): void {
    this.chunks.push(Buffer.from(chunk));
    done();
  }
}

function responseBody({ wire }: { wire: Buffer }): Buffer {
  const separator = wire.indexOf('\r\n\r\n');
  if (separator < 0) throw new Error('Incomplete in-process HTTP response');
  const head = wire.subarray(0, separator).toString('latin1');
  const content = wire.subarray(separator + 4);
  if (!/\r\ntransfer-encoding: chunked\r\n/i.test(`\r\n${head}\r\n`)) return content;
  const chunks: Buffer[] = [];
  let offset = 0;
  for (;;) {
    const line = content.indexOf('\r\n', offset);
    if (line < 0) throw new Error('Incomplete chunked response');
    const size = Number.parseInt(content.subarray(offset, line).toString('ascii'), 16);
    if (!Number.isFinite(size)) throw new Error('Invalid chunked response');
    if (size === 0) return Buffer.concat(chunks);
    const start = line + 2;
    const end = start + size;
    if (end + 2 > content.length) throw new Error('Incomplete chunked response');
    chunks.push(content.subarray(start, end));
    offset = end + 2;
  }
}

export async function startSiteDev({ root }: { root: string }) {
  const server = await createServer({
    configFile: false,
    root,
    logLevel: 'error',
    plugins: [createDocsDevBridge()],
    server: { middlewareMode: true, hmr: false, ws: false },
    optimizeDeps: { noDiscovery: true, include: [] },
    css: { postcss: { plugins: [] } },
  });
  return {
    server,
    async request({ url, method = 'GET' }: { url: string; method?: string }): Promise<Response> {
      const socket = new MemorySocket();
      const incoming = new IncomingMessage(socket as unknown as Socket);
      incoming.url = url;
      incoming.method = method;
      incoming.headers.host = 'localhost';
      const outgoing = new ServerResponse(incoming);
      outgoing.assignSocket(socket as unknown as Socket);
      await new Promise<void>((resolve, reject) => {
        outgoing.once('finish', resolve);
        outgoing.once('error', reject);
        server.middlewares(incoming, outgoing, reject);
      });
      const headers = new Headers();
      for (const [name, value] of Object.entries(outgoing.getHeaders())) {
        if (value !== undefined) headers.set(name, String(value));
      }
      return new Response(responseBody({ wire: Buffer.concat(socket.chunks) }).toString('utf8'), { status: outgoing.statusCode, headers });
    },
    [Symbol.asyncDispose]: () => server.close(),
  };
}

export function parsePage({ html }: { html: string }) {
  const dom = new JSDOM(html, { url: 'https://naidan-docs.invalid/docs/' });
  return {
    document: dom.window.document,
    [Symbol.dispose]: () => dom.window.close(),
  };
}
