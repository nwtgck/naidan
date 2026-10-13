<script setup lang="ts">
import BranchingDemo from '../../islands/branching/BranchingDemo.vue';
import RelatedGuide from '../../site/RelatedGuide.vue';
import type { DocsLocale } from '../../site/routes';
import type { BranchingMessages, CommonMessages } from '../../site/messages';

defineProps<{ s: BranchingMessages; locale: DocsLocale; common: CommonMessages }>();


defineExpose({
  ...((__BUILD_MODE_IS_TEST__ && {
    TEST_ONLY: {
      // Export internal state and logic used only for testing here. Do not reference these in production logic.
      // ESLint-required for defineExpose.
    },
  }) || {}),
});
</script>

<template>
  <article
    class="prose"
    data-testid="docs-branching"
  >
    <h1>{{ s.title }}</h1>
    <p
      v-for="paragraph in s.intro"
      :key="paragraph"
      class="lead"
    >{{ paragraph }}</p>
    <h2>{{ s.stepsTitle }}</h2>
    <ol>
      <li
        v-for="step in s.steps"
        :key="step"
      >{{ step }}</li>
    </ol>
    <h2>{{ s.demoTitle }}</h2>
    <div
      data-docs-island="branching"
      :data-docs-props="JSON.stringify({ copy: s.demo, chrome: common.chrome })"
    >
      <BranchingDemo :copy="s.demo" :chrome="common.chrome" />
    </div>
    <h2>{{ s.detail.title }}</h2>
    <p>{{ s.detail.body }}</p>
    <RelatedGuide :locale="locale" :eyebrow="common.relatedGuides" :guides="[{ page: 'chat/super-edit', title: s.next, description: s.nextDescription }]" />
  </article>
</template>
