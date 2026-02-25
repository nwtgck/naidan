/**
 * Detects if a given endpoint is an Ollama instance.
 * Ollama returns "Ollama is running" on its base URL.
 */
export async function detectOllama({ url, headers }: {
  url: string;
  headers?: [string, string][];
}): Promise<boolean> {
  if (!url) return false;

  try {
    const headerObj: Record<string, string> = {};
    if (headers) {
      for (const [k, v] of headers) {
        if (k && v) headerObj[k] = v;
      }
    }

    const response = await fetch(url, {
      method: 'GET',
      headers: headerObj,
    });

    if (!response.ok) return false;

    const text = await response.text();
    return text.includes('Ollama is running');
  } catch (e) {
    // Silently fail if connection fails or CORS blocks it
    return false;
  }
}
