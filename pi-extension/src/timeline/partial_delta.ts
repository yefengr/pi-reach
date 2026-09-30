const MAX_PARTIAL_DELTA_CHARS = 64 * 1024;

/** 按字符上限切分流式增量，不拆开 UTF-16 代理对。 */
export function partialDeltaChunks(delta: string): string[] {
  const chunks: string[] = [];
  for (let offset = 0; offset < delta.length;) {
    let end = Math.min(delta.length, offset + MAX_PARTIAL_DELTA_CHARS);
    const finalCodeUnit = delta.charCodeAt(end - 1);
    const nextCodeUnit = delta.charCodeAt(end);
    if (end < delta.length && finalCodeUnit >= 0xD800 && finalCodeUnit <= 0xDBFF && nextCodeUnit >= 0xDC00 && nextCodeUnit <= 0xDFFF) end -= 1;
    chunks.push(delta.slice(offset, end));
    offset = end;
  }
  return chunks;
}
