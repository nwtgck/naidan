import { computed, ref, type Ref } from 'vue';
import { useRoute, useRouter, type LocationQuery } from 'vue-router';

export function readTranslationLanguages({ query }: { query: LocationQuery }): { sourceLang: string | undefined, targetLang: string | undefined, invalid: boolean } {
  const from = query.from;
  const to = query.to;
  return {
    sourceLang: typeof from === 'string' && from !== '' && from !== 'auto' ? from : undefined,
    targetLang: typeof to === 'string' ? to : undefined,
    // Repeated, valueless and empty target parameters must not silently become
    // another language. Absence alone selects the model's default target.
    invalid: Array.isArray(from) || Array.isArray(to) || from === null || to === null || to === '',
  };
}

export function useTranslationLanguages({ defaultTarget }: { defaultTarget: Readonly<Ref<string>> }) {
  const route = useRoute();
  const router = useRouter();
  const parsed = computed(() => readTranslationLanguages({ query: route.query }));
  const sourceLang = computed(() => parsed.value.sourceLang);
  const targetLang = computed(() => parsed.value.targetLang ?? defaultTarget.value);
  const changing = ref(false);
  const failed = ref(false);

  async function choose({ source, target }: { source: string | undefined, target: string }): Promise<boolean> {
    if (changing.value) {
      return false;
    }
    const path = route.path;
    const query = { ...route.query };
    if (source === undefined) {
      delete query.from;
    } else {
      query.from = source;
    }
    if (target === defaultTarget.value) {
      delete query.to;
    } else {
      query.to = target;
    }
    changing.value = true;
    failed.value = false;
    try {
      const failure = await router.replace({ path, query, hash: route.hash });
      return !failure && route.path === path;
    } catch {
      failed.value = true;
      return false;
    } finally {
      changing.value = false;
    }
  }
  return { sourceLang, targetLang, invalid: computed(() => parsed.value.invalid), changing, failed, choose, ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) };
}

export const TEST_ONLY = {
};
