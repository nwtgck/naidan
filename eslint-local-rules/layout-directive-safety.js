const lineBreakPattern = /\r\n|[\n\r\u2028\u2029]/gu;

// Changing line breaks can change the meaning of next-line/line directives,
// including directives consumed by tools other than ESLint. Do not guess at
// their attachment. Annotation and documentation attachment is checked separately.
export function getProtectedLines({ sourceCode }) {
  const intervals = [];
  for (const comment of sourceCode.getAllComments()) {
    // TypeScript also recognizes directives on the last line of block
    // comments and in triple-slash comments. Conservatively inspect every
    // comment line instead of only the first non-whitespace character.
    const lines = comment.value.split(lineBreakPattern).map(line => line.replace(/^[\s/*]*/u, ''));
    // TypeScript matches these directive prefixes without a word boundary:
    // even `@ts-expect-errorTS2304` suppresses the following code line.
    // Match the compiler's behavior rather than requiring a separated reason.
    const typeScriptNextLine = lines.some(line => /^@ts-(?:expect-error|ignore)/u.test(line));
    if (!typeScriptNextLine && !lines.some(line => /^(?:eslint(?:-(?:disable(?:-next-line|-line)?|enable))?\b|@ts-(?:check|nocheck)\b|(?:istanbul|c8|v8)\s+ignore\b|node:coverage\s+(?:ignore|disable|enable)\b|prettier-ignore\b|biome-ignore\b)/u.test(line))) {
      continue;
    }
    const nextLine = typeScriptNextLine || lines.some(line => /^(?:eslint-disable-next-line\b|(?:istanbul|c8|v8)\s+ignore\b|node:coverage\s+ignore\s+next\b|prettier-ignore\b|biome-ignore\b)/u.test(line));
    // c8/v8 and the Node.js test runner can suppress a counted span, not
    // merely the next statement's first token. Expanding an object anywhere
    // inside that span would shift its end.
    const coveredLines = lines.reduce((count, line) => {
      const match = /^(?:c8|v8|node:coverage)\s+ignore\s+next\s+(\d+)\b/u.exec(line);
      return match ? Math.max(count, Math.min(Number(match[1]), sourceCode.lines.length)) : count;
    }, nextLine ? 1 : 0);
    const start = comment.loc.start.line;
    // Some tools skip blank/comment-only lines when finding the target. Extend
    // protection through the next code token, not just the next physical line.
    const nextToken = nextLine ? sourceCode.getTokenAfter(comment) : undefined;
    const end = Math.max(comment.loc.end.line + coveredLines, nextToken?.loc.start.line ?? 0);
    const previous = intervals.at(-1);
    if (previous && start <= previous.end + 1) {
      previous.end = Math.max(previous.end, end);
    } else {
      intervals.push({ start, end });
    }
  }
  return intervals;
}

export function intersectsProtectedLines({ node, intervals }) {
  let low = 0;
  let high = intervals.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (intervals[middle].end < node.loc.start.line) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }
  return low < intervals.length && intervals[low].start <= node.loc.end.line;
}
