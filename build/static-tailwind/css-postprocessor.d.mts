export const naidanAutoprefixerOptions: Readonly<Record<string, never>>;

export function postprocessStaticTailwindCss(options: {
  css: string,
}): string;

export function assertStaticTailwindCssHasNoRelativeUrls(options: {
  css: string,
}): void;
