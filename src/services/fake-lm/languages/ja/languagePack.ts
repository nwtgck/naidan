import type { FakeLmContext } from '@/services/fake-lm/core/languagePack';
import type { Inline } from '@/services/fake-lm/core/markdownTypes';
import { pickTextPattern, recordInputKeywordUse, recordTextPatternUse, renderTextPattern, type TextPatternSlot } from '@/services/fake-lm/core/textPattern';
import { pickWeighted, oneOf } from '@/services/fake-lm/core/weighted';

export function makeJaNounPhrase({ ctx }: { ctx: FakeLmContext }): string {
  const d = ctx.lexicons;
  const r = ctx.random;

  return oneOf({
    random: r,
    factories: [
      { weight: 16, value: () => pickWeighted({ items: d.abstractNouns, random: r }) },
      { weight: 14, value: () => `${pickWeighted({ items: d.wrongAdjectives, random: r })}${pickWeighted({ items: d.physicalNouns, random: r })}` },
      { weight: 13, value: () => `${pickWeighted({ items: d.timeNouns, random: r })}の${pickWeighted({ items: d.abstractNouns, random: r })}` },
      { weight: 12, value: () => `${pickWeighted({ items: d.livingNouns, random: r })}の形をした${pickWeighted({ items: d.abstractNouns, random: r })}` },
      { weight: 10, value: () => `${pickWeighted({ items: d.physicalNouns, random: r })}に近い${pickWeighted({ items: d.timeNouns, random: r })}` },
      { weight: 9, value: () => `${pickWeighted({ items: d.normalAdjectives, random: r })}${pickWeighted({ items: d.livingNouns, random: r })}` },
    ],
  });
}

export function makeJaPredicatePhrase({ ctx }: { ctx: FakeLmContext }): string {
  const d = ctx.lexicons;
  const r = ctx.random;

  return oneOf({
    random: r,
    factories: [
      { weight: 16, value: () => `${makeJaNounPhrase({ ctx })}として${pickWeighted({ items: d.plainVerbs, random: r })}必要があります` },
      { weight: 14, value: () => `${makeJaNounPhrase({ ctx })}の近くで少しだけ${pickWeighted({ items: d.softVerbs, random: r })}ように見えます` },
      { weight: 12, value: () => `説明される前に${makeJaNounPhrase({ ctx })}へ移動します` },
      { weight: 10, value: () => `意味になるより先に${pickWeighted({ items: d.physicalNouns, random: r })}になります` },
      { weight: 8, value: () => `${pickWeighted({ items: d.timeNouns, random: r })}まで${pickWeighted({ items: d.softVerbs, random: r })}ことがあります` },
    ],
  });
}

export function makeJaSentence({ ctx }: { ctx: FakeLmContext }): Inline[] {
  return [{ kind: 'text', text: makeJaPatternText({ ctx, category: 'body' }) }];
}

export function makeJaHeading({ ctx }: { ctx: FakeLmContext }): Inline[] {
  return maybeBoldInline({ text: pickWeighted({ items: ctx.lexicons.headings, random: ctx.random }), ctx });
}

export function makeJaOpeningParagraph({ ctx, sentenceCount }: {
  ctx: FakeLmContext;
  sentenceCount: number;
}): Inline[] {
  return joinInlineSentences({
    sentences: [
      [{ kind: 'text', text: makeJaPatternText({ ctx, category: 'opening' }) }],
      ...Array.from({ length: Math.max(0, sentenceCount - 1) }, () => makeJaSentence({ ctx })),
    ],
    separator: '',
  });
}

export function makeJaParagraph({ ctx, sentenceCount }: {
  ctx: FakeLmContext;
  sentenceCount: number;
}): Inline[] {
  return joinInlineSentences({
    sentences: Array.from({ length: sentenceCount }, () => makeJaSentence({ ctx })),
    separator: '',
  });
}

export function makeJaClosingParagraph({ ctx }: { ctx: FakeLmContext }): Inline[] {
  return [{ kind: 'text', text: makeJaPatternText({ ctx, category: 'closing' }) }];
}

export function makeJaThinkingText({ ctx, sentenceCount, paragraphBreakEvery }: {
  ctx: FakeLmContext;
  sentenceCount: number;
  paragraphBreakEvery: number | undefined;
}): string {
  const sentences = Array.from({ length: sentenceCount }, () => makeJaPatternText({ ctx, category: 'thinking' }));

  if (paragraphBreakEvery === undefined) {
    return sentences.join('');
  }

  return sentences.map((sentence, index) => {
    const shouldBreak = index > 0 && index % paragraphBreakEvery === 0;
    return shouldBreak ? `\n\n${sentence}` : sentence;
  }).join('');
}

export function makeJaListItem({ ctx }: { ctx: FakeLmContext }): Inline[] {
  const text = ctx.random() < 0.3 && ctx.inputAnalysis.keywords.length > 0
    ? makeJaInputKeywordPhrase({ ctx })
    : ctx.random() < 0.45
      ? pickWeighted({ items: ctx.lexicons.listItems, random: ctx.random })
      : makeJaNounPhrase({ ctx });
  return maybeBoldInline({ text, ctx });
}

