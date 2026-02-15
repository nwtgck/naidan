export type DiffChangeType = 'added' | 'removed' | 'unchanged';

export interface DiffPart {
  type: DiffChangeType;
  value: string;
}

/**
 * Computes a word-level diff between two strings.
 * Adheres to GEMINI.md: Named arguments, explicit types, no defaults.
 */
export function computeWordDiff({ oldText, newText }: {
  oldText: string,
  newText: string,
}): DiffPart[] {
  // Tokenize by words, whitespace, and symbols to capture precise changes
  const tokenize = ({ text }: { text: string }) => {
    // Split by whitespace OR any non-word/non-whitespace character (symbols)
    // We use capturing groups to keep the delimiters in the result
    return text.split(/(\s+|[^\w\s])/).filter(Boolean);
  };

  const oldWords = tokenize({ text: oldText });
  const newWords = tokenize({ text: newText });

  const n = oldWords.length;
  const m = newWords.length;

  // Space optimization: we only need the current and previous row of the DP table
  // to compute the LCS length, but to backtrack we might need the whole table
  // or use a more efficient algorithm. For chat messages, N*M is manageable.
  // Use a flat array for better performance
  const dp = new Uint32Array((n + 1) * (m + 1));

  const getIdx = ({ i, j }: { i: number, j: number }) => i * (m + 1) + j;

  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      if (oldWords[i - 1] === newWords[j - 1]) {
        dp[getIdx({ i, j })] = (dp[getIdx({ i: i - 1, j: j - 1 })] ?? 0) + 1;
      } else {
        const left = dp[getIdx({ i, j: j - 1 })] ?? 0;
        const top = dp[getIdx({ i: i - 1, j })] ?? 0;
        dp[getIdx({ i, j })] = left >= top ? left : top;
      }
    }
  }

  const parts: DiffPart[] = [];
  let i = n;
  let j = m;

  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && oldWords[i - 1] === newWords[j - 1]) {
      parts.unshift({ type: 'unchanged', value: oldWords[i - 1]! });
      i--;
      j--;
    } else if (j > 0 && (i === 0 || (dp[getIdx({ i, j: j - 1 })] ?? 0) >= (dp[getIdx({ i: i - 1, j })] ?? 0))) {
      parts.unshift({ type: 'added', value: newWords[j - 1]! });
      j--;
    } else if (i > 0 && (j === 0 || (dp[getIdx({ i, j: j - 1 })] ?? 0) < (dp[getIdx({ i: i - 1, j })] ?? 0))) {
      parts.unshift({ type: 'removed', value: oldWords[i - 1]! });
      i--;
    }
  }

  // Merge consecutive parts of the same type
  const merged: DiffPart[] = [];
  for (const part of parts) {
    const last = merged[merged.length - 1];
    if (last && last.type === part.type) {
      last.value += part.value;
    } else {
      merged.push({ ...part });
    }
  }

  return merged;
}
