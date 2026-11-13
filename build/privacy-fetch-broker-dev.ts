import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { build, normalizePath, type Plugin } from 'vite';
import { parseAst } from 'rolldown/parseAst';
import { createBuildDom } from './jsdom.ts';
import { createTestOnlyBoundaryPlugin } from './test-only-boundary.ts';
import { createNodeEnvBoundaryPlugin } from './node-env-boundary.ts';

const BROKER_HTML = '/privacy-fetch-broker.html';
const BROKER_ENTRY = '/src/features/privacy-fetch/broker-entry.ts';
const BROKER_ASSETS = '/assets/privacy-fetch-broker/';
const BROKER_SCRIPT = `${BROKER_ASSETS}broker.js`;

function createBrokerHtml({ source, scriptUrl }: { source: string, scriptUrl: string }): string {
  const dom = createBuildDom({ html: source, options: undefined });
  try {
    const scripts = dom.window.document.querySelectorAll('script');
    const entry = scripts[0];
    // Do not silently lose template changes or allow unbundled dependencies to
    // escape the single-file contract. The hosted template remains the source.
    if (scripts.length !== 1 || entry?.getAttribute('type') !== 'module'
        || entry.getAttribute('src') !== BROKER_ENTRY) {
      throw new Error('Privacy fetch broker HTML must contain exactly its module entry script');
    }
    entry.setAttribute('src', scriptUrl);
    return dom.serialize();
  } finally {
    dom.window.close();
  }
}

function assertNoRuntimeImports({ node }: { node: unknown }): void {
  if (node === null || typeof node !== 'object') {
    return;
  }
  if ('type' in node && (node.type === 'ImportExpression' || node.type === 'ImportDeclaration'
      || node.type === 'ExportAllDeclaration' || (node.type === 'ExportNamedDeclaration' && 'source' in node && node.source !== null))) {
    throw new Error('Privacy fetch broker contains an unbundled module import');
  }
  for (const child of Object.values(node)) {
    assertNoRuntimeImports({ node: child });
  }
}

