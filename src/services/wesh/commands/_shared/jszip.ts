import JSZip from 'jszip';

interface JSZipObjectWithInternalStream extends JSZip.JSZipObject {
  // eslint-disable-next-line local-rules-named-args/require-named-args -- Kept positional because this method mirrors the JSZip internalStream signature.
  internalStream(type: 'uint8array'): JSZip.JSZipStreamHelper<Uint8Array>;
}

export function generateZipReadableStream({
  zip,
}: {
  zip: JSZip;
}): ReadableStream<Uint8Array> {
  return new ReadableStream({
    // eslint-disable-next-line local-rules-named-args/require-named-args -- Kept positional because this callback mirrors the Web Streams underlying source start signature.
    start(controller) {
      zip.generateInternalStream({
        type: 'uint8array',
        streamFiles: true,
      })
        .on('data', (data) => controller.enqueue(data))
        .on('error', (error) => controller.error(error))
        .on('end', () => controller.close())
        .resume();
    },
  });
}

export function zipObjectToReadableStream({
  entry,
}: {
  entry: JSZip.JSZipObject;
}): ReadableStream<Uint8Array> {
  return new ReadableStream({
    // eslint-disable-next-line local-rules-named-args/require-named-args -- Kept positional because this callback mirrors the Web Streams underlying source start signature.
    start(controller) {
      (entry as JSZipObjectWithInternalStream)
        .internalStream('uint8array')
        .on('data', (data) => controller.enqueue(data))
        .on('error', (error) => controller.error(error))
        .on('end', () => controller.close())
        .resume();
    },
  });
}
