<script setup lang="ts">
import { computed } from 'vue';
import { marked, sanitizeHtml, ExternalImagePayloadSchema, type ExternalImagePayload } from './useMarkdown';
import ExternalImage from './ExternalImage.vue';

const props = defineProps<{
  text: string;
}>();

interface ImagePart {
  type: 'image';
  payload: ExternalImagePayload;
}

interface HtmlPart {
  type: 'html';
  content: string;
}

type Part = ImagePart | HtmlPart;

const parts = computed<Part[]>(() => {
  if (!props.text) return [];
  
  const rawHtml = marked.parseInline(props.text) as string;
  const sanitized = sanitizeHtml({ html: rawHtml });

  // Regex to match our custom tag and capture its data-payload attribute
  const tagRegex = /<naidan-external-image\s+data-payload="([^"]+)">\s*<\/naidan-external-image>/g;
  
  const result: Part[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = tagRegex.exec(sanitized)) !== null) {
    // Add preceding HTML
    if (match.index > lastIndex) {
      result.push({
        type: 'html',
        content: sanitized.substring(lastIndex, match.index)
      });
    }

    // Add image part
    try {
      const payloadBase64 = match[1];
      if (payloadBase64) {
        const payloadJson = decodeURIComponent(atob(payloadBase64));
        const data = JSON.parse(payloadJson);
        const validated = ExternalImagePayloadSchema.safeParse(data);
        if (validated.success) {
          result.push({
            type: 'image',
            payload: validated.data
          });
        } else {
          console.error('Invalid image payload schema:', validated.error);
        }
      }
    } catch (e) {
      console.error('Failed to parse image payload:', e);
    }

    lastIndex = tagRegex.lastIndex;
  }

  // Add remaining HTML
  if (lastIndex < sanitized.length) {
    result.push({
      type: 'html',
      content: sanitized.substring(lastIndex)
    });
  }

  return result;
});

defineExpose({
  __testOnly: {
    parts,
  }
});
</script>

<template>
  <template v-for="(part, idx) in parts" :key="idx">
    <span v-if="part.type === 'html'" v-html="part.content"></span>
    <ExternalImage
      v-else-if="part.type === 'image'"
      :src="part.payload.href"
      :alt="part.payload.text"
      :title="part.payload.title || undefined"
    />
  </template>
</template>
