// Keep the publicly-served installer (/install.sh) in sync with its single
// source of truth: pi-extension/install.sh.
//
// Docker 与本地构建均使用仓库根上下文，从源脚本同步公开副本。
// public/install.sh 仍受版本管理；仅在单独分发 PWA 源码、缺少兄弟目录时
// 使用已提交副本，并验证副本存在。
//
// Runs automatically as part of `pnpm build` (see package.json). The copy is
// kept BYTE-IDENTICAL to pi-extension/install.sh so what users curl|bash is
// exactly the script that was smoke-tested in the extension.

import { existsSync, copyFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(here, "../../pi-extension/install.sh");
const DEST = resolve(here, "../public/install.sh");

if (!existsSync(SRC)) {
  console.log(
    `[sync-install-sh] source not found (${SRC}) — using the committed public/install.sh`,
  );
  if (!existsSync(DEST)) {
    console.error(
      "[sync-install-sh] FATAL: public/install.sh is also missing — the PWA would 404 on /install.sh.",
    );
    process.exit(1);
  }
  process.exit(0);
}

copyFileSync(SRC, DEST);
console.log("[sync-install-sh] synced public/install.sh ← pi-extension/install.sh");
