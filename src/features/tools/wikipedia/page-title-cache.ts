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

export function clearRememberedWikipediaPageTitles(): void {
  rememberedPageTitlesByKey.clear();
}
