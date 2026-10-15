export type ThinkingTextResult = { firstTitle?: string; latestTitle?: string; summary?: string; empty: boolean };

type HeadingCandidate = {
  phase: "indent" | "open" | "body" | "close" | "trailing";
  contentLength: number;
  first: number;
  end: number;
  title?: string;
};
const whitespace = /\s/;
function lineBoundary(char: string): boolean {
  return char === "\n" || char === "\r" || char === "\u2028" || char === "\u2029";
}
function candidate(): HeadingCandidate {
  return { phase: "indent", contentLength: 0, first: -1, end: 0 };
}

/** 同一 epoch 的已显示 UTF-16 前缀由展示 buffer 保证不变；这里只扫描新增字符，不校验全文前缀。 */
export class ThinkingTextParser {
  /** 确定性工作量：每个被解析的 UTF-16 字符记一次，重建也计入。 */
  scannedCharacters = 0;
  private epoch?: object;
  private streaming?: boolean;
  private length = 0;
  private untrustedText?: string;
  private candidates: HeadingCandidate[] = [candidate()];
  private firstTitle?: string;
  private latestTitle?: string;
  private summary = "";
  private summarySpace = false;
  private summaryDone = false;
  private empty = true;

  read(text: string, epoch?: object, streaming?: boolean): ThinkingTextResult {
    const modeChanged = this.streaming !== streaming;
    const trusted = epoch !== undefined && epoch === this.epoch && text.length >= this.length;
    if (modeChanged || (!trusted && !(epoch === undefined && this.epoch === undefined && text === this.untrustedText))) this.reset();
    this.epoch = epoch;
    this.streaming = streaming;
    this.untrustedText = epoch === undefined ? text : undefined;
    for (let index = this.length; index < text.length; index++) {
      const char = text[index]!;
      const space = whitespace.test(char);
      this.scannedCharacters += 1;
      if (!space) this.empty = false;
      this.consumeSummary(char, space);
      this.consumeHeading(text, index, char, space);
    }
    this.length = text.length;
    // 末尾无换行的完整标题是暂定值；追加非空白可使它失效，不污染已提交的标题。
    const provisional = this.candidates.find(value => value.phase === "trailing")?.title;
    return { firstTitle: this.firstTitle ?? provisional, latestTitle: provisional ?? this.latestTitle,
      summary: this.summary || undefined, empty: this.empty };
  }

  private reset(): void {
    this.length = 0;
    this.candidates = [candidate()];
    this.firstTitle = undefined;
    this.latestTitle = undefined;
    this.summary = "";
    this.summarySpace = false;
    this.summaryDone = false;
    this.empty = true;
  }

  private consumeSummary(char: string, space: boolean): void {
    if (this.summaryDone) return;
    if (char === "\n") {
      if (this.summary) this.summaryDone = true;
      this.summarySpace = false;
      return;
    }
    if (space) {
      if (this.summary) this.summarySpace = true;
      return;
    }
    if (this.summarySpace) this.summary += " ";
    this.summary += char;
    this.summarySpace = false;
  }

  private consumeHeading(text: string, index: number, char: string, space: boolean): void {
    const boundary = lineBoundary(char);
    if (boundary) {
      const complete = this.candidates.find(value => value.phase === "trailing");
      if (complete) {
        if (complete.title) {
          this.firstTitle ??= complete.title;
          this.latestTitle = complete.title;
        }
        // matchAll 不返回重叠匹配；已完成匹配之前开启的候选同时作废。
        this.candidates = [];
      }
    }
    this.candidates = this.candidates.filter(value => this.advanceCandidate(value, text, index, char, space));
    if (boundary) this.candidates.push(candidate());
  }

  private advanceCandidate(value: HeadingCandidate, text: string, index: number, char: string, space: boolean): boolean {
    switch (value.phase) {
      case "indent":
        if (char === " " || char === "\t") return true;
        if (char !== "*") return false;
        value.phase = "open";
        return true;
      case "open":
        if (char !== "*") return false;
        value.phase = "body";
        return true;
      case "body":
        if (char === "\n") return false;
        if (char === "*") {
          if (value.contentLength === 0) return false;
          value.phase = "close";
          return true;
        }
        value.contentLength += 1;
        if (!space) {
          if (value.first < 0) value.first = index;
          value.end = index + 1;
        }
        return true;
      case "close":
        if (char !== "*") return false;
        value.phase = "trailing";
        value.title = value.first < 0 ? undefined : text.slice(value.first, value.end);
        return true;
      case "trailing":
        return char === " " || char === "\t";
    }
  }
}

export function thinkingTitle(text: string, streaming: boolean): string | undefined {
  return new ThinkingTextParser().read(text, undefined, streaming).latestTitle;
}

/** 独立调用保留首行早退；组件同时需要标题时复用增量解析器的摘要结果。 */
export function thinkingSummary(text: string): string | undefined {
  let start = 0;
  while (start < text.length) {
    const newline = text.indexOf("\n", start);
    const line = text.slice(start, newline === -1 ? text.length : newline).trim();
    if (line) return line.replace(/\s+/g, " ");
    if (newline === -1) return undefined;
    start = newline + 1;
  }
  return undefined;
}
