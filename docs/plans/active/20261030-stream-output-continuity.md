# 会话输出连续性与 Working 兜底重构方案

本文供实现模型和审查者使用，记录 2026-10-30 录屏暴露的会话输出不连续问题、已确认决策、目标行为、架构方案、实施顺序与验收要求。它是实施方案，不代表已经实现或验收。

本文保存时只获得方案制定授权；2026-10-30 用户确认 R1—R7 按推荐执行，并授权一次性实施 PWA、协议与 Extension 改动及直接相关的测试与文档。提交、push、PR 与部署仍须另行授权。方案明确替代 [ADR-20261030](../../adr/20261030-thinking-tool-process-groups.md) 第 6 条（Working 承载）与过程组自动收起时机、[ADR-20261011](../../adr/20261011-live-tool-grouping.md) 的「Working 提示修订（2026-10-12）」，以及 [DESIGN「会话正文」「过程组」](../../DESIGN.md#组件规则) 中对应规则；替代关系在实施完成后以新 ADR 记录，完成前不能把目标行为写成当前事实。项目级状态以 [ROADMAP](../../ROADMAP.md) 为准。

## 阅读与执行顺序

1. 先读「背景与证据」「已确认决策」「目标行为」，明确要改变什么、保留什么。
2. P0 一次性确认第三节的待确认规则，并完成 P0 的技术核查；核查结论可能改变 P6 的协议形态。
3. 按 P1—P8 串行实施。每阶段独立可交付，阶段出口通过后再推进；PWA-only 阶段可以先于协议阶段上线。
4. 遇到「停止条件」列出的情况，交回决策，不靠调整时长常量试错。

## 一、背景与证据

### 1.1 录屏逐帧时间线

样本：iOS 已安装 PWA，DeepSeek V4.1 Flash，提示词「随意调用几次工具，并输出300字」，8.1s，60fps，按 10fps 与 30fps 抽帧核对。

| 时刻 | 画面 | 问题 |
|---|---|---|
| 1.2s → 1.3s | 用户气泡出现，100ms 后出现 Working | 正常 |
| 2.2–2.8s | Thinking 组出现，单行摘要逐字增长到「…并输出300...」被省略号截断后静止 | 思考的流式进度在截断后不可见 |
| 2.9s | 2 条 bash 同一帧整组出现且已打勾；摘要退回「Thinking」；组头变为「运行 2 条命令 Working…」 | 工具无流式；快速工具没有可感知的运行态；已显示内容消失；Working 换位置 |
| 3.9–4.7s | 新思考「Interesting: git status…」同样单行截断后静止 | 同上 |
| 4.8s | wc、read 两行同一帧出现且已完成；摘要再次退回「Thinking」 | 同上，一次插入约 3 行高度 |
| 5.5–6.7s | 正文匀速放出、淡入、平滑跟随；Working 在正文下方独立一行并随正文下移 | 有明确输出时仍显示 Working |
| 6.5s | 一帧出现灰色斜体「*内容核验」 | 未闭合的 `**` 被解析成斜体 |
| 6.8s | Working 隐藏、完成时间 22:53 出现、发送按钮复原 | 「已结束」先于正文 |
| 6.9–7.1s | 正文补完最后约两行 | 同上 |

1.2–5.5s 约 4.3 秒处于思考与工具阶段，呈现以离散跳变为主；正文的平滑只覆盖最后约 1.3 秒，整体观感由前者决定。

### 1.2 根因

1. **Working 表达「仍在运行」而非「界面没有动静」**：它与正文、组头争夺位置，正文输出时仍挂着，并在组头、末尾之间迁移。
2. **两套时钟**：文字经显示缓冲（约 240ms 延迟＋160–640ms 收尾），结构变化（新行、工具状态、`run_end`）与 `endpoint.working` 立即穿透到界面。
3. **高度阶跃**：新行、Working 显隐、过程组收起直接改变高度；平滑跟随只认 Pi 正文。

### 1.3 代码事实

| 位置 | 事实 |
|---|---|
| `pi-extension/src/timeline/runtime.ts:249-270` | `onMessageUpdate` 只处理 `text_*`、`thinking_*`；`toolcall_start`、`toolcall_delta` 被忽略，`toolcall_end` 只建立关联 |
| `pi-extension/src/timeline/tool_lifecycle.ts:135-160` | 工具 partial 的 `partial_id` 为 `tool:<toolCallId>`，`status` 取 `running`（无结果）或 `delta`（有输出） |
| `packages/protocol/src/session/schema.ts:214` | partial `status` 为 `z.enum(["running", "delta"])`，严格校验 |
| pi-ai 1.3.0 `types.d.ts:566-612` | `toolcall_start` 带 `partial: AssistantMessage`，`toolcall_delta` 带 JSON 增量；部分 provider（如 openai-responses）在流式中用 `parseStreamingJson` 回填 `block.arguments` |
| `pwa/src/lib/pwa/stream-display-buffer.ts:90` | `streamsImmediately`：工具 partial 与带 `blocks` 的 partial 不做节奏放出 |
| 同上 `:547-559` | `buildSnapshot` 中正式事件（含 `run_end`）立即进入显示快照 |
| `pwa/src/components/pwa/message-list.tsx:148` | `completions` 由显示快照中的正式事件推出，驱动完成时间、自动收起与 `runEnded` |
| `pwa/src/components/pwa/pwa-app.tsx:1246` | 时间线 `running` 与 Composer `isWorking` 都直接取 `displayEndpoint.working` |
| `pwa/src/components/pwa/use-process-presentation.ts:80-88` | `genericWorking = working && !specificVisible`；`host` 决定组头承载或末尾兜底 |
| `pwa/src/components/pwa/conversation-timeline.tsx:219-235` | Working 显隐时测量自身高度并以 `activity` 通知视口 |
| `pwa/src/components/pwa/process-group-state.ts:29-37` | 展开优先级：手动 > 阅读保护 > `run_end` 收起 > 运行展开 > 保持 > 历史收起 |
| `pwa/src/components/pwa/use-thinking-heading.ts` | 未结束时显示加粗标题或首行摘要（120ms 合并），结束后无标题即回到「Thinking」 |
| `pwa/src/components/pwa/conversation-timeline.tsx:63-64` | 流式淡入只用于 `TextRow`，思考与工具没有 |
| `pwa/src/lib/pwa/timeline-viewport-layout.ts:58` | 平滑接续只识别末尾的 `.pwa-message.assistant.partial` |
| `pwa/src/lib/pwa/markdown-stream.ts` | 只做块切分与淡入标记，不处理未闭合的行内标记 |

## 二、目标与非目标

### 2.1 目标

1. Working 只在界面一段时间内没有任何可见变化时出现，位置固定、出现消失不改变布局高度。
2. 文字、结构变化、状态切换与本轮结束统一经显示队列，按同一时钟呈现，顺序与事件顺序一致。
3. 思考与工具阶段持续可见地「在动」：思考看得到最新内容，工具从模型开始生成调用起就出现并逐步补全参数。
4. 时间线高度变化都有过渡或预留，跟随滚动对所有尾部增长一致平滑。
5. 已显示的内容不回退（摘要不退回「Thinking」，不出现未闭合标记闪烁）。

### 2.2 非目标

- 不改变权威状态：运行态、`run_end` 确认语义、投递与排队逻辑、持久化不变；显示层只决定「何时呈现」。
- 不改变 Composer 发送／停止的功能判定（见 R3）。
- 不改变过程组的分组边界、组身份继承、阅读器与手动选择语义。
- 不改变 Relay；不在时间线铺开工具参数全文、输出或思考全文。
- 不处理历史会话的展示（历史无流式，直接呈现最终态）。

## 三、决策

### 3.1 已确认（2026-10-30）

| 编号 | 决策 |
|---|---|
| D1 | Working 只在页面没有明确动作时作为兜底展示，表示仍在运行；空窗阈值 400ms |
| D2 | 本轮工具调用与思考结束、其后有新的正文出现时，收起上方过程组 |
| D3 | 现有 DESIGN 与 ADR 中与 D1、D2 冲突的规则不构成约束，由本方案替代并在完成后记录新 ADR |

### 3.2 实施细则（2026-10-30 按推荐确认）

| 编号 | 问题 | 推荐 |
|---|---|---|
| R1 | 发送后首次 Working 是否也等 400ms 空窗 | 等待。气泡进入（160ms）本身是可见动作，统一规则；首包通常 <1s，空窗期由 Working 补位 |
| R2 | 快速工具的最短运行展示 | 300ms，只对实际收到过运行态的工具生效，不为首次即完成的工具伪造运行态 |
| R3 | Composer 发送／停止按钮是否等显示排空 | 不等。按钮决定发送是否排队，保持权威 |
| R4 | 思考运行中的预览形态 | 明细内标题行＋最多 2 行尾部预览，固定高度，结束后收起为单行摘要 |
| R5 | 工具「准备中」的协议表达 | partial `status` 新增 `preparing`；P0 核查旧 PWA 对未知 status 的处理后最终确定（见 5.6） |
| R6 | 新行进入形态 | 只淡入（160ms），不做高度动画；位移由统一跟随平滑承担 |
| R7 | 结构单元最小间隔 | 120ms；积压超过 1000ms 时压缩间隔追赶 |

## 四、目标行为

### 4.1 可见活动

「可见活动」指当前轮在显示层产生的、用户能看到的变化，作为 Working 判定的唯一依据：

1. 正文或思考有新字素放出；
2. 新行进入（过程组、思考行、工具行、正文行、文件卡片）；
3. 工具参数增长、工具状态切换、思考标题或预览变化；
4. 视口内存在当前轮的运行图标（运行或准备中的工具），按现有 `tool-indicator-visibility` 的可见性判定，被裁剪、隐藏或不在视口内不算。

partial 仍处于 streaming 但网络停滞、显示不再变化时，**不算**可见活动。

### 4.2 Working 与活动区

- **活动区**：当前轮从开始（本端发送或首个输出）到「本轮结束已呈现」期间，时间线末尾保留一个固定高度的活动区（沿用 Working 行的 44px 最小高与 6px 上下外边距）。活动区随发送过渡一起出现，不单独触发跟随。
- **Working**：活动区内，当本轮仍在运行（`running`）且距最后一次可见活动 ≥ 400ms 时，以 `--pwa-duration-fade` 淡入「Working…」与旋转图标；发生任何可见活动时同时长淡出。显隐只改透明度，不改高度，不通知视口。
- **位置唯一**：Working 只出现在活动区，取消组头承载与「具体运行图标让位」规则。
- **结束交接**：本轮结束呈现后（见 4.3），活动区以 `--pwa-duration-collapse-out` 收起到 0，完成时间行同时淡入；高度净变化按收缩处理（见 4.7）。
- **压缩**：压缩进行中沿用活动区位置显示压缩状态，优先于 Working。
- **离线／Pi 空闲**：连接离线或 Pi 空闲且显示已排空时，活动区按结束交接收起；离线不显示完成时间（与现状一致，完成时间只来自 `run_end`）。

### 4.3 统一显示队列

显示队列扩展现有 `StreamDisplayBuffer`，原则是「权威状态立即进入队列，按顺序与节奏呈现」：

1. **文字**：保持现有匀速放出与收尾窗口参数（240ms 目标延迟、160–640ms 收尾）。
2. **结构单元**：新 partial 首次出现、无 partial 前驱的新正式行、工具状态切换都是结构单元。按时间线顺序排队，只有前面的文字 lane 放完且距上一个结构单元 ≥ 120ms 才放出；积压延迟超过 1000ms 时把间隔压缩到一帧，直到追上。
3. **工具最短运行展示**：工具行以运行或准备中状态放出后，完成状态至少在 300ms 后才呈现；首次即为完成态的工具直接以完成态进入，不伪造运行态。
4. **`run_end` 排队**：本轮的 `run_end` 事件在该 `group_id` 的全部 lane 放完、结构单元与最短运行展示全部结束后才进入显示快照。由此，完成时间、过程组「本轮结束」收起、`runEnded` 判定、活动区收起自动与正文对齐，不再需要单独的等待逻辑。
5. **不排队的变化**：本端发送与 pending 状态、排队面板、投递失败与核对、会话切换、重置、前插历史、前台恢复，保持立即呈现（现有 urgent／reset／flush 路径）。
6. **本端发送冲刷（实施中撤回，见 10.2）**：本端发送新消息时，上一轮尚未放完的显示内容立即放完（`flush`），新气泡不与旧尾巴交错。
7. **后台与恢复**：保持现状，页面隐藏时不推进，恢复时直接接管最新权威内容，不重播。

### 4.4 过程组收起

展开优先级调整为：手动 > 阅读保护 > **后续正文收起** > 本轮结束收起 > 运行展开 > 保持 > 历史收起。

- **后续正文收起（D2）**：同一轮中，过程组之后紧接的 Pi 正文在显示快照中已有至少 1 个可见字素，且组内没有运行或准备中的成员时，该组默认收起（`expansionSource: "superseded"`）。组内仍有运行成员时等其全部结束后再收起。
- **本轮结束收起**：本轮最后一个过程组之后没有正文时，在 `run_end` 呈现（已排空）后收起。
- 手动展开、阅读器打开或退出中、焦点在明细内时不收起，释放后按当前规则重新求值。
- 收起动画沿用 `Collapse` 与 `--pwa-duration-collapse-out`；视口沿用现有「组收起预计回收高度」通知（`conversation-timeline.tsx:205-218`），跟随时底部锚定、正文不跳。
- 正文之后再出现新的思考或工具时，按现有分组规则形成新组并运行展开；已收起的旧组保持收起。

### 4.5 思考呈现

- **运行中（明细内）**：思考行第一行为标题——加粗标题优先，否则为占位「Thinking…」；其下为最多 2 行的尾部预览，显示当前已放出正文的最新内容（纯文本，不解析 Markdown，只取末尾约 300 字符），14px／1.5、`secondary`，高度从第一个字素起固定为 2 行，新内容自底部进入、顶部以渐隐遮罩裁剪，新字素以 `--pwa-duration-content` 淡入。
- **组头收起时**：显示加粗标题，否则显示预览的最新一行（单行，前端省略）。
- **结束后**：预览区以 `--pwa-duration-collapse-out` 收起；标题保留为最后一个有效摘要——最新加粗标题优先，其次首行摘要；只有完全没有正文时才显示「Thinking」。不再退回占位。
- **思考阅读器**：不变，仍从思考行打开查看全文。
- 120ms 摘要合并窗口改为只用于组头单行摘要；预览直接跟随显示队列的放出节奏。

### 4.6 工具准备与运行

- 模型开始生成工具调用（`toolcall_start`）时出现工具行，状态为「准备中」：图标为 `secondary` 色的旋转图标，工具名后接参数摘要（命令／路径，等宽，单行省略）。
- 参数生成过程中（`toolcall_delta`）参数摘要按约 100ms 节流更新；摘要增长计为可见活动。
- 开始执行（`tool_execution_start`）时同一行原位切换为运行色旋转图标；完成、失败、中断沿用现有状态。行身份（`tool:<toolCallId>`）全程不变，不重建节点。
- 模型中止或出错导致已准备的调用未执行时，该行在消息结束后转为「中断」或被撤回（P0 核查后确定，见 5.6）。
- 分类摘要与「+N」计数把准备中视为进行中；工具审批（`approve_tool`）只在执行阶段出现，准备中不显示审批入口。

### 4.7 布局过渡与跟随

- **新行进入**：以 `--pwa-duration-message-in`（160ms）与标准曲线淡入，不加位移与高度动画；首次加载、重新挂载、历史前插不播放。
- **组头文案替换**：当前活动切换时，旧文案淡出、新文案淡入（`--pwa-duration-fade`），不改变组头高度。
- **统一跟随**：跟随中，时间线尾部的任何增长（正文、思考预览、工具行、过程组、活动区）在增量不超过一屏、可视高度未变时，都使用现有逐帧平滑接续（`FollowGlide`）；超过一屏、可视高度变化或减少动态效果时瞬时贴底，与现有例外一致。
- **收缩**：过程组收起、活动区收起、思考预览收起按净布局处理；跟随时保持底部锚定，原位置不可达时在过渡期内保留尚未收回的空间、平滑收口，结束后不留永久占位（沿用现有 `collapseHold` 机制）。
- **回看**：不跟随时新增内容不移动阅读位置，沿用现有锚点规则。

### 4.8 流式 Markdown

流式期间，只对最后一个 Markdown 块，在渲染前对末尾未闭合的行内标记临时补闭合：`**`、`~~`、行内代码反引号；未完成的链接 `[文本](…` 只渲染文本。正文完成后使用原文渲染。`_` 与单个 `*` 易与标识符、列表混淆，不做补闭合。

### 4.9 减少动态效果与边界

- 减少动态效果：淡入淡出改为 `--pwa-duration-reduced`；结构单元间隔与最短运行展示保留（它们是信息节奏而非装饰），跟随瞬时贴底。
- 离线：显示队列立即放完；准备中与运行中的工具按现有离线规则显示未知。
- 会话切换、重置：清空队列与活动时钟，不播放任何进入动画。

## 五、架构方案

### 5.1 显示队列（`stream-display-buffer.ts`）

现有 `StreamDisplayBuffer` 已拥有字素 lane、收尾窗口与「正式版本由 lane 原位代替」的机制。扩展方向：

1. **结构门控**：`buildSnapshot` 按权威顺序遍历时维护「已放出前缀」。某个结构单元之前存在未放完的 lane 或未到间隔时，该单元及其后的同组结构单元暂不进入快照。门控只作用于当前轮（最后一个 `group_id`）的直播增量，不作用于 pending、排队与历史项。
2. **工具状态 lane**：工具 partial 不再 `streamsImmediately`，改为持有「已呈现状态」与「最早可切换时间」。正式工具结果到达时，像文字收尾一样由 lane 原位代替，直到最短运行展示结束再交接。
3. **`run_end` 门控**：`run_end` 事件视为该组最后一个结构单元，满足 4.3 第 4 条后才进入快照。
4. **活动信号**：`advance` 与 `ingest` 返回的变化中新增 `activity: boolean`，表示本次是否产生可见变化（字素放出、结构单元放出、工具状态切换）。
5. **复杂度**：buffer 已有 579 行，超出单文件 600 行上限前需要拆分。建议拆出 `stream-structure-gate.ts`（结构门控与 `run_end` 门控）与 `stream-tool-lane.ts`（工具状态 lane），buffer 只负责编排。

### 5.2 活动时钟与 Working 判定

- `StreamDisplayScheduler` 在每次发布时，若变化带 `activity`，记录 `lastActivityAt` 并通知订阅者；不为每帧触发 React 渲染。
- 新增 `useIdleWorking({ running, live, compacting, turnActive, scheduler, visibleIndicators })`：订阅活动信号，内部用一个定时器在最后一次活动后 400ms 把 `idle` 置真，任何活动立即置假；视口内存在当前轮运行图标时视为持续活动。只在显隐边沿 `setState`。
- 删除 `use-process-presentation.ts` 中的 `specificVisible`、`host`、`workingGroupKey`，`process-group-state.ts` 中的 `canHostWorking`，`ProcessGroup` 的 `showWorking` 与组头「Working…」文案分支。
- `timeline-activity.ts` 的 `working` 与 `runActive` 语义保留，作为「本轮仍在运行」输入。

### 5.3 活动区组件

- `ConversationTimeline` 末尾以 `TurnActivitySlot` 替代 `WorkingStatus`／`CompactionStatus` 的条件渲染：`turnActive` 为真时渲染固定高度容器，内部根据 `idle`、`compacting` 切换内容透明度。
- `turnActive = live && 最后一轮尚未呈现 run_end && (running || 显示队列未排空 || 本端刚发送)`。
- 删除 `conversation-timeline.tsx:219-235` 的 Working 显隐几何通知；活动区出现随发送或首个输出一起进入，结束收起走 4.7 的收缩通知。视口协调器中 `activity` 原因与 `activityPending`、`activityGrowth` 若不再有调用方则一并删除（实现时核对调用方）。
- 现有「Working 交接的临时留白」逻辑随活动区固定高度失去用途，核对后删除，不保留死代码。

### 5.4 过程组展开（`process-group-state.ts`）

- `ProcessContext` 增加 `supersededByText: boolean`：由 `useProcessPresentation` 按显示快照计算——组之后的下一个条目是同轮 Pi 正文且已有可见文字。
- `expansionState` 在阅读保护之后、`completion` 之前判断 `supersededByText && 组内无运行成员`。
- `expansionSource` 增加 `"superseded"`；视口收起通知已按「展开 → 收起」边沿触发，无需改动。

### 5.5 思考预览

- `ThinkingProcessRow` 拆出 `ThinkingTailPreview`：输入为已放出的 `entry.text`，只取末尾片段；用 `--pwa-*` token 写固定 2 行高度与顶部渐隐遮罩；新字素淡入复用 `useStreamRevealMarks` 的标记思路，以纯文本 span 实现，不经 Markdown。
- `use-thinking-heading.ts`：结束后返回最后有效摘要；运行中组头单行使用预览末行。
- `ThinkingTextParser` 增量解析不变；尾部预览不需要解析器。

### 5.6 工具准备中（协议 → PWA → Extension）

**P0 核查项（决定最终形态）**：

1. 旧 PWA 收到 `status` 为未知值的 `timeline_partial` 时，是丢弃该帧还是使通道失败（`pwa/src/lib/pwa/timeline-runtime.ts:614`、`:761` 起的校验路径）。若只丢弃该帧，新增枚举值安全；若导致通道失败，必须严格先部署 PWA 再发布 Extension，并在发布说明中强调。
2. 各 provider 在 `toolcall_start` 时 `partial.content[contentIndex]` 是否已有 `id` 与 `name`；DeepSeek 所用的 openai-completions 路径在流式中是否回填 `arguments`。不回填时 Extension 自行累积 `toolcall_delta` 并调用 pi-ai 的 `parseStreamingJson`（核对包导出路径）。
3. 消息被中止或出错、已准备的调用不会执行时，现有 partial 是否有撤回机制；没有时确定按「中断」呈现还是新增撤回。

**协议**：`packages/protocol/src/session/schema.ts` 中工具 partial 的 `status` 增加 `"preparing"`（仅工具 partial 允许），补 schema 测试与协议文档；不改帧结构。

**PWA**：`tool-presentation.ts` 的状态映射增加 `preparing`；工具行、组头、分类摘要、阅读器按 4.6 呈现；`effectiveProcessStatus` 把 `preparing` 视为进行中。

**Extension**：

- `onMessageUpdate` 处理 `toolcall_start`：取 `partial.content[contentIndex]` 的 `id`、`name`，建立临时关联并发布 `tool:<id>` 的 `preparing` partial（参数为空）。
- `toolcall_delta`：每个调用按 100ms 节流发布最新参数，参数经现有 `outgoingToolArgs` 截断，超过帧上限时沿用 `toolPartial` 去掉参数的回退。
- `toolcall_end`：发布最终参数（仍为 `preparing`），并保持现有关联索引。
- `tool_execution_start`：沿用现有 running partial，同一 `partial_id` 原位替换。
- 消息结束时仍为 `preparing` 的调用按 P0 核查结论处理。

**发布顺序**：先部署支持 `preparing` 的 PWA，再发布 Extension（同 [DEPLOYMENT](../../DEPLOYMENT.md#extension-npm-发布)）。

### 5.7 视口跟随（`timeline-viewport-layout.ts`、`timeline-viewport-coordinator.ts`）

- 把「末尾是实时 Pi 回复」的判定从 `.pwa-message.assistant.partial` 改为带 `data-viewport-live` 的末尾行：流式正文、含运行或准备中成员的过程组、活动区设置该属性。
- `glideMode` 的条件不变（一屏以内、可视高度不变、动画可用）；`replyContinuity` 的身份校验扩展到上述行类型。
- 新增或调整协调器契约前，按 [时间线视口协调层重构](20261022-timeline-viewport-coordinator.md) 的约束先报告接口变化。

### 5.8 Markdown 补闭合（`markdown-stream.ts`、`timeline-content.tsx`）

- 新增纯函数 `closeStreamingInline(text): string`，只处理最后一个块，按 4.8 规则补闭合；`MarkdownContent` 在 `streaming` 时对最后一块调用。
- 淡入标记 `reveal` 的偏移基于原文；补上的闭合字符不参与偏移计算。

## 六、实施阶段

每阶段出口：受影响的 Node／Browser Mode 测试通过、`pnpm --filter pwa lint` 与 `typecheck` 通过、`git diff --check` 通过；涉及 CSS 时运行 `pwa-style-guard` 等静态守卫；阶段结束用同一提示词在 staging 真机录屏，与 1.1 逐帧对比。

| 阶段 | 内容 | 主要文件 | 自动化验证 |
|---|---|---|---|
| P0 | 确认 R1—R7；完成 5.6 的三项核查；冻结常量与新模块名 | — | 核查结论写入本方案实施记录 |
| P1 | `run_end` 显示门控 | `stream-display-buffer.ts`、`stream-display-scheduler.ts`、`use-timeline.ts` | buffer：`run_end` 在 lane 排空前不进入快照、排空后进入；flush 立即放完；`message-list`／`timeline-handoff` 浏览器用例：完成时间不早于正文末字 |
| P2 | 活动时钟、`useIdleWorking`、活动区；删除组头承载与 Working 几何通知 | `stream-display-scheduler.ts`、新 `use-idle-working.ts`、`conversation-timeline.tsx`、`use-process-presentation.ts`、`process-group*.ts(x)`、`timeline-viewport-coordinator.ts`、`timeline-content.css` | Node：活动信号与 400ms 定时；浏览器：正文放出期间无 Working、停滞 400ms 后出现、活动恢复即隐藏、显隐不改列表高度、结束交接收缩平滑；删除后的协调器测试同步更新 |
| P3 | 后续正文收起过程组 | `process-group-state.ts`、`use-process-presentation.ts` | `process-group-state.node.test.ts`：优先级表全覆盖（手动、保护、运行成员未结束、无后续正文）；浏览器：首字出现时收起、跟随时正文不跳 |
| P4 | 统一跟随与新行淡入 | `timeline-viewport-layout.ts`、`timeline-viewport-coordinator.ts`、`conversation-timeline.tsx`、`process-group.tsx`、相关 CSS | `timeline-viewport-coordinator.node.test.ts`：工具行、过程组增长走平滑接续；超过一屏仍瞬时；浏览器：首次加载与前插不播放淡入 |
| P5 | 思考尾部预览与摘要保留 | `thinking-process-row.tsx`、新 `thinking-tail-preview.tsx`、`use-thinking-heading.ts`、`process-group.css` | `thinking-heading-motion`、`process-group` 浏览器用例：预览固定 2 行高度、结束后保留摘要、不退回 Thinking；整像素比较高度 |
| P6 | 结构单元排队与工具最短运行展示 | `stream-display-buffer.ts` 拆分出的门控与工具 lane | Node：120ms 间隔、积压追赶、300ms 最短运行、首次即完成不伪造；浏览器：工具逐行出现 |
| P7 | 工具准备中（协议 → PWA → Extension） | `packages/protocol`、`tool-presentation.ts`、`process-group*.tsx`、`pi-extension/src/timeline/runtime.ts`、`tool_lifecycle.ts` | protocol schema 测试；Extension `runtime.test.ts`：start／delta 节流／end／execution 的帧序与同一 `partial_id`；PWA 准备中呈现；`pnpm test:e2e` 覆盖真实链路 |
| P8 | Markdown 补闭合；文档收口 | `markdown-stream.ts`、`timeline-content.tsx`；DESIGN、新 ADR | `markdown-stream.node.test.tsx`：补闭合规则与 reveal 偏移；`pnpm check:docs` |

P1—P6、P8 只改 PWA，可分批上线；P7 跨三端，单独成 PR，按发布顺序上线。

## 七、验收

### 7.1 自动化

- 所有计时断言为慢机器留余量：400ms 阈值断言「300ms 内未出现、700ms 内出现」，不依赖精确帧；几何断言按整像素比较。
- 不依赖关闭事件处理时序；需要逐帧采样的用例，采样窗口只覆盖一次过渡。
- 根级：P7 运行 `pnpm verify` 与 `pnpm test:e2e`；其余阶段按 `pwa/AGENTS.md` 只运行直接覆盖改动的测试文件，更广回归以 PR CI 为准。

### 7.2 录屏对比

用同一模型与提示词在 staging 真机录屏，逐帧核对：

| 检查项 | 通过标准 |
|---|---|
| Working | 正文、思考预览、工具行变化期间不出现；任何停滞 ≥400ms 时出现；只出现在末尾；显隐时其上内容不移动 |
| 结束顺序 | 完成时间、过程组收起都在正文最后一个字之后出现 |
| 过程组 | 正文首字出现时上方组收起，正文位置不跳 |
| 思考 | 运行中预览持续变化；结束后显示摘要而不是「Thinking」 |
| 工具 | 逐行出现，每行至少可见约 300ms 运行态（P7 后从准备中开始） |
| 高度 | 无一帧内超过一行的突变（跟随状态下） |
| Markdown | 无未闭合标记闪烁 |

## 八、风险与停止条件

| 风险 | 应对 |
|---|---|
| 显示队列延迟累积，界面明显落后于真实进度 | 积压追赶（R7）；验收时测量 `run_end` 权威到达与呈现的差值，超过 1s 停下复核参数 |
| 本端发送与上一轮尾巴交错 | 4.3 第 6 条冲刷；浏览器用例覆盖 |
| 活动区与发送过渡、留白优先规则冲突 | P2 先在 `timeline-viewport.integration.browser.test.tsx` 复现现有发送用例，冲突时停下报告，不靠调整时长试错 |
| 收起与正文首字同帧导致双重位移 | P3 用协调器诊断记录核对单帧位移；不满足时停下报告 |
| 协议新增枚举导致旧 PWA 通道失败 | P0 核查；结论为通道失败时，P7 发布前单独确认发布窗口 |
| provider 不提供流式参数 | 准备中只显示工具名，参数在 `toolcall_end` 一次补齐；不为个别 provider 自行解析非 JSON 增量 |
| buffer 拆分改变现有收尾行为 | 拆分先做等价重构并保持 `stream-display-buffer.node.test.ts` 全部通过，再加新能力 |

停止条件：需要改变权威状态语义、协议帧结构（新增枚举值以外）、视口协调器公共契约，或验收发现「显示落后真实进度超过 1s」时，先报告证据与选项，等待确认。

## 九、文档同步（实施完成后）

- 新增 ADR：记录 D1—D3 与 R1—R7 的结论，注明替代 ADR-20261030 第 6 条与自动收起时机、ADR-20261011 的 2026-10-12 Working 修订。
- DESIGN：重写「会话正文」中 Working、流式正文、完成时间的段落；「过程组」中 Working 承载、思考标题与收起规则；新增思考预览、工具准备中与活动区的视觉规格。
- ARCHITECTURE：显示队列职责（文字、结构、`run_end` 门控）与活动时钟。
- 协议参考：工具 partial `preparing` 状态。
- ROADMAP：方案获准实施时登记事项并链接本方案；完成后按生命周期归档。

## 十、实施记录

### 10.1 P0 核查结论（2026-10-30）

1. **旧 PWA 对未知 status 的处理**：帧在 `peer-channel.ts` 解码阶段被严格 schema 拒收，经 `onMalformed` 显示协议错误提示；不会断开通道。新增 `preparing` 可行，但混合版本期间每个准备中帧都会弹提示，必须先部署 PWA 再发布 Extension。
2. **流式参数**：pi-ai 1.3.0 的 openai-completions、anthropic-messages、openai-responses、mistral、bedrock、pi-messages 在 `toolcall_delta` 时以 `parseStreamingJson` 回填 `block.arguments`；google 系列不流式输出参数。Extension 直接读取 `partial.content[contentIndex]`，`id` 或 `name` 尚未到达时不发布。
3. **未执行调用的撤回**：PWA 的工具 partial 只在对应正式工具事件提交时移除，中止的调用不会有正式事件。改为在运行时提交 `run_end` 时移除同组仍为 `preparing` 的工具 partial，不新增撤回协议。

### 10.2 与方案的差异

- **活动区收起**：未做高度收起动画。本轮结束呈现时活动区移除、完成时间同时出现，沿用现有「活动行显隐」的几何通知与协调器净布局处理（原 Working 显隐路径），只是触发时机从频繁显隐改为发送与结束两处。
- **组头思考摘要**：收起的组头沿用首行摘要，未改为最新一行；运行中的组默认展开，明细内的尾部预览已提供持续进度。
- **尾部预览**：不重复标题区已显示的文字——有整行加粗标题时只去掉标题行，否则跳过首个非空行；标题之外没有正文时不显示预览。
- **结构门控范围**：只对正在观看的一轮里「追加在已显示条目之后」的新行排队；插在其前的（历史前插、补齐）直接显示，`run_end` 例外，始终等本轮排空。
- **组头文案淡入**：只在挂载后当前活动换人时播放，首次挂载与历史不播放。
- **视口协调器修正**：实施中发现运行中过程组改为逐帧接续后，窗口尺寸变化触发的 `settle` 会清掉最后一次程序写入的回执，随后到达的原生 scroll 被误判为用户回看而结束跟随（流式回复早已存在同样的窗口，只是很少触发）。`exit()` 现在以实际落点作回执，真正的用户滚动落点不同，仍按回看处理；新增协调器回归测试。
- **活动区出现时机**：最初按方案随本端发送立即出现，发送过渡与「Working 晚出现时借用底部留白」的几何回归随即失败（多出 50px、发送后未贴底）。改为在本轮开始运行（Pi 报告 `working`）时出现，与原 Working 首次出现的时机一致，沿用已调好的活动行几何路径；发送到开始运行通常约 100ms，远短于 400ms 空闲阈值，不影响兜底。
- **本端发送冲刷（4.3 第 6 条）撤回**：排队消息出队时立即放完上一条回复会使剩余文字一次跳出，与既有「出队后平滑承接上一条回复尾巴」的交接规则冲突。改为不冲刷，上一条回复继续按节奏放完。
- **准备中参数截断**：写入大文件时每 100ms 一帧会重复发送整段内容（协议单帧上限 2MB），准备中参数中的单个字符串截至 2048 字符；完整参数仍由执行开始的运行帧送达。
- **Working 判定实现**：可见变化按展示条目的引用比较识别（投影会复用未变化的条目），不向调度器新增活动回调；视口内转动的工具图标沿用过程组已有的可见性上报。

### 10.3 本地验证（2026-10-30）

| 范围 | 命令 | 结果 |
|---|---|---|
| 根类型检查 | `pnpm typecheck` | 通过 |
| PWA lint | `pnpm lint` | 0 错误（6 条警告均为既有文件，未触及） |
| PWA Node 全量 | `pnpm --filter pwa exec vitest run --project node` | 94 文件、1254 用例通过 |
| PWA 浏览器（直接受影响文件） | message-list、use-timeline、process-group、thinking-reader、thinking-heading-motion、tool-indicator-visibility、timeline-handoff、timeline-viewport.integration、message-send、use-timeline-viewport | 10 文件、400 用例通过 |
| PWA 浏览器（pwa-app 相关用例） | `-t "queue display commit\|working\|Working"` | 3 用例通过 |
| PWA 生产构建 | `pnpm --filter pwa build` | 通过 |
| 协议包 | `pnpm --filter @pi-reach/protocol test` | 57 用例通过 |
| Extension | `pnpm --filter @yefengr/pi-reach test` | 757 用例＋15 脚本测试通过 |
| Relay | `pnpm test:relay` | 52 用例通过 |
| 文档 | `pnpm check:docs`、`git diff --check` | 通过 |

测试改写原则：旧用例中断言「组头承载 Working」「Working 与具体图标逐帧互斥」「新行立即出现」「完成时间与 run_end 同时出现」的部分按新规则改写；几何类断言改为可观察结果（末行完整可见并保留 8px、跟随不反向、借用留白不回补），并在比较前等待显示追上与滚动静止。

未覆盖：PWA 浏览器全量（本地只跑直接受影响文件，以 PR CI 的 4 组 `pwa-browser` 为准）、`pnpm test:e2e` 与 Docker 远程 E2E、真实模型下的真机录屏对比（7.2），以及新旧版本混跑期间旧 PWA 收到准备中帧的协议提示（按发布顺序规避，未实测）。
