<script setup lang="ts">
import { GithubIcon } from 'lucide-vue-next';
import logo from '../assets/naidan.svg';
import type { CommonMessages } from './messages';
import { docsHref, otherLocale, DOCS_LOCALE_NAMES } from './routes';
import type { DocsLocale, DocsPageId } from './routes';
import DocsGuideMenu from './DocsGuideMenu.vue';
import DocsGuideTree from './DocsGuideTree.vue';
import DocsSymbols from './DocsSymbols.vue';
import SearchIsland from '../islands/search/SearchIsland.vue';

defineProps<{ locale: DocsLocale; page: DocsPageId; s: CommonMessages }>();


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
        <span class="brand-sep" aria-hidden="true" /><span class="brand-docs" aria-hidden="true">DOCS</span>
      </div>
      <DocsGuideMenu :locale="locale" :page="page" :copy="s.navigation" />
      <div data-docs-island="search" :data-docs-props="JSON.stringify({ locale, copy: s.searchUi })">
        <SearchIsland :locale="locale" :copy="s.searchUi" />
      </div>
      <nav
        class="main-nav"
        :aria-label="s.source"
      >
        <a
          href="https://github.com/nwtgck/naidan"
          target="_blank"
          rel="noopener noreferrer"
          referrerpolicy="no-referrer"
          class="source-icon"
          :title="s.source"
        ><GithubIcon class="icon sm" aria-hidden="true" /><span class="sr-only">{{ s.source }}</span></a>
      </nav>
      <div class="nav-controls">
        <a
          class="control"
          :href="docsHref({ locale: otherLocale({ locale }), page })"
          :lang="otherLocale({ locale })"
          data-testid="docs-language-switch"
        >{{ DOCS_LOCALE_NAMES[otherLocale({ locale })] }}</a>
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
