export function visibleGuideText({ text }: { text: string }): string {
  return text.replaceAll('［', '').replaceAll('］', '');
}
