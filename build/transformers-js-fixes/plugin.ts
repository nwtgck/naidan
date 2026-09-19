import { readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { normalizePath, type Plugin } from 'vite';
import { TRANSFORMERS_JS_FIXES_PROVENANCE, transformersJsFixesSha256, applyTransformersJsFixes } from './transform';

export function readTransformersJsFixesPackage({ projectRoot }: { projectRoot: string }) {
  const packageRoot = realpathSync(path.join(projectRoot, 'node_modules/@huggingface/transformers'));
  // Validate even when Vite reuses optimized output and never calls transform.
  // No install hook, package mutation, network access or automatic patch update.
  for (const [relativePath, expected] of Object.entries(TRANSFORMERS_JS_FIXES_PROVENANCE.upstreamHashes)) {
    if (transformersJsFixesSha256({ code: readFileSync(path.join(packageRoot, relativePath)) }) !== expected) {
      throw new Error(`Unreviewed Transformers.js fix integration input: ${relativePath}`);
    }
  }
  const metadata = z.object({ name: z.literal('@huggingface/transformers'), version: z.literal('4.2.0') })
    .passthrough().parse(JSON.parse(readFileSync(path.join(packageRoot, 'package.json'), 'utf8')));
  return { packageRoot, version: metadata.version, bundlePath: path.join(packageRoot, 'dist/transformers.web.js') };
}

export function createTransformersJsFixesPlugin({ projectRoot }: { projectRoot: string }): Plugin {
  const installed = readTransformersJsFixesPackage({ projectRoot });
  // A warm optimizer cache may bypass transform entirely. Reject a changed
  // replacement implementation even when the approved output identity is stale.
  applyTransformersJsFixes({ code: readFileSync(installed.bundlePath, 'utf8'), version: installed.version });
  const target = normalizePath(installed.bundlePath);
  return {
    // Vite's dependency cache hashes plugin names, not transform source code.
    name: `naidan-transformers-js-fixes-${TRANSFORMERS_JS_FIXES_PROVENANCE.transformedWebSha256}`,
    enforce: 'pre',
    transform(code, id) {
      if (normalizePath(id.split(/[?#]/u, 1)[0] ?? id) !== target) return undefined;
      const result = applyTransformersJsFixes({ code, version: installed.version });
      return { code: result.code, map: result.map, meta: { naidanTransformersJsFixes: {
        patchId: TRANSFORMERS_JS_FIXES_PROVENANCE.patchId,
        originalSha256: result.originalSha256,
        transformedSha256: result.transformedSha256,
      } } };
    },
  };
}

/** One registration responsibility for the client, Worker and dependency optimizer. */
export function createTransformersJsFixesViteConfig({ projectRoot, mode }: {
  projectRoot: string; mode: 'browser' | 'standalone';
}) {
  function plugins(): Plugin[] {
    switch (mode) {
    case 'browser': return [createTransformersJsFixesPlugin({ projectRoot })];
    case 'standalone': return [];
    default: {
      const _ex: never = mode;
      throw new Error(`Unhandled Transformers fix integration mode: ${_ex}`);
    }
    }
  }
  return { plugins: plugins(), worker: { plugins }, optimizeDeps: { rolldownOptions: { plugins: plugins() } } };
}

export const TEST_ONLY = {
};
