import {
  editorDocumentChangesSchema,
  editorDocumentSnapshotSchema,
  editorReplaceRequestSchema,
  editorSearchRequestSchema,
  type EditorReplaceRequest,
  type EditorReplaceResponse,
  type EditorSearchMatch,
  type EditorSearchOptions,
  type EditorSearchRequest,
  type EditorSearchResponse,
  type EditorSearchWorker,
} from './types';

const MAX_HIGHLIGHTS = 400;
const MAX_FALLBACK_LENGTH = 128 * 1024;
const MAX_FALLBACK_QUERY = 64 * 1024;
const MAX_REPLACEMENT_LENGTH = 4 * 1024 * 1024;
const MAX_REPLACEMENT_COUNT = 20_000;
const CHECKPOINT_STRIDE = 256;
const MAX_CHECKPOINTS = 16_384;

type SearchMatches = Extract<EditorSearchResponse, { kind: 'matches' }>;
type SearchIndex = {
  count: number,
  stride: number,
  checkpoints: Uint32Array,
  first: EditorSearchMatch | undefined,
  last: EditorSearchMatch | undefined,
};

function buildPattern({ options }: { options: EditorSearchOptions }): RegExp | undefined {
  const pattern = {
    literal: () => options.query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
    regex: () => options.query,
  }[options.mode]();
  const flags = { 'case-sensitive': 'gu', 'case-insensitive': 'giu' }[options.caseSensitivity];
  try {
    return new RegExp(pattern, flags);
  } catch {
    return undefined;
  }
}

function prepareSearchTarget({ target }: { target: EditorSearchRequest['target'] }) {
  switch (target.kind) {
  case 'offset': return { offset: target.offset, index: undefined };
  case 'index': return { offset: undefined, index: target.index };
  default: {
    const exhaustive: never = target;
    throw new Error('Unexpected editor search target ' + String(exhaustive));
  }
  }
}

function searchText({ text, pattern, request }: { text: string, pattern: RegExp, request: EditorSearchRequest }): { response: SearchMatches, index: SearchIndex } {
  const { visible, target } = request;
  const requested = prepareSearchTarget({ target });
  let first: EditorSearchMatch | undefined;
  let lastStart = 0;
  let lastEnd = 0;
  let active: EditorSearchMatch | undefined;
  let count = 0;
  const highlights: EditorSearchMatch[] = [];
  const checkpoints: number[] = [];
  let stride = CHECKPOINT_STRIDE;
  let nextCheckpoint = 0;
  for (const match of text.matchAll(pattern)) {
    const start = match.index;
    const end = start + match[0].length;
    if (count === nextCheckpoint) {
      if (checkpoints.length === MAX_CHECKPOINTS) {
        // Double the spacing instead of keeping every match in dense documents.
        for (let i = 1; i < MAX_CHECKPOINTS / 2; i++) {
          checkpoints[i] = checkpoints[2 * i]!;
        }
        checkpoints.length = MAX_CHECKPOINTS / 2;
        stride *= 2;
      }
      checkpoints.push(start);
      nextCheckpoint = count + stride;
    }
    const isActive = active === undefined
      && (requested.offset === undefined ? count === requested.index : start >= requested.offset || end > requested.offset);
    const isVisible = highlights.length < MAX_HIGHLIGHTS && start <= visible.end && end >= visible.start;
    if (count === 0 || isActive || isVisible) {
      const located = { start, end, index: count };
      first ??= located;
      if (isActive) {
        active = located;
      }
      if (isVisible) {
        highlights.push(located);
      }
    }
    lastStart = start;
    lastEnd = end;
    count++;
  }
  const last = count === 0 ? undefined : { start: lastStart, end: lastEnd, index: count - 1 };
  const current = active ?? ((requested.index ?? 0) < 0 ? last : first);
  return {
    response: current === undefined ? { kind: 'matches', count, highlights } : { kind: 'matches', count, active: current, highlights },
    index: { count, stride, checkpoints: Uint32Array.from(checkpoints), first, last },
  };
}

function checkpointBefore({ checkpoints, offset }: { checkpoints: Uint32Array, offset: number }): number {
  let left = 0;
  let right = checkpoints.length;
  while (left < right) {
    const middle = Math.floor((left + right) / 2);
    if (checkpoints[middle]! < offset) {
      left = middle + 1;
    } else {
      right = middle;
    }
  }
  // The preceding match can end exactly at the viewport's first offset.
  return Math.max(0, left - 1);
}

