export type WikipediaLanguageCode = string;

export type WikipediaSearchLanguages = readonly [
  WikipediaLanguageCode,
  WikipediaLanguageCode?,
];

export type WikipediaSearchItem = {
  title: string,
  pageId: number,
};

export type WikipediaSearchGroup = {
  lang: WikipediaLanguageCode,
  items: WikipediaSearchItem[],
};

export type WikipediaSearchResult = {
  groups: WikipediaSearchGroup[],
};

export type WikipediaPageResult = {
  kind: 'inline',
  lang: WikipediaLanguageCode,
  pageId: number,
  title: string,
  content: string,
} | {
  kind: 'binary_object',
  lang: WikipediaLanguageCode,
  pageId: number,
  title: string,
  lineCount: number,
  byteLength: number,
  sysfsNaidanDataFilePath: string,
};

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {};
