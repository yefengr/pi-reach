// 与 JSON 编码一致地计数，但不先分配完整字符串或 UTF-8 副本。
export const MAX_JSON_BUDGET_DEPTH = 64;

export function boundedJsonByteLength(value: unknown, limit: number): number | null {
  if (!Number.isSafeInteger(limit) || limit < 0) return null;
  let bytes = 0;
  const ancestors = new WeakSet<object>();
  const add = (count: number): boolean => (bytes += count) <= limit;

  const string = (text: string): boolean => {
    if (!add(2)) return false;
    for (let index = 0; index < text.length; index += 1) {
      const code = text.charCodeAt(index);
      let size: number;
      if (code === 0x22 || code === 0x5c || (code >= 8 && code <= 10) || code === 12 || code === 13) size = 2;
      else if (code < 0x20) size = 6;
      else if (code < 0x80) size = 1;
      else if (code < 0x800) size = 2;
      else if (code >= 0xd800 && code <= 0xdbff) {
        const next = text.charCodeAt(index + 1);
        if (next >= 0xdc00 && next <= 0xdfff) {
          size = 4;
          index += 1;
        } else size = 6;
      } else size = code >= 0xdc00 && code <= 0xdfff ? 6 : 3;
      if (!add(size)) return false;
    }
    return true;
  };

  const visit = (item: unknown, depth: number): boolean => {
    if (depth > MAX_JSON_BUDGET_DEPTH) return false;
    if (item === null) return add(4);
    if (typeof item === "boolean") return add(item ? 4 : 5);
    if (typeof item === "number") return Number.isFinite(item) && add(JSON.stringify(item).length);
    if (typeof item === "string") return string(item);
    if (typeof item !== "object" || ancestors.has(item)) return false;
    if (!Array.isArray(item) && Object.getPrototypeOf(item) !== Object.prototype && Object.getPrototypeOf(item) !== null) return false;
    ancestors.add(item);
    if (!add(2)) return false;
    let count = 0;
    if (Array.isArray(item)) {
      for (const child of item) {
        if ((count++ > 0 && !add(1)) || !visit(child, depth + 1)) return false;
      }
    } else {
      for (const key in item) {
        if (!Object.hasOwn(item, key)) continue;
        if ((count++ > 0 && !add(1)) || !string(key) || !add(1)
          || !visit((item as Record<string, unknown>)[key], depth + 1)) return false;
      }
    }
    ancestors.delete(item);
    return true;
  };

  return visit(value, 0) ? bytes : null;
}
