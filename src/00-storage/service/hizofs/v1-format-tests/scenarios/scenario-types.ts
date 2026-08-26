export type HizoFSV1FormatScenarioOperation =
  | Readonly<{
      path: readonly string[];
      type: "mkdir";
    }>
  | Readonly<{
      path: readonly string[];
      type: "create_file";
    }>
  | Readonly<{
      bytes: Uint8Array;
      path: readonly string[];
      type: "write_file";
    }>
  | Readonly<{
      path: readonly string[];
      target: string;
      type: "create_symlink";
    }>
  | Readonly<{
      bytes: Uint8Array;
      offset: number;
      path: readonly string[];
      type: "write_file_at";
    }>
  | Readonly<{
      path: readonly string[];
      size: number;
      type: "truncate_file";
    }>
  | Readonly<{
      from: readonly string[];
      replace: boolean;
      to: readonly string[];
      type: "clone_file";
    }>
  | Readonly<{
      from: readonly string[];
      replace: boolean;
      to: readonly string[];
      type: "move_entry";
    }>
  | Readonly<{
      path: readonly string[];
      recursive: boolean;
      type: "remove_entry";
    }>;

export type HizoFSV1FormatScenario = Readonly<{
  id: string;
  operations: readonly HizoFSV1FormatScenarioOperation[];
}>;

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
