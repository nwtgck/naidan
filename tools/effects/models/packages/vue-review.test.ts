import { effectScope, ref, watch } from 'vue';
import { describe, expect, it } from 'vitest';
import { checkVueSource } from '../../test-support/vue-fixture.ts';
import { printEffect } from '../../contracts/effects.ts';
import { reviewEffects } from '../../review.ts';

/** Regression for the reviewed over-approximation: stopping is not rerunning the callback. */
describe('Vue lifetime upper bounds versus a concrete no-cleanup execution', () => {
  it('keeps the callback bound on registration but removes it from a no-cleanup stop', () => {
    const result = checkVueSource({
      source: `\
const value = ref('');
function writer(next: string) { localStorage.setItem('x', next); }
const stop = watch(value, writer);
function stopWatching() { stop(); }
function setValue() { value.value = 'new'; }
`,
    });
    expect(result.diagnostics.filter(item => item.code !== 'missing' && item.code !== 'exceeds')).toEqual([]);
    const stopOwner = result.owners.find(owner => owner.label === 'stopWatching')!;
    const setter = result.owners.find(owner => owner.label === 'setValue')!;
    expect(result.solution.rows.get(stopOwner.id)?.map(effect => printEffect({ effect }))).toEqual([]);
    expect(result.solution.rows.get(setter.id)).toEqual([]);
    const explained = reviewEffects({ analysis: result, budget: 100 }).find(item => item.label === 'stopWatching')!;
    expect(explained.witnesses).toEqual([]);
    let writes = 0;
    const scope = effectScope();
    try {
      scope.run(() => {
        const value = ref('');
        const stop = watch(value, () => {
          writes++;
        });
        expect(writes).toBe(0);
        stop();
        expect(writes).toBe(0);
      });
    } finally {
      scope.stop();
    }
    expect(writes).toBe(0);
  });
});
