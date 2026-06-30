
import {
  advancedTextEditorV3ApplyMultiEditRequestSchema,
  advancedTextEditorV3ApplyMultiEditResponseSchema,
  advancedTextEditorV3PrepareMultiEditRequestSchema,
  advancedTextEditorV3PrepareMultiEditResponseSchema,
  advancedTextEditorV3ReplaceAllRequestSchema,
  advancedTextEditorV3ReplaceAllResponseSchema,
  advancedTextEditorV3ReplaceSingleRequestSchema,
  advancedTextEditorV3ReplaceSingleResponseSchema,
  advancedTextEditorV3SearchTextRequestSchema,
  advancedTextEditorV3SearchTextResponseSchema,
  type AdvancedTextEditorV3Match,
  type AdvancedTextEditorV3ReplaceAllRequest,
  type AdvancedTextEditorV3ReplaceSingleRequest,
  type AdvancedTextEditorV3SearchTextRequest,
  type IAdvancedTextEditorV3Worker,
} from './types';

function escapeRegExp({ text }: { text: string }): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function buildRegex({
  query,
  caseSensitive,
  useRegex,
  global,
}: {
  query: string,
  caseSensitive: 'case-sensitive' | 'case-insensitive',
  useRegex: 'regex-on' | 'regex-off',
  global: boolean,
}): RegExp {
  const caseSensitiveFlags = (() => {
    switch (caseSensitive) {
    case 'case-insensitive':
      return 'i';
    case 'case-sensitive':
      return '';
    default: {
      const _exhaustiveCheck: never = caseSensitive;
      throw new Error(`Unhandled case sensitivity: ${_exhaustiveCheck}`);
    }
    }
  })();
  const source = (() => {
    switch (useRegex) {
    case 'regex-on':
      return query;
    case 'regex-off':
      return escapeRegExp({ text: query });
    default: {
      const _exhaustiveCheck: never = useRegex;
      throw new Error(`Unhandled regex mode: ${_exhaustiveCheck}`);
    }
    }
  })();
  const flags = `${global ? 'g' : ''}${caseSensitiveFlags}`;
  return new RegExp(source, flags);
}

export function searchTextWithWorkerLogic({
  request,
}: {
  request: AdvancedTextEditorV3SearchTextRequest,
}): { matches: AdvancedTextEditorV3Match[], isValidRegex: boolean } {
  const validated = advancedTextEditorV3SearchTextRequestSchema.parse(request);

  if (!validated.query) {
    return { matches: [], isValidRegex: true };
  }

  try {
    const regex = buildRegex({
      query: validated.query,
      caseSensitive: validated.caseSensitive,
      useRegex: validated.useRegex,
      global: true,
    });
    const matches: AdvancedTextEditorV3Match[] = [];
    let match: RegExpExecArray | null;
    while ((match = regex.exec(validated.text)) !== null) {
      const matchText = match[0];
      if (matchText.length === 0) {
        regex.lastIndex += 1;
        continue;
      }
      matches.push({ start: match.index, end: match.index + matchText.length });
    }
    return { matches, isValidRegex: true };
  } catch {
    return { matches: [], isValidRegex: false };
  }
}

function replaceAllWithWorkerLogic({
  request,
}: {
  request: AdvancedTextEditorV3ReplaceAllRequest,
}): { text: string, matches: AdvancedTextEditorV3Match[], isValidRegex: boolean } {
  const validated = advancedTextEditorV3ReplaceAllRequestSchema.parse(request);

  if (!validated.query) {
    return {
      text: validated.text,
      matches: [],
      isValidRegex: true,
    };
  }

  try {
    const regex = buildRegex({
      query: validated.query,
      caseSensitive: validated.caseSensitive,
      useRegex: validated.useRegex,
      global: true,
    });
    const text = validated.text.replace(regex, validated.replacement);
    const searchResult = searchTextWithWorkerLogic({
      request: {
        text,
        query: validated.query,
        caseSensitive: validated.caseSensitive,
        useRegex: validated.useRegex,
      },
    });
    return {
      text,
      matches: searchResult.matches,
      isValidRegex: true,
    };
  } catch {
    return {
      text: validated.text,
      matches: [],
      isValidRegex: false,
    };
  }
}

