export type FakeLmToneKey = 'greeting' | 'question' | 'request' | 'technical';

export type FakeLmToneScores = Record<FakeLmToneKey, number>;

export type FakeLmInputKeyword = {
  readonly text: string,
  readonly kind: 'ascii' | 'japanese' | 'mixed',
  readonly weight: number,
};

export type FakeLmInputGreeting =
  | 'generic'
  | 'morning'
  | 'afternoon'
  | 'evening'
  | 'intro'
  | 'work';

export type FakeLmInputAnalysis = {
  readonly lastUserText: string,
  readonly toneScores: FakeLmToneScores,
  readonly keywords: readonly FakeLmInputKeyword[],
  readonly greeting: FakeLmInputGreeting | undefined,
};

export function analyzeFakeLmInputFromMessages({ messages }: {
  messages: readonly unknown[],
}): FakeLmInputAnalysis {
  return analyzeFakeLmInputText({ text: extractLastUserText({ messages }) });
}

export function analyzeFakeLmInputText({ text }: {
  text: string,
}): FakeLmInputAnalysis {
  const normalized = normalizeInputText({ text });
  const rawKeywords = extractFakeLmInputKeywords({ text: normalized });
  const greeting = detectFakeLmInputGreeting({ text: normalized, lower: normalized.toLowerCase() });
  const keywords = filterGreetingKeywordNoise({ keywords: rawKeywords });

  return {
    lastUserText: normalized,
    toneScores: detectFakeLmToneScores({ text: normalized, keywords, greeting }),
    keywords,
    greeting,
  };
}

export function createEmptyFakeLmInputAnalysis(): FakeLmInputAnalysis {
  return analyzeFakeLmInputText({ text: '' });
}

function extractLastUserText({ messages }: {
  messages: readonly unknown[],
}): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!isRecord(message) || message.role !== 'user') {
      continue;
    }

    return extractMessageContentText({ content: message.content });
  }

  return '';
}

function extractMessageContentText({ content }: {
  content: unknown,
}): string {
  if (typeof content === 'string') {
    return content;
  }

  if (!Array.isArray(content)) {
    return '';
  }

  return content
    .map((part) => extractContentPartText({ part }))
    .filter((part) => part.length > 0)
    .join(' ');
}

function extractContentPartText({ part }: {
  part: unknown,
}): string {
  if (typeof part === 'string') {
    return part;
  }

  if (!isRecord(part)) {
    return '';
  }

  if (typeof part.text === 'string') {
    return part.text;
  }

  return '';
}

function normalizeInputText({ text }: {
  text: string,
}): string {
  return text.replace(/\s+/gu, ' ').trim();
}

function extractFakeLmInputKeywords({ text }: {
  text: string,
}): FakeLmInputKeyword[] {
  const matches = text.match(/[A-Za-z0-9][A-Za-z0-9_-]*(?:[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}ー]+[A-Za-z0-9_-]*)+|[A-Za-z0-9][A-Za-z0-9_-]{1,30}|[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}ー]{2,24}/gu) ?? [];
  const seen = new Set<string>();
  const keywords: FakeLmInputKeyword[] = [];

  for (const match of matches) {
    const candidates = expandRawKeywordCandidate({ value: match });
    for (const candidate of candidates) {
      const normalized = normalizeKeywordCandidate({ value: candidate });
      if (normalized === undefined || seen.has(normalized)) {
        continue;
      }

      if (isFakeLmStopword({ value: normalized })) {
        continue;
      }

      seen.add(normalized);
      keywords.push({
        text: normalized,
        kind: getKeywordKind({ value: normalized }),
        weight: getKeywordWeight({ value: normalized }),
      });

      if (keywords.length >= 8) {
        return keywords;
      }
    }
  }

  return keywords;
}

function expandRawKeywordCandidate({ value }: {
  value: string,
}): string[] {
  if (!containsJapaneseScript({ value }) || isFakeLmGreetingKeyword({ value })) {
    return [value];
  }

  const parts = value
    .split(/(?:について|として|から|まで|より|なら|では|です|ます|して|した|する|される|された|の|を|に|が|は|で|と|へ|も|や|か)/u)
    .map((part) => part.trim())
    .filter((part) => part.length >= 2);

  return parts.length > 0 ? parts : [value];
}

function normalizeKeywordCandidate({ value }: {
  value: string,
}): string | undefined {
  const trimmed = value.trim().replace(/^[、。,.!?！？:：;；()[\]{}「」『』]+|[、。,.!?！？:：;；()[\]{}「」『』]+$/gu, '');
  if (trimmed.length < 2) {
    return undefined;
  }

  if (trimmed.length > 24) {
    return trimmed.slice(0, 24);
  }

  return trimmed;
}


function filterGreetingKeywordNoise({ keywords }: {
  keywords: readonly FakeLmInputKeyword[],
}): FakeLmInputKeyword[] {
  return keywords.filter((keyword) => !isFakeLmGreetingKeyword({ value: keyword.text }));
}

function isFakeLmGreetingKeyword({ value }: {
  value: string,
}): boolean {
  const lower = value.toLowerCase();
  return jaGreetingKeywordStopwords.has(value) || enGreetingKeywordStopwords.has(lower);
}

