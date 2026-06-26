import type { FakeLmContext } from '@/services/fake-lm/core/languagePack';
import type { Inline } from '@/services/fake-lm/core/markdownTypes';
import { pickTextPattern, recordInputKeywordUse, recordTextPatternUse, renderTextPattern, type TextPatternSlot } from '@/services/fake-lm/core/textPattern';
import { pickWeighted, oneOf } from '@/services/fake-lm/core/weighted';

export function makeEnNounPhrase({ ctx }: { ctx: FakeLmContext }): string {
  const d = ctx.lexicons;
  const r = ctx.random;

  return oneOf({
    random: r,
    factories: [
      { weight: 15, value: () => withArticle({ phrase: pickWeighted({ items: d.abstractNouns, random: r }) }) },
      { weight: 13, value: () => withArticle({ phrase: `${pickWeighted({ items: d.wrongAdjectives, random: r })} ${pickWeighted({ items: d.physicalNouns, random: r })}` }) },
      { weight: 12, value: () => `${pickWeighted({ items: d.timeNouns, random: r })}'s ${pickWeighted({ items: d.abstractNouns, random: r })}` },
      { weight: 11, value: () => withArticle({ phrase: `${pickWeighted({ items: d.livingNouns, random: r })}-shaped ${pickWeighted({ items: d.abstractNouns, random: r })}` }) },
      { weight: 9, value: () => withArticle({ phrase: `${pickWeighted({ items: d.physicalNouns, random: r })} near ${pickWeighted({ items: d.timeNouns, random: r })}` }) },
      { weight: 8, value: () => withArticle({ phrase: `${pickWeighted({ items: d.normalAdjectives, random: r })} ${pickWeighted({ items: d.livingNouns, random: r })}` }) },
    ],
  });
}

export function makeEnPredicatePhrase({ ctx }: { ctx: FakeLmContext }): string {
  const d = ctx.lexicons;
  const r = ctx.random;

  return oneOf({
    random: r,
    factories: [
      { weight: 15, value: () => `needs to ${pickWeighted({ items: d.plainVerbs, random: r })} as ${makeEnNounPhrase({ ctx })}` },
      { weight: 13, value: () => `appears to ${pickWeighted({ items: d.softVerbs, random: r })} near ${makeEnNounPhrase({ ctx })}` },
      { weight: 11, value: () => `moves toward ${makeEnNounPhrase({ ctx })} before being explained` },
      { weight: 10, value: () => `becomes ${withArticle({ phrase: pickWeighted({ items: d.physicalNouns, random: r }) })} before becoming a meaning` },
      { weight: 8, value: () => `may ${pickWeighted({ items: d.softVerbs, random: r })} until ${pickWeighted({ items: d.timeNouns, random: r })}` },
    ],
  });
}

export function makeEnSentence({ ctx }: { ctx: FakeLmContext }): Inline[] {
  return [{ kind: 'text', text: makeEnPatternText({ ctx, category: 'body' }) }];
}

export function makeEnHeading({ ctx }: { ctx: FakeLmContext }): Inline[] {
  return maybeBoldInline({ text: pickWeighted({ items: ctx.lexicons.headings, random: ctx.random }), ctx });
}

export function makeEnOpeningParagraph({ ctx, sentenceCount }: {
  ctx: FakeLmContext,
  sentenceCount: number,
}): Inline[] {
  return joinInlineSentences({
    sentences: [
      [{ kind: 'text', text: makeEnPatternText({ ctx, category: 'opening' }) }],
      ...Array.from({ length: Math.max(0, sentenceCount - 1) }, () => makeEnSentence({ ctx })),
    ],
    separator: ' ',
  });
}

export function makeEnParagraph({ ctx, sentenceCount }: {
  ctx: FakeLmContext,
  sentenceCount: number,
}): Inline[] {
  return joinInlineSentences({
    sentences: Array.from({ length: sentenceCount }, () => makeEnSentence({ ctx })),
    separator: ' ',
  });
}

export function makeEnClosingParagraph({ ctx }: { ctx: FakeLmContext }): Inline[] {
  return [{ kind: 'text', text: makeEnPatternText({ ctx, category: 'closing' }) }];
}

export function makeEnThinkingText({ ctx, sentenceCount, paragraphBreakEvery }: {
  ctx: FakeLmContext,
  sentenceCount: number,
  paragraphBreakEvery: number | undefined,
}): string {
  const sentences = Array.from({ length: sentenceCount }, () => makeEnPatternText({ ctx, category: 'thinking' }));

  if (paragraphBreakEvery === undefined) {
    return sentences.join(' ');
  }

  return sentences.map((sentence, index) => {
    const shouldBreak = index > 0 && index % paragraphBreakEvery === 0;
    return shouldBreak ? `\n\n${sentence}` : sentence;
  }).join(' ');
}

