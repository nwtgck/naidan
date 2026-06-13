import JSZip from 'jszip';

interface JSZipObjectWithInternalStream extends JSZip.JSZipObject {
  // eslint-disable-next-line local-rules-named-args/require-named-args -- Kept positional because this runtime JSZip method is not declared on JSZip.JSZipObject's public type.
  internalStream(type: 'uint8array'): JSZip.JSZipStreamHelper<Uint8Array>;
}

export function generateZipReadableStream({
  zip,
}: {
  zip: JSZip;
}): ReadableStream<Uint8Array> {
  return new ReadableStream({
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
