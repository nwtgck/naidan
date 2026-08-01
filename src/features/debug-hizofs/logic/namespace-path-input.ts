import { encodeFilenameComponent } from "@/00-storage/service/hizofs/00-format";

export function parseHizoFSInspectorNamespacePath({ path }: {
  path: string;
}): readonly string[] {
  if (path === "/") return [];
  if (!path.startsWith("/")) {
    throw new TypeError("Inspector namespace path must be absolute");
  }
  const components = path.slice(1).split("/");
  for (const component of components) encodeFilenameComponent({ value: component });
  return components;
}

export function formatHizoFSInspectorNamespacePath({ pathComponents }: {
  pathComponents: readonly string[];
}): string {
  if (pathComponents.length === 0) return "/";
  const captured = pathComponents.map(component => {
    encodeFilenameComponent({ value: component });
    return component;
  });
  return `/${captured.join("/")}`;
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
