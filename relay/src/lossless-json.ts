const MAX_JSON_DEPTH = 128;

export class JsonNumberToken {
  constructor(readonly source: string) {}
}

type ReviverContext = { source?: string };
type ParseWithContext = (text: string, reviver: (this: unknown, key: string, value: unknown, context: ReviverContext) => unknown) => unknown;
type JsonWithRaw = typeof JSON & { rawJSON(source: string): unknown };

export function parseStrictJson(text: string): unknown {
  new JsonScanner(text).scan();
  const parseWithContext = JSON.parse as ParseWithContext;
  return parseWithContext(text, (_key, value, context) => {
    if (typeof value !== "number") return value;
    if (context.source === undefined) throw new SyntaxError("JSON number source is unavailable");
    return new JsonNumberToken(context.source);
  });
}

export function stringifyWire(value: unknown): string {
  const json = JSON as JsonWithRaw;
  return JSON.stringify(value, (_key, current: unknown) => {
    if (typeof current === "bigint") return json.rawJSON(current.toString());
    if (current instanceof JsonNumberToken) return json.rawJSON(current.source);
    return current;
  });
}

class JsonScanner {
  private index = 0;

  constructor(private readonly text: string) {}

  scan(): void {
    this.whitespace();
    this.value(0);
    this.whitespace();
    if (this.index !== this.text.length) this.fail();
  }

  private value(depth: number): void {
    const character = this.text[this.index];
    if (character === "{") this.object(depth + 1);
    else if (character === "[") this.array(depth + 1);
    else if (character === "\"") this.string();
    else if (character === "t") this.literal("true");
    else if (character === "f") this.literal("false");
    else if (character === "n") this.literal("null");
    else this.number();
  }

  private object(depth: number): void {
    this.depth(depth);
    this.index += 1;
    this.whitespace();
    const keys = new Set<string>();
    if (this.consume("}")) return;
    while (true) {
      if (this.text[this.index] !== "\"") this.fail();
      const key = this.string();
      if (keys.has(key)) throw new SyntaxError("duplicate JSON object key");
      keys.add(key);
      this.whitespace();
      this.expect(":");
      this.whitespace();
      this.value(depth);
      this.whitespace();
      if (this.consume("}")) return;
      this.expect(",");
      this.whitespace();
    }
  }

  private array(depth: number): void {
    this.depth(depth);
    this.index += 1;
    this.whitespace();
    if (this.consume("]")) return;
    while (true) {
      this.value(depth);
      this.whitespace();
      if (this.consume("]")) return;
      this.expect(",");
      this.whitespace();
    }
  }

  private string(): string {
    const start = this.index;
    this.index += 1;
    while (this.index < this.text.length) {
      const code = this.text.charCodeAt(this.index);
      if (code === 0x22) {
        this.index += 1;
        const decoded = JSON.parse(this.text.slice(start, this.index)) as string;
        if (hasLoneSurrogate(decoded)) throw new SyntaxError("isolated Unicode surrogate");
        return decoded;
      }
      if (code < 0x20) this.fail();
      if (code === 0x5c) {
        this.index += 1;
        const escape = this.text[this.index];
        if (escape === "u") {
          const digits = this.text.slice(this.index + 1, this.index + 5);
          if (!/^[0-9A-Fa-f]{4}$/.test(digits)) this.fail();
          this.index += 5;
          continue;
        }
        if (escape === undefined || !'"\\/bfnrt'.includes(escape)) this.fail();
      }
      this.index += 1;
    }
    this.fail();
  }

  private number(): void {
    const rest = this.text.slice(this.index);
    const match = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/.exec(rest);
    if (match === null) this.fail();
    this.index += match[0].length;
  }

  private literal(expected: "true" | "false" | "null"): void {
    if (!this.text.startsWith(expected, this.index)) this.fail();
    this.index += expected.length;
  }

  private whitespace(): void {
    while (this.index < this.text.length && " \t\r\n".includes(this.text[this.index]!)) this.index += 1;
  }

  private expect(expected: string): void {
    if (!this.consume(expected)) this.fail();
  }

  private consume(expected: string): boolean {
    if (this.text[this.index] !== expected) return false;
    this.index += 1;
    return true;
  }

  private depth(depth: number): void {
    if (depth > MAX_JSON_DEPTH) throw new SyntaxError("JSON nesting limit exceeded");
  }

  private fail(): never {
    throw new SyntaxError(`invalid JSON at offset ${this.index}`);
  }
}

function hasLoneSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}
