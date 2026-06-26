import { describe, expect, it } from 'vitest';

import { collectBoundaryStringKeys } from './analyze';

describe('collectBoundaryStringKeys', () => {
  it('collects direct lazy and ensured string calls', () => {
    const sourceCode = `\
import {
  lazyStrings,
  ensureStrings,
} from '@/strings';

lazyStrings.ChatInput__type_a_message();
await ensureStrings.ChatInput__failed_to_copy({
  name: 'folder',
  errorMessage: 'failed',
});
lazyStrings.ChatInput__type_a_message();
`;

    expect(collectBoundaryStringKeys({ sourceCode })).toEqual([
      'ChatInput__failed_to_copy',
      'ChatInput__type_a_message',
    ]);
  });

  it('does not let earlier named imports swallow the strings import in a Vue SFC', () => {
    const sourceCode = `\
<script setup lang="ts">
import { computed, ref } from 'vue';
import { useLayout } from '@/composables/useLayout';
import { lazyStrings, ensureStrings } from '@/strings';

await ensureStrings.ChatInput__failed_to_copy({
  name: 'folder',
  errorMessage: 'failed',
});
</script>

<template>
  <textarea :placeholder="lazyStrings.ChatInput__type_a_message()" />
</template>
`;

    expect(collectBoundaryStringKeys({ sourceCode })).toEqual([
      'ChatInput__failed_to_copy',
      'ChatInput__type_a_message',
    ]);
  });

  it('supports an imported alias for analysis while lint rejects it', () => {
    const sourceCode = `\
import { lazyStrings as localizedStrings } from '@/strings';
localizedStrings.LanguageSelector__language();
`;

    expect(collectBoundaryStringKeys({ sourceCode })).toEqual([
      'LanguageSelector__language',
    ]);
  });

  it('ignores unrelated variables named strings', () => {
    const sourceCode = `\
const strings = createUnrelatedStrings();
lazyStrings.ChatInput__type_a_message();
`;

    expect(collectBoundaryStringKeys({ sourceCode })).toEqual([]);
  });
});
