import { open, readFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { withIdentityLock } from "./identity-lock.ts";

const directory = process.argv[2];
process.send("ready");
process.once("message", async () => {
  try {
    await withIdentityLock(directory, async () => {
      const marker = join(directory, "exclusive-marker");
      const handle = await open(marker, "wx");
      try {
        const published = JSON.parse(await readFile(join(directory, "identity.lock"), "utf8"));
        if (published.pid !== process.pid || !published.token || !published.createdAt) {
          throw new Error("lock publication or ownership failure");
        }
        await new Promise((resolve) => setTimeout(resolve, 30));
      } finally {
        await handle.close();
        await unlink(marker);
      }
    }, { waitTimeoutMs: 5_000, pollIntervalMs: 5 });
    process.disconnect();
  } catch {
    process.exit(2);
  }
});
