export type FileLocation = {
  name: string,
  /** Segments from the OPFS root, including the file name. */
  path: readonly string[],
};

export type ReadFileText = ({ file }: { file: FileLocation }) => Promise<string | undefined>;
export type WriteFileText = ({ file, text }: { file: FileLocation, text: string }) => Promise<void>;

// Export internal state and logic used only for testing here. Do not reference these in production logic.
export const TEST_ONLY = {
};
