# 历史会话与在线会话统一时间线

- 日期：2026-10-27
- 用途：统一历史会话与在线会话时间线代码的设计与验收依据；本文不是当前实现说明。
- 项目级状态：见 [ROADMAP](../../ROADMAP.md)，不在本文另设状态表。
- 基线：[PR #146](https://github.com/yefengr/pi-reach/pull/146) 已压缩合并（`3cee8b0`），实施分支 `feature/261027-unified-timeline`。
- 当前事实来源：[ARCHITECTURE](../../ARCHITECTURE.md)、[DESIGN](../../DESIGN.md)、[已关闭决策](../../adr/20260518-closed-decisions.md)。实现完成后把成立的事实同步到长期文档。

## 1. 背景

2026-10-27 iOS 录屏显示：历史会话快速上滑展开更早记录时，位置跳到会话开头。原因是历史会话由 `HistoryWorkspace` 单独实现分页与位置恢复，没有 PR #146 为在线会话加入的前插保护和「滚动停下再前插」。两套代码各自维护滚动逻辑，修复一侧容易漏掉另一侧。

## 2. 目标与边界

**目标**：历史会话和在线会话共用同一个时间线组件、同一个视口协调器、同一条「向前分页 → 滚动停下再前插 → 保住阅读位置」的链路，以及同一套阅读位置保存与恢复。

**不改动**：

- 数据来源：历史只读本地 IndexedDB，不经 Relay，离线可读，符合 [ADR-20260914](../../adr/20260914-pure-extension-runtime.md)，不新建 ADR。
- 协议、Extension、Relay；因此没有「先部署 PWA、再发布 Extension」的顺序约束。
- 历史只读：不能发送，不恢复远程会话。

## 3. 现状

| 层 | 在线会话 | 历史会话 |
| --- | --- | --- |
| 数据 | `TimelineRuntime` + `TimelineHistoryLoader`：先读本地，缺的序号经 Relay 补齐并写回本地 | `pwa-app` 一次读出全部事件，存于 `historyItems` |
| 分页 | 每页 80 条，经 `onPage` → `prependHistory` 前插 | `HistoryWorkspace` 自管 `visibleCount`：先 30 条，每次加 80 条 |
| 视口 | `useTimelineViewport`：锚点恢复、Latest、前插保护、`ScrollIdleGate` | 打开历史时关闭；`HistoryWorkspace` 自己恢复位置、监听尺寸 |
| 位置记忆 | 协调器保存「跟随最新」或「屏幕顶部那一行」 | `scrollTop` + `visibleCount` |
| 「最新」按钮 | 有 | 无 |

## 4. 目标架构

### 4.1 数据层

- **复用 `TimelineHistoryLoader`，增加只读模式**：
  - 读本地缓存，与在线一致。
  - 本地缺的序号不请求，保留为缺口，界面沿用「更早的记录未保存在此浏览器」提示。
  - 不写回本地。
  - 首页与每页条数与在线一致。
  - 「缺口如何处理」做成可替换策略。以后若支持经 Relay 补全历史，只替换这一策略（见第 8 节）。
- **`TimelineRuntime` 增加只读模式**：
  - 拒收所有实时帧。
  - `sendUser` 与重试返回 null，排队与投递状态为空。
  - 允许序号不连续以显示缺口，不像预览那样截成连续区间。
- 附件信息仍需全部事件推算，打开历史时单独读取一次全部事件。

### 4.2 Hook 层

`use-live-timeline.ts` 加入历史后会超过 600 行，按职责拆分：

- `use-timeline.ts`：对外统一接口，新增 `openHistory(target)`。
- 在线连接：握手、补齐、替换、Relay 分页，从现有代码迁出。
- 历史会话：只读打开、读取失败处理。
- `ScrollIdleGate` 暂存、前插保护与 `useTimelineViewport` 两种会话都启用。

### 4.3 视图层

- 删除 `HistoryWorkspace` 及其显示条数、位置恢复和尺寸监听。在线工作区按模式切换可发送输入区或只读输入区。
- `pwa-app.tsx` 删除 `historyItems`、`historyLoading`、`historyRestore`、`historyVisibleCountRef`；`openHistory` 改调统一接口；两种会话使用同一个 `MessageList`。
- `MessageList` 两种会话一律提前两屏加载；`earlierLocal` 只保留离线文案用途。
- DEV 状态展厅改用新组件。

### 4.4 阅读位置

- 两种会话统一为「跟随最新」或「屏幕顶部那一行」。
- 历史额外记住已展开的页数：恢复时先展开到那一页，再按行定位。
- 「那一行加载出来之前先停在底部」的机制两种会话共用。

## 5. 已确认的行为变化

2026-10-27 用户确认以下全部按建议执行。

| # | 变化 | 决定 |
| --- | --- | --- |
| D1 | 历史滚离底部时也显示「最新」按钮 | 采用 |
| D2 | 内容不足一屏时自动补页 | 两种会话都保留，补到能滚动或没有更早记录为止 |
| D3 | 历史向前展开也等滚动停下再前插 | 采用 |
| D4 | 历史阅读位置从 `scrollTop` 改为按行恢复 | 采用 |

## 6. 风险与对策

1. **从历史回到同一个在线 Pi**：现在只有切到不同 Pi 才重建时间线。统一后离开历史一律走「本地预览 + 重新握手」，补回归测试。
2. **只读模式泄漏实时状态**：排队面板、投递状态、运行中与压缩提示在只读模式下屏蔽，补测试。
3. **只读时误收实时帧**：运行时拒收全部实时帧，作为连接关闭之外的兜底。
4. **测试改写量大**：`history-workspace` 测试改写为针对统一组件；逐项核对 `pwa-app` 历史相关测试。
5. **文件行数**：`pwa-app.tsx` 已超 600 行，本轮只删除、不新增职责。

## 7. 分阶段实施

一个分支、一个 Pull Request，按阶段分提交。

| 阶段 | 内容 | 验证 |
| --- | --- | --- |
| P1 | 加载器只读模式与缺口策略、运行时只读模式 | Node 测试：只读不调用 `send`／`persist`、缺口照常出页、只读拒收实时帧 |
| P2 | 拆分 Hook，新增 `openHistory`，视口在两种会话下启用 | `use-live-timeline`／`use-timeline-viewport` 浏览器测试，新增历史路径用例 |
| P3 | `pwa-app` 与 `workspace-content` 接入，删除 `HistoryWorkspace`，统一阅读位置，迁移展厅 | 改写历史测试；`pwa-app` 历史相关测试；「历史 → 同一个在线 Pi」回归 |
| P4 | 同步 DESIGN、ARCHITECTURE、ROADMAP | `pnpm check:docs`、`git diff --check` |
| P5 | 类型检查、lint、构建、Node 全量、受影响浏览器测试；推送功能分支（覆盖 staging）并提交 PR | staging 真机：历史快速甩到顶、顶部下拉、历史与在线切换并恢复位置、离线阅读历史 |

## 8. 不在本轮范围

**历史经 Relay 补全**：Extension 只服务所在 Pi 进程的当前会话（`pi-extension/src/timeline/request_scope.ts`、`history.ts`）。补全需要：

- 新协议帧；
- Extension 读取非当前会话文件；
- 扩大浏览器可读取的会话范围。

这与 ADR-20260914「不引入远程 Host 历史索引」方向相邻，须先新建 ADR 再另立事项。本轮只预留第 4.1 节的缺口策略接口。

## 9. 实施记录

（实施过程中追加。）
