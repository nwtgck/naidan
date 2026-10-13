import { cp, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
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

export async function startSiteDev({ root }: { root: string }) {
  const server = await createServer({
    configFile: false,
    root,
    logLevel: 'error',
    plugins: [createDocsDevBridge()],
    server: { host: '127.0.0.1', port: 0, hmr: false },
    optimizeDeps: { noDiscovery: true, include: [] },
    css: { postcss: { plugins: [] } },
  });
  try {
    await server.listen();
    const address = server.httpServer?.address();
    if (!address || typeof address === 'string') throw new Error('Missing dev server address');
    return {
      server,
      origin: `http://127.0.0.1:${address.port}`,
      [Symbol.asyncDispose]: () => server.close(),
    };
  } catch (error) {
    await server.close();
    throw error;
  }
}

export function parsePage({ html }: { html: string }) {
  const dom = new JSDOM(html, { url: 'https://naidan-docs.invalid/docs/' });
  return {
    document: dom.window.document,
    [Symbol.dispose]: () => dom.window.close(),
  };
}
