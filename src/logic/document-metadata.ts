export type PageMetadata = Readonly<{
  title: string,
  description: string,
}>;

export type HomeIntroduction =
  | Readonly<{ kind: 'active', routePaths: readonly string[] }>
  | Readonly<{ kind: 'inactive' }>;

export type DocumentMetadataRoute = Readonly<{
  path: string,
  query: Readonly<Record<string, unknown>>,
  matched: readonly Readonly<{ path: string }>[],
}>;

export const SITE_METADATA = {
  name: 'Naidan',
  url: 'https://naidan.nwtgck.org',
  image: 'https://naidan.nwtgck.org/favicon.svg',
  description: 'A privacy-focused, local-first AI app. Run models on your device, directly in your browser, or connect to OpenAI-compatible APIs and Ollama.',
} as const;

// Public introduction copy intentionally uses English, including before UI strings load.
export const HOME_METADATA: PageMetadata = {
  title: 'Naidan | Run AI on your device, directly in your browser',
  description: SITE_METADATA.description,
};

export const APPLICATION_METADATA: PageMetadata = {
  title: SITE_METADATA.name,
  description: SITE_METADATA.description,
};

export const AUDIO_METADATA: PageMetadata = {
  title: 'Text to speech on your device, directly in your browser | Naidan',
  description: 'Turn text into speech on your device, directly in your browser with Naidan. Choose a local AI model and generate audio without installation.',
};

export const IMAGE_METADATA: PageMetadata = {
  title: 'Generate images on your device, directly in your browser | Naidan',
  description: 'Generate images on your device, directly in your browser with Naidan. Choose a local AI model and enter a prompt to create images without installation.',
};

export function isHomepageIntroductionRoute({ route }: { route: DocumentMetadataRoute }): boolean {
  return (route.path === '/' || route.path === '/home') && route.query['llama-cpp-browser-model'] === undefined && route.query.q === undefined && route.query.settings === undefined;
}

export function isHomeIntroductionActive({ introduction, route }: {
  introduction: HomeIntroduction,
  route: DocumentMetadataRoute | undefined,
}): boolean {
  switch (introduction.kind) {
  case 'inactive': return false;
  case 'active': return route !== undefined && introduction.routePaths.includes(route.path)
    && route.query['llama-cpp-browser-model'] === undefined && route.query.q === undefined && route.query.settings === undefined;
  default: {
    const _ex: never = introduction;
    return _ex;
  }
  }
}

export function routeDocumentMetadata({ route }: { route: DocumentMetadataRoute | undefined }): PageMetadata {
  if (route === undefined) {
    return APPLICATION_METADATA;
  }
  const path = route.path.replace(/\/+$/, '');
  if (path === '/home') {
    return HOME_METADATA;
  }
  if (path === '/audio-generation' && route.matched.some(record => record.path === '/audio-generation')) {
    return AUDIO_METADATA;
  }
  if (path === '/image-generation' && route.matched.some(record => record.path === '/image-generation')) {
    return IMAGE_METADATA;
  }
  return APPLICATION_METADATA;
}

export function applyDocumentMetadata({ document, page, documentTitle }: {
  document: Document,
  page: PageMetadata,
  documentTitle: string,
}): void {
  const { title, description, ...unhandled } = page;
  unhandled satisfies Record<PropertyKey, never>;
  const titles = [...document.head.querySelectorAll('title')];
  for (const duplicate of titles.slice(1)) {
    duplicate.remove();
  }
  if (document.title !== documentTitle || titles.length === 0) {
    document.title = documentTitle;
  }
  document.head.querySelector('title')?.setAttribute('data-document-metadata', '');

  const entries = [
    { attribute: 'name', key: 'description', content: description },
    { attribute: 'property', key: 'og:title', content: title },
    { attribute: 'property', key: 'og:description', content: description },
    { attribute: 'name', key: 'twitter:title', content: title },
    { attribute: 'name', key: 'twitter:description', content: description },
  ] as const;
  for (const { attribute, key, content } of entries) {
    const matches = [...document.head.querySelectorAll<HTMLMetaElement>(`meta[${attribute}="${key}"]`)];
    const meta = matches[0] ?? document.createElement('meta');
    for (const duplicate of matches.slice(1)) {
      duplicate.remove();
    }
    meta.setAttribute(attribute, key);
    meta.setAttribute('data-document-metadata', '');
    if (meta.content !== content) {
      meta.content = content;
    }
    if (meta.parentNode === null) {
      document.head.append(meta);
    }
  }
}

export const TEST_ONLY = {
};
