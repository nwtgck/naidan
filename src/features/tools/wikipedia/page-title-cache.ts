const rememberedPageTitlesByKey = new Map<string, string>();

function createWikipediaPageTitleCacheKey({
  lang,
  pageId,
}: {
  lang: string,
  pageId: number,
}): string {
  return `${lang}:${pageId}`;
}

export function rememberWikipediaPageTitle({
  lang,
  pageId,
  title,
}: {
  lang: string,
  pageId: number,
  title: string,
}): void {
  rememberedPageTitlesByKey.set(createWikipediaPageTitleCacheKey({
    lang,
    pageId,
  }), title);
}

export function getRememberedWikipediaPageTitle({
  lang,
  pageId,
}: {
  lang: string,
  pageId: number,
}): string | undefined {
  return rememberedPageTitlesByKey.get(createWikipediaPageTitleCacheKey({
    lang,
    pageId,
  }));
}

function clearRememberedWikipediaPageTitles(): void {
  rememberedPageTitlesByKey.clear();
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
  clearRememberedWikipediaPageTitles,
};
