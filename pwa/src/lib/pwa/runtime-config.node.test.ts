import { expect, test } from "vitest";
import { readDefaultRelayUrl, validateDefaultRelayUrl } from "./runtime-config";

for (const value of ["https://relay.example.test", "http://127.0.0.1:9000/relay/ws", "wss://[::1]:9000/relay?tenant=one&region=two", "https://relay.example.test/a%20b?q='public'", "https://[::ffff:192.0.2.1]/a%20b"]) {
  test(`preserves the public Relay URL ${value}`, () => { expect(validateDefaultRelayUrl(value)).toBe(value); });
}
for (const value of ["", " https://relay.test", "https://relay.test\n", "ftp://relay.test", "https://user:secret@relay.test", "https://@relay.test", "https://relay.test/#fragment", "https://relay.test/\"<script>", "https://relay.test/\\evil", "https://relay.test/%zz", "https://relay.test:70000", "https://[bad]", "https://[:1::]", "https://relay.test:", "https://256.0.0.1", "https://relay..test", "https://relay.123", "http://192.168.001.009:9000/relay", "https://192.168.001.001/relay", "https://[::ffff:192.168.001.009]/relay"]) {
  test("rejects invalid runtime defaults without reflecting their value", () => {
    expect(() => validateDefaultRelayUrl(value)).toThrow("invalid_default_relay_url");
  });
}

function metadata(contents: Array<string | null>): Pick<Document, "querySelectorAll"> {
  return { querySelectorAll: () => contents.map((content) => ({ getAttribute: () => content })) as unknown as NodeListOf<Element> };
}

test("reads exactly one valid metadata entry and never falls back to production", () => {
  expect(readDefaultRelayUrl(metadata(["https://staging.example.test/relay"]))).toBe("https://staging.example.test/relay");
  for (const values of [[], [null], [""], ["https://one.test", "https://two.test"]]) {
    expect(() => readDefaultRelayUrl(metadata(values))).toThrow();
  }
});
