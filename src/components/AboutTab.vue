<script setup lang="ts">
import { usePortableAppDownload } from '@/features/file-protocol-standalone/composables/usePortableAppDownload';
import { BookOpenIcon, InfoIcon, GithubIcon, DownloadIcon, ExternalLinkIcon } from 'lucide-vue-next';
import Logo from './Logo.vue';
import OpenSourceLicenses from './OpenSourceLicenses.vue';
import AboutPortableEditionHelp from './AboutPortableEditionHelp.vue';
import { lazyStrings } from '@/strings';

const props = defineProps<{
  visibility: 'visible' | 'hidden',
}>();

const isStandalone = __BUILD_MODE_IS_STANDALONE__;
const appVersion = __APP_VERSION__;
const portableAppDownload = usePortableAppDownload({ version: appVersion });
const documentationUrl = 'https://naidan.pages.dev/docs';
const isDocumentationExternal = location.origin !== new URL(documentationUrl).origin;

defineExpose({
  ...((__BUILD_MODE_IS_TEST__ && {
    TEST_ONLY: {
      // Export internal state and logic used only for testing here. Do not reference these in production logic.
    },
  }) || {}),
});
</script>

<template>
  <div data-testid="about-section" class="animate-in fade-in slide-in-from-bottom-2" tw-class="@container space-y-7 duration-300">
    <section tw-class="space-y-5">
      <div tw-class="flex items-center gap-2.5 border-b border-gray-200/70 pb-4 dark:border-gray-800">
        <InfoIcon aria-hidden="true" tw-class="h-5 w-5 shrink-0 text-blue-500 dark:text-blue-400" />
        <h2 tw-class="text-lg font-semibold tracking-tight text-gray-800 dark:text-gray-100">{{ lazyStrings.AboutTab__about_naidan() }}</h2>
      </div>

      <div tw-class="flex flex-col items-center space-y-4 rounded-2xl border border-gray-200/80 bg-gray-50/60 px-5 py-7 text-center dark:border-gray-800 dark:bg-gray-900/30 sm:py-8">
        <div tw-class="flex h-20 w-20 items-center justify-center rounded-2xl border border-gray-200/80 bg-white shadow-sm dark:border-gray-700/70 dark:bg-gray-800/45">
          <Logo :size="48" />
        </div>
        <div>
          <h3 tw-class="text-2xl font-bold tracking-tight text-gray-800 dark:text-gray-100">Naidan</h3>
          <p tw-class="mt-1 break-all text-sm font-medium text-blue-600 dark:text-blue-400">{{ lazyStrings.AboutTab__version({ version: appVersion }) }}</p>
        </div>
        <p tw-class="max-w-md text-sm leading-relaxed text-gray-600 dark:text-gray-300">{{ lazyStrings.AboutTab__privacy_focused_local_lm_interface() }}</p>
      </div>

      <div :tw-class="['grid grid-cols-1 gap-3 @lg:grid-cols-2', !isStandalone && '@2xl:grid-cols-3']">
        <a
          :href="documentationUrl"
          target="_blank"
          rel="noopener noreferrer"
          data-testid="documentation-link"
          tw-class="flex min-w-0 items-start gap-3 rounded-2xl border border-slate-200 bg-white p-4 no-underline transition-colors hover:border-slate-300 hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40 dark:border-slate-700/70 dark:bg-slate-800/70 dark:hover:border-slate-600 dark:hover:bg-slate-800 motion-reduce:transition-none @2xl:gap-2 @2xl:p-3"
        >
          <span tw-class="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-blue-50 text-blue-500 dark:bg-blue-500/10 dark:text-blue-400 @2xl:h-10 @2xl:w-10">
            <BookOpenIcon aria-hidden="true" tw-class="h-6 w-6" />
          </span>
          <div tw-class="min-w-0 flex-1">
            <div tw-class="flex items-center justify-between gap-2 text-sm font-semibold leading-snug text-gray-800 dark:text-gray-100">
              <span>{{ lazyStrings.AboutTab__documentation() }}</span>
              <ExternalLinkIcon v-if="isDocumentationExternal" data-testid="documentation-external-icon" aria-hidden="true" tw-class="h-3.5 w-3.5 shrink-0 text-gray-400 dark:text-gray-500" />
            </div>
            <p tw-class="mt-1 text-sm leading-relaxed text-gray-600 dark:text-gray-300">{{ lazyStrings.AboutTab__learn_how_to_use_naidan() }}</p>
          </div>
        </a>

        <a
          href="https://github.com/nwtgck/naidan"
          target="_blank"
          rel="noopener noreferrer"
          tw-class="flex min-w-0 items-start gap-3 rounded-2xl border border-slate-200 bg-white p-4 no-underline transition-colors hover:border-slate-300 hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40 dark:border-slate-700/70 dark:bg-slate-800/70 dark:hover:border-slate-600 dark:hover:bg-slate-800 motion-reduce:transition-none @2xl:gap-2 @2xl:p-3"
        >
          <span tw-class="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-gray-50 text-gray-500 dark:bg-gray-900/70 dark:text-gray-400 @2xl:h-10 @2xl:w-10">
            <GithubIcon aria-hidden="true" tw-class="h-6 w-6" />
          </span>
          <div tw-class="min-w-0 flex-1">
            <div tw-class="flex items-center justify-between gap-2 text-sm font-semibold leading-snug text-gray-800 dark:text-gray-100">
              <span>{{ lazyStrings.AboutTab__github_repository() }}</span>
              <ExternalLinkIcon aria-hidden="true" tw-class="h-3.5 w-3.5 shrink-0 text-gray-400 dark:text-gray-500" />
            </div>
            <p tw-class="mt-1 text-sm leading-relaxed text-gray-600 dark:text-gray-300">{{ lazyStrings.AboutTab__view_source_code() }}</p>
          </div>
        </a>

        <div v-if="!isStandalone" tw-class="relative min-w-0">
          <a
            :href="portableAppDownload.href"
            :download="portableAppDownload.fileName"
            :aria-label="lazyStrings.SHARED__download_portable_html_edition()"
            data-testid="portable-html-download"
            tw-class="flex h-full min-w-0 items-start gap-3 rounded-2xl border border-green-200 bg-green-50/70 p-4 no-underline transition-colors hover:border-green-300 hover:bg-green-100/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-green-500/40 dark:border-green-900/50 dark:bg-green-900/15 dark:hover:border-green-800 dark:hover:bg-green-900/20 motion-reduce:transition-none @2xl:gap-2 @2xl:p-3"
          >
            <span tw-class="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-green-100/80 text-green-600 dark:bg-green-500/15 dark:text-green-400 @2xl:h-10 @2xl:w-10">
              <DownloadIcon aria-hidden="true" tw-class="h-6 w-6" />
            </span>
            <div tw-class="min-w-0 flex-1">
              <p tw-class="pr-7 text-sm font-semibold leading-snug text-green-800 dark:text-green-300">{{ lazyStrings.SHARED__portable_html_edition() }}</p>
              <p tw-class="mt-1 text-sm leading-relaxed text-green-700 dark:text-green-300">{{ lazyStrings.AboutTab__download_zip() }}</p>
            </div>
          </a>
          <div v-if="props.visibility === 'visible'" tw-class="absolute right-2 top-3 @2xl:top-2">
            <AboutPortableEditionHelp />
          </div>
        </div>
      </div>
    </section>

    <OpenSourceLicenses v-if="props.visibility === 'visible'" />
  </div>
</template>
