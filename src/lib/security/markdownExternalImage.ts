import { z } from 'zod';

export const ExternalImagePayloadSchema = z.object({
  href: z.string(),
  title: z.string().nullable(),
  text: z.string(),
});

export type ExternalImagePayload = z.infer<typeof ExternalImagePayloadSchema>;

export function encodeExternalImagePayload({
  payload,
}: {
  payload: ExternalImagePayload;
}): string {
  return btoa(encodeURIComponent(JSON.stringify(payload)));
}

export function decodeExternalImagePayload({
  encodedPayload,
}: {
  encodedPayload: string;
}): ExternalImagePayload | undefined {
  try {
    const payloadJson = decodeURIComponent(atob(encodedPayload));
    const data: unknown = JSON.parse(payloadJson);
    const validated = ExternalImagePayloadSchema.safeParse(data);
    if (validated.success) {
      return validated.data;
    }

    console.error('Invalid image payload schema:', validated.error);
    return undefined;
  } catch (e) {
    console.error('Failed to parse image payload:', e);
    return undefined;
  }
}
