import { describe, expect, it } from 'vitest';
import { createFixture } from '../test-support/project-fixture.ts';
import { printEffect } from '../contracts/effects.ts';

// A source-file trivia range may overlap the first function's dedicated comment.
// That comment is not a declaration of module initialization effects.
describe('module and callable contract ownership', () => {
  it('does not charge importing a first annotated function as invoking it', () => {
    const fixture = createFixture({
      files: {
        'storage.ts': `\
/** @effects ["localstorage.write(*)"] */
export function save() { localStorage.clear(); }
`,
        'main.ts': `\
import { save } from './storage';
/** @effects ["localstorage.write(*)"] */
export function invoke() { save(); }
`,
      },
      entries: ['main.ts'],
    });
    try {
      const analysis = fixture.check();
      expect(analysis.diagnostics).toEqual([]);
      for (const owner of analysis.owners.filter(owner => owner.role === 'module')) {
        expect(owner.annotation).toBeUndefined();
        expect(analysis.solution.rows.get(owner.id)).toEqual([]);
      }
      const invoked = analysis.owners.find(owner => owner.label === 'invoke')!;
      expect(analysis.solution.rows.get(invoked.id)?.map(effect => printEffect({ effect }))).toEqual(['localstorage.write(*)']);
    } finally {
      fixture.dispose();
    }
  });
});