function indexedActiveMatch({ text, pattern, index, target }: { text: string, pattern: RegExp, index: SearchIndex, target: EditorSearchRequest['target'] }): EditorSearchMatch | undefined {
  const requested = prepareSearchTarget({ target });
  if (requested.index !== undefined) {
    if (requested.index < 0 || requested.index === index.count - 1) {
      return index.last;
    }
    if (requested.index === 0 || requested.index >= index.count) {
      return index.first;
    }
  } else if (requested.offset! > index.last!.end) {
    return index.first;
  }
  const checkpoint = requested.offset === undefined
    ? Math.floor(requested.index! / index.stride)
    : checkpointBefore({ checkpoints: index.checkpoints, offset: requested.offset });
  pattern.lastIndex = index.checkpoints[checkpoint] ?? 0;
  let ordinal = checkpoint * index.stride;
  for (const match of text.matchAll(pattern)) {
    const start = match.index;
    const end = start + match[0].length;
    if (requested.offset === undefined ? ordinal === requested.index : start >= requested.offset || end > requested.offset) {
      return { start, end, index: ordinal };
    }
    ordinal++;
  }
  return index.first;
}

function searchIndexed({ text, pattern, request, index }: { text: string, pattern: RegExp, request: EditorSearchRequest, index: SearchIndex }): SearchMatches {
  const highlights: EditorSearchMatch[] = [];
  const { count, checkpoints, stride } = index;
  if (count === 0) {
    return { kind: 'matches', count, highlights };
  }
  const active = indexedActiveMatch({ text, pattern, index, target: request.target });
  const { start: visibleStart, end: visibleEnd } = request.visible;
  if (visibleEnd >= index.first!.start && visibleStart <= index.last!.end) {
    const checkpoint = checkpointBefore({ checkpoints, offset: visibleStart });
    // Resume the Unicode regexp on the original text to retain anchors, lookbehind and zero-length advancement.
    pattern.lastIndex = checkpoints[checkpoint]!;
    let ordinal = checkpoint * stride;
    for (const match of text.matchAll(pattern)) {
      const start = match.index;
      if (start > visibleEnd) {
        break;
      }
      const end = start + match[0].length;
      if (end >= visibleStart) {
        highlights.push({ start, end, index: ordinal });
        if (highlights.length === MAX_HIGHLIGHTS) {
          break;
        }
      }
      ordinal++;
    }
  }
  return { kind: 'matches', count, active, highlights };
}

function replacementPart({ token, match, text }: { token: string, match: RegExpMatchArray, text: string }): string {
  switch (token) {
  case '$':
    return '$';
  case '&':
    return match[0] ?? '';
  case '\x60':
    return text.slice(0, match.index);
  case "'":
    return text.slice((match.index ?? 0) + (match[0]?.length ?? 0));
  default: {
    if (token.startsWith('<')) {
      return match.groups === undefined ? '$' + token : match.groups[token.slice(1, -1)] ?? '';
    }
    const group = Number(token);
    if (group > 0 && group < match.length) {
      return match[group] ?? '';
    }
    const firstDigit = Number(token[0]);
    if (token.length === 2 && firstDigit > 0 && firstDigit < match.length) {
      return (match[firstDigit] ?? '') + token[1];
    }
    return '$' + token;
  }
  }
}

