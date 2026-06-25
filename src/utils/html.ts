export function escapeTextForHtml({
  text,
}: {
  text: string,
}): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
