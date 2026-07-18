<script setup lang="ts">
import type { HizoFSBinaryRecordInspectionView } from '@/features/debug-hizofs/worker/types';
import { JsonCodeView } from '@/features/json-viewer';
import BinaryHexView from './BinaryHexView.vue';
import DecodedBinaryFields from './DecodedBinaryFields.vue';

type BinaryDetailsStatus = 'not_loaded' | 'loading' | 'loaded' | 'error';

const props = defineProps<{
  readonly binary: HizoFSBinaryRecordInspectionView;
  readonly persistedDto: unknown;
  readonly dtoValidationError: string | undefined;
  readonly binaryDetailsStatus: BinaryDetailsStatus;
  readonly binaryDetailsError: string | undefined;
}>();

const emit = defineEmits<{
  (event: 'load-binary-details'): void;
}>();

function rawJson({ value }: { value: unknown }): string {
  return JSON.stringify(value, undefined, 2);
}

function handleLazyDetailsToggle({ event }: { event: Event }): void {
  const details = event.currentTarget;
  if (!(details instanceof HTMLDetailsElement) || !details.open) return;
  if (props.binaryDetailsStatus === 'not_loaded' || props.binaryDetailsStatus === 'error') {
    emit('load-binary-details');
  }
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
      <div tw-class="border-b border-gray-200 bg-gray-950 px-3 py-2 text-[9px] font-semibold uppercase tracking-wide text-gray-100 dark:border-gray-700">Record header · decrypted binary framing</div>
      <p tw-class="px-3 py-2 text-[9px] text-gray-400">The field table preserves offsets and raw bytes while decoding the fixed 16-byte record header.</p>
      <DecodedBinaryFields :fields="binary.decryptedRecord.headerFields" />
    </section>

    <section tw-class="border-t border-gray-200 dark:border-gray-700">
      <div tw-class="border-b border-gray-200 bg-emerald-50 px-3 py-2 text-[9px] font-semibold uppercase tracking-wide text-emerald-700 dark:border-gray-700 dark:bg-emerald-950/20 dark:text-emerald-300">Raw DTO · parsed only from the actual metadata JSON range</div>
      <JsonCodeView :source="rawJson({ value: persistedDto })" display-mode="formatted" overflow-mode="scroll" height-mode="content" />
    </section>

    <slot name="references" />

    <section tw-class="border-t border-gray-200 px-3 py-2 dark:border-gray-700">
      <div tw-class="text-[9px] font-semibold uppercase tracking-wide text-gray-500">Validation · derived</div>
      <div v-if="dtoValidationError === undefined" tw-class="mt-1 text-xs text-emerald-600 dark:text-emerald-400">Valid</div>
      <details v-else tw-class="mt-1 rounded border border-red-200 bg-red-50 dark:border-red-900 dark:bg-red-950/20">
        <summary tw-class="cursor-pointer px-2 py-1.5 text-xs text-red-700 dark:text-red-300">Invalid · show schema error</summary>
        <div tw-class="border-t border-red-200 px-2 py-2 font-mono text-xs text-red-700 dark:border-red-900 dark:text-red-300">{{ dtoValidationError }}</div>
      </details>
    </section>

    <details
      v-if="binary.decryptedRecord.binaryPayload.regionByteLength > 0"
      data-testid="hizofs-binary-payload-details"
      tw-class="border-t border-gray-200 dark:border-gray-700"
      @toggle="handleLazyDetailsToggle({ event: $event })"
    >
      <summary tw-class="cursor-pointer px-3 py-2 text-[9px] font-semibold uppercase tracking-wide text-gray-500">
        Binary payload · {{ binary.decryptedRecord.binaryPayload.regionByteLength }} bytes · lazy
      </summary>
      <div v-if="binaryDetailsStatus === 'loading'" tw-class="px-3 py-3 text-xs text-gray-500">Loading binary payload…</div>
      <div v-else-if="binaryDetailsStatus === 'error'" tw-class="px-3 py-3 text-xs text-red-600 dark:text-red-400">{{ binaryDetailsError }}</div>
      <BinaryHexView
        v-else-if="binaryDetailsStatus === 'loaded'"
        :bytes="binary.decryptedRecord.binaryPayload.bytes"
        :offset="binary.decryptedRecord.binaryPayload.offset"
        :region-byte-length="binary.decryptedRecord.binaryPayload.regionByteLength"
        :truncated-after="binary.decryptedRecord.binaryPayload.truncatedAfter"
      />
      <div v-else tw-class="px-3 py-3 text-xs text-gray-500">Expand to read the payload bytes.</div>
    </details>

    <details
      data-testid="hizofs-binary-representation-details"
      tw-class="border-t border-gray-200 dark:border-gray-700"
      @toggle="handleLazyDetailsToggle({ event: $event })"
    >
      <summary tw-class="cursor-pointer px-3 py-2 text-[9px] font-semibold uppercase tracking-wide text-gray-500">
        Binary representation · {{ binary.persistedObject.bytes.regionByteLength }} persisted bytes · lazy
      </summary>
      <div v-if="binaryDetailsStatus === 'loading'" tw-class="px-3 py-3 text-xs text-gray-500">Loading binary ranges…</div>
      <div v-else-if="binaryDetailsStatus === 'error'" tw-class="px-3 py-3 text-xs text-red-600 dark:text-red-400">{{ binaryDetailsError }}</div>
      <template v-else-if="binaryDetailsStatus === 'loaded'">
        <section>
          <div tw-class="border-y border-gray-200 bg-gray-50 px-3 py-2 text-[9px] font-semibold uppercase tracking-wide text-gray-500 dark:border-gray-700 dark:bg-gray-950">Authenticated persisted frame fields</div>
          <DecodedBinaryFields :fields="binary.persistedObject.headerFields" />
          <dl tw-class="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 px-3 py-2 font-mono text-[9px] text-gray-500 dark:text-gray-400">
            <dt>ciphertext offset</dt><dd>0x{{ binary.persistedObject.ciphertextOffset.toString(16).padStart(8, '0') }}</dd>
            <dt>ciphertext length</dt><dd>{{ binary.persistedObject.ciphertextByteLength }} bytes</dd>
          </dl>
        </section>

        <details tw-class="border-t border-gray-200 dark:border-gray-700">
          <summary tw-class="cursor-pointer px-3 py-2 text-[9px] font-semibold uppercase tracking-wide text-gray-500">Persisted authenticated frame bytes</summary>
          <BinaryHexView
            :bytes="binary.persistedObject.bytes.bytes"
            :offset="binary.persistedObject.bytes.offset"
            :region-byte-length="binary.persistedObject.bytes.regionByteLength"
            :truncated-after="binary.persistedObject.bytes.truncatedAfter"
          />
        </details>

        <details tw-class="border-t border-gray-200 dark:border-gray-700">
          <summary tw-class="cursor-pointer px-3 py-2 text-[9px] font-semibold uppercase tracking-wide text-gray-500">Complete decrypted record bytes</summary>
          <BinaryHexView
            :bytes="binary.decryptedRecord.bytes.bytes"
            :offset="binary.decryptedRecord.bytes.offset"
            :region-byte-length="binary.decryptedRecord.bytes.regionByteLength"
            :truncated-after="binary.decryptedRecord.bytes.truncatedAfter"
          />
        </details>

        <details tw-class="border-t border-gray-200 dark:border-gray-700">
          <summary tw-class="cursor-pointer px-3 py-2 text-[9px] font-semibold uppercase tracking-wide text-gray-500">Metadata JSON encoding</summary>
          <BinaryHexView
            :bytes="binary.decryptedRecord.metadataJson.bytes.bytes"
            :offset="binary.decryptedRecord.metadataJson.bytes.offset"
            :region-byte-length="binary.decryptedRecord.metadataJson.bytes.regionByteLength"
            :truncated-after="binary.decryptedRecord.metadataJson.bytes.truncatedAfter"
          />
          <pre v-if="binary.decryptedRecord.metadataJson.utf8Text !== undefined" tw-class="overflow-x-auto whitespace-pre-wrap break-all border-t border-gray-200 px-3 py-2 font-mono text-[10px] text-gray-700 dark:border-gray-700 dark:text-gray-200">{{ binary.decryptedRecord.metadataJson.utf8Text }}</pre>
          <div v-else tw-class="border-t border-gray-200 px-3 py-2 text-xs text-gray-500 dark:border-gray-700">The complete UTF-8 source text was not loaded in this preview.</div>
        </details>
      </template>
      <div v-else tw-class="px-3 py-3 text-xs text-gray-500">Expand to fetch byte ranges that are not needed for normal DTO and reference traversal.</div>
    </details>
  </div>
</template>