function expandReplacement({
  replacement, match, text,
}: { replacement: string, match: RegExpMatchArray, text: string }): string | undefined {
  const chunks: string[] = [];
  let size = 0;
  let offset = 0;
  for (const tokenMatch of replacement.matchAll(/\$([$&\x60']|\d{1,2}|<[^>]*>)/g)) {
    const prefix = replacement.slice(offset, tokenMatch.index);
    const part = replacementPart({ token: tokenMatch[1] ?? '', match, text });
    size += prefix.length + part.length;
    if (size > MAX_REPLACEMENT_LENGTH) {
      return undefined;
    }
    chunks.push(prefix, part);
    offset = tokenMatch.index + tokenMatch[0].length;
  }
  const tail = replacement.slice(offset);
  return size + tail.length > MAX_REPLACEMENT_LENGTH ? undefined : chunks.join('') + tail;
}

function replaceText({ text, request, index }: { text: string, request: EditorReplaceRequest, index: SearchIndex | undefined }): EditorReplaceResponse {
  const { options, replacement, target } = request;
  if (options.query === '') {
    return { kind: 'edits', edits: [] };
  }
  const pattern = buildPattern({ options });
  if (pattern === undefined) {
    return { kind: 'invalid-regex' };
  }
  if (replacement.length > MAX_REPLACEMENT_LENGTH) {
    return { kind: 'too-large' };
  }
  const targetIndex = (() => {
    switch (target.kind) {
    case 'match': return target.index;
    case 'all': return undefined;
    default: {
      const exhaustive: never = target;
      throw new Error('Unexpected editor replacement target ' + String(exhaustive));
    }
    }
  })();
  let ordinal = 0;
  if (targetIndex !== undefined && index !== undefined) {
    if (targetIndex >= index.count) {
      return { kind: 'edits', edits: [] };
    }
    const checkpoint = Math.floor(targetIndex / index.stride);
    pattern.lastIndex = index.checkpoints[checkpoint]!;
    ordinal = checkpoint * index.stride;
  }
  let size = 0;
  const edits: { start: number, end: number, text: string }[] = [];
  const replaceMatch = {
    literal: () => replacement,
    regex: ({ match }: { match: RegExpMatchArray }) => expandReplacement({ replacement, match, text }),
  }[options.mode];
  for (const match of text.matchAll(pattern)) {
    const start = match.index;
    const end = start + match[0].length;
    if (targetIndex !== undefined && ordinal++ !== targetIndex) {
      continue;
    }
    const value = replaceMatch({ match });
    if (value === undefined) {
      return { kind: 'too-large' };
    }
    size += value.length + end - start;
    if (size > MAX_REPLACEMENT_LENGTH || edits.length >= MAX_REPLACEMENT_COUNT) {
      return { kind: 'too-large' };
    }
    if (value !== match[0]) {
      edits.push({ start, end, text: value });
    }
    if (targetIndex !== undefined) {
      break;
    }
  }
  return { kind: 'edits', edits };
}

export function createEditorSearchWorker({ runtime }: { runtime: 'worker' | 'fallback' }): EditorSearchWorker {
  let version: number | undefined;
  let text = '';
  let cachedSearch: { options: EditorSearchOptions, index: SearchIndex } | undefined;

  function requireVersion({ expected }: { expected: number }): void {
    if (version !== expected) {
      throw new Error('Editor search document version changed');
    }
  }

  function isAvailable({ options }: { options: EditorSearchOptions }): boolean {
    return runtime === 'worker' || (options.mode === 'literal' && text.length <= MAX_FALLBACK_LENGTH && options.query.length <= MAX_FALLBACK_QUERY);
  }

  function getSearchIndex({ options }: { options: EditorSearchOptions }): SearchIndex | undefined {
    const cached = cachedSearch;
    if (cached?.options.query === options.query && cached.options.caseSensitivity === options.caseSensitivity && cached.options.mode === options.mode) {
      return cached.index;
    }
    return undefined;
  }

  return {
    async setDocument({ snapshot }) {
      const document = editorDocumentSnapshotSchema.parse(snapshot);
      text = document.text;
      version = document.version;
      cachedSearch = undefined;
    },
    async applyChanges({ changes }) {
      const next = editorDocumentChangesSchema.parse(changes);
      requireVersion({ expected: next.baseVersion });
      if (next.version <= next.baseVersion) {
        throw new Error('Editor search document version did not advance');
      }
      const chunks: string[] = [];
      let offset = 0;
      for (const edit of next.edits) {
        if (edit.start < offset || edit.end < edit.start || edit.end > text.length) {
          throw new Error('Invalid editor search document edit');
        }
        chunks.push(text.slice(offset, edit.start), edit.text);
        offset = edit.end;
      }
      text = chunks.join('') + text.slice(offset);
      version = next.version;
      cachedSearch = undefined;
    },
    async search({ request }) {
      const validated = editorSearchRequestSchema.parse(request);
      requireVersion({ expected: validated.version });
      const { options } = validated;
      const index = getSearchIndex({ options });
      if (index === undefined) {
        cachedSearch = undefined;
      }
      if (!isAvailable({ options })) {
        return { kind: 'unavailable' };
      }
      if (options.query === '') {
        return { kind: 'matches', count: 0, highlights: [] };
      }
      const pattern = buildPattern({ options });
      if (pattern === undefined) {
        return { kind: 'invalid-regex' };
      }
      if (index !== undefined) {
        return searchIndexed({ text, pattern, request: validated, index });
      }
      const result = searchText({ text, pattern, request: validated });
      cachedSearch = { options, index: result.index };
      return result.response;
    },
    async replace({ request }) {
      const validated = editorReplaceRequestSchema.parse(request);
      requireVersion({ expected: validated.version });
      return isAvailable({ options: validated.options })
        ? replaceText({ text, request: validated, index: getSearchIndex({ options: validated.options }) })
        : { kind: 'unavailable' };
    },
  };
}

export const TEST_ONLY = {
};
