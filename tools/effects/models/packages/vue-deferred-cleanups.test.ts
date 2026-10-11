import { describe, expect, it } from 'vitest';
import { vueFixture } from '../../test-support/vue-fixture.ts';
import { printEffect } from '../../contracts/effects.ts';

const mechanisms = [
  { name: 'direct', body: 'onWatcherCleanup(cleanup);', stop: ['sessionstorage.write(*)'] },
  { name: 'Promise executor', body: 'new Promise<void>(resolve => { onWatcherCleanup(cleanup); resolve(); });', stop: ['sessionstorage.write(*)'] },
  { name: 'queueMicrotask', body: 'queueMicrotask(() => { localStorage.clear(); onWatcherCleanup(cleanup); });', stop: [] },
  { name: 'setTimeout', body: 'setTimeout(() => { localStorage.clear(); onWatcherCleanup(cleanup); });', stop: [] },
  { name: 'setInterval', body: 'setInterval(() => { localStorage.clear(); onWatcherCleanup(cleanup); });', stop: [] },
  { name: 'requestAnimationFrame', body: 'requestAnimationFrame(() => { localStorage.clear(); onWatcherCleanup(cleanup); });', stop: [] },
  { name: 'Promise.then', body: 'Promise.resolve().then(() => { localStorage.clear(); onWatcherCleanup(cleanup); });', stop: [] },
  { name: 'Promise.catch', body: 'Promise.resolve().catch(() => { localStorage.clear(); onWatcherCleanup(cleanup); });', stop: [] },
  { name: 'Promise.finally', body: 'Promise.resolve().finally(() => { localStorage.clear(); onWatcherCleanup(cleanup); });', stop: [] },
];

describe('watcher cleanup synchronous callback regions', () => {
  it.each(mechanisms)('keeps ordinary I/O but isolates cleanup in $name', ({ body, stop }) => {
    using fixture = vueFixture({
      source: `\
function cleanup() { sessionStorage.clear(); }
const handle = watchEffect(() => { ${body} });
function entry() { handle.stop(); }
`,
      extra: {},
    });
    const result = fixture.fix();
    expect(result.analysis.diagnostics).toEqual([]);
    const entry = result.analysis.owners.find(owner => owner.label === 'entry' && owner.role === 'implementation')!;
    expect((result.analysis.solution.rows.get(entry.id) ?? []).map(effect => printEffect({ effect }))).toEqual(stop);
    const module = result.analysis.owners.find(owner => owner.role === 'module')!;
    const ordinary = (result.analysis.solution.rows.get(module.id) ?? []).map(effect => printEffect({ effect }));
    expect(ordinary).toContain('sessionstorage.write(*)');
    if (stop.length === 0) expect(ordinary).toContain('localstorage.write(*)');
    expect(fixture.fix().changedFiles).toEqual([]);
  });
});
