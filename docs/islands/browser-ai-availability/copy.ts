import { strings as en } from '../../pages/endpoint-type-browser-provided-lm/strings/checker/en';
import { strings as ja } from '../../pages/endpoint-type-browser-provided-lm/strings/checker/ja';
import type { BrowserAiAvailabilityCopy } from '../../pages/endpoint-type-browser-provided-lm/strings/checker/en';
import type { DocsLocale } from '../../site/routes';

export const checkerCopy = { en, ja } satisfies Record<DocsLocale, BrowserAiAvailabilityCopy>;
