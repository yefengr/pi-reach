import { entryGroupId, type PresentationEntry } from "@/lib/pwa/timeline-presentation";

export type ProcessEntry = Extract<PresentationEntry, { kind: "thinking" | "tool" }>;
export type ProcessGroup = { key: string; groupId: string; entries: readonly ProcessEntry[] };
export type ProcessExpansion = { expanded: boolean; order: number };

type CandidateGroup = { groupId: string; entries: ProcessEntry[] };
const PROCESS_KEY_PREFIX = "process:";
const processKey = (entry: ProcessEntry) => `${PROCESS_KEY_PREFIX}${entry.key}`;

export function isProcessEntry(entry: PresentationEntry): entry is ProcessEntry {
  return entry.kind === "thinking" || entry.kind === "tool";
}

/** 分组只消费已投影顺序；记录、正文、轮次与显式边界均断开，不改变成员内容。 */
function candidates(entries: readonly PresentationEntry[], breakKeys: ReadonlySet<string>): CandidateGroup[] {
  const groups: CandidateGroup[] = [];
  let current: CandidateGroup | null = null;
  for (const entry of entries) {
    if (!isProcessEntry(entry)) { current = null; continue; }
    const groupId = entryGroupId(entry)!;
    if (current === null || current.groupId !== groupId || breakKeys.has(entry.key)) {
      current = { groupId, entries: [] };
      groups.push(current);
    }
    current.entries.push(entry);
  }
  return groups;
}

/**
 * 旧组只向一个新段交接身份：原锚点优先，锚点消失则按旧成员顺序选择仍在的继承者。
 * 合并时按旧组顺序保留一个 key；选择状态不依附这个取舍，另按成员继承。
 */
function inheritedKeys(groups: readonly CandidateGroup[], previous: readonly ProcessGroup[]): Map<number, string> {
  const location = new Map<string, number>();
  groups.forEach((group, index) => group.entries.forEach(entry => location.set(entry.key, index)));
  const inherited = new Map<number, string>();
  for (const group of previous) {
    // key 保留原锚点身份，即使该成员曾离开上一份窗口，历史补齐后仍能准确归还给它。
    const anchorIndex = location.get(group.key.slice(PROCESS_KEY_PREFIX.length));
    const heir = group.entries.find(entry => location.has(entry.key));
    const index = anchorIndex ?? (heir === undefined ? undefined : location.get(heir.key));
    if (index === undefined) continue;
    if (groups[index]!.groupId === group.groupId && !inherited.has(index)) inherited.set(index, group.key);
  }
  return inherited;
}

/** previous 由调用方按真实来源清理；没有共同成员时不按文本、时间或位置猜测身份。 */
export function processGroups(entries: readonly PresentationEntry[], breakKeys: ReadonlySet<string>, previous: readonly ProcessGroup[] = []): ProcessGroup[] {
  const groups = candidates(entries, breakKeys);
  const inherited = inheritedKeys(groups, previous);
  // 先预留全部继承身份，避免拆分新段抢占另一段尚未输出的旧 key。
  const reserved = new Set(inherited.values());
  const known = new Map(previous.map(group => [group.key, group]));
  return groups.map((group, index) => {
    let key = inherited.get(index);
    if (key === undefined) {
      const anchor = group.entries.find(entry => !reserved.has(processKey(entry)));
      if (anchor === undefined) throw new Error("Process group identity collision");
      key = processKey(anchor);
      reserved.add(key);
    }
    const retained = known.get(key);
    if (retained?.groupId === group.groupId && retained.entries.length === group.entries.length
      && retained.entries.every((entry, position) => entry === group.entries[position])) return retained;
    return { key, groupId: group.groupId, entries: group.entries };
  });
}

/** 最近一次手动操作优先；默认展开与阅读保护均不写入本表。 */
export function processExpansion(entries: readonly ProcessEntry[], choices: ReadonlyMap<string, ProcessExpansion>): ProcessExpansion | undefined {
  let latest: ProcessExpansion | undefined;
  for (const entry of entries) {
    const choice = choices.get(entry.key);
    if (choice !== undefined && (latest === undefined || choice.order > latest.order)) latest = choice;
  }
  return latest;
}

export function withProcessExpansion(choices: ReadonlyMap<string, ProcessExpansion>, members: readonly string[], expanded: boolean): ReadonlyMap<string, ProcessExpansion> {
  if (members.length === 0) return choices;
  let order = 0;
  for (const choice of choices.values()) order = Math.max(order, choice.order);
  const next = new Map(choices);
  for (const key of members) next.set(key, { expanded, order: order + 1 });
  return next;
}

/** 与行装配相同地消费本地提示；只提供断组边界，不生成或移动提示。 */
export function processNoticeBreakKeys(entries: readonly PresentationEntry[], afterSeqs: readonly number[]): ReadonlySet<string> {
  const pending = [...afterSeqs].sort((left, right) => left - right);
  const keys = new Set<string>();
  let index = 0;
  for (const entry of entries) {
    let consumed = false;
    while (index < pending.length && pending[index]! < (entry.seq ?? Infinity)) { index += 1; consumed = true; }
    if (consumed) keys.add(entry.key);
  }
  return keys;
}