export function makeJaTableCell({ ctx }: { ctx: FakeLmContext }): Inline[] {
  const text = ctx.random() < 0.22 && ctx.inputAnalysis.keywords.length > 0
    ? pickJaInputKeyword({ ctx })
    : ctx.random() < 0.5
      ? pickWeighted({ items: ctx.lexicons.tableCells, random: ctx.random })
      : makeJaNounPhrase({ ctx });
  return maybeBoldInline({ text, ctx });
}

function makeJaPatternText({ ctx, category }: {
  ctx: FakeLmContext;
  category: 'opening' | 'body' | 'thinking' | 'closing';
}): string {
  const patterns = (() => {
    switch (category) {
    case 'opening':
      return ctx.lexicons.openingPatterns;
    case 'body':
      return ctx.lexicons.bodySentencePatterns;
    case 'thinking':
      return ctx.lexicons.thinkingSentencePatterns;
    case 'closing':
      return ctx.lexicons.closingPatterns;
    default: {
      const _ex: never = category;
      throw new Error(`Unhandled fake LM pattern category: ${String(_ex)}`);
    }
    }
  })();
  const picked = pickTextPattern({ patterns, ctx, category });
  const text = renderTextPattern({ pattern: picked.pattern, ctx, renderSlot: renderJaTextPatternSlot });
  recordTextPatternUse({ pattern: picked.pattern, key: picked.key, ctx });
  return text;
}

function renderJaTextPatternSlot({ slot, ctx }: {
  slot: TextPatternSlot;
  ctx: FakeLmContext;
}): string {
  const d = ctx.lexicons;
  const r = ctx.random;

  switch (slot) {
  case 'nounPhrase':
    return makeJaNounPhrase({ ctx });
  case 'abstractNoun':
    return pickWeighted({ items: d.abstractNouns, random: r });
  case 'physicalNoun':
    return pickWeighted({ items: d.physicalNouns, random: r });
  case 'livingNoun':
    return pickWeighted({ items: d.livingNouns, random: r });
  case 'timeNoun':
    return pickWeighted({ items: d.timeNouns, random: r });
  case 'normalAdjective':
    return pickWeighted({ items: d.normalAdjectives, random: r });
  case 'wrongAdjective':
    return pickWeighted({ items: d.wrongAdjectives, random: r });
  case 'connector':
    return pickWeighted({ items: d.connectors, random: r });
  case 'inputKeyword':
    return pickJaInputKeyword({ ctx });
  case 'inputKeywordPhrase':
    return makeJaInputKeywordPhrase({ ctx });
  case 'inputReference':
    return pickWeighted({ items: d.inputReferences, random: r });
  case 'inputGreeting':
    return makeJaInputGreeting({ ctx });
  default: {
    const _ex: never = slot;
    throw new Error(`Unhandled fake LM text pattern slot: ${String(_ex)}`);
  }
  }
}

function makeJaInputGreeting({ ctx }: {
  ctx: FakeLmContext;
}): string {
  switch (ctx.inputAnalysis.greeting) {
  case 'morning':
    return 'おはようございます。';
  case 'afternoon':
  case 'generic':
    return 'こんにちは。';
  case 'evening':
    return 'こんばんは。';
  case 'intro':
    return 'はじめまして。';
  case 'work':
    return 'お疲れさまです。';
  case undefined:
    return 'こんにちは。';
  default: {
    const _ex: never = ctx.inputAnalysis.greeting;
    throw new Error(`Unhandled fake LM input greeting: ${String(_ex)}`);
  }
  }
}

function pickJaInputKeyword({ ctx }: {
  ctx: FakeLmContext;
}): string {
  if (ctx.inputAnalysis.keywords.length === 0) {
    return makeJaNounPhrase({ ctx });
  }

  const fresh = ctx.inputAnalysis.keywords.filter((keyword) => !ctx.patternHistory.recentInputKeywords.includes(keyword.text));
  const candidates = fresh.length > 0 ? fresh : ctx.inputAnalysis.keywords;
  const keyword = pickWeighted({
    random: ctx.random,
    items: candidates.map((candidate) => ({ value: candidate.text, weight: candidate.weight })),
  });
  recordInputKeywordUse({ keyword, ctx });
  return keyword;
}

function makeJaInputKeywordPhrase({ ctx }: {
  ctx: FakeLmContext;
}): string {
  const keyword = pickJaInputKeyword({ ctx });
  return oneOf({
    random: ctx.random,
    factories: [
      { weight: 8, value: () => keyword },
      { weight: 7, value: () => `${keyword}の近く` },
      { weight: 6, value: () => `${keyword}に似た${pickWeighted({ items: ctx.lexicons.abstractNouns, random: ctx.random })}` },
      { weight: 5, value: () => `${keyword}を横に置いた${pickWeighted({ items: ctx.lexicons.physicalNouns, random: ctx.random })}` },
    ],
  });
}

function maybeBoldInline({ text, ctx }: {
  text: string;
  ctx: FakeLmContext;
}): Inline[] {
  if (ctx.random() > 0.28) {
    return [{ kind: 'text', text }];
  }

  return [
    { kind: 'text', text },
    { kind: 'text', text: ' ' },
    { kind: 'bold', text: makeJaNounPhrase({ ctx }) },
  ];
}

function joinInlineSentences({ sentences, separator }: {
  sentences: Inline[][];
  separator: string;
}): Inline[] {
  return sentences.flatMap((sentence, index) => (
    index === 0 ? sentence : [{ kind: 'text' as const, text: separator }, ...sentence]
  ));
}
