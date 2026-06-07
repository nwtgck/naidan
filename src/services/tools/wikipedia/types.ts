export type WikipediaLanguageCode = string;

export type WikipediaSearchLanguages = readonly [
  WikipediaLanguageCode,
  WikipediaLanguageCode?,
];

export type WikipediaSearchItem = {
  title: string;
  pageId: number;
};

export type WikipediaSearchGroup = {
  lang: WikipediaLanguageCode;
  items: WikipediaSearchItem[];
};

export type WikipediaSearchResult = {
  groups: WikipediaSearchGroup[];
};

export type WikipediaPageResult = {
  lang: WikipediaLanguageCode;
  pageId: number;
  title: string;
  content: string;
};