function detectFakeLmToneScores({ text, keywords, greeting }: {
  text: string,
  keywords: readonly FakeLmInputKeyword[],
  greeting: FakeLmInputGreeting | undefined,
}): FakeLmToneScores {
  if (text.length === 0) {
    return { greeting: 0, question: 0, request: 0, technical: 0 };
  }

  const lower = text.toLowerCase();
  const greetingScore = clampScore({ value: detectGreetingScore({ text, greeting }) });
  const question = clampScore({ value: /[?？]/u.test(text) ? 1 : /(?:かな|でしょうか|ですか|ますか|what|why|how|when|where|which|who)\b/iu.test(lower) ? 0.65 : 0 });
  const request = clampScore({ value: /(?:して|してほしい|お願い|実装|修正|設計|作って|書いて|出して|教えて|見積もって|短く|長く|please|can you|could you|would you)/iu.test(lower) ? 0.8 : 0 });
  const technical = clampScore({ value: detectTechnicalScore({ lower, keywords }) });

  return { greeting: greetingScore, question, request, technical };
}

function detectGreetingScore({ text, greeting }: {
  text: string,
  greeting: FakeLmInputGreeting | undefined,
}): number {
  if (greeting === undefined) {
    return 0;
  }

  return text.length <= 42 ? 1 : 0.35;
}

function detectFakeLmInputGreeting({ text, lower }: {
  text: string,
  lower: string,
}): FakeLmInputGreeting | undefined {
  if (/(?:おはよう)/u.test(text) || /^(?:good morning)\b/iu.test(lower)) {
    return 'morning';
  }

  if (/^(?:good afternoon)\b/iu.test(lower)) {
    return 'afternoon';
  }

  if (/(?:こんばんは)/u.test(text) || /^(?:good evening)\b/iu.test(lower)) {
    return 'evening';
  }

  if (/(?:はじめまして)/u.test(text)) {
    return 'intro';
  }

  if (/(?:お疲れ|おつかれ)/u.test(text)) {
    return 'work';
  }

  if (/(?:こんにちは|やあ|どうも|よろしく)/u.test(text) || /^(?:hi|hello|hey)\b/iu.test(lower)) {
    return 'generic';
  }

  return undefined;
}

function detectTechnicalScore({ lower, keywords }: {
  lower: string,
  keywords: readonly FakeLmInputKeyword[],
}): number {
  if (/(?:typescript|javascript|api|json|bundle|patch|diff|npm|lint|typecheck|test|fetch|provider|endpoint|stream|seed|vue|vite|zod|schema|gguf|llm|lm)/iu.test(lower)) {
    return 1;
  }

  if (keywords.some((keyword) => keyword.kind === 'ascii')) {
    return 0.45;
  }

  return 0;
}

function getKeywordKind({ value }: {
  value: string,
}): FakeLmInputKeyword['kind'] {
  const hasJapanese = containsJapaneseScript({ value });
  const hasAscii = /[A-Za-z0-9]/u.test(value);

  if (hasJapanese && hasAscii) {
    return 'mixed';
  }

  if (hasJapanese) {
    return 'japanese';
  }

  return 'ascii';
}

function getKeywordWeight({ value }: {
  value: string,
}): number {
  if (/^[A-Z0-9_-]{2,}$/u.test(value)) {
    return 12;
  }

  if (/[A-Za-z0-9]/u.test(value) && containsJapaneseScript({ value })) {
    return 11;
  }

  if (/[A-Za-z0-9]/u.test(value)) {
    return 10;
  }

  return Math.min(12, Math.max(5, value.length));
}

function containsJapaneseScript({ value }: {
  value: string,
}): boolean {
  return /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(value);
}

function isFakeLmStopword({ value }: {
  value: string,
}): boolean {
  const lower = value.toLowerCase();
  return jaStopwords.has(value) || enStopwords.has(lower);
}

function clampScore({ value }: {
  value: number,
}): number {
  return Math.max(0, Math.min(1, value));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

const jaGreetingKeywordStopwords = new Set([
  'こんにちは', 'こんばんは', 'おはよう', 'おはようございます', 'やあ', 'どうも', 'はじめまして', 'よろしく', 'お疲れ', 'おつかれ', 'お疲れさま', 'お疲れさまです',
]);

const enGreetingKeywordStopwords = new Set([
  'hi', 'hello', 'hey', 'morning', 'afternoon', 'evening', 'good', 'greetings',
]);

const jaStopwords = new Set([
  'これ', 'それ', 'あれ', 'ここ', 'そこ', 'もの', 'こと', 'ため', 'よう', 'さん', 'ください', 'ほしい', '良い', '悪い', '思う', '可能', '場合', '全体', '今回', '今まで', 'つまり', 'ちなみに', 'そして', 'ただし', 'これら', 'それら', 'あまり', 'もう少し', 'できる', 'して', 'した', 'する', 'では', 'あり', 'ある', 'いる', 'ない', 'はい', 'よろしく', 'お願いします', 'って', '見積',
]);

const enStopwords = new Set([
  'the', 'and', 'for', 'with', 'this', 'that', 'please', 'would', 'could', 'should', 'about', 'into', 'from', 'there', 'their', 'your', 'have', 'hello', 'thanks', 'thank', 'just', 'make', 'made', 'need', 'want', 'good', 'bad', 'more', 'less', 'can', 'you', 'are', 'is', 'to', 'of', 'in', 'on', 'it', 'be', 'as', 'or', 'if', 'we', 'do', 'does', 'did', 'done', 'not',
]);

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {};
