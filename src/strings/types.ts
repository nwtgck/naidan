import { z } from 'zod';

export const UiLocaleSchema = z.enum(['en', 'ja']);
export type UiLocale = z.infer<typeof UiLocaleSchema>;
