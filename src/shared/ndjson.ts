/** 在网络边界限制解压量与单行长度，避免压缩文件耗尽 Worker 或浏览器内存。 */
export async function* readNdjson(
  body: ReadableStream<Uint8Array>,
  gzip = true,
  maximumBytes = 64 * 1024 * 1024,
): AsyncGenerator<unknown> {
  const bytes = body.pipeThrough(new TransformStream<Uint8Array, Uint8Array<ArrayBuffer>>({
    transform(chunk, controller) { controller.enqueue(Uint8Array.from(chunk)); },
  }));
  const stream = gzip ? bytes.pipeThrough(new DecompressionStream("gzip")) : bytes;
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let decodedBytes = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      decodedBytes += value?.byteLength ?? 0;
      if (decodedBytes > maximumBytes) throw new Error("归档解压后超过单文件安全上限，请减小 Logpush 批次");
      buffer += decoder.decode(value, { stream: !done });
      let end: number;
      while ((end = buffer.indexOf("\n")) !== -1) {
        if (end > 1024 * 1024) throw new Error("归档包含超长记录");
        const line = buffer.slice(0, end).trim();
        buffer = buffer.slice(end + 1);
        if (line) yield JSON.parse(line) as unknown;
      }
      if (buffer.length > 1024 * 1024) throw new Error("归档包含超长记录");
      if (done) break;
    }
    if (buffer.trim()) yield JSON.parse(buffer) as unknown;
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
}
