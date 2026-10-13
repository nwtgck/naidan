import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { build } from 'vite';
import { describe, expect, it } from 'vitest';
import { docsBuildConfig } from '../build/production';
import { createSiteFixture } from './site.test-support';

const runNode = promisify(execFile);

// A separate process sets up the DOM before loading the real production bundle.
// This tests emitted ESM rather than recompiling client source through Vitest.
const exerciseProductionBundle = `\
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { JSDOM } from 'jsdom';
const [dist, locale] = process.argv.slice(1);
const dom = new JSDOM(await readFile(path.join(dist, locale, 'chat/branching/index.html'), 'utf8'), {
  url: 'https://naidan.invalid/docs/' + locale + '/chat/branching/',
  pretendToBeVisual: true,
});
const errors = [];
console.warn = (...values) => errors.push(values.map(String).join(' '));
console.error = (...values) => errors.push(values.map(String).join(' '));
try {
  for (const name of ['window', 'document', 'Element', 'HTMLElement', 'SVGElement', 'Node', 'MutationObserver', 'navigator']) {
    Object.defineProperty(globalThis, name, { configurable: true, value: name === 'window' ? dom.window : dom.window[name] });
  }
  const { document } = dom.window;
  const root = document.querySelector('[data-docs-island]');
  const copy = JSON.parse(root.getAttribute('data-docs-props')).copy;
  const original = document.querySelector('[data-testid="branch-original"]');
  const alternative = document.querySelector('[data-testid="branch-alternative"]');
  const reply = document.querySelector('[data-testid="branch-reply"]');
  assert.equal(original.disabled, true);
  assert.equal(reply.textContent, copy.replies[0]);
  const source = new URL(document.querySelector('script[src]').getAttribute('src'), 'https://naidan.invalid');
  await import(pathToFileURL(path.join(dist, source.pathname.slice('/docs/'.length))).href);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(alternative.disabled, false);
  alternative.click();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(reply.textContent, copy.replies[1]);
  assert.equal(alternative.getAttribute('aria-pressed'), 'true');
  document.querySelector('[data-testid="branch-reset"]').click();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(reply.textContent, copy.replies[0]);
  assert.equal(root.dataset.docsHydrated, 'ready');
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ locale, result: 'passed', errors }));
} finally {
  dom.window.close();
}
`;

describe('emitted production island', () => {
  it.each(['en', 'ja'])('hydrates %s HTML with the actual generated JavaScript', async locale => {
    await using fixture = await createSiteFixture();
    await build({ ...docsBuildConfig({ root: fixture.docs }), configFile: false, logLevel: 'silent' });
    const result = await runNode(process.execPath, ['--input-type=module', '-e', exerciseProductionBundle, `${fixture.docs}/dist`, locale], {
      cwd: fixture.root,
      timeout: 15000,
      maxBuffer: 1024 * 1024,
    });
    expect(JSON.parse(result.stdout)).toEqual({ locale, result: 'passed', errors: [] });
    expect(result.stderr).toBe('');
  });
});
