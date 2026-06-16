import type { FakeLmContext } from '@/services/fake-lm/core/languagePack';
import type { FakeLmToneKey, FakeLmToneScores } from '@/services/fake-lm/core/inputAnalysis';
import { pickWeighted } from '@/services/fake-lm/core/weighted';

export type TextPatternSlot =
  | 'nounPhrase'
  | 'abstractNoun'
  | 'physicalNoun'
  | 'livingNoun'
  | 'timeNoun'
  | 'normalAdjective'
  | 'wrongAdjective'
  | 'connector'
  | 'inputKeyword'
  | 'inputKeywordPhrase'
  | 'inputReference'
  | 'inputGreeting';

export type TextPatternPart = string | { slot: TextPatternSlot };

export type TextPatternRequirement = 'inputKeyword' | 'inputGreeting';

export type TextPattern = {
  weight: number;
  parts: TextPatternPart[];
  affinity?: Partial<Record<FakeLmToneKey, number>>;
  requires?: TextPatternRequirement[];
  containsNotAlways?: boolean;
};

export type PatternHistory = {
  recentPatternKeys: string[];
  notAlwaysCount: number;
  recentInputKeywords: string[];
};

export function createPatternHistory(): PatternHistory {
  return {
    recentPatternKeys: [],
    notAlwaysCount: 0,
    recentInputKeywords: [],
  };
}

export function pickTextPattern({ patterns, ctx, category }: {
  patterns: readonly TextPattern[];
  ctx: FakeLmContext;
  category: string;
}): { pattern: TextPattern; key: string } {
  const weighted = patterns
    .map((pattern, index) => {
      const key = `${category}:${index}`;
      return {
        value: { pattern, key },
        weight: makePatternWeight({ pattern, key, ctx, category }),
      };
    })
    .filter((item) => item.weight > 0);

  if (weighted.length === 0) {
    const fallback = patterns.find((pattern) => makePatternWeight({ pattern, key: `${category}:fallback`, ctx, category }) > 0)
      ?? patterns.find((pattern) => patternRequiresAvailableInput({ pattern, ctx }))
      ?? patterns[0];
    if (fallback === undefined) {
      throw new Error(`Fake LM text patterns are empty: ${category}`);
    }
    return { pattern: fallback, key: `${category}:fallback` };
  }

  return pickWeighted({ items: weighted, random: ctx.random });
}

export function recordTextPatternUse({ pattern, key, ctx }: {
  pattern: TextPattern;
  key: string;
  ctx: FakeLmContext;
}): void {
  ctx.patternHistory.recentPatternKeys = [
    key,
    ...ctx.patternHistory.recentPatternKeys,
  ].slice(0, 6);

  if (pattern.containsNotAlways === true) {
    ctx.patternHistory.notAlwaysCount += 1;
  }
}

export function recordInputKeywordUse({ keyword, ctx }: {
  keyword: string;
  ctx: FakeLmContext;
}): void {
  ctx.patternHistory.recentInputKeywords = [
    keyword,
    ...ctx.patternHistory.recentInputKeywords,
  ].slice(0, 3);
}

export function renderTextPattern({ pattern, ctx, renderSlot }: {
  pattern: TextPattern;
  ctx: FakeLmContext;
  renderSlot: ({ slot, ctx }: { slot: TextPatternSlot; ctx: FakeLmContext }) => string;
}): string {
  return pattern.parts.map((part) => {
    if (typeof part === 'string') {
      return part;
    }

    return renderSlot({ slot: part.slot, ctx });
  }).join('');
}

function patternRequiresAvailableInput({ pattern, ctx }: {
  pattern: TextPattern;
  ctx: FakeLmContext;
}): boolean {
  if (pattern.requires?.includes('inputKeyword') === true && ctx.inputAnalysis.keywords.length === 0) {
    return false;
  }

  if (pattern.requires?.includes('inputGreeting') === true && ctx.inputAnalysis.greeting === undefined) {
    return false;
  }

  return true;
}

function makePatternWeight({ pattern, key, ctx, category }: {
  pattern: TextPattern;
  key: string;
  ctx: FakeLmContext;
  category: string;
}): number {
  if (category === 'opening' && ctx.inputAnalysis.toneScores.greeting >= 0.85 && pattern.affinity?.greeting === undefined) {
    return 0;
  }

  if (!patternRequiresAvailableInput({ pattern, ctx })) {
    return 0;
  }

  if (pattern.containsNotAlways === true && ctx.patternHistory.notAlwaysCount >= 2) {
    return 0;
  }

  let weight = pattern.weight;

  if (ctx.patternHistory.recentPatternKeys.includes(key)) {
    weight *= 0.08;
  }

  if (pattern.affinity !== undefined) {
    weight *= makeAffinityMultiplier({ toneScores: ctx.inputAnalysis.toneScores, affinity: pattern.affinity });
  }

  return weight;
}

function makeAffinityMultiplier({ toneScores, affinity }: {
  toneScores: FakeLmToneScores;
  affinity: Partial<Record<FakeLmToneKey, number>>;
}): number {
  const tonePull = Object.entries(affinity).reduce((sum, [key, value]) => {
    const toneKey = key as FakeLmToneKey;
    return sum + toneScores[toneKey] * (value ?? 0);
  }, 0);

  if (tonePull <= 0) {
    return 0.35;
  }

  return 1 + tonePull * 2.4;
}
