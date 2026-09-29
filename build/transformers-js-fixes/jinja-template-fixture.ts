import { readFileSync } from 'node:fs';
import { TRANSFORMERS_JS_FIXES_PROVENANCE, transformersJsFixesSha256 } from './transform';

interface TemplateInstance {
  // Exact bundled Jinja public API.
  render(items?: Record<string, unknown>): string;
}

export function bundledJinjaTemplate({ code }: { code: string }) {
  const from = code.indexOf('var TOKEN_TYPES = Object.freeze({');
  const to = code.indexOf('// src/utils/hub/FileResponse.js', from);
  if (from < 0 || to < from) throw new Error('Reviewed bundled Jinja section is missing');
  // Execute actual original/transformed browser code, not installed Jinja's
  // different version or a second test-specific implementation of the fix.
  return new Function(`${code.slice(from, to)}\nreturn Template;`)() as new (template: string) => TemplateInstance;
}

export function originalBundledJinjaTemplate() {
  const code = readFileSync('node_modules/@huggingface/transformers/dist/transformers.web.js', 'utf8');
  if (transformersJsFixesSha256({ code }) !== TRANSFORMERS_JS_FIXES_PROVENANCE.upstreamHashes['dist/transformers.web.js']) {
    throw new Error('Unreviewed original browser bundle');
  }
  return bundledJinjaTemplate({ code });
}

export const TEST_ONLY = {};
