import type { BlockPlan } from '@/features/fake-lm/core/markdownTypes';
import { randomInt, type SeededNonCryptoPseudoRandom } from '@/features/fake-lm/core/random';
import { pickWeighted } from '@/features/fake-lm/core/weighted';

export function makeMarkdownPlan({ random }: {
  random: SeededNonCryptoPseudoRandom,
}): BlockPlan[] {
  const bodyBlockCount = pickWeighted({
    random,
    items: [
      { value: 6, weight: 12 },
      { value: 7, weight: 28 },
      { value: 8, weight: 34 },
      { value: 9, weight: 20 },
      { value: 10, weight: 6 },
    ],
  });

  const plans: BlockPlan[] = [];
  let tableCount = 0;

  for (let index = 0; index < bodyBlockCount; index += 1) {
    const block = makeBlockPlanAt({ random, index, blockCount: bodyBlockCount, tableCount });
    switch (block.kind) {
    case 'table':
      tableCount += 1;
      break;
    case 'openingParagraph':
    case 'paragraph':
    case 'heading':
    case 'list':
      break;
    case 'closingParagraph':
      break;
    default: {
      const _ex: never = block;
      throw new Error(`Unhandled fake LM block plan: ${String(_ex)}`);
    }
    }
    plans.push(block);
  }

  return normalizeBlockPlan({
    plans: [
      ...plans,
      { kind: 'closingParagraph' },
    ],
  });
}

function makeBlockPlanAt({ random, index, blockCount, tableCount }: {
  random: SeededNonCryptoPseudoRandom,
  index: number,
  blockCount: number,
  tableCount: number,
}): BlockPlan {
  if (index === 0) {
    return { kind: 'openingParagraph', sentenceCount: randomInt({ random, min: 2, max: 3 }) };
  }

  if (index === blockCount - 1) {
    return { kind: 'paragraph', sentenceCount: randomInt({ random, min: 2, max: 3 }) };
  }

  return pickWeighted({
    random,
    items: [
      { value: { kind: 'paragraph' as const, sentenceCount: randomInt({ random, min: 2, max: 3 }) }, weight: 42 },
      { value: { kind: 'heading' as const, level: random() < 0.65 ? 2 as const : 3 as const }, weight: 16 },
      { value: { kind: 'list' as const, itemCount: randomInt({ random, min: 3, max: 5 }) }, weight: 26 },
      { value: { kind: 'table' as const, rowCount: randomInt({ random, min: 3, max: 5 }), columnCount: random() < 0.8 ? 2 as const : 3 as const }, weight: tableCount === 0 ? 16 : 1 },
    ],
  });
}

function normalizeBlockPlan({ plans }: {
  plans: BlockPlan[],
}): BlockPlan[] {
  const normalized: BlockPlan[] = [];
  let tableCount = 0;

  for (const plan of plans) {
    const previous = normalized[normalized.length - 1];
    if (
      previous?.kind === 'heading'
      && plan.kind !== 'openingParagraph'
      && plan.kind !== 'paragraph'
      && plan.kind !== 'closingParagraph'
    ) {
      normalized.push({ kind: 'paragraph', sentenceCount: 2 });
    }

    if (plan.kind === 'table' && (previous?.kind === 'table' || tableCount >= 1)) {
      normalized.push({ kind: 'list', itemCount: 4 });
      continue;
    }

    if (plan.kind === 'closingParagraph' && previous?.kind === 'heading') {
      normalized.push({ kind: 'paragraph', sentenceCount: 2 });
    }

    switch (plan.kind) {
    case 'table':
      tableCount += 1;
      normalized.push(plan);
      normalized.push({ kind: 'paragraph', sentenceCount: 2 });
      break;
    case 'heading':
    case 'openingParagraph':
    case 'paragraph':
    case 'list':
    case 'closingParagraph':
      normalized.push(plan);
      break;
    default: {
      const _ex: never = plan;
      throw new Error(`Unhandled fake LM block plan: ${String(_ex)}`);
    }
    }
  }

  return removeDuplicateParagraphsBeforeClosing({ plans: normalized });
}

function removeDuplicateParagraphsBeforeClosing({ plans }: {
  plans: BlockPlan[],
}): BlockPlan[] {
  if (plans.length < 3) {
    return plans;
  }

  const closingIndex = plans.length - 1;
  const beforeClosing = plans[closingIndex - 1];
  const beforeBeforeClosing = plans[closingIndex - 2];

  if (
    plans[closingIndex]?.kind === 'closingParagraph'
    && beforeClosing?.kind === 'paragraph'
    && beforeBeforeClosing?.kind === 'paragraph'
  ) {
    return [
      ...plans.slice(0, closingIndex - 1),
      { kind: 'list', itemCount: 4 },
      plans[closingIndex]!,
    ];
  }

  return plans;
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {};