export function makeEnListItem({ ctx }: { ctx: FakeLmContext }): Inline[] {
  const text = ctx.random() < 0.3 && ctx.inputAnalysis.keywords.length > 0
    ? makeEnInputKeywordPhrase({ ctx })
    : ctx.random() < 0.45
      ? pickWeighted({ items: ctx.lexicons.listItems, random: ctx.random })
      : makeEnNounPhrase({ ctx });
  return maybeBoldInline({ text, ctx });
}

export function makeEnTableCell({ ctx }: { ctx: FakeLmContext }): Inline[] {
  const text = ctx.random() < 0.22 && ctx.inputAnalysis.keywords.length > 0
    ? pickEnInputKeyword({ ctx })
    : ctx.random() < 0.5
      ? pickWeighted({ items: ctx.lexicons.tableCells, random: ctx.random })
      : makeEnNounPhrase({ ctx });
  return maybeBoldInline({ text, ctx });
}

function makeEnPatternText({ ctx, category }: {
  ctx: FakeLmContext,
  category: 'opening' | 'body' | 'thinking' | 'closing',
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
  const text = renderTextPattern({ pattern: picked.pattern, ctx, renderSlot: renderEnTextPatternSlot });
  recordTextPatternUse({ pattern: picked.pattern, key: picked.key, ctx });
  return capitalize({ text });
}

function renderEnTextPatternSlot({ slot, ctx }: {
  slot: TextPatternSlot,
  ctx: FakeLmContext,
}): string {
  const d = ctx.lexicons;
  const r = ctx.random;

  switch (slot) {
  case 'nounPhrase':
    return makeEnNounPhrase({ ctx });
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
    return pickEnInputKeyword({ ctx });
  case 'inputKeywordPhrase':
    return makeEnInputKeywordPhrase({ ctx });
  case 'inputReference':
    return pickWeighted({ items: d.inputReferences, random: r });
  case 'inputGreeting':
    return makeEnInputGreeting({ ctx });
  default: {
    const _ex: never = slot;
    throw new Error(`Unhandled fake LM text pattern slot: ${String(_ex)}`);
  }
  }
}

function makeEnInputGreeting({ ctx }: {
  ctx: FakeLmContext,
}): string {
  switch (ctx.inputAnalysis.greeting) {
  case 'morning':
    return 'Good morning.';
  case 'afternoon':
    return 'Good afternoon.';
  case 'evening':
    return 'Good evening.';
  case 'intro':
    return 'Nice to meet you.';
  case 'work':
  case 'generic':
    return 'Hello.';
  case undefined:
    return 'Hello.';
  default: {
    const _ex: never = ctx.inputAnalysis.greeting;
    throw new Error(`Unhandled fake LM input greeting: ${String(_ex)}`);
  }
  }
}

function pickEnInputKeyword({ ctx }: {
  ctx: FakeLmContext,
}): string {
  if (ctx.inputAnalysis.keywords.length === 0) {
    return makeEnNounPhrase({ ctx });
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

function makeEnInputKeywordPhrase({ ctx }: {
  ctx: FakeLmContext,
}): string {
  const keyword = pickEnInputKeyword({ ctx });
  return oneOf({
    random: ctx.random,
    factories: [
      { weight: 8, value: () => keyword },
      { weight: 7, value: () => `${keyword} near the answer` },
      { weight: 6, value: () => `${keyword}-shaped ${pickWeighted({ items: ctx.lexicons.abstractNouns, random: ctx.random })}` },
      { weight: 5, value: () => `${keyword} beside ${pickWeighted({ items: ctx.lexicons.physicalNouns, random: ctx.random })}` },
    ],
  });
}

function maybeBoldInline({ text, ctx }: {
  text: string,
  ctx: FakeLmContext,
}): Inline[] {
  if (ctx.random() > 0.28) {
    return [{ kind: 'text', text }];
  }

  return [
    { kind: 'text', text },
    { kind: 'text', text: ' ' },
    { kind: 'bold', text: makeEnNounPhrase({ ctx }) },
  ];
}

function withArticle({ phrase }: {
  phrase: string,
}): string {
  return /^[aeiou]/iu.test(phrase) ? `an ${phrase}` : `a ${phrase}`;
}

function capitalize({ text }: {
  text: string,
}): string {
  return text.length === 0 ? text : `${text[0]!.toUpperCase()}${text.slice(1)}`;
}

function joinInlineSentences({ sentences, separator }: {
  sentences: Inline[][],
  separator: string,
}): Inline[] {
  return sentences.flatMap((sentence, index) => (
    index === 0 ? sentence : [{ kind: 'text' as const, text: separator }, ...sentence]
  ));
}
