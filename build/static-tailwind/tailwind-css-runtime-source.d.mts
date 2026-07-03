export type TailwindCssRuntimeFragment = readonly [order: number, css: string];

export type TailwindCssRegistry = {
  register(options: {
    moduleId: string,
    fragments: readonly TailwindCssRuntimeFragment[],
  }): void,
  unregister(options: { moduleId: string }): void,
  flush(): void,
};

export function createTailwindCssRegistry(options: {
  document: Document,
  scheduleFlush(options: { callback: () => void }): void,
}): TailwindCssRegistry;

export function createTailwindCssRuntimeModuleSource(): string;

export function createTailwindCssRegistrationModuleSource(options: {
  moduleId: string,
  fragments: readonly TailwindCssRuntimeFragment[],
  runtimeModuleId: string,
}): string;
