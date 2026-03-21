import JSZip from 'jszip';

interface JSZipObjectWithInternalStream extends JSZip.JSZipObject {
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
