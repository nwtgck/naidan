import { createHash } from 'node:crypto';
import MagicString from 'magic-string';
import { z } from 'zod';
import originalProvenance from './provenance.json';
import originalReplacements from './replacements';

export const TRANSFORMERS_JS_FIXES_PROVENANCE = z.object({
  schemaVersion: z.literal(1), packageName: z.literal('@huggingface/transformers'),
  version: z.literal('4.2.0'), patchId: z.literal('naidan-transformers-js-fixes-v5'),
  upstreamHashes: z.object({
    'src/utils/model-loader.js': z.string().regex(/^[a-f0-9]{64}$/u),
    'src/models/session.js': z.string().regex(/^[a-f0-9]{64}$/u),
    'src/models/modeling_utils.js': z.string().regex(/^[a-f0-9]{64}$/u),
    LICENSE: z.string().regex(/^[a-f0-9]{64}$/u),
    'dist/transformers.web.js': z.string().regex(/^[a-f0-9]{64}$/u),
    'package.json': z.string().regex(/^[a-f0-9]{64}$/u),
  }).strict(),
  transformedWebSha256: z.string().regex(/^[a-f0-9]{64}$/u),
  bundledJinja: z.object({
    version: z.literal('0.5.6'), sectionSha256: z.string().regex(/^[a-f0-9]{64}$/u),
    licenseSha256: z.string().regex(/^[a-f0-9]{64}$/u), licenseSource: z.string().min(1),
  }).strict(),
  changes: z.array(z.string()), scope: z.string(),
}).strict().parse(originalProvenance);
const replacements = z.array(z.object({ before: z.string().min(1), after: z.string() }).strict()).length(11).parse(originalReplacements);

export function transformersJsFixesSha256({ code }: { code: string | Uint8Array }): string {
  return createHash('sha256').update(code).digest('hex');
}

/** The same bounded transform is used by Vite, its optimizer and runtime replay builds. */
export function applyTransformersJsFixes({ code, version }: { code: string; version: string }) {
  if (version !== TRANSFORMERS_JS_FIXES_PROVENANCE.version) throw new Error('Unreviewed Transformers.js fix integration version');
  const originalSha256 = transformersJsFixesSha256({ code });
  if (originalSha256 !== TRANSFORMERS_JS_FIXES_PROVENANCE.upstreamHashes['dist/transformers.web.js']) {
    throw new Error('Unreviewed Transformers.js web bundle content');
  }
  const transformed = new MagicString(code);
  for (const { before, after } of replacements) {
    const start = code.indexOf(before);
    if (start < 0 || code.indexOf(before, start + before.length) >= 0) throw new Error('Ambiguous Transformers.js fix integration edit');
    transformed.overwrite(start, start + before.length, after);
  }
  const result = transformed.toString();
  const transformedSha256 = transformersJsFixesSha256({ code: result });
  if (transformedSha256 !== TRANSFORMERS_JS_FIXES_PROVENANCE.transformedWebSha256) {
    throw new Error('Unreviewed Transformers.js fix integration output');
  }
  return {
    code: result,
    // The installed web bundle has no upstream map. Map edits to its original
    // bundled source; never pretend this map points to the individual src files.
    map: transformed.generateMap({ hires: true, source: 'transformers.web.js', includeContent: true }),
    originalSha256,
    transformedSha256,
  };
}

export const TEST_ONLY = {
};
