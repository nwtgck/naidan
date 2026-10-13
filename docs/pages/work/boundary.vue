<script setup lang="ts">
import { docsHref } from '../../site/routes';
import type { DocsLocale } from '../../site/routes';
import type { BoundaryMessages } from '../../site/messages';

defineProps<{ s: BoundaryMessages; locale: DocsLocale }>();


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
    data-testid="docs-boundary"
  >
    <h1>{{ s.title }}</h1>
    <p
      v-for="paragraph in s.intro"
      :key="paragraph"
      class="lead"
    >{{ paragraph }}</p>
    <h2>{{ s.diagramTitle }}</h2>
    <figure class="permission-diagram">
      <label class="motion-control"><input
        type="checkbox"
        data-testid="docs-motion-toggle"
      > {{ s.motionLabel }}</label>
      <div
        class="permission-ring"
        :aria-label="s.permission"
      ><strong class="permission-label">{{ s.permission }}</strong>
        <div class="flow-nodes"><span>{{ s.app }}</span><span
          class="signal"
          aria-hidden="true"
        >↔</span><span>{{ s.runtime }}</span></div><span class="selected-files">{{ s.files }}</span>
        <p>{{ s.flowLabel }}</p>
      </div>
      <figcaption class="caption">{{ s.motionNote }}</figcaption>
    </figure>
    <section
      v-for="section in s.sections"
      :key="section.title"
    >
      <h2>{{ section.title }}</h2>
      <p>{{ section.body }}</p>
    </section>
    <a
      class="next-link"
      :href="docsHref({ locale, page: 'files/privacy' })"
    >{{ s.next }} <span aria-hidden="true">→</span></a>
  </article>
</template>

<style scoped>
.permission-diagram {
  margin: 26px 0;
}

.motion-control {
  display: flex;
  gap: 9px;
  align-items: center;
  font-size: 13px;
  color: var(--muted);
}

.permission-ring {
  border: 1px solid var(--blue-strong);
  border-radius: 20px;
  padding: 29px;
  margin: 20px 0;
  background: linear-gradient(135deg, var(--surface-2), var(--bg));
}

.permission-label {
  color: var(--blue);
  font-size: 14px;
}

.flow-nodes {
  display: grid;
  grid-template-columns: 1fr 50px 1fr;
  align-items: center;
  gap: 10px;
  margin: 30px 0;
}

.flow-nodes>span:not(.signal) {
  border: 1px solid var(--line-strong);
  border-radius: 12px;
  padding: 20px 9px;
  text-align: center;
  background: var(--surface);
  font-size: 14px;
}

.signal {
  text-align: center;
  color: var(--blue);
  font-size: 25px;
}

.selected-files {
  font-size: 12px;
  border: 1px dashed var(--line-strong);
  border-radius: 8px;
  padding: 8px 12px;
}

.permission-ring p {
  font-size: 12px;
  margin: 20px 0 0;
}

.permission-diagram:has(input:checked) .signal {
  animation: docs-signal 2s ease-in-out infinite;
}

@keyframes docs-signal {

  0%,
  100% {
    transform: translateX(-9px);
    opacity: .55;
  }

  50% {
    transform: translateX(9px);
    opacity: 1;
  }
}

@media(prefers-reduced-motion:reduce) {
  .permission-diagram:has(input:checked) .signal {
    animation: none;
  }
}

@media(max-width:420px) {
  .permission-ring {
    padding: 19px;
  }

  .flow-nodes {
    grid-template-columns: 1fr 28px 1fr;
    gap: 4px;
  }
}
</style>
