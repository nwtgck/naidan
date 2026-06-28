import { chunkText } from '@/features/fake-lm/core/chunkText';
import { createLanguagePack, type FakeLmContext, type LanguagePack } from '@/features/fake-lm/core/languagePack';
import type { FakeLmInputAnalysis } from '@/features/fake-lm/core/inputAnalysis';
import { loadLanguageLexicons } from '@/features/fake-lm/core/lexiconLoader';
import { makeMarkdownPlan } from '@/features/fake-lm/core/markdownPlanner';
import type { BlockPlan, FakeLmLanguage, FakeLmMode, MarkdownBlock } from '@/features/fake-lm/core/markdownTypes';
import { renderMarkdownBlock } from '@/features/fake-lm/core/markdownRenderer';
import { createSeededNonCryptoPseudoRandom, mixSeed, type FakeLmSeed } from '@/features/fake-lm/core/random';
import { createPatternHistory } from '@/features/fake-lm/core/textPattern';
import {
  makeFakeLmThinkingChunking,
  makeFakeLmThinkingParagraphBreakEvery,
  makeFakeLmThinkingSentenceCount,
  type FakeLmStreamItem,
  type FakeLmThinkingEffort,
} from '@/features/fake-lm/core/thinking';

export type { FakeLmStreamItem } from '@/features/fake-lm/core/thinking';

export type StreamFakeLmMarkdownInput = {
  language: FakeLmLanguage,
  mode: FakeLmMode,
  seed: FakeLmSeed,
  thinkingEffort: FakeLmThinkingEffort,
  inputAnalysis: FakeLmInputAnalysis,
  signal: AbortSignal | undefined,
  chunking: {
    minChars: number,
    maxChars: number,
    delayMs: number,
  },
};

export async function* streamFakeLmMarkdown({ language, mode, seed, thinkingEffort, inputAnalysis, signal, chunking }: StreamFakeLmMarkdownInput): AsyncIterable<FakeLmStreamItem> {
  const lexicons = await loadLanguageLexicons({ language });
  const ctx: FakeLmContext = {
    random: createSeededNonCryptoPseudoRandom({ seed: mixSeed({ seed, salt: `text:${language}:${mode}:${thinkingEffort}` }) }),
    chunkRandom: createSeededNonCryptoPseudoRandom({ seed: mixSeed({ seed, salt: `chunk:${language}:${mode}:${thinkingEffort}` }) }),
    mode,
    seed,
    lexicons,
    inputAnalysis,
    patternHistory: createPatternHistory(),
  };
  const pack = createLanguagePack({ language });

  yield* streamFakeLmThinking({ pack, ctx, effort: thinkingEffort, signal });
  yield* streamFakeLmContent({ pack, ctx, signal, chunking });
}

async function* streamFakeLmThinking({ pack, ctx, effort, signal }: {
  pack: LanguagePack,
  ctx: FakeLmContext,
  effort: FakeLmThinkingEffort,
  signal: AbortSignal | undefined,
}): AsyncIterable<FakeLmStreamItem> {
  const sentenceCount = makeFakeLmThinkingSentenceCount({ effort, random: ctx.random });
  if (sentenceCount === 0) {
    return;
  }

  const paragraphBreakEvery = makeFakeLmThinkingParagraphBreakEvery({ effort });
  const thinkingText = pack.makeThinkingText({ ctx, sentenceCount, paragraphBreakEvery });
  const thinkingChunking = makeFakeLmThinkingChunking({ effort });

  for (const chunk of chunkText({
    text: `${thinkingText}\n`,
    random: ctx.chunkRandom,
    minChars: thinkingChunking.minChars,
    maxChars: thinkingChunking.maxChars,
  })) {
    if (isAbortSignalAborted({ signal })) {
      return;
    }

    yield { type: 'thinking', chunk };

    if (thinkingChunking.delayMs > 0) {
      await sleep({ ms: thinkingChunking.delayMs, signal });
    }
  }
}

async function* streamFakeLmContent({ pack, ctx, signal, chunking }: {
  pack: LanguagePack,
  ctx: FakeLmContext,
  signal: AbortSignal | undefined,
  chunking: {
    minChars: number,
    maxChars: number,
    delayMs: number,
  },
}): AsyncIterable<FakeLmStreamItem> {
  const plans = makeMarkdownPlan({ random: ctx.random });

  for (const plan of plans) {
    if (isAbortSignalAborted({ signal })) {
      return;
    }

    const block = makeMarkdownBlock({ pack, ctx, plan });
    const markdown = renderMarkdownBlock({ block });

    for (const chunk of chunkText({
      text: `${markdown}\n\n`,
      random: ctx.chunkRandom,
      minChars: chunking.minChars,
      maxChars: chunking.maxChars,
    })) {
      if (isAbortSignalAborted({ signal })) {
        return;
      }

      yield { type: 'content', chunk };

      if (chunking.delayMs > 0) {
        await sleep({ ms: chunking.delayMs, signal });
      }
    }
  }
}

function makeMarkdownBlock({ pack, ctx, plan }: {
  pack: LanguagePack,
  ctx: FakeLmContext,
  plan: BlockPlan,
}): MarkdownBlock {
  switch (plan.kind) {
  case 'heading':
    return { kind: 'heading', level: plan.level, content: pack.makeHeading({ ctx }) };
  case 'openingParagraph':
    return { kind: 'paragraph', content: pack.makeOpeningParagraph({ ctx, sentenceCount: plan.sentenceCount }) };
  case 'paragraph':
    return { kind: 'paragraph', content: pack.makeParagraph({ ctx, sentenceCount: plan.sentenceCount }) };
  case 'closingParagraph':
    return { kind: 'paragraph', content: pack.makeClosingParagraph({ ctx }) };
  case 'list':
    return { kind: 'list', items: Array.from({ length: plan.itemCount }, () => pack.makeListItem({ ctx })) };
  case 'table':
    return {
      kind: 'table',
      headers: Array.from({ length: plan.columnCount }, () => pack.makeTableCell({ ctx })),
      rows: Array.from({ length: plan.rowCount }, () => (
        Array.from({ length: plan.columnCount }, () => pack.makeTableCell({ ctx }))
      )),
    };
  default: {
    const _ex: never = plan;
    throw new Error(`Unhandled fake LM block plan: ${String(_ex)}`);
  }
  }
}

function sleep({ ms, signal }: {
  ms: number,
  signal: AbortSignal | undefined,
}): Promise<void> {
  if (isAbortSignalAborted({ signal })) {
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    const timeoutId = globalThis.setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      globalThis.clearTimeout(timeoutId);
      resolve();
    }, { once: true });
  });
}

function isAbortSignalAborted({ signal }: {
  signal: AbortSignal | undefined,
}): boolean {
  return signal?.aborted === true;
}
