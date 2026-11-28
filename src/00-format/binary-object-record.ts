export function binaryObjectRecord({ parentPath, body, complete }: { parentPath: readonly string[], body: string, complete: string }) {
  return {
    parentPath,
    async open<T>({ openFile }: {
      openFile({ name }: { name: string }): Promise<T>,
    }): Promise<T> {
      await openFile({ name: complete });
      return openFile({ name: body });
    },
    async write({ writeBody, createMarker }: {
      writeBody({ name }: { name: string }): Promise<void>,
      createMarker({ name }: { name: string }): Promise<void>,
    }): Promise<void> {
      await writeBody({ name: body });
      await createMarker({ name: complete });
    },
    async remove({ removeFile }: { removeFile({ name }: { name: string }): Promise<void> }): Promise<void> {
      await removeFile({ name: body });
      await removeFile({ name: complete });
    },
  };
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
export const TEST_ONLY = {
};
