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

    expect(collectBoundaryStringKeys({
      moduleId: '/src/example.ts',
      sourceCode,
    })).toEqual([
      'ChatInput__failed_to_copy',
      'ChatInput__type_a_message',
    ]);
  });

  it('parses Vue SFC blocks and template expressions without scanning markup text', () => {
    const sourceCode = `\
<!-- <script setup lang="ts">lazyStrings.ChatInput__comment()</script> -->
<script lang="ts">
import { computed, ref } from 'vue';
</script>
<script generic="T" lang="ts" setup>
import { useLayout } from '@/composables/useLayout';
import { lazyStrings, ensureStrings } from '@/strings';

await ensureStrings.ChatInput__failed_to_copy({
  name: 'folder',
  errorMessage: 'failed',
});
</script>

<template>
  <code>lazyStrings.ChatInput__plain_text()</code>
  <!-- {{ lazyStrings.ChatInput__template_comment() }} -->
  <textarea :placeholder="lazyStrings.ChatInput__type_a_message()" />
  {{ lazyStrings.ChatInput__visible_message() }}
</template>
`;

    expect(collectBoundaryStringKeys({
      moduleId: '/src/components/Example.vue',
      sourceCode,
    })).toEqual([
      'ChatInput__failed_to_copy',
      'ChatInput__type_a_message',
      'ChatInput__visible_message',
    ]);
  });

  it('supports an imported alias for analysis while lint rejects it', () => {
    const sourceCode = `\
import { lazyStrings as localizedStrings } from '@/strings';
localizedStrings.LanguageSelector__language();
`;

    expect(collectBoundaryStringKeys({
      moduleId: '/src/example.ts',
      sourceCode,
    })).toEqual([
      'LanguageSelector__language',
    ]);
  });

  it('ignores comments, strings, template literals, and unrelated receivers', () => {
    const sourceCode = `\
import { lazyStrings } from '@/strings';

// lazyStrings.ChatInput__line_comment();
/* lazyStrings.ChatInput__block_comment(); */
const quoted = 'lazyStrings.ChatInput__quoted()';
const templated = \`lazyStrings.ChatInput__templated()\`;
const unrelated = createUnrelatedStrings();
unrelated.ChatInput__unrelated();
`;

    expect(collectBoundaryStringKeys({
      moduleId: '/src/example.ts',
      sourceCode,
    })).toEqual([]);
  });

  it('ignores an imported binding shadowed by a local parameter or block binding', () => {
    const sourceCode = `\
import { lazyStrings } from '@/strings';

function render(lazyStrings: OtherStrings): string {
  return lazyStrings.ChatInput__shadowed_parameter();
}

{
  const lazyStrings = createOtherStrings();
  lazyStrings.ChatInput__shadowed_block();
}

lazyStrings.ChatInput__real();
`;

    expect(collectBoundaryStringKeys({
      moduleId: '/src/example.ts',
      sourceCode,
    })).toEqual(['ChatInput__real']);
  });

  it('tracks Vue v-for and v-slot bindings that shadow an imported accessor', () => {
    const sourceCode = `\
<script setup lang="ts">
import { lazyStrings } from '@/strings';
const rows = [];
</script>

<template>
  <div v-for="lazyStrings in rows">
    {{ lazyStrings.ChatInput__shadowed_by_for() }}
  </div>
  <SomeComponent v-slot="{ lazyStrings }">
    {{ lazyStrings.ChatInput__shadowed_by_slot() }}
  </SomeComponent>
  {{ lazyStrings.ChatInput__real() }}
</template>
`;

    expect(collectBoundaryStringKeys({
      moduleId: '/src/components/Example.vue',
      sourceCode,
    })).toEqual(['ChatInput__real']);
  });

  it('rejects accessor shapes that the plugin cannot bundle safely', () => {
    const sourceCode = `\
import { lazyStrings } from '@/strings';
lazyStrings[messageKey]();
`;

    expect(() => collectBoundaryStringKeys({
      moduleId: '/src/example.ts',
      sourceCode,
    })).toThrow('lazyStrings must be used as lazyStrings.<message_key>(...).');
  });

  it('surfaces Vue parser failures instead of partially scanning malformed SFC source', () => {
    const sourceCode = `\
<script setup lang="ts">
import { lazyStrings } from '@/strings';
</script>
<template><div></template>
`;

    expect(() => collectBoundaryStringKeys({
      moduleId: '/src/components/Invalid.vue',
      sourceCode,
    })).toThrow('Failed to parse /src/components/Invalid.vue');
  });
});
