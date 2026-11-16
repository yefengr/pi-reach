import type { IdleAttachmentDraft } from "./attachment-composer";

/** 只随本端新建请求保存；附件原件仍由 AttachmentComposer 持有。 */
export type SessionDraftHandoff = {
  sourceKey: string;
  text: string;
  version: number;
  attachments: IdleAttachmentDraft;
};

export function handoffDraftText(
  drafts: Readonly<Record<string, string>>, handoff: SessionDraftHandoff, targetKey: string, sourceVersion: number,
): Readonly<Record<string, string>> | null {
  if (handoff.sourceKey === targetKey || handoff.version !== sourceVersion ||
      (drafts[handoff.sourceKey] ?? "") !== handoff.text || (drafts[targetKey] ?? "") !== "") return null;
  const next = { ...drafts, [targetKey]: handoff.text };
  delete next[handoff.sourceKey];
  return next;
}
