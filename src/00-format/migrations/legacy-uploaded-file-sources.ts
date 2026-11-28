/** The old root contains attachment IDs, with named files one level below. */
export async function* listLegacyAttachmentSources<T extends { kind: 'directory' | 'file', name: string }>({ attachments, listFiles }: {
  attachments: AsyncIterable<T>,
  listFiles({ directory }: { directory: T }): AsyncIterable<T>,
}): AsyncIterable<{ attachmentId: string, file: T } | undefined> {
  for await (const attachment of attachments) {
    const kind = attachment.kind;
    switch (kind) {
    case 'file':
      yield undefined;
      break;
    case 'directory':
      for await (const file of listFiles({ directory: attachment })) {
        const fileKind = file.kind;
        switch (fileKind) {
        case 'file':
          yield { attachmentId: attachment.name, file };
          break;
        case 'directory':
          yield undefined;
          break;
        default: {
          const exhaustive: never = fileKind;
          throw new Error(`Unhandled legacy file kind: ${exhaustive}`);
        }
        }
      }
      break;
    default: {
      const exhaustive: never = kind;
      throw new Error(`Unhandled legacy entry kind: ${exhaustive}`);
    }
    }
  }
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
export const TEST_ONLY = {
};
