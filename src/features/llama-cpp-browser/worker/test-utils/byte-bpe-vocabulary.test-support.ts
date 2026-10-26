/** Self-authored byte vocabulary; no model vocabulary or merge table is copied. */
export function createByteBpeVocabulary() {
  // GPT-2-style BPE spells otherwise non-printable bytes with extra code points.
  const bytes: string[] = [];
  let nextCharacter = 256;
  for (let byte = 0; byte < 256; byte++) {
    const visible = byte >= 33 && byte <= 126 || byte >= 161 && byte <= 172 || byte >= 174;
    bytes.push(String.fromCodePoint(visible ? byte : nextCharacter++));
  }
  return {
    tokens: ['<unk>', '<s>', '</s>', ...bytes, bytes[32]! + bytes[10]!],
    merges: [`${bytes[32]} ${bytes[10]}`],
  };
}
