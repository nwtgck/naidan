<script setup lang="ts">
import { computed } from 'vue';
import { LanguagesIcon } from 'lucide-vue-next';
import logo from '../assets/naidan.svg';
import type { CommonMessages } from './messages';
import { docsHref, DOCS_LOCALES, DOCS_LOCALE_NAMES } from './routes';
import type { DocsLocale, DocsPageId } from './routes';
import DocsGuideMenu from './DocsGuideMenu.vue';
import DocsGuideTree from './DocsGuideTree.vue';
import DocsSymbols from './DocsSymbols.vue';
import { purposeGuides } from './search-purpose';
import SearchIsland from '../islands/search/SearchIsland.vue';

const props = defineProps<{ locale: DocsLocale; page: DocsPageId; s: CommonMessages }>();
const searchPurpose = computed(() => purposeGuides({
  locale: props.locale,
  titles: props.s.navigation.pages,
  descriptions: props.s.searchPurposeDescriptions,
}));


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
  <DocsSymbols />
  <a
    class="skip-link"
    href="#docs-main"
  >{{ s.skip }}</a>
  <header
    class="topbar"
    :class="{ 'docs-article-page': page !== 'index' }"
    data-testid="docs-header"
  >
    <div class="wrap topbar-inner">
      <div class="brand-group" data-docs-brand-slot>
        <a
          class="brand"
          :href="docsHref({ locale, page: 'index' })"
          :aria-label="s.home"
          data-docs-brand-link
        >
          <img
            :src="logo"
            width="38"
            height="38"
            class="brand-mark"
            alt=""
          >
          <span class="brand-text brand-wordmark">Naidan</span>
        </a>
        <span class="brand-spacer" data-docs-brand-spacer aria-hidden="true" />
        <span class="brand-sep" aria-hidden="true" /><span class="brand-docs" aria-hidden="true">DOCS</span>
      </div>
      <DocsGuideMenu :locale="locale" :page="page" :copy="s.navigation" />
      <div data-docs-island="search" :data-docs-props="JSON.stringify({ locale, currentPage: page, copy: s.searchUi, purpose: searchPurpose })">
        <SearchIsland :locale="locale" :current-page="page" :copy="s.searchUi" :purpose="searchPurpose" />
      </div>
      <div class="nav-controls">
        <details class="locale-menu" name="docs-header-menu" data-testid="docs-language-menu">
          <summary class="control locale-trigger" :aria-label="`${s.languageMenu}: ${DOCS_LOCALE_NAMES[locale]}`" :title="s.languageMenu">
            <LanguagesIcon class="icon sm" aria-hidden="true" />
            <span class="locale-code" aria-hidden="true">{{ locale.toUpperCase() }}</span>
          </summary>
          <nav class="locale-panel" :aria-label="s.languageMenu">
            <a
              v-for="option in DOCS_LOCALES"
              :key="option"
              :href="docsHref({ locale: option, page })"
              :lang="option"
              :hreflang="option"
              :aria-current="option === locale ? 'page' : undefined"
              data-testid="docs-language-link"
            >
              <span>{{ DOCS_LOCALE_NAMES[option] }}</span>
              <span v-if="option === locale" class="locale-current">{{ s.currentLanguage }}</span>
            </a>
          </nav>
        </details>
        <label class="control theme-control">
          <input
            id="docs-light-theme"
            type="checkbox"
            :aria-label="s.lightTheme"
          >
          <svg
            class="icon"
            aria-hidden="true"
          >
            <use href="#i-sun" />
          </svg>
        </label>
        <div class="motion-preference">
          <label class="control motion-preference-control" :title="s.pauseMotion">
            <input id="docs-pause-motion" type="checkbox" :aria-label="s.pauseMotion" data-testid="docs-pause-motion">
            <span class="pause-motion-label" aria-hidden="true">Ⅱ</span><span class="resume-motion-label" aria-hidden="true">▷</span>
            <span class="sr-only resume-motion-label">{{ s.resumeMotion }}</span>
          </label>
        </div>
        <a
          href="/"
          class="nav-launch"
          :aria-label="s.launch"
        ><span class="nav-open-text">{{ s.launch }}</span><span aria-hidden="true">→</span></a>
      </div>
    </div>
  </header>
  <main
    id="docs-main"
    data-testid="docs-main"
  >
    <slot v-if="page === 'index'" />
    <div v-else class="docs-article-shell">
      <aside class="docs-article-sidebar" :aria-label="s.navigation.sidebarTitle" data-testid="docs-article-sidebar">
        <DocsGuideTree
          :locale="locale"
          :page="page"
          :copy="s.navigation"
          :label="s.navigation.sidebarTitle"
          id-prefix="sidebar"
          group-mode="disclosure"
        />
      </aside>
      <div class="docs-article-body">
        <slot />
      </div>
    </div>
  </main>
  <footer class="footer">
    <div class="wrap footer-inner"><span>{{ s.footer }}</span><a
      :href="docsHref({ locale, page: 'index' })">{{ s.home }}</a></div>
  </footer>
</template>

<style scoped>
.theme-control {
  position: relative;
  padding: 0;
  width: 38px;
}

.theme-control input {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  opacity: 0;
  cursor: pointer;
  margin: 0;
}

.theme-control:focus-within {
  outline: 2px solid var(--blue);
  outline-offset: 3px;
}

.footer-inner {
  display: flex;
  justify-content: space-between;
  gap: 20px;
}
</style>