function replaceSingleWithWorkerLogic({
  request,
}: {
  request: AdvancedTextEditorV3ReplaceSingleRequest,
}): {
  didReplace: boolean,
  text: string,
  replacementStart: number | undefined,
  replacementEnd: number | undefined,
  matches: AdvancedTextEditorV3Match[],
  isValidRegex: boolean,
} {
  const validated = advancedTextEditorV3ReplaceSingleRequestSchema.parse(request);
  const selection = validated.text.substring(validated.selectionStart, validated.selectionEnd);

  if (!validated.query) {
    return {
      didReplace: false,
      text: validated.text,
      replacementStart: undefined,
      replacementEnd: undefined,
      matches: [],
      isValidRegex: true,
    };
  }

  try {
    const regex = buildRegex({
      query: validated.query,
      caseSensitive: validated.caseSensitive,
      useRegex: validated.useRegex,
      global: false,
    });
    if (!regex.test(selection)) {
      const searchResult = searchTextWithWorkerLogic({
        request: {
          text: validated.text,
          query: validated.query,
          caseSensitive: validated.caseSensitive,
          useRegex: validated.useRegex,
        },
      });
      return {
        didReplace: false,
        text: validated.text,
        replacementStart: undefined,
        replacementEnd: undefined,
        matches: searchResult.matches,
        isValidRegex: true,
      };
    }

    const before = validated.text.substring(0, validated.selectionStart);
    const after = validated.text.substring(validated.selectionEnd);
    const text = `${before}${validated.replacement}${after}`;
    const replacementStart = validated.selectionStart;
    const replacementEnd = validated.selectionStart + validated.replacement.length;
    const searchResult = searchTextWithWorkerLogic({
      request: {
        text,
        query: validated.query,
        caseSensitive: validated.caseSensitive,
        useRegex: validated.useRegex,
      },
    });

    return {
      didReplace: true,
      text,
      replacementStart,
      replacementEnd,
      matches: searchResult.matches,
      isValidRegex: true,
    };
  } catch {
    return {
      didReplace: false,
      text: validated.text,
      replacementStart: undefined,
      replacementEnd: undefined,
      matches: [],
      isValidRegex: false,
    };
  }
}

function prepareMultiEditWithWorkerLogic({
  request,
}: {
  request: {
    text: string,
    selectionStart: number,
    selectionEnd: number,
  },
}): {
  selection: string | undefined,
  selectionStart: number | undefined,
  selectionEnd: number | undefined,
  matchStarts: number[],
} {
  const validated = advancedTextEditorV3PrepareMultiEditRequestSchema.parse(request);
  let selectionStart = validated.selectionStart;
  let selectionEnd = validated.selectionEnd;
  let selection = validated.text.substring(selectionStart, selectionEnd);

  if (!selection) {
    while (selectionStart > 0 && /\w/.test(validated.text[selectionStart - 1] || '')) {
      selectionStart -= 1;
    }
    while (selectionEnd < validated.text.length && /\w/.test(validated.text[selectionEnd] || '')) {
      selectionEnd += 1;
    }
    if (selectionStart === selectionEnd) {
      return {
        selection: undefined,
        selectionStart: undefined,
        selectionEnd: undefined,
        matchStarts: [],
      };
    }
    selection = validated.text.substring(selectionStart, selectionEnd);
  }

  const matchStarts: number[] = [];
  let position = validated.text.indexOf(selection);
  while (position !== -1) {
    matchStarts.push(position);
    position = validated.text.indexOf(selection, position + 1);
  }

  return {
    selection,
    selectionStart,
    selectionEnd,
    matchStarts,
  };
}

function applyMultiEditWithWorkerLogic({
  request,
}: {
  request: {
    text: string,
    target: string,
    replacement: string,
  },
}): { text: string } {
  const validated = advancedTextEditorV3ApplyMultiEditRequestSchema.parse(request);
  return {
    text: validated.text.split(validated.target).join(validated.replacement),
  };
}

export function createAdvancedTextEditorV3Worker(): IAdvancedTextEditorV3Worker {
  return {
    async searchText({ request }) {
      return advancedTextEditorV3SearchTextResponseSchema.parse(
        searchTextWithWorkerLogic({ request }),
      );
    },
    async replaceAll({ request }) {
      return advancedTextEditorV3ReplaceAllResponseSchema.parse(
        replaceAllWithWorkerLogic({ request }),
      );
    },
    async replaceSingle({ request }) {
      return advancedTextEditorV3ReplaceSingleResponseSchema.parse(
        replaceSingleWithWorkerLogic({ request }),
      );
    },
    async prepareMultiEdit({ request }) {
      return advancedTextEditorV3PrepareMultiEditResponseSchema.parse(
        prepareMultiEditWithWorkerLogic({ request }),
      );
    },
    async applyMultiEdit({ request }) {
      return advancedTextEditorV3ApplyMultiEditResponseSchema.parse(
        applyMultiEditWithWorkerLogic({ request }),
      );
    },
  };
}

export const TEST_ONLY = (__BUILD_MODE_IS_TEST__ && {
  searchTextWithWorkerLogic,
  replaceSingleWithWorkerLogic,
  prepareMultiEditWithWorkerLogic,
  applyMultiEditWithWorkerLogic,
}) || undefined;
