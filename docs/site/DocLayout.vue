<script setup lang="ts">
import { computed } from 'vue';
import logo from '../assets/naidan.svg';
import type { CommonMessages } from './messages';
import { DOCS_NAV_PAGES } from './navigation';
import { docsHref, otherLocale, DOCS_LOCALE_NAMES } from './routes';
import type { DocsLocale, DocsPageId } from './routes';
import DocsGuideMenu from './DocsGuideMenu.vue';
import DocsSymbols from './DocsSymbols.vue';

const props = defineProps<{ locale: DocsLocale; page: DocsPageId; s: CommonMessages }>();
const breadcrumb = computed(() => {
  const current = DOCS_NAV_PAGES[props.page];
  const parent = current.parent;
  return {
    group: props.s.navigation.groups[current.group],
    current: props.s.navigation.pages[props.page],
    parent: parent === undefined ? undefined : {
      href: docsHref({ locale: props.locale, page: parent }),
      label: props.s.navigation.pages[parent],
    },
  };
});


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
    data-testid="docs-header"
  >
    <div class="wrap topbar-inner">
      <a
        class="brand"
        :href="docsHref({ locale, page: 'index' })"
        :aria-label="s.home"
      >
        <img
          :src="logo"
          width="38"
          height="38"
          class="brand-mark"
          alt=""
        >
        <span class="brand-text">Naidan</span><span class="brand-sep" /><span class="brand-docs">DOCS</span>
      </a>
      <DocsGuideMenu :locale="locale" :page="page" :copy="s.navigation" />
      <nav
        class="main-nav"
        :aria-label="s.source"
      >
        <a
          href="https://github.com/nwtgck/naidan"
          rel="noopener noreferrer"
          referrerpolicy="no-referrer"
        >{{ s.source }}</a>
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
    <nav v-if="page !== 'index'" class="docs-breadcrumb wrap" :aria-label="s.navigation.location" data-testid="docs-breadcrumb">
      <a :href="docsHref({ locale, page: 'index' })">{{ s.navigation.pages.index }}</a>
      <span aria-hidden="true">›</span>
      <span>{{ breadcrumb.group }}</span>
      <template v-if="breadcrumb.parent">
        <span aria-hidden="true">›</span>
        <a :href="breadcrumb.parent.href">{{ breadcrumb.parent.label }}</a>
      </template>
      <span aria-hidden="true">›</span>
      <span aria-current="page">{{ breadcrumb.current }}</span>
    </nav>
  </header>
  <main
    id="docs-main"
    data-testid="docs-main"
  >
    <slot />
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
