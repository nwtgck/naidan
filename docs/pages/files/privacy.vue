<script setup lang="ts">
import FolderAccessDemo from '../../site/demos/FolderAccessDemo.vue';
import { docsHref } from '../../site/routes';
import type { DocsLocale } from '../../site/routes';
import type { FilesMessages } from '../../site/messages';

defineProps<{ s: FilesMessages; locale: DocsLocale }>();


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
    data-testid="docs-files"
  >
    <h1>{{ s.title }}</h1>
    <p
      v-for="paragraph in s.intro"
      :key="paragraph"
      class="lead"
    >{{ paragraph }}</p>
    <figure class="guide-figure"><FolderAccessDemo /><figcaption class="caption">{{ s.diagramCaption }}</figcaption></figure>
    <div class="pair-grid methods">
      <section
        v-for="method in s.methods"
        :key="method.title"
        class="panel"
      >
        <h2>{{ method.title }}</h2>
        <p>{{ method.body }}</p>
      </section>
    </div>
    <h2>{{ s.permissions.title }}</h2>
    <p>{{ s.permissions.body }}</p>
    <div class="decision-list"><section v-for="(item, index) in s.checklist" :key="item.title"><span aria-hidden="true">0{{ index + 1 }}</span><div><h3>{{ item.title }}</h3><p>{{ item.body }}</p></div></section></div>
    <h2>{{ s.stepsTitle }}</h2>
    <ol>
      <li
        v-for="step in s.steps"
        :key="step"
      >{{ step }}</li>
    </ol>
    <a
      class="next-link"
      :href="docsHref({ locale, page: 'work/boundary' })"
    >{{ s.next }} <span aria-hidden="true">→</span></a>
  </article>
</template>

<style scoped>
.methods {
  margin-top: 35px;
}

.methods h2 {
  font-size: 21px;
  margin-top: 0;
}
</style>
