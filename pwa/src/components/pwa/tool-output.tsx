import { useState } from "react";
import { TOOL_IMAGE_MIMES, type ToolOutputBlock } from "./tool-presentation";
import { useI18n } from "@/lib/i18n";

export function ToolImage({ block, index }: { block: Extract<ToolOutputBlock, { kind: "image" }>; index: number }) {
  const { t, format } = useI18n();
  const [failedSource, setFailedSource] = useState<string>();
  const size = block.byteLength === undefined ? "" : ` · ${t.tools.bytes(format.number(block.byteLength))}`;
  if (block.omitted || !block.data) return <p className="pwa-image-omitted">{t.tools.imageOmitted}{block.mime ? ` · ${block.mime}` : ""}{size}</p>;
  if (!TOOL_IMAGE_MIMES.has(block.mime)) return <p className="pwa-image-omitted">{t.tools.imageUnsupported}{block.mime ? `: ${block.mime}` : ""}{size}</p>;
  const source = `data:${block.mime};base64,${block.data}`;
  if (failedSource === source) return <p className="pwa-image-omitted">{t.tools.imageUnavailable}{block.mime ? ` · ${block.mime}` : ""}{size}</p>;
  return <img className="pwa-tool-output-image" src={source} alt={t.tools.imageAlt(index + 1)} loading="lazy" onError={() => setFailedSource(source)} />;
}