/** Bundle only the sandbox entry; never make arbitrary application modules CORS-readable. */
export function createPrivacyFetchBrokerDevPlugin(): Plugin {
  // Vite creates the replacement server before closing the old one. A plugin
  // object can be reused by both; cleanup must belong to each environment.
  const cleanupByEnvironment = new WeakMap<object, () => Promise<void>>();

  return {
    name: 'privacy-fetch-broker-dev',
    apply: 'serve',
    async configureServer(server) {
      // configureServer runs after Vite initializes the development environment.
      // Starting a Vite build earlier can change the process's NODE_ENV default.
      const config = server.config;
      const base = config.base;
      const htmlUrl = `${base}${BROKER_HTML.slice(1)}`;
      const scriptUrl = `${base}${BROKER_SCRIPT.slice(1)}`;
      const assetsUrl = `${base}${BROKER_ASSETS.slice(1)}`;
      const htmlFile = path.join(config.root, BROKER_HTML);
      const entryFile = path.join(config.root, BROKER_ENTRY);
      let closed = false;
      let failed = false;
      let published: { html: string, code: string } | undefined;
      let dependencies = new Set([normalizePath(htmlFile), normalizePath(entryFile)]);
      let dirty = false;
      let buildTask: Promise<void> | undefined;
      let closeTask: Promise<void> | undefined;
      let changeWait: Promise<void> | undefined;
      let finishChangeWait: (() => void) | undefined;
      let changeTimer: ReturnType<typeof setTimeout> | undefined;

      function finishPendingChange(): void {
        if (changeTimer !== undefined) {
          clearTimeout(changeTimer);
          changeTimer = undefined;
        }
        const finish = finishChangeWait;
        changeWait = undefined;
        finishChangeWait = undefined;
        finish?.();
      }

      function reportFailure({ error }: { error: unknown }) {
        if (closed) {
          return;
        }
        failed = true;
        const message = error instanceof Error ? error.message : String(error);
        config.logger.error(`[privacy-fetch-broker] ${message}`);
        if (config.server.hmr !== false) {
          server.environments.client?.hot.send({ type: 'error', err: { message, stack: '', plugin: 'privacy-fetch-broker-dev' } });
        }
      }

      const close = () => {
        closeTask ??= (async () => {
          closed = true;
          finishPendingChange();
          server.watcher.off('add', onFileAdded);
          server.watcher.off('change', onFileChanged);
          server.watcher.off('unlink', onFileChanged);
          await buildTask;
          published = undefined;
        })();
        return closeTask;
      };

      for (const environment of Object.values(server.environments)) {
        cleanupByEnvironment.set(environment, close);
      }

      server.middlewares.use((req, res, next) => {
        // Match the raw path, not a normalized traversal that could acquire this
        // namespace's headers before Vite resolves a different source file.
        const pathname = (req.url ?? '').split('?', 1)[0] ?? '';
        const isHtml = pathname === htmlUrl;
        if (!isHtml && !pathname.startsWith(assetsUrl)) {
          next();
          return;
        }
        res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
        res.setHeader('Cache-Control', 'no-store');
        res.setHeader('X-Content-Type-Options', 'nosniff');
        // This response bypasses Vite's response middleware, so explicitly keep
        // the parent's isolation policy and any custom response headers.
        for (const [name, value] of Object.entries(config.server.headers ?? {})) {
          if (value !== undefined && !['access-control-allow-origin', 'cross-origin-resource-policy', 'cache-control', 'content-type', 'content-length', 'x-content-type-options'].includes(name.toLowerCase())) {
            res.setHeader(name, value);
          }
        }
        if (!isHtml) {
          res.setHeader('Access-Control-Allow-Origin', '*');
        }
        const send = ({ status, body, type }: { status: number, body: string, type: string }) => {
          res.statusCode = status;
          res.setHeader('Content-Type', type);
          res.setHeader('Content-Length', Buffer.byteLength(body));
          res.end(req.method === 'HEAD' ? undefined : body);
        };
        if (req.method !== 'GET' && req.method !== 'HEAD') {
          res.setHeader('Allow', 'GET, HEAD');
          send({ status: 405, body: 'Method not allowed', type: 'text/plain; charset=utf-8' });
        } else if (!isHtml && pathname !== scriptUrl) {
          send({ status: 404, body: 'Unknown privacy fetch broker asset', type: 'text/plain; charset=utf-8' });
        } else if (closed || failed || published === undefined) {
          // Never silently serve the previous successful build after an error.
          send({ status: 503, body: 'Privacy fetch broker build unavailable; see the development server log', type: 'text/plain; charset=utf-8' });
        } else {
          send({ status: 200, body: isHtml ? published.html : published.code, type: isHtml ? 'text/html; charset=utf-8' : 'text/javascript; charset=utf-8' });
        }
      });

      async function compile() {
        const nextDependencies = new Set([normalizePath(htmlFile), normalizePath(entryFile)]);
        const source = await readFile(htmlFile, 'utf8');
        const html = createBrokerHtml({ source, scriptUrl });
        const result = await build({
          configFile: false,
          envFile: false,
          root: config.root,
          mode: config.mode,
          publicDir: false,
          logLevel: 'silent',
          base,
          // Reuse resolved values, not the main application's output plugins or
          // package hooks. In particular, DEV must not become false in this build.
          define: { 'process.env.NODE_ENV': JSON.stringify(config.isProduction ? 'production' : 'development'), ...config.define, 'import.meta.env': JSON.stringify(config.env) },
          resolve: {
            alias: config.resolve.alias,
            conditions: config.resolve.conditions,
            mainFields: config.resolve.mainFields,
            dedupe: config.resolve.dedupe,
            preserveSymlinks: config.resolve.preserveSymlinks,
          },
          plugins: [
            createTestOnlyBoundaryPlugin(),
            createNodeEnvBoundaryPlugin({ rootDir: config.root }),
            {
              name: 'privacy-fetch-broker-dev-dependencies',
              buildStart() {
                this.addWatchFile(htmlFile);
              },
              buildEnd() {
                // Collect both successful and partially resolved builds. These
                // files select rebuilds, never CORS permissions for raw sources.
                for (const id of this.getModuleIds()) {
                  const file = id.split(/[?#]/u, 1)[0] ?? '';
                  if (path.isAbsolute(file)) {
                    nextDependencies.add(normalizePath(file));
                    dependencies.add(normalizePath(file));
                  }
                }
                server.watcher.add([...nextDependencies]);
              },
            },
          ],
          build: {
            write: false,
            emptyOutDir: false,
            copyPublicDir: false,
            minify: false,
            sourcemap: false,
            reportCompressedSize: false,
            modulePreload: false,
            target: 'esnext',
            // Library mode avoids Vite's HTML preload rewriting. With an
            // inlined dynamic import, the HTML-build pipeline can leave an
            // unresolved __VITE_PRELOAD__ marker even with modulePreload:false.
            lib: { entry: entryFile, formats: ['es'], fileName: () => 'broker.js' },
            rolldownOptions: {
              preserveEntrySignatures: false,
              output: { format: 'es', entryFileNames: 'broker.js', codeSplitting: false },
            },
          },
        });
        const output = Array.isArray(result) ? (result.length === 1 ? result[0] : undefined) : result;
        if (output === undefined || !('output' in output)) {
          throw new Error('Privacy fetch broker build did not return a single output');
        }
        const outputs = output.output;
        const entry = outputs[0];
        if (outputs.length !== 1 || entry?.type !== 'chunk' || !entry.isEntry
            || entry.imports.length !== 0 || entry.dynamicImports.some(file => file !== entry.fileName)) {
          throw new Error('Privacy fetch broker must produce one self-contained JavaScript module (no CSS, workers, external imports or extra assets)');
        }
        // Rolldown can keep a self-edge in dynamicImports after inlining. The
        // syntax check also catches non-literal imports with no dependency edge.
        assertNoRuntimeImports({ node: parseAst(entry.code) });
        dependencies = nextDependencies;
        return { html, code: entry.code };
      }

      async function rebuild() {
        while (dirty && !closed) {
          if (changeWait !== undefined) {
            await changeWait;
            if (closed) {
              return;
            }
            if (changeWait !== undefined) {
              continue;
            }
          }
          dirty = false;
          try {
            const next = await compile();
            // A source may have changed during compilation. Do not publish or
            // reload a known-outdated generation; coalesce into one more build.
            if (closed || dirty) {
              continue;
            }
            const changed = published !== undefined && (published.code !== next.code || published.html !== next.html);
            const recovered = failed;
            published = next;
            failed = false;
            // An identical repair still needs to reload pages that saw a 503.
            if ((changed || recovered) && config.server.hmr !== false) {
              server.environments.client?.hot.send({ type: 'full-reload' });
            }
          } catch (error) {
            if (!dirty) {
              reportFailure({ error });
            }
          }
        }
      }

      function scheduleBuild(): Promise<void> {
        dirty = true;
        buildTask ??= rebuild().finally(() => {
          buildTask = undefined;
        });
        return buildTask;
      }

      function scheduleSourceChange(): void {
        // Vite's shared watcher coalesces rapid writes, including an immediate
        // repair of invalid HTML. Reading before that window ends can miss the
        // repair and leave the broker failed. Debounce only our rebuild; startup
        // remains immediate and shutdown cancels the wait. Errors fail closed.
        if (changeTimer !== undefined) {
          clearTimeout(changeTimer);
        }
        changeWait ??= new Promise<void>(resolve => {
          finishChangeWait = resolve;
        });
        changeTimer = setTimeout(finishPendingChange, 100);
        void scheduleBuild();
      }

      function onFileChanged(file: string) {
        const normalized = normalizePath(file);
        if (!closed && (failed || buildTask !== undefined || dependencies.has(normalized))) {
          scheduleSourceChange();
        }
      }

      function onFileAdded() {
        // New files can resolve a failed import or add a match to import.meta.glob
        // even without an existing graph edge. Reuse Vite's watcher and let the
        // output comparison avoid reloads for unrelated additions.
        if (!closed) {
          scheduleSourceChange();
        }
      }

      server.watcher.on('add', onFileAdded);
      server.watcher.on('change', onFileChanged);
      server.watcher.on('unlink', onFileChanged);
      // Initial compilation is part of startup. Syntax errors still let Vite
      // start with diagnostics and a 503, and later edits recover normally.
      await scheduleBuild();
    },
    // Vite calls closeBundle for both close() and restart(), including middleware
    // mode where there is no owned HTTP server to attach a 'close' listener to.
    async closeBundle() {
      await cleanupByEnvironment.get(this.environment)?.();
    },
    hotUpdate(options) {
      if (this.environment.name === 'client' && this.environment.config.server.hmr !== false
          && path.resolve(options.file) === path.resolve(this.environment.config.root, BROKER_HTML.slice(1))) {
        // The auxiliary build reloads the parent only after the new HTML and
        // JS have been published. A normal HTML reload races that publication.
        return [];
      }
      return options.modules;
    },
  };
}

export const TEST_ONLY = {
  createBrokerHtml,
};
