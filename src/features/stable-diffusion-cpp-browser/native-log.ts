export type ImageNativeLog = { sourceFile: string, message: string };

/** Recognize only a bounded source-tagged native line. Callers still validate
 * the source filename and the complete diagnostic payload before using it. */
export function parseImageNativeLog({ message }: { message: string }): ImageNativeLog | undefined {
  if (message.length > 2048) {
    return undefined;
  }
  const prefix = /^([a-zA-Z0-9_-]+\.(?:cpp|hpp|h|c)):\d+[ \t]+-[ \t]+([^\r\n]*)(?:\r?\n)?$/.exec(message);
  if (prefix && prefix[0] === message) {
    return { sourceFile: prefix[1]!, message: prefix[2]! };
  }
  const suffix = /^([^\r\n]*) --- ([a-zA-Z0-9_-]+\.(?:cpp|hpp|h|c)):\d+(?:\r?\n)?$/.exec(message);
  if (suffix && suffix[0] === message) {
    return { sourceFile: suffix[2]!, message: suffix[1]! };
  }
  return undefined;
}

export const TEST_ONLY = {
};
