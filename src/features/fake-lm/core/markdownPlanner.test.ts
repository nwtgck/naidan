import { describe, expect, it } from 'vitest';

import { makeMarkdownPlan } from '@/features/fake-lm/core/markdownPlanner';
import { createSeededNonCryptoPseudoRandom } from '@/features/fake-lm/core/random';

describe('makeMarkdownPlan', () => {
  it('always ends with a closing paragraph after enough body blocks', () => {
    const plan = makeMarkdownPlan({
      random: createSeededNonCryptoPseudoRandom({ seed: 123 }),
    });

    expect(plan.length).toBeGreaterThanOrEqual(7);
    expect(plan.at(-1)).toEqual({ kind: 'closingParagraph' });
  });

  it('adds readable body content after tables and headings', () => {
    for (let seed = 1; seed <= 100; seed += 1) {
      const plan = makeMarkdownPlan({
        random: createSeededNonCryptoPseudoRandom({ seed }),
      });

      for (let index = 0; index < plan.length - 1; index += 1) {
        const current = plan[index]!;
        const next = plan[index + 1]!;

        if (current.kind === 'table' || current.kind === 'heading') {
          expect(next.kind).toBe('paragraph');
        }
      }
    }
  });
});
