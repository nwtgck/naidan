<script setup lang="ts">
import logo from '../assets/naidan.svg';
import type { CommonMessages } from './messages';
import { docsHref, otherLocale, DOCS_LOCALE_NAMES } from './routes';
import type { DocsLocale, DocsPageId } from './routes';
import DocsSymbols from './DocsSymbols.vue';

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
      <nav
        class="main-nav"
        :aria-label="s.home"
      >
        <a :href="`${docsHref({ locale, page: 'index' })}#guides`">{{ s.guides }}</a>
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
        <a
          href="/"
          class="nav-launch"
          :aria-label="s.launch"
        ><span class="nav-open-text">{{ s.launch }}</span><span aria-hidden="true">↗</span></a>
      </div>
    </div>
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
