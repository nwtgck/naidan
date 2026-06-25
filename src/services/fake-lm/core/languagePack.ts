import type { LoadedLexicons } from '@/services/fake-lm/core/lexiconLoader';
import type { FakeLmInputAnalysis } from '@/services/fake-lm/core/inputAnalysis';
import type { FakeLmLanguage, FakeLmMode, Inline } from '@/services/fake-lm/core/markdownTypes';
import type { FakeLmSeed, SeededNonCryptoPseudoRandom } from '@/services/fake-lm/core/random';
import type { PatternHistory } from '@/services/fake-lm/core/textPattern';
import { makeEnClosingParagraph, makeEnHeading, makeEnListItem, makeEnOpeningParagraph, makeEnNounPhrase, makeEnParagraph, makeEnPredicatePhrase, makeEnSentence, makeEnTableCell, makeEnThinkingText } from '@/services/fake-lm/languages/en/languagePack';
import { makeJaClosingParagraph, makeJaHeading, makeJaListItem, makeJaOpeningParagraph, makeJaNounPhrase, makeJaParagraph, makeJaPredicatePhrase, makeJaSentence, makeJaTableCell, makeJaThinkingText } from '@/services/fake-lm/languages/ja/languagePack';

export type FakeLmContext = {
  random: SeededNonCryptoPseudoRandom,
  chunkRandom: SeededNonCryptoPseudoRandom,
  mode: FakeLmMode,
  seed: FakeLmSeed,
  lexicons: LoadedLexicons,
  inputAnalysis: FakeLmInputAnalysis,
  patternHistory: PatternHistory,
};

export type LanguagePack = {
  language: FakeLmLanguage,
  makeHeading: ({ ctx }: { ctx: FakeLmContext }) => Inline[],
  makeOpeningParagraph: ({ ctx, sentenceCount }: { ctx: FakeLmContext, sentenceCount: number }) => Inline[],
  makeParagraph: ({ ctx, sentenceCount }: { ctx: FakeLmContext, sentenceCount: number }) => Inline[],
  makeClosingParagraph: ({ ctx }: { ctx: FakeLmContext }) => Inline[],
  makeThinkingText: ({ ctx, sentenceCount, paragraphBreakEvery }: { ctx: FakeLmContext, sentenceCount: number, paragraphBreakEvery: number | undefined }) => string,
  makeListItem: ({ ctx }: { ctx: FakeLmContext }) => Inline[],
  makeTableCell: ({ ctx }: { ctx: FakeLmContext }) => Inline[],
  makeNounPhrase: ({ ctx }: { ctx: FakeLmContext }) => string,
  makePredicatePhrase: ({ ctx }: { ctx: FakeLmContext }) => string,
  makeSentence: ({ ctx }: { ctx: FakeLmContext }) => Inline[],
};

export function createLanguagePack({ language }: {
  language: FakeLmLanguage,
}): LanguagePack {
  switch (language) {
  case 'ja':
    return {
      language,
      makeHeading: makeJaHeading,
      makeOpeningParagraph: makeJaOpeningParagraph,
      makeParagraph: makeJaParagraph,
      makeClosingParagraph: makeJaClosingParagraph,
      makeThinkingText: makeJaThinkingText,
      makeListItem: makeJaListItem,
      makeTableCell: makeJaTableCell,
      makeNounPhrase: makeJaNounPhrase,
      makePredicatePhrase: makeJaPredicatePhrase,
      makeSentence: makeJaSentence,
    };
  case 'en':
    return {
      language,
      makeHeading: makeEnHeading,
      makeOpeningParagraph: makeEnOpeningParagraph,
      makeParagraph: makeEnParagraph,
      makeClosingParagraph: makeEnClosingParagraph,
      makeThinkingText: makeEnThinkingText,
      makeListItem: makeEnListItem,
      makeTableCell: makeEnTableCell,
      makeNounPhrase: makeEnNounPhrase,
      makePredicatePhrase: makeEnPredicatePhrase,
      makeSentence: makeEnSentence,
    };
  default: {
    const _ex: never = language;
    throw new Error(`Unhandled fake LM language: ${String(_ex)}`);
  }
  }
}
