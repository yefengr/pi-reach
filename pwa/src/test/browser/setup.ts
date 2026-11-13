import "vitest-browser-react";
import "@mantine/core/styles.css";
import "@mantine/notifications/styles.css";
import "@/app/globals.css";
import { beforeEach } from "vitest";
import { DRAFT_STORAGE_KEY, resetDraftStorageForTest } from "@/lib/pwa/draft-storage";
import { SESSION_POSITION_STORAGE_KEY } from "@/lib/pwa/session-position-store";

// 草稿与阅读位置会跨页面重载保留；用例之间共用同一会话标识，开始前清掉上一例留下的内容。
beforeEach(() => {
  window.localStorage.removeItem(DRAFT_STORAGE_KEY);
  window.sessionStorage.removeItem(SESSION_POSITION_STORAGE_KEY);
  resetDraftStorageForTest();
});
