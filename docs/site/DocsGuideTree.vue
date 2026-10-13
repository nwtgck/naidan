<script setup lang="ts">
import { computed } from 'vue';
import type { CommonMessages } from './messages';
import { DOCS_NAV_PAGES, navigationGroups } from './navigation';
import type { DocsLocale, DocsPageId } from './routes';

const props = defineProps<{
  locale: DocsLocale;
  page: DocsPageId;
  copy: CommonMessages['navigation'];
  label: string;
  idPrefix: string;
  groupMode: 'disclosure' | 'expanded';
}>();
const groups = computed(() => navigationGroups({ locale: props.locale, copy: props.copy }));
const currentGroup = computed(() => DOCS_NAV_PAGES[props.page].group);

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
  <nav :aria-label="label" data-testid="docs-guide-tree">
    <component
      :is="groupMode === 'disclosure' ? 'details' : 'section'"
      v-for="group in groups"
      :key="group.id"
      class="docs-guide-group"
      :class="{ 'is-current': group.id === currentGroup }"
      :open="groupMode === 'disclosure' && group.id === currentGroup ? true : undefined"
      :aria-labelledby="`docs-guide-group-${idPrefix}-${group.id}`"
      :data-group="group.id"
    >
      <summary v-if="groupMode === 'disclosure'" :id="`docs-guide-group-${idPrefix}-${group.id}`">
        {{ group.label }}<svg class="docs-guide-chevron" viewBox="0 0 12 12" aria-hidden="true"><path d="m2 4 4 4 4-4" /></svg>
      </summary>
      <h2 v-else :id="`docs-guide-group-${idPrefix}-${group.id}`">{{ group.label }}</h2>
      <ul>
        <li v-for="entry in group.pages" :key="entry.id">
          <a
            :href="entry.href"
            :aria-current="entry.id === page ? 'page' : undefined"
            :class="{ 'is-ancestor': entry.children.some(child => child.id === page) }"
            data-testid="docs-guide-link"
          >{{ entry.label }}</a>
          <ul v-if="entry.children.length > 0" class="docs-guide-children">
            <li v-for="child in entry.children" :key="child.id">
              <a
                :href="child.href"
                :aria-current="child.id === page ? 'page' : undefined"
                data-testid="docs-guide-link"
              >{{ child.label }}</a>
            </li>
          </ul>
        </li>
      </ul>
    </component>
  </nav>
</template>
