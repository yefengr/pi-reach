/** 只转发 Edit 的已执行结果；其余工具继续使用原始 content。 */
export function toolDetailResult(tool: string, result: unknown): unknown {
  if (typeof result !== "object" || result === null || Array.isArray(result)) return undefined;
  const value = result as { content?: unknown; details?: unknown };
  const content = value.content;
  if (tool !== "edit" || typeof value.details !== "object" || value.details === null || Array.isArray(value.details)) return content;

  const source = value.details as Record<string, unknown>;
  const details: { diff?: string; patch?: string; firstChangedLine?: number } = {};
  if (Object.hasOwn(source, "diff") && typeof source.diff === "string") details.diff = source.diff;
  if (Object.hasOwn(source, "patch") && typeof source.patch === "string") details.patch = source.patch;
  if (Object.hasOwn(source, "firstChangedLine") && typeof source.firstChangedLine === "number"
    && Number.isSafeInteger(source.firstChangedLine) && source.firstChangedLine > 0) details.firstChangedLine = source.firstChangedLine;
  return Object.keys(details).length ? { content, details } : content;
}
