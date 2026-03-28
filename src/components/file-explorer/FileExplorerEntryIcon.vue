<script setup lang="ts">
import {
  Folder, FileText, Image, Video, Music, File,
  FileCode, FileJson, FileType,
} from 'lucide-vue-next';
import type { EntryKind, MimeCategory } from './types';

const props = defineProps<{
  kind: EntryKind;
  extension: string;
  mimeCategory: MimeCategory;
  size?: 'sm' | 'md' | 'lg';
}>();

const sizeClass = {
  sm: 'w-4 h-4',
  md: 'w-6 h-6',
  lg: 'w-10 h-10',
};

function getIcon() {
  switch (props.kind) {
  case 'directory': return Folder;
  case 'file': break;
  default: {
    const _ex: never = props.kind;
    void _ex;
  }
  }

  switch (props.mimeCategory) {
  case 'image': return Image;
  case 'video': return Video;
  case 'audio': return Music;
  case 'text': {
    switch (props.extension) {
    case '.json':
    case '.jsonl':
      return FileJson;
    case '.ts':
    case '.tsx':
    case '.js':
    case '.jsx':
    case '.vue':
    case '.py':
    case '.rs':
    case '.go':
    case '.rb':
    case '.php':
    case '.java':
    case '.kt':
    case '.swift':
    case '.c':
    case '.cpp':
    case '.cs':
      return FileCode;
    case '.md':
    case '.markdown':
      return FileType;
    default:
      return FileText;
    }
  }
  case 'binary':
    return File;
  default: {
    const _exhaustiveCheck: never = props.mimeCategory;
    void _exhaustiveCheck;
    return File;
  }
  }
}

function getColorClass() {
  switch (props.kind) {
  case 'directory': return 'text-amber-500';
  case 'file': return 'text-blue-500';
  default: {
    const _ex: never = props.kind;
    void _ex;
    return 'text-gray-400';
  }
  }
}


defineExpose({
  __testOnly: {
    // Export internal state and logic used only for testing here. Do not reference these in production logic.
  }
});
</script>

<template>
  <component
    :is="getIcon()"
    :class="[sizeClass[size ?? 'sm'], getColorClass()]"
  />
</template>
