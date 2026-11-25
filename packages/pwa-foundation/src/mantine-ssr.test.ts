import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { MantineProvider, Button, TextInput, Textarea, NativeSelect, Select } from "@mantine/core";
import { expect, test } from "vitest";
import { usePwaTheme, pwaCssVariablesResolver } from "./mantine.js";

test("真实 SSR 可渲染主题 hook 与所有输入，不依赖 window/document", () => {
  function Fixture() {
    const theme = usePwaTheme();
    return createElement(MantineProvider, { theme, cssVariablesResolver: pwaCssVariablesResolver },
      createElement(Button, null, "确认"),
      createElement(TextInput, { label: "名称" }),
      createElement(Textarea, { label: "描述" }),
      createElement(NativeSelect, { label: "类型", data: ["一"] }),
      createElement(Select, { label: "选择", data: ["一"] }),
    );
  }
  const html = renderToString(createElement(Fixture));
  for (const className of ["pwa-button", "pwa-input", "pwa-textarea", "pwa-select"]) expect(html).toContain(className);
  expect(html).toContain("确认");
});
