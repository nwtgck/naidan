import { strings as en } from '../../strings/models/browser-provided/checker/en';
import { strings as ja } from '../../strings/models/browser-provided/checker/ja';
import type { BrowserAiAvailabilityCopy } from '../../strings/models/browser-provided/checker/en';
import type { DocsLocale } from '../../site/routes';

export const checkerCopy = { en, ja } satisfies Record<DocsLocale, BrowserAiAvailabilityCopy>;
