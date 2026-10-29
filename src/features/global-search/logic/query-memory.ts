export type SearchQueryMemoryContext =
  | { type: 'global' }
  | { type: 'chat', chatId: string }
  | { type: 'chat_group', chatGroupId: string };

function getTargetKey({ context }: { context: SearchQueryMemoryContext }): string | undefined {
  switch (context.type) {
  case 'global': {
    const { type: _type, ...unhandledContext } = context;
    unhandledContext satisfies Record<PropertyKey, never>;
    return undefined;
  }
  case 'chat': {
    const { type: _type, chatId, ...unhandledContext } = context;
    unhandledContext satisfies Record<PropertyKey, never>;
    return `chat:${chatId}`;
  }
  case 'chat_group': {
    const { type: _type, chatGroupId, ...unhandledContext } = context;
    unhandledContext satisfies Record<PropertyKey, never>;
    return `chat-group:${chatGroupId}`;
  }
  default: {
    const exhaustive: never = context;
    throw new Error(`Unhandled search query context: ${String(exhaustive)}`);
  }
  }
}

export function createSearchQueryMemory({ targetLimit }: { targetLimit: number }) {
  if (!Number.isInteger(targetLimit) || targetLimit < 0) {
    throw new Error('Search query memory limit must be a non-negative integer');
  }

  let globalQuery = '';
  const targetQueries = new Map<string, string>();

  function restoreQuery({ context }: { context: SearchQueryMemoryContext }): string {
    const key = getTargetKey({ context });
    if (key === undefined) {
      return globalQuery;
    }

    const query = targetQueries.get(key);
    if (query === undefined) {
      return '';
    }

    targetQueries.delete(key);
    targetQueries.set(key, query);
    return query;
  }

  function rememberQuery({ context, query }: { context: SearchQueryMemoryContext, query: string }): void {
    const key = getTargetKey({ context });
    if (key === undefined) {
      globalQuery = query;
      return;
    }

    targetQueries.delete(key);
    if (query === '') {
      return;
    }

    targetQueries.set(key, query);
    if (targetQueries.size > targetLimit) {
      const oldestKey = targetQueries.keys().next().value;
      if (oldestKey !== undefined) {
        targetQueries.delete(oldestKey);
      }
    }
  }

  return { restoreQuery, rememberQuery };
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
