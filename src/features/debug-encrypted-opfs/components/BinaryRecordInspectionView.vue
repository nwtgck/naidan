<script setup lang="ts">
import type { EncryptedOpfsBinaryRecordInspectionView } from '@/features/debug-encrypted-opfs/worker/types';
import { JsonCodeView } from '@/features/json-viewer';
import BinaryHexView from './BinaryHexView.vue';
import DecodedBinaryFields from './DecodedBinaryFields.vue';

defineProps<{
  readonly binary: EncryptedOpfsBinaryRecordInspectionView;
  readonly persistedDto: unknown;
  readonly dtoValidationError: string | undefined;
}>();

function rawJson({ value }: { value: unknown }): string {
  return JSON.stringify(value, undefined, 2);
}

defineExpose({
  ...((__BUILD_MODE_IS_TEST__ && {
    TEST_ONLY: {
    },
  }) || {}),
});
</script>

<template>
  <div>
    <section>
      <div tw-class="border-b border-gray-200 bg-gray-950 px-3 py-2 text-[9px] font-semibold uppercase tracking-wide text-gray-100 dark:border-gray-700">Persisted object bytes</div>
      <BinaryHexView
        :bytes="binary.persistedObject.bytes.bytes"
        :offset="binary.persistedObject.bytes.offset"
        :region-byte-length="binary.persistedObject.bytes.regionByteLength"
        :truncated-after="binary.persistedObject.bytes.truncatedAfter"
      />
    </section>

    <details open tw-class="border-t border-gray-200 dark:border-gray-700">
      <summary tw-class="cursor-pointer px-3 py-2 text-[9px] font-semibold uppercase tracking-wide text-gray-500">Decoded object envelope fields</summary>
      <p tw-class="px-3 pb-2 text-[9px] text-gray-400">Offsets and raw bytes remain visible; decoded values are an interpretation of the persisted binary framing.</p>
      <DecodedBinaryFields :fields="binary.persistedObject.headerFields" />
      <dl tw-class="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 px-3 py-2 font-mono text-[9px] text-gray-500 dark:text-gray-400">
        <dt>ciphertext offset</dt><dd>0x{{ binary.persistedObject.ciphertextOffset.toString(16).padStart(8, '0') }}</dd>
        <dt>ciphertext length</dt><dd>{{ binary.persistedObject.ciphertextByteLength }} bytes</dd>
      </dl>
    </details>

    <section tw-class="border-t border-gray-200 dark:border-gray-700">
      <div tw-class="border-b border-gray-200 bg-gray-950 px-3 py-2 text-[9px] font-semibold uppercase tracking-wide text-gray-100 dark:border-gray-700">Decrypted record bytes</div>
      <BinaryHexView
        :bytes="binary.decryptedRecord.bytes.bytes"
        :offset="binary.decryptedRecord.bytes.offset"
        :region-byte-length="binary.decryptedRecord.bytes.regionByteLength"
        :truncated-after="binary.decryptedRecord.bytes.truncatedAfter"
      />
    </section>

    <details open tw-class="border-t border-gray-200 dark:border-gray-700">
      <summary tw-class="cursor-pointer px-3 py-2 text-[9px] font-semibold uppercase tracking-wide text-gray-500">Decoded record header fields</summary>
      <p tw-class="px-3 pb-2 text-[9px] text-gray-400">The decrypted plaintext remains binary. These field rows decode its fixed 16-byte record header.</p>
      <DecodedBinaryFields :fields="binary.decryptedRecord.headerFields" />
    </details>

    <details tw-class="border-t border-gray-200 dark:border-gray-700">
      <summary tw-class="cursor-pointer px-3 py-2 text-[9px] font-semibold uppercase tracking-wide text-gray-500">Metadata JSON bytes</summary>
      <BinaryHexView
        :bytes="binary.decryptedRecord.metadataJson.bytes.bytes"
        :offset="binary.decryptedRecord.metadataJson.bytes.offset"
        :region-byte-length="binary.decryptedRecord.metadataJson.bytes.regionByteLength"
        :truncated-after="binary.decryptedRecord.metadataJson.bytes.truncatedAfter"
      />
    </details>

    <details tw-class="border-t border-gray-200 dark:border-gray-700">
      <summary tw-class="cursor-pointer px-3 py-2 text-[9px] font-semibold uppercase tracking-wide text-gray-500">Metadata UTF-8 text</summary>
      <pre tw-class="overflow-x-auto whitespace-pre-wrap break-all px-3 py-2 font-mono text-[10px] text-gray-700 dark:text-gray-200">{{ binary.decryptedRecord.metadataJson.utf8Text }}</pre>
    </details>

    <section tw-class="border-t border-gray-200 dark:border-gray-700">
      <div tw-class="border-b border-gray-200 bg-emerald-50 px-3 py-2 text-[9px] font-semibold uppercase tracking-wide text-emerald-700 dark:border-gray-700 dark:bg-emerald-950/20 dark:text-emerald-300">Raw DTO · parsed only from the actual metadata JSON range</div>
      <JsonCodeView :source="rawJson({ value: persistedDto })" display-mode="formatted" overflow-mode="scroll" height-mode="content" />
    </section>
    <div v-if="dtoValidationError !== undefined" tw-class="border-t border-red-200 bg-red-50 p-3 dark:border-red-900 dark:bg-red-950/20">
      <div tw-class="text-[9px] font-semibold uppercase tracking-wide text-red-500">Validation · derived</div>
      <div tw-class="mt-1 font-mono text-xs text-red-700 dark:text-red-300">{{ dtoValidationError }}</div>
    </div>

    <details open tw-class="border-t border-gray-200 dark:border-gray-700">
      <summary tw-class="cursor-pointer px-3 py-2 text-[9px] font-semibold uppercase tracking-wide text-gray-500">Binary payload bytes</summary>
      <BinaryHexView
        :bytes="binary.decryptedRecord.binaryPayload.bytes"
        :offset="binary.decryptedRecord.binaryPayload.offset"
        :region-byte-length="binary.decryptedRecord.binaryPayload.regionByteLength"
        :truncated-after="binary.decryptedRecord.binaryPayload.truncatedAfter"
      />
    </details>
  </div>
</template>
