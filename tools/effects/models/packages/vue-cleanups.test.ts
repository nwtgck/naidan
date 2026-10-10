import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { checkVueSource, vueFixture } from '../../test-support/vue-fixture.ts';
import { printEffect } from '../../contracts/effects.ts';
import type { EffectsAnalysis } from '../../analysis/analyze.ts';
import { reviewEffects } from '../../review.ts';

function row({ analysis, label }: { analysis: EffectsAnalysis, label: string }): string[] {
  const owner = analysis.owners.find(item => item.label === label && item.role !== 'body')!;
  expect(owner, label).toBeDefined();
  return (analysis.solution.rows.get(owner.id) ?? []).map(effect => printEffect({ effect }));
}

function check({ source }: { source: string }): EffectsAnalysis {
  const analysis = checkVueSource({ source });
  expect(analysis.diagnostics.filter(item => item.code !== 'missing' && item.code !== 'exceeds')).toEqual([]);
  return analysis;
}

describe('watcher cleanup contracts (not reactive causality)', () => {
  it.each(['handle()', 'handle.stop()'])('does not rerun a source or ordinary callback for %s', call => {
    const analysis = check({
      source: `\
function source() { return localStorage.getItem('x') ?? ''; }
const handle = watch(source, value => { sessionStorage.setItem('x', value); });
function stop() { ${call}; }
function resume() { handle.resume(); }
`,
    });
    expect(row({ analysis, label: 'stop' })).toEqual([]);
    expect(row({ analysis, label: 'resume' })).toEqual(['localstorage.read(*)', 'sessionstorage.write(*)']);
  });

  it.each(['watchEffect', 'watchSyncEffect', 'watchPostEffect'])('isolates the cleanup row for %s', operation => {
    const analysis = check({
      source: `\
const handle = ${operation}(() => { localStorage.clear(); onWatcherCleanup(() => { sessionStorage.clear(); }); });
function stop() { handle.stop(); }
function resume() { handle.resume(); }
function pause() { handle.pause(); }
`,
    });
    expect(row({ analysis, label: 'stop' })).toEqual(['sessionstorage.write(*)']);
    expect(row({ analysis, label: 'resume' })).toEqual(['localstorage.write(*)', 'sessionstorage.write(*)']);
    expect(row({ analysis, label: 'pause' })).toEqual([]);
  });

  it('retains multiple conditional cleanups without assuming which branch ran', () => {
    const analysis = check({
      source: `\
const value = ref('');
const handle = watch(value, next => {
  if (next) onWatcherCleanup(() => { localStorage.clear(); });
  else onWatcherCleanup(() => { sessionStorage.clear(); });
});
function stop() { handle(); }
`,
    });
    expect(row({ analysis, label: 'stop' })).toEqual(['localstorage.write(*)', 'sessionstorage.write(*)']);
  });

  it.each(['direct', 'alias', 'slot'])('preserves cleanup through %s helper references', kind => {
    const callable = kind === 'direct' ? 'register' : kind === 'alias' ? 'alias' : 'slot.run';
    const binding = kind === 'direct' ? '' : kind === 'alias' ? 'const alias: () => void = register;' : 'const slot = { run: register };';
    const analysis = check({
      source: `\
function register() { onWatcherCleanup(() => { sessionStorage.clear(); }); }
${binding}
const handle = watchEffect(() => { localStorage.clear(); ${callable}(); });
function stop() { handle(); }
`,
    });
    expect(row({ analysis, label: 'stop' })).toEqual(['sessionstorage.write(*)']);
  });

  it('does not move an inner watcher cleanup into the outer watcher', () => {
    const analysis = check({
      source: `\
const handle = watchEffect(() => {
  onWatcherCleanup(() => { localStorage.clear(); });
  watchEffect(() => { onWatcherCleanup(() => { sessionStorage.clear(); }); });
});
function stop() { handle.stop(); }
`,
    });
    expect(row({ analysis, label: 'stop' })).toEqual(['localstorage.write(*)']);
  });

  it('does not treat onScopeDispose or a lifecycle callback as watcher cleanup', () => {
    const analysis = check({
      source: `\
const handle = watchEffect(() => {
  onScopeDispose(() => { localStorage.clear(); });
  onMounted(() => { onWatcherCleanup(() => { sessionStorage.clear(); }); });
});
function stop() { handle(); }
`,
    });
    expect(row({ analysis, label: 'stop' })).toEqual([]);
  });

  it('preserves an explicit inner-stop call inside the outer cleanup', () => {
    const analysis = check({
      source: `\
const inner = watchEffect(() => { onWatcherCleanup(() => { sessionStorage.clear(); }); });
const outer = watchEffect(() => { onWatcherCleanup(() => { inner.stop(); }); });
function stop() { outer(); }
`,
    });
    expect(row({ analysis, label: 'stop' })).toEqual(['sessionstorage.write(*)']);
  });

  it('does not leak an outer unsafe exemption into an independently deferred cleanup', () => {
    const analysis = check({
      source: `\
/** @effects [] */
/** @effectsUNSAFE {"effects":["localstorage.write(*)"],"reason":"Only the registration surface is exempt."} */
function callback() { onWatcherCleanup(() => { localStorage.clear(); }); }
const handle = watchEffect(callback);
function stop() { handle(); }
`,
    });
    expect(row({ analysis, label: 'callback' })).toEqual([]);
    expect(row({ analysis, label: 'stop' })).toEqual(['localstorage.write(*)']);
  });

  it('honors an unsafe exemption on the actual cleanup implementation', () => {
    const analysis = check({
      source: `\
/** @effects [] */
/** @effectsUNSAFE {"effects":["localstorage.write(*)"],"reason":"This exact cleanup is intentionally exempt."} */
function cleanup() { localStorage.clear(); }
const handle = watchEffect(() => { onWatcherCleanup(cleanup); });
function stop() { handle.stop(); }
`,
    });
    expect(row({ analysis, label: 'stop' })).toEqual([]);
  });

  it('does not treat an unused returned cleanup factory as a registration', () => {
    const analysis = check({
      source: `\
function factory() { return () => { onWatcherCleanup(() => { sessionStorage.clear(); }); }; }
const handle = watchEffect(() => { factory(); });
function stop() { handle(); }
`,
    });
    expect(row({ analysis, label: 'stop' })).toEqual([]);
  });

  it('preserves cleanup through a cycle of ordinary helper calls', () => {
    const analysis = check({
      source: `\
function first() { second(); }
function second() { if (Math.random()) first(); onWatcherCleanup(() => { localStorage.clear(); }); }
const handle = watchEffect(first);
function stop() { handle(); }
`,
    });
    expect(row({ analysis, label: 'stop' })).toEqual(['localstorage.write(*)']);
  });

  it('specializes cleanup for invoked callbacks without charging unrelated helper uses', () => {
    const analysis = check({
      source: `\
function invoke(operation: () => void) { operation(); }
const dirty = watchEffect(() => { invoke(() => { onWatcherCleanup(() => { localStorage.clear(); }); }); });
const clean = watchEffect(() => { invoke(() => { sessionStorage.clear(); }); });
function stopDirty() { dirty(); }
function stopClean() { clean(); }
`,
    });
    expect(row({ analysis, label: 'stopDirty' })).toEqual(['localstorage.write(*)']);
    expect(row({ analysis, label: 'stopClean' })).toEqual([]);
  });

  it('does not infer a cleanup from a callback that is only stored', () => {
    const analysis = check({
      source: `\
function ignore(operation: () => void) { void operation; }
const handle = watchEffect(() => { ignore(() => { onWatcherCleanup(() => { localStorage.clear(); }); }); });
function stop() { handle(); }
`,
    });
    expect(row({ analysis, label: 'stop' })).toEqual([]);
  });

  it('keeps declared ordinary bounds but does not manufacture cleanup registration facts', () => {
    const analysis = check({
      source: `\
/** @effects ["localstorage.write(*)"] */
function callback() {}
const handle = watchEffect(callback);
function stop() { handle(); }
function resume() { handle.resume(); }
`,
    });
    expect(row({ analysis, label: 'stop' })).toEqual([]);
    expect(row({ analysis, label: 'resume' })).toEqual(['localstorage.write(*)']);
  });

  it('preserves unrelated direct work in the stop wrapper', () => {
    const analysis = check({
      source: `\
const handle = watchEffect(() => { localStorage.clear(); });
function stop() { fetch('/stop'); handle.stop(); }
`,
    });
    expect(row({ analysis, label: 'stop' })).toEqual(['network.http(*)']);
  });

  it('keeps nested callback violations and does not silently fix unknown cleanup behavior', () => {
    const fixture = vueFixture({
      source: `\
const handle = watchEffect(() => { onWatcherCleanup(() => { new Proxy({}, {}); }); });
function stop() { handle(); }
`,
      extra: {},
    });
    try {
      expect(fixture.check().diagnostics.some(item => item.code === 'unsupported')).toBe(true);
      expect(() => fixture.fix()).toThrow();
    } finally {
      fixture.dispose();
    }
  });

  it('explains cleanup through helpers, fixes once and never writes synthetic annotations', () => {
    const fixture = vueFixture({
      source: `\
function register() { onWatcherCleanup(() => { localStorage.clear(); }); }
const handle = watchEffect(() => { register(); });
function stop() { handle(); }
`,
      extra: {},
    });
    try {
      const result = fixture.fix();
      expect(result.analysis.diagnostics).toEqual([]);
      const source = fs.readFileSync(path.join(fixture.root, 'main.ts'), 'utf8');
      expect(source).not.toContain('<watch cleanup>');
      expect(fixture.fix().changedFiles).toEqual([]);
      const review = reviewEffects({ analysis: result.analysis, budget: 100 }).find(item => item.label === 'stop')!;
      expect(review.witnesses[0]?.path.some(item => item.reason?.includes('cleanup'))).toBe(true);
    } finally {
      fixture.dispose();
    }
  });

  it('retains cleanup registered by an inner watch source getter in the active outer watcher', () => {
    const analysis = check({
      source: `\
const handle = watchEffect(() => {
  watch(() => { onWatcherCleanup(() => { localStorage.clear(); }); return ''; }, () => {});
});
function stop() { handle(); }
`,
    });
    expect(row({ analysis, label: 'stop' })).toEqual(['localstorage.write(*)']);
  });

  it('rejects reentrant cleanup registration rather than losing the next cleanup layer', () => {
    const analysis = checkVueSource({
      source: `\
const inner = watchEffect(() => {
  onWatcherCleanup(() => { onWatcherCleanup(() => { localStorage.clear(); }); });
});
const outer = watchEffect(() => { inner.stop(); });
function stop() { outer(); }
`,
    });
    expect(analysis.diagnostics.filter(item => item.code === 'typescript')).toEqual([]);
    expect(analysis.diagnostics.some(item => item.code === 'unsupported' && item.message.includes('Reentrant'))).toBe(true);
  });
});
