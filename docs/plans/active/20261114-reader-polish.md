# 工具详情与文档阅读器视觉优化方案

- 日期：2026-11-14
- 用途：供实施代理据此实现；本文不是当前实现说明。
- 项目级状态：见 [ROADMAP](../../ROADMAP.md)，不在本文另设状态表。
- 视觉稿：[`docs/prototypes/20261114-reader-polish/page.html`](../../prototypes/20261114-reader-polish/page.html)，原型状态「已确认」（2026-11-14，用户确认按全部 7 条建议实施）。视觉稿是静态评审稿，数据以本文第 3 节为准；稿中「退出码 2」「用时 6.4 秒」与 diff 的 `@@` 行属于第二期，第一期不做。
- 当前规则来源：[DESIGN「组件规则」](../../DESIGN.md#组件规则)中的工具详情阅读器与文件阅读器条目。本方案会改动其中几条规则，用户已同意（见第 6 节），须在同一 Pull Request 中同步 DESIGN。

## 1. 背景与目标

用户反馈工具详情和文档阅读界面不好看。2026-11-14 在状态展厅里实际截图，归纳出三个原因：

1. 工具详情把原始数据直接摆出来：标题只有小写工具名（`edit`、`bash`），会话行里的「Edit tool-card.tsx +2 −1」点开后反而丢了；参数以 `path: …` 键值列出，像调试输出；输出直接铺在底色上，说明文字和代码之间没有边界。
2. 状态只有一个彩色图标，紧挨关闭按钮；手机上右上角只剩一个对勾，像「确认」按钮。
3. 文档阅读器标题栏只有文件名；二级标题 18px 只比正文 16px 大 2px，长文档层次不清；没有目录。

目标是在不改变阅读器外壳（Drawer 宽度、进出动画、手势、历史记录、焦点规则）的前提下，让详情读起来和会话行是同一件事，输出与说明分得开，文档有结构。

## 2. 范围

| # | 建议 | 期 | 改动面 |
| --- | --- | --- | --- |
| 1 | 标题与会话中的工具行一致：类型图标＋动作词＋对象 | 一 | PWA |
| 2 | 状态改为图标加文字的标签，放在正文第一行 | 一 | PWA |
| 3 | 输出放进代码块，块头有标签和复制按钮 | 一 | PWA |
| 4 | 已知工具的参数按语义显示，其余参数原样列出 | 一 | PWA |
| 5a | read 输出带行号 | 一 | PWA |
| 5b | edit 显示 diff 并带旧／新行号 | 二 | Extension＋PWA |
| 5c | bash 失败显示退出码，显示耗时 | 二 | Extension＋PWA |
| 6 | 文档正文前加文件信息，拉开标题层级 | 一 | PWA |
| 7 | 文档目录 | 一 | PWA |

第一期只改 PWA，可以独立合并、部署和验收。第二期需要扩展端回传更多字段，先按第 3 节确认可行再动手；第二期不做时，第一期的界面也必须完整可用。

### 不改动

- 阅读器外壳：桌面 720px 右侧 Drawer、移动全屏、直角、`bg` 底色、48px 顶栏、右滑关闭、系统返回、焦点返回、滚动边缘分隔，均保持现状。
- 思考阅读器与摘要阅读器的内容（它们共用 `ReaderShell`，外壳改动不能破坏它们）。
- 图片阅读器（缩放、下拉关闭、几何过渡）。
- 不做语法高亮，不引入新依赖。
- 不改 Relay；第一期不改协议与扩展端。

## 3. 已核对的数据事实

以下事实决定了哪些能在 PWA 单独完成，实施前请先在真实会话中复核一次（任选一次 read、edit、失败的 bash 打开详情）。

1. **会话详情只带结果正文。** [`tool_detail_source.ts`](../../../pi-extension/src/timeline/tool_detail_source.ts) 组装详情时 `result: message.content`；运行中预览同样只取 `result.content`（[`runtime.ts`](../../../pi-extension/src/timeline/runtime.ts) 的 `publishToolPartial`）。Pi 工具结果里的 `details` 与 `structuredContent` 都没有传到 PWA。
2. **edit：真实详情里没有 diff。** Pi edit 工具的正文只有 `Successfully replaced N block(s) in <path>.`，diff 在 `details.diff`（Pi 自有格式，每行形如 `-18 旧文本`、`+18 新文本`、` 19 上下文`，省略处为 ` ... `，不带 `---/+++/@@`）与 `details.patch`（统一 diff）里。所以现在只有展厅演示数据会出现「Returned diff」块；时间线的「+N −M」同样依赖 diff，摘要（`toolSummarySchema`）里没有这项数据。
3. **bash：退出码与耗时不在详情里。** Pi 在 `structuredContent` 里给出 `exit_code` 与 `wall_time_seconds`；失败时只在正文末尾追加 `Command exited with code N`。不得解析这行文字推断退出码。
4. **read：行号可以在 PWA 计算。** Pi 的 `offset` 为 1 起始的行号，未传时从第 1 行开始（现有 `readLineOffset` 与 `readRange` 已按此处理）。Pi 会在正文末尾追加续读提示，三种形式：
   - `\n\n[Showing lines A-B of N. Use offset=C to continue.]`
   - `\n\n[Showing lines A-B of N (50KB limit). Use offset=C to continue.]`（字节上限文字随 Pi 常量变化）
   - `\n\n[R more lines in file. Use offset=C to continue.]`

   另有单独一行的 `[Line N is …, exceeds … limit. Use bash: …]`，整段就是提示，没有文件内容。

## 4. 第一期规格（只改 PWA）

### 4.1 工具详情标题（#1）

- 标题与时间线工具行同源：复用 `toolCallCopy`（[`tool-presentation.ts`](../../../pwa/src/components/pwa/tool-presentation.ts)）的动作词与对象，类型图标复用 [`tool-card.tsx`](../../../pwa/src/components/pwa/tool-card.tsx) 的 `TOOL_TYPE_ICONS`（建议导出共用，不复制一份映射）。
- 显示为：类型图标（20）＋动作词（系统字体 18／600）＋对象（等宽、`soft-ink`、比动作词小一档）。read、edit、write 的对象只放文件名，目录移到第一行元信息（#2）；bash 与搜索的对象为命令或搜索词，单行省略，完整内容在正文。
- 无法分类的工具（`kind: "generic"`）保持现状：标题为原始工具名，不加动作词。
- `ReaderShell` 的 `title` 目前是字符串，同时用作 `Drawer.Title` 内容与悬停 `title`。新增可选的标题节点参数，字符串仍用作可访问名称与悬停提示（取 `toolCallCopy().title` 的完整摘要）。思考与摘要阅读器不传新参数，表现不变。
- 顶栏只保留返回／关闭（以及文件阅读器的保存、目录）；状态图标从顶栏移走。

### 4.2 状态标签与元信息行（#2）

- 正文第一行为元信息行：状态标签，加上与工具相关的元信息，可换行。
  - 状态标签：图标 14＋文字，胶囊，文字用现有 `t.tools.status`（完成、出错、运行中、已中断、状态未知）。颜色：完成 `complete`／`complete-wash`，出错 `error`／`error-wash`，运行中 `running`／`running-wash`（图标旋转），已中断与未知为 `secondary`／`tonal`。现有状态胶囊样式见 `.pwa-current-label`，尺寸、字号与圆角保持一致。
  - read：行范围文字（见 4.5，如「第 53–62 行」）＋目录。
  - edit、write：目录；第二期有 diff 后再加「+N −M」。
  - 目录用等宽 13px、`secondary`，从左侧省略，规则与时间线的 `.pwa-tool-context` 相同。
- 原来顶栏状态元素上的 `id="pwa-tool-reader-description"` 与 `aria-describedby` 关系移到状态标签上，读屏仍能读到状态。
- 「准备中」（`isToolPreparing`）沿用运行中的标签外形，但用中性色，与时间线一致。

### 4.3 输出代码块与复制（#3）

- 每个文本输出块放进代码块：`code-surface` 底、圆角 `--pwa-radius-lg`（12），内边距上下 10、左右 12。块头高 36：左侧为块标签（13／600、`secondary`），右侧为复制按钮（复用 [`CopyButton`](../../../pwa/src/components/pwa/copy-button.tsx)，复制该块原文），块头下有发丝线。
- 块标签：输出为「Output」，diff 为「Diff」，搜索结果沿用 `t.tools.searchResults`；新文案加到 [`zh.ts`](../../../pwa/src/lib/i18n/messages/zh.ts) 与 `en.ts`。是否把「Output」「Diff」登记为 DESIGN「固定英文术语」由实施者在同步 DESIGN 时一并说明。
- 结果里的短说明（如 edit 的 `Successfully replaced …`、`notice` 样式的提示）不进代码块，以 14px `secondary` 普通文字显示在代码块之前。
- 错误：工具出错时不再整块红底包住全部输出。状态由 #2 的标签表达；输出仍放在普通代码块，块标签用 `error` 色。只有错误信息不在输出中、需要单独显示时（`toolContentBlocks` 中 `style: "error"` 的独立块），才保留现有错误块样式。
- 图片输出保持现状。
- 运行中跟随滚动（停在底部时跟随）的行为不变。
- 截断提示（`toolWasTruncated`）保持在所有块之后。

### 4.4 参数按工具语义显示（#4）

原则：已用于标题、元信息或命令块的参数不再重复列出，其余参数仍按现有「名称: 值」原样列出，不省略、不推断。

| 工具类型 | 显示方式 | 不再单列的参数 |
| --- | --- | --- |
| command（bash 等） | 命令块：`code-surface` 底、圆角 12，`$ ` 提示符为 `secondary` 且不可选中，命令完整显示、可换行、可选中 | 命令参数（`command`／`cmd`） |
| read | 标题（文件名）＋元信息（行范围、目录） | 路径、`offset`／`start_line`／`startLine`、`limit` |
| edit、write | 标题（文件名）＋元信息（目录） | 路径 |
| search | 标题（搜索词） | 搜索词参数 |
| generic | 与现在相同的键值块 | 无 |

- 剩余参数（如 bash 的 `timeout`、edit 的 `edits`、write 的 `content`）用现有 `.pwa-tool-reader-command` 键值样式，放在命令块或元信息之后、输出之前；没有剩余参数时不显示这一块，也不显示它下面的分隔线。
- 判定已用参数时复用 `PATH_KEYS`、`COMMAND_KEYS`、`QUERY_KEYS` 与 `readLineOffset` 的键名，不另写一份。
- 参数不是对象时（字符串或其他 JSON），保持现状。

### 4.5 read 行号（#5a）

- 只在同时满足以下条件时显示行号：工具类型为 read；结果恰好是一个文本块；不是出错状态；文本不是单独一行的 `[Line N is …]` 提示。
- 起始行：`readLineOffset(value)`，没有时为 1。
- 先剥离末尾的续读提示（第 3 节第 4 条的三种形式，匹配必须锚定在文本末尾、前面紧接空行）；剥离出的提示放在代码块之后，以 `.pwa-tool-notice` 样式显示，不编号。匹配失败时整段按正文编号，不报错。
- 版式：两列网格，行号列右对齐、`secondary`、不可选中，复制时不带行号；长行折行时正文悬挂缩进，与本行首字对齐。
- 元信息里的行范围按实际显示的行数计算（起始行到起始行＋行数−1），与时间线 `readRange` 的「L53–62」写法不同处只在文案，数值一致；时间线写法不改。

### 4.6 文件信息与标题层级（#6）

- 文本文件阅读器正文第一行为文件信息：类型＋大小，如「Markdown · 3.1 KiB」「纯文本 · 12 KiB」，13px、`secondary`，下方发丝线，与正文间隔 16。大小来自 `state.byteLength`（没有时用描述符的 `byte_length`）；格式化复用现有实现（`attachment-cards.tsx` 的大小格式化，或抽成共用函数），不再新写一份。视觉稿里的「5 个章节」不做。
- 标题层级只作用于文件阅读器（`.pwa-file-markdown` 作用域），聊天 Markdown 与思考、摘要阅读器不变：
  - h1：26／700，行高 1.25，下方 12；
  - h2：21／600，行高 1.3，上方 28、下方 8；
  - h3：17／600，行高 1.4，上方 20、下方 6；
  - 段落上下 10。
  这些字号须按 DESIGN「字号档位」随档位放大，不写死；若现有字号 token 不够用，在 DESIGN 中登记新的语义字号，不在 CSS 中写裸值。
- 纯文本（非 Markdown）文件只加文件信息行，正文不变。

### 4.7 文档目录（#7）

- 仅 Markdown 文件、且 h1–h3 标题不少于 2 个时，在顶栏保存按钮左侧显示目录按钮（图标按钮 44，Lucide `List` 或 `TableOfContents`，可访问名称与悬停说明「目录」）。
- 点按打开目录面板，复用现有 Mantine `Menu`（浮层面板圆角 12，与其他菜单一致）：按层级缩进列出 h1–h3，当前所在章节高亮；选择后在阅读器的滚动容器内滚动到该标题（遵守减少动态效果），然后关闭菜单。
- 标题锚点只用于阅读器内部定位：生成稳定的元素 id（文档内去重），不改变 URL、不写入历史记录。
- 叠层：目录菜单位于阅读器 Drawer 之上，必须满足 Escape 只关闭菜单、系统返回与右滑在菜单打开时先关菜单或被门禁拒绝（与现有 `readerHasOverlay` 一致）、焦点返回目录按钮。按 [overlay 验证技能](../../../.agents/skills/validate-mantine-stacked-overlays/SKILL.md) 验收，并把目录菜单补入技能的叠层组件清单（`scripts/overlay-skill-guard.test.mjs` 会校验）。
- 正文在进入动画结束后才渲染（现有规则），目录按钮在正文渲染后出现，不影响滑入。

### 4.8 展厅

- 状态展厅的工具与文件演示数据改用真实格式：read 带 `offset`／`limit` 与 Pi 续读提示；失败的 bash 使用 Pi 的真实正文（末尾 `Command exited with code N`）；edit 演示在第一期不再伪造 `details.diff`（与真实链路一致），第二期再按真实字段补回；文件演示文档改为含 h1–h3、列表、代码块与表格的内容，便于检查层级与目录。
- 展厅只展示当前正式组件，不保留改前对照。

## 5. 第二期：扩展端补数据（#5b、#5c）

先确认可行性，再开始实现；任一项不可行时记录原因并停在第一期。

1. **字段来源。** 确认 Pi SDK（当前 1.3.0）会话记录里的工具结果消息是否保存 `details` 与 `structuredContent`，以及 `tool_execution_end` 事件里的 `result` 是否带这两个字段。历史会话打开详情时只能用会话记录里保存的字段。
2. **回传形状。** 详情的 `result` 目前是正文数组。若改为对象（如 `{ content, details }`），需核对 PWA `toolResult`、`toolOutputBlocks`、`reliableToolDiff` 与详情缓存的兼容性；`toolDetailsContentSchema` 的 `result` 为 JSON，预计不必改 schema，但须以协议测试确认。只回传白名单字段：edit 的 `diff`、`patch`、`firstChangedLine`，bash 的 `exit_code`、`wall_time_seconds`；不回传 `full_output_path` 等本机路径，并注意 `MAX_TOOL_DETAILS_BYTES` 上限。
3. **发布顺序。** 先部署能识别新字段的 PWA，再发布扩展（见 [DEPLOYMENT](../../DEPLOYMENT.md#extension-npm-发布)）；旧扩展没有这些字段时，PWA 按第一期显示。
4. **PWA 显示。**
   - edit：优先使用 Pi 自有格式的 `details.diff`，把每行开头的行号拆进行号列（删除行只有旧行号，新增行只有新行号，上下文行两者都有），` ... ` 显示为 `secondary` 的省略行。没有 `diff` 只有 `patch` 时显示统一 diff：去掉 `---`／`+++` 两行，`@@` 行为 `secondary`，按 hunk 头推算行号。两者都没有时保持第一期的样子。元信息行加「+N −M」，计数复用 `diffLineKind` 的判定（注意 Pi 自有格式里行号紧跟 `+`／`-`，计数逻辑须覆盖）。
   - bash：状态标签为「出错 · 退出码 N」；完成或出错时在元信息行加「用时 X 秒」。没有字段时不显示，不从文字解析。
   - 时间线工具行的「+N −M」是否随之出现属于另一处改动，不在本方案范围；如需要，另行确认。

## 6. 需要同步的规范

用户已同意以下规则变更（2026-11-14），实施时在同一 Pull Request 中更新 [DESIGN](../../DESIGN.md)，不新增与本方案无关的条目：

- 「组件规则」工具详情阅读器条目：标题由「工具名」改为与时间线工具行同源（图标＋动作词＋对象，未分类工具仍为工具名）；状态由「只显示彩色状态图标」改为正文首行的图标加文字标签，删除「阅读器不跟随」类型图标的说法；参数由「所有工具一致、不做推断或省略」改为第 4.4 节的「已知工具按语义显示、其余参数原样列出」；输出由「与 Pi 原生一致不带行号、与调用参数同一左边线」改为代码块＋复制，read 带行号，diff 的增删底色规则保留在代码块内。
- 「组件规则」文件阅读器条目：加文件信息行与目录按钮（含出现条件与叠层规则）。
- 「字号语义」：加文件阅读器 Markdown 标题字号；如新增字号 token，登记到字号档位。
- 颜色表中 `code-surface` 的用途说明：加上工具详情阅读器的输出块与命令块。
- 第二期如实施，再补 diff 行号、退出码与耗时的显示规则。

本方案不涉及已关闭决策；阅读器统一为右侧 Drawer（[ADR-20261018](../../adr/20261018-reader-drawer-only.md)）与直角 Drawer（[ADR-20261028](../../adr/20261028-square-navigation-and-drawers.md)）保持不变。

## 7. 验证

按 [`pwa/AGENTS.md`](../../../pwa/AGENTS.md#验证与交付) 只运行直接覆盖改动的测试文件，更广的回归以 Pull Request 的 CI 为准。

- Node：[`tool-presentation.node.test.ts`](../../../pwa/src/components/pwa/tool-presentation.node.test.ts) 补充：参数分拣（已用与剩余）、read 起始行与三种续读提示的剥离（含不匹配时不剥离）、`[Line N is …]` 不编号；第二期补 Pi 自有 diff 与统一 diff 的行号拆分与计数。
- Browser Mode：
  - [`tool-reader.browser.test.tsx`](../../../pwa/src/components/pwa/tool-reader.browser.test.tsx)：标题与时间线同源、未分类工具保持工具名、状态标签文字与 `aria-describedby`、命令块与剩余参数、输出块复制内容不含行号、read 行号与提示位置、出错时不再整块红底、运行中跟随不回退。
  - [`published-file.browser.test.tsx`](../../../pwa/src/components/pwa/published-file.browser.test.tsx)：文件信息行、目录按钮出现条件、目录跳转、Escape／系统返回／右滑在目录打开时的行为、焦点返回。
  - 外壳改动后运行 [`reader-drawer.browser.test.tsx`](../../../pwa/src/components/pwa/reader-drawer.browser.test.tsx)、[`thinking-reader.browser.test.tsx`](../../../pwa/src/components/pwa/thinking-reader.browser.test.tsx)、[`summary-reader.browser.test.tsx`](../../../pwa/src/components/pwa/summary-reader.browser.test.tsx)，确认思考与摘要阅读器不受影响。
  - 展厅：[`ui-state-tool-details.browser.test.tsx`](../../../pwa/src/dev/ui-state-tool-details.browser.test.tsx) 及受演示数据影响的展厅测试。
- 设计守卫：改动 CSS、图标或叠层后运行 `pwa/src/app/` 下的 `pwa-style-guard`、`pwa-button-guard`、`pwa-layer-guard`、`pwa-script-token-guard`、`pwa-theme-contrast`，以及 `scripts/overlay-skill-guard.test.mjs`。
- `pnpm --filter pwa lint`、`pnpm --filter pwa typecheck`、`pnpm check:docs`、`git diff --check`。
- 目视：在 `/app/ui-states` 对照视觉稿检查桌面 720 抽屉与移动全屏、浅色与深色、三个字号档位；README 截图若包含阅读器，按 `pnpm screenshots` 重新生成。
- 第二期另需：扩展端单元测试、协议测试（字段白名单与字节上限）、`pnpm test:e2e`（含 Docker Protocol v2）。

## 8. 实施与交付

- 分支：第一期 `feature/261114-reader-polish`；提交与 Pull Request 标题如 `feat(pwa): 优化工具详情与文档阅读器的标题、状态与输出呈现`。第二期跨包，另开分支，标题省略 scope。
- 建议顺序：4.4 参数分拣与 4.5 行号的纯函数及测试 → 4.1／4.2 标题与状态 → 4.3 输出块 → 4.6 文件信息与标题层级 → 4.7 目录与叠层验收 → 4.8 展厅 → DESIGN 同步。
- 推送 `feature/*` 会自动部署并覆盖 staging；推送前按根 [AGENTS](../../../AGENTS.md#工作规则) 核对 `STAGING_BRANCH_DEPLOY` 并取得推送授权。提交、推送和 Pull Request 均需用户另行授权。
- 完成后：把成立的事实同步到 DESIGN（第 6 节），更新 ROADMAP 状态，按项目文档生命周期归档本方案；视觉稿在规则提炼进 DESIGN 后改为「已失效」或删除，不作为实现真源。

## 9. 风险

- 标题改用动作词后，未分类工具与已分类工具的标题风格不同；这是有意保留的回退，不为未分类工具编造动作词。
- read 续读提示的文字由 Pi 定义，Pi 升级后可能变化；匹配失败时退化为整段编号，提示行会多一个行号。升级 Pi SDK 时应复核这条匹配。
- 文件阅读器标题字号加大后，大字号档位下 h1 可能折行较多；需要在最大档位目视检查。
- 目录菜单是阅读器之上的新叠层，Escape、系统返回与右滑的竞争最容易出问题，必须按叠层技能逐项验收，不能只比截图。
