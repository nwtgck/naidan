<script setup lang="ts">
import DocsLink from './DocsLink.vue';
import type { DocsLocale, DocsPageId } from '../navigation/routes';

defineProps<{
  locale: DocsLocale;
  eyebrow: string;
  guides: readonly { page: DocsPageId; title: string; description: string }[];
}>();

defineExpose({ ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) });
</script>

<template>
  <nav class="related-guides" :aria-label="eyebrow" data-docs-related-guide data-testid="docs-related-guides">
    <p class="related-eyebrow">{{ eyebrow }}</p>
    <ul class="related-list">
      <li v-for="guide in guides" :key="guide.page">
        <DocsLink class="related-link" :locale="locale" :page="guide.page">
          <span class="related-copy">
            <strong>{{ guide.title }}</strong>
            <span>{{ guide.description }}</span>
          </span>
          <span class="related-arrow" aria-hidden="true">→</span>
        </DocsLink>
      </li>
    </ul>
  </nav>
</template>

<style scoped>
.related-guides {
  margin-top: 42px;
  padding-top: 21px;
  border-top: 1px solid var(--line);
}
.related-eyebrow {
  margin: 0 0 12px;
  color: var(--subtle);
  font-size: 11px;
  font-weight: 800;
  letter-spacing: .08em;
  line-height: 1.5;
}
.related-list {
  display: grid;
  grid-template-columns: repeat(auto-fit,minmax(min(100%,300px),1fr));
  gap: 12px;
  margin: 0;
  padding: 0;
  list-style: none;
}
.related-list li {
  min-width: 0;
  margin: 0;
  padding: 0;
}
.related-link {
  display: grid;
  grid-template-columns: minmax(0,1fr) auto;
  align-items: center;
  gap: 16px;
  height: 100%;
  min-width: 0;
  padding: 17px 19px;
  border: 1px solid var(--line-strong);
  border-radius: 13px;
  background: var(--surface);
  text-decoration: none;
  transition: border-color .18s ease,background-color .18s ease,box-shadow .18s ease;
}
.related-copy {
  display: grid;
  gap: 5px;
  min-width: 0;
  overflow-wrap: anywhere;
}
.related-copy strong {
  color: var(--text);
  font-size: 15px;
  font-weight: 750;
  line-height: 1.5;
}
.related-copy > span {
  color: var(--muted);
  font-size: 12px;
  line-height: 1.65;
}
.related-arrow {
  color: var(--blue);
  font-size: 22px;
  line-height: 1;
  transition: transform .18s ease;
}
.related-link:hover {
  border-color: var(--blue);
  background: var(--surface-2);
  box-shadow: var(--panel-shadow);
}
.related-link:hover .related-arrow,.related-link:focus-visible .related-arrow {
  transform: translateX(3px);
}
.related-link:focus-visible {
  outline: 2px solid var(--blue);
  outline-offset: 3px;
}
@media(prefers-reduced-motion:reduce) {
  .related-link,.related-arrow {
    transition: none;
  }
}
</style>
