# 当前架构

## 系统边界与拓扑

Pi Reach 的当前交互链路只有浏览器 PWA、Relay 和用户当前打开且加载 Extension 的 Pi。Owner、device、endpoint、runtime 与 session 的定义见[背景与术语](CONTEXT.md#核心概念)。

```text
浏览器 PWA（/app）
        <-> WebSocket / TLS
Relay（实时 endpoint registry、ACL、路由）
        <-> WebSocket / TLS
当前打开的 Pi + Pi Reach Extension
```

PWA 不启动或唤醒 Pi；Relay 也不运行 Pi。Extension 在 Pi `session_start` 自动连接 Relay。没有 daemon、supervisor、Cron、独立 CLI 或后台 Pi 作为产品运行时。

| 子项目 | 职责 |
| --- | --- |
| [`packages/protocol/`](../packages/protocol/) | 私有 workspace 包 `@pi-reach/protocol`，提供跨端共享 outer 与 session 实现。 |
| [`pwa/`](../pwa/) | 浏览器入口，负责 pairing、0/1/N 活动 Pi 选择、会话输入、正式 timeline 持久化和只读历史展示。 |
| [`relay/`](../relay/) | WebSocket Relay，负责实时 endpoint 注册、ACL、订阅、短期 pairing-code target 与消息路由。 |
| [`pi-extension/`](../pi-extension/) | Pi Extension，负责设备身份、Owner pairing/ACL、当前 Pi endpoint 和 Protocol v2 会话。 |

产品路由均位于 `/app` 下：工作区为 `/app`，设置页为 `/app/settings`，由前端识别子路径，未识别的 `/app/*` 显示默认工作区并把地址改回 `/app`；根路径 `/` 在服务端重定向至 `/app`。React 应用由 Vite 构建为静态资源，生产容器使用 Nginx 托管，不承担账号或业务 API 后台职责。

## 工程与构建边界

PWA、Extension、Node Relay 与 `packages/protocol` 由根 pnpm workspace 统一安装，依赖 catalog、构建许可和安全 overrides 集中在根 `pnpm-workspace.yaml`，使用单一 `pnpm-lock.yaml`。端侧编译器基线通过命名 catalog 分别保留；Relay 使用 TypeScript、Node.js 与 `ws`，身份验证使用 Node 内置 Ed25519。

`packages/protocol` 是私有包 `@pi-reach/protocol`，只导出 `@pi-reach/protocol/outer` 和 `@pi-reach/protocol/session`。它输出 ESM `dist/*.js` 及对应 `.d.ts`，使用浏览器原生 API，唯一生产依赖为 Zod；不引入 Pi SDK、React、Node 的 crypto/fs 或网络客户端。

| 共享入口 | 边界 |
| --- | --- |
| `outer` | 认证、registry、control 与 route 类型，以及 PWA 原有 strict 校验与编解码。 |
| `session` | Protocol v2 的纯 schema、类型、codec 与常量。 |

PWA 将共享包作为 workspace dependency，保留的 `pi-reach/protocol` 与 `protocol-v2` 入口只作薄适配。Extension 将共享包作为 workspace devDependency；marker、Pi SDK 绑定与 session state 继续保留在本地。Extension 构建后由 `scripts/vendor-protocol.mjs` 将共享 `dist` 复制到 `dist/vendor/protocol`，并以 AST 重写 JavaScript 和声明文件中的模块引用。共享包不独立发布，安装 Extension 的用户不需要 workspace；`prepack` 先构建，`pnpm pack` 消除 catalog 与 workspace 引用。

Relay 把共享包作为生产依赖，复用 outer 类型与版本常量；服务端入站校验留在 Relay，保留 canonical 公钥、UUID hex 布局、nullable 字段归一与完整 u64/i64 整数 token。客户端 decoder 不承担服务端授权校验。Relay 本地 lossless JSON 编解码避免 JavaScript 对超安全整数静默舍入，`ct` 始终不透明，Node 特有实现不进入共享包。生产镜像用 pnpm 的自包含 deploy 产物，只在该命令中启用 workspace 注入，不改变本地开发依赖布局。

安装与根验证入口先编译共享包，端侧构建按依赖顺序消费生成的 ESM 与声明；开发、watch 和局部验证命令由 [README](../README.md#本地开发) 维护。

PWA 由 `index.html` 与 `src/main.tsx` 启动，继续复用原有 Provider、AppShell 和业务组件。Vite 输出 `pwa/dist/`，`@serwist/vite` 从 `src/app/sw.ts` 生成 `dist/sw.js`；预缓存将 HTML 映射到实际入口 `/app`，包含脚本、样式与应用图标等静态资源。现有注册组件仍手动注册 `/sw.js`，scope 为 `/app`。界面使用系统字体栈，不打包或下载网络字体；Mantine 外观脚本在应用 JS 执行前使用原存储键恢复主题。

生产容器以非 root Nginx 托管静态资源；开发与本地 E2E 分别使用 Vite dev 和 preview，共用路由插件并与 Nginx 保持 HTTP 契约一致。PWA、Relay 及 E2E Host、Owner 的 Docker 构建输入均包含 `packages/protocol` 源码，并经根 workspace 安装和构建。根开发 Node 工具链不改变 Extension 的 `engines` 或 Pi SDK peer 约束。命令见 [README](../README.md#本地开发)。

## Relay 运行边界

Relay 仅在内存中维护在线 registry、ACL、订阅与短期邀请；不保存业务消息或离线发送队列。WebSocket 入口为 `/`，`/health` 是 liveness。发送路径同时限制单连接和全局未完成写入，积压连接被关闭后立即失去路由资格；健康连接继续独立工作。连接数、待认证连接、原始 HTTP socket、帧大小、声明的 ACL/订阅数组及 metadata 都有明确预算。

认证、心跳和关闭有独立期限，SIGINT/SIGTERM 触发停止接入及有界清理。日志只记录结构化事件，stderr 背压时丢弃后续诊断事件，不积压 payload。限额真源为 [`relay/src/config.ts`](../relay/src/config.ts)，环境变量及异常处置见 [Relay README](../relay/README.md#resource-limits)。这些资源超限策略独立于正常协议行为的跨实现兼容验收。

## 身份与在线状态

```text
device_id
  └─ endpoint_id
       ├─ runtime_instance_id
       └─ session_id + leaf_id
```

- `device_id` 是一台电脑的持久身份。它与 Owner pairing/ACL 一起保留在 Host 本地。
- 每个普通 Pi 进程生成新的 `endpoint_id` 和 `runtime_instance_id`；同一进程内 Extension reload 保持身份。endpoint 不能按 cwd 固定。
- `session_id` 和 `leaf_id` 由 Pi `SessionManager` 决定；`session_id` 标识当前 Pi session，`leaf_id` 是当前 branch 不断推进的 tip，普通追加会更新 leaf。`/new` 更换 session，只有明确的 branch reset 才要求 PWA 替换当前分支投影；两者都不更换 endpoint/runtime。
- Endpoint 的 `metadata.name` 和配对回执的 `session_name` 来自当前 Pi 会话名称，未命名时使用 `Untitled session`。Extension 在会话启动、切换及 `session_info_changed` 时更新名称，经现有 Relay registry 同步到 PWA；重命名不改变 endpoint/runtime 或会话身份。
- Relay registry 是内存中的实时在线视图。endpoint 下线、Relay 重启或连接断开都不会删除 Host pairing/ACL，也不会保留为在线 inventory。
- 新 Extension 只上报 `metadata.kind = interactive`。Relay、Protocol v2 与 PWA decoder 在兼容窗口内仍可读取旧 `daemon` metadata，但它不代表现行可启动、可调度或稳定 endpoint。

## 状态与持久化所有权

| 拥有者 | 持久或内存 | 用途 |
| --- | --- | --- |
| 浏览器 `PwaDatabase` | IndexedDB 持久化 | Owner identity、device pairing、endpoint metadata、正式 timeline 和设置。 |
| 浏览器 `TimelineRuntime` | 页面内存 | pending、partial、当前实时 channel 与滚动状态。 |
| Host / Extension | 本机持久化 | device identity、Owner pairing/ACL、Relay 配置。 |
| Host 的 Pi session | Pi 本机状态 | 当前 session/branch 与正式历史的权威来源。 |
| Relay registry | 内存 | 实时 endpoint、ACL、Owner 订阅、连接与短期 pairing offer。 |

组件版本不写入 IndexedDB。PWA 版本来自当前 bundle 编译时使用的本包版本；Relay 版本由 `useRelayConnection` 持有，扩展版本由 `PwaApp` 持有，分别随当前连接和会话清理，不从配对记录恢复。版本上报契约见[Protocol v2](reference/protocol/protocol-v2.md#relay-control-frames)，展示规则见[设置页](DESIGN.md#设置页)。

浏览器数据库名为 `pi-reach`，定义由 [`db.ts`](../pwa/src/lib/pwa/db.ts) 维护。IndexedDB v11 使用 `events` 和 `sessions` 表；正式历史的稳定分区键为：

```text
device_id + endpoint_id + session_id
```

`leaf_id` 是当前 branch tip 元数据，不进入持久主键；`runtime_instance_id` 只用于实时 stale gate。`events` 以稳定 `event_id` 覆盖，冗余保存 `event_seq` 和是否可生成预览，并为稳定 session 下的序号、时间与预览来源建立复合索引。`sessions` 在同一事务中维护事件数、首末时间、预览及其来源事件；历史导航直接读取摘要。普通事件合入只查询相同 event ID、相同序号、首末事件和最新预览，不随 session 长度加载全部正文；权威 branch replacement 才完整替换当前 session 投影。

PWA 只保存已收到的正式事件；pending 和 partial 不写入正式事件表。下线不会删除正式 timeline，只有用户移除 pairing 或清除本地数据才删除关联数据。

endpoint metadata 可以落盘，但不是 presence。`use-endpoint-registry.ts` 持久化时移除 `online`，读取缓存时也不能把 metadata 当作在线证明。

## PWA 活动选择与历史

`PwaApp` 编排 Relay、endpoint snapshot、选中 endpoint、timeline 和 UI。主要模块包括：

| 模块 | 职责 |
| --- | --- |
| [`use-endpoint-registry.ts`](../pwa/src/lib/pwa/use-endpoint-registry.ts) | Relay snapshot、在线 endpoint 和非 presence metadata 持久化。 |
| [`use-active-endpoint-selection.ts`](../pwa/src/lib/pwa/use-active-endpoint-selection.ts) | 当前电脑、用户选择与 0/1/N endpoint 选择。 |
| [`use-device-pairing.ts`](../pwa/src/lib/pwa/use-device-pairing.ts) | 八位 pairing code 的解析、target 解析和配对写入。 |
| [`timeline-store.ts`](../pwa/src/lib/pwa/timeline-store.ts) | 正式 timeline scope 的持久化、会话名称保存、读取和历史摘要。 |
| [`use-history-session-names.ts`](../pwa/src/lib/pwa/use-history-session-names.ts) | 将已握手的活动会话与在线名称关联，顺序保存名称更新。 |
| [`workspace-view.tsx`](../pwa/src/components/pwa/workspace-view.tsx) | 电脑、活动 Pi 与本地历史导航。 |
| [`session-sheet.tsx`](../pwa/src/components/pwa/session-sheet.tsx) | 移动端导航 Drawer。 |

对当前选中电脑，PWA 在收到完整 Relay snapshot 后处理：

1. 0 个在线 Pi：显示“无 Pi 正在运行”，不尝试唤醒或新建进程。
2. 1 个在线 Pi：可以自动选择该 endpoint。
3. 多个在线 Pi：保留用户明确选择，不按 cwd 或名称猜测。

PWA 在会话握手就绪后，按 `deviceId + endpointId + sessionId` 将当前在线名称保存到 IndexedDB 的 `sessions` 表，活动会话重命名时同步更新。`leafId` 只更新该稳定 session 的当前 tip 元数据，不创建新的历史条目。历史标题优先读取该名称；旧记录缺少名称时回退到消息摘要，不使用 endpoint 当前名称推测其他历史会话的名称。名称保存不改变历史的最后活动时间或排序，删除配对及清除本地数据时同时删除名称。

打开本地历史时，PWA 清除实时 session channel，并按历史 scope 从 IndexedDB 读取正式事件。历史视图不发送输入、不建立远程 resume；`automaticSelectionPaused` 使实时 0/1/N 更新不能抢走正在阅读的历史。返回活动 endpoint 后，PWA 才建立新的 `session_hello`。

桌面采用可收起的左侧导航和会话主区；移动端使用单栏与左侧全高导航 Drawer。在线 Pi 和本地历史在当前电脑范围内上下排列，电脑选择／管理复用独立面板；移动端该面板从底部打开。具体尺寸、动态效果、组件和叠层规则由[DESIGN](DESIGN.md)维护。

## PWA 反馈状态所有权

反馈组件不拥有连接、表单或时间线的业务状态。`PwaApp` 按来源把反馈交给对应消费者，呈现和叠层规则见 [DESIGN](DESIGN.md#反馈呈现)。

| 状态来源 | 所有者与撤销边界 |
| --- | --- |
| 连接、重连和离线 | [`useRelayConnection`](../pwa/src/lib/pwa/use-relay-connection.ts) 另行持有 Relay 与网络本身的状态，`PwaApp` 持有包含会话握手的连接状态。打开实时会话时由后者驱动 Header 和 `PwaConnectionBanner`；未打开会话（没有在线 Pi、等待选择或等待快照）时由 Relay 状态驱动，没有可连接的 Pi 不视为连接故障。恢复后清除连接反馈。回到前台（含页面从缓存恢复）时若连接仍显示打开，重新订阅并等待 Relay 回包，限时内收不到任何 Relay 帧即视为已在后台失效，立即重连；没有已配对电脑时订阅没有回包，不做此确认。 |
| 一次性全局反馈（Toast） | 每个 PWA Shell 持有独立的 [`OperationNotificationController`](../pwa/src/lib/pwa/operation-notifications.ts)，由 `PwaToastProvider` 共享给工作区 `PwaApp` 与入口级 `ServiceWorkerRegister`，唯一通知展示组件随工作区根节点定位，在启动／故障态使用 Shell fallback；单独挂载组件时使用各自控制器。控制器管理单槽 Toast：操作失败不自动消失，匹配成功回执、手动关闭或对应会话/实例清理撤销；普通反馈（已复制、设置已保存、连接已恢复、配对成功）4 秒后自动关闭，悬停或聚焦暂停，错误期间排队。Service Worker 更新状态由注册组件持有，更新提示通过同一控制器显示持久可关闭的「刷新」操作 Toast，普通提示不会挤掉待处理更新，错误结束后更新可恢复；旧实例回调不能写入新实例。 |
| 设置页路由 | [`useSettingsRoute`](../pwa/src/lib/pwa/settings-route.ts) 以 history state 持有设置页记录及其来源（工作区或已展开的移动导航与滚动位置）；页内返回与浏览器后退统一由 `popstate` 恢复。工作区在设置页期间保持挂载（隐藏且 `inert`），会话、草稿与阅读位置不重建。 |
| 表单、确认、历史加载与消息投递 | 各领域组件及 timeline 状态继续持有错误与重试条件；`PwaStatusToast` 仍用于现有局部错误，不是全局操作通知的统一状态容器。 |
| 安装与浏览器能力 | [`ServiceWorkerRegister`](../pwa/src/components/pwa/service-worker-register.tsx) 保持 React 入口级挂载，持有浏览器事件；安装／能力 `Alert` 的 Portal 只在启动页与工作区间迁移展示位置，不重置注册生命周期。 |

## 会话数据流

1. 已配对 PWA 用 Owner identity 连接 Relay，并订阅自己的 device。
2. 用户选中一个当前 online endpoint 后，PWA 建立 session channel 并发送 `session_hello`。从另一个 Pi 切换过来时先撤下旧投影（未确认投递按原 scope 保留）；本地保存过该 Pi 的会话时，以末尾最多 30 条连续正式 event 作预览，预览没有 scope，不能发送。
3. 收到 `session_ready` 后，PWA 建立 scope：与预览是同一 session 时把预览当作已保留区间，只补缺口；否则撤下预览，异步读取本地正式 timeline，并请求当前 Pi 的 recent history。
4. 正式 event 与 history 按稳定 `event_id` 合流；不同事件不能占用同一 `event_seq`。普通追加更新当前 `leaf_id`，branch reset 的新投影在完整同步和持久化成功后原子替换旧投影；partial 和 pending 只保留内存。
5. PWA 发送文本、会话附件或受限 typed action；附件先上传原件，再通过文件 ID 提交消息。Extension 把用户文字与本地文件清单交给当前 Pi session。Relay 只转发，不提供离线队列。

事件字段、分组、错误码、尺寸限制和合流不变量见[会话协议](reference/protocol/protocol-v2.md)，本文不复制 wire schema。

## 会话附件

附件沿用既有 session route，不增加 HTTP 上传服务或 Relay 文件存储。浏览器只在用户发送时读取原 File、计算摘要并分片上传；具体限额、租约和回执见[会话协议](reference/protocol/protocol-v2.md#会话附件)。图片只生成有界展示预览，原件不转换；所有格式都以清单和路径提供给 Pi，不自动注入视觉 block、解析、解压或执行。

Extension 将新上传原件保存在 `~/.pi/pi-reach/attachments/YYYY-MM-DD/<附件唯一ID>/<安全原文件名>`。日期取接收电脑首次开始接收时的本地日期，跨午夜续传不换目录；每件附件使用服务端随机 ID 独立目录，同名不覆盖。正常文件名与扩展名保持原样，路径分隔符、危险名称和超长名称经安全处理，原始字节不变；历史附件不迁移。目录层级不承载会话授权，Owner、session 和上传租约仍由存储状态核验。目录和文件分别使用 `0700`、`0600`，独占创建并拒绝预置符号链接。发送前校验实际大小与 SHA-256；使用跨进程磁盘预留和有限的活上传资源保护写入。磁盘余量是尽力保护，不保证无关进程并发写入时绝不耗尽；ENOSPC 按受控错误失败。

可能已交给 Pi 的原件会保守 retain。已发送原件长期保留，不设历史累计配额、到期清理或淘汰旧文件；取消和租约失效只清理确定废弃的临时原件。能力、上传任务和消息幂等保护均有内存准入门禁；门禁耗尽时拒绝新请求，不删除历史原件或逐出仍有用的重试保护记录。

Pi 输入包含完整原文和 JSON 转义的文件清单、本地路径；PWA 的 started、queue 和历史展示使用原文与文件名，不展示这些路径。附件描述与预览、正式消息关联分别写入 Pi 原生 custom entries，不进入模型上下文。它们参与正式时间线序号、历史同步和 IndexedDB 持久化，只在展示层隐藏；PWA 通过它们补齐正式消息和队列卡片。

浏览器按实际电脑、endpoint、runtime、session 和 Owner 保存页面内草稿。File 不写入 IndexedDB，不保证刷新、浏览器迁移或 Pi 重启后续传；已保存的历史只包含描述和预览，不能从 PWA 下载原件。短断线可在同一上传租约内查询已收 offset 后恢复；真正切换目标或 branch 租约后不能转投旧附件。

## 会话文件发布与获取

`publish_file` 只发布 Pi 明确交付或用户要求的普通文件，不自动把读取、修改或临时文件变成成果。路径相对当前工作目录或使用绝对路径，允许项目外文件；Extension 安全解析后保存源文件引用，不复制原件、不建立文件数据库，也不把发布图片自动放入模型视觉上下文。它与上传附件是两个独立流程，不改变附件的保存策略或下载能力。工具仅在已持久化的原生会话中可用；当前安全打开支持 macOS 与 Linux，缺少等价保护的平台拒绝文件发布和获取。

Pi 原生 custom 是文件引用的唯一持久来源，原生成功 `toolResult` 是发布确认点。Extension 以当前分支及只读原生磁盘证明重建资格，不把 SDK 内存 append 成功当作落盘证明。SDK 写入失败可能留下内部记录；这些记录没有成功确认时不展示、不可获取，不修改 SDK 私有树或尝试伪造回滚。成功文件投影排在确认结果之后，实时显示不等待整轮结束；恢复时保留同一 ID、时间与分组。

在线 PWA 经既有 session route 向 Extension 获取原件，传输依赖 TLS 和既有身份认证，不提供应用层端到端加密。`ct` 是 Protocol v2 JSON 的 Base64；Relay 不解码、不记录、不持久化，运营方仍有能力读取内容。Extension 验证 Owner 和当前会话、分支权限后，用同一安全只读句柄连续读取；PWA 校验完整长度和摘要后才提供图片或保存。源文件是可变引用：新一次远程打开返回当前内容信息，删除、权限变化或读取中修改会受控失败，不承诺版本归档或原子快照；页面可以继续使用此前完整获取的缓存。协议和资源限额见[会话协议](reference/protocol/protocol-v2.md#会话文件发布与获取)。

PWA 的文件 controller 独立管理请求、取消、页面缓存和 Blob URL，UI 只借用完整结果；阅读器 pin 防止正在查看的内容被逐出。文件正文不进入 IndexedDB 或 Service Worker。历史保留发布 metadata，但只读历史不建立远程获取；短断线期间，当前页面已经完整获取的内容仍可查看和保存。重新打开或刷新页面须连接在线 Pi 并重新获取。

## PWA 缓存与离线边界

Serwist 在构建时生成 `dist/sw.js`，Service Worker scope 为 `/app`；`/app/*` 的导航请求在网络不可用时回退到预缓存的 `/app`。应用壳与静态资源可被缓存，但 Service Worker 不拥有 pairing、业务会话、WebSocket 或离线发送队列。

离线时，已经缓存的页面壳和 IndexedDB 中的正式历史可以读取；首次访问、未收到过的 Pi 历史、发送输入和后台持续连接均不保证。

## 相关真源

- [协议入口](reference/protocol/README.md)、[会话协议](reference/protocol/protocol-v2.md)与[配对协议](reference/protocol/pairing.md)：身份、wire 字段、配对和安全边界。
- [纯 Extension ADR](adr/20260914-pure-extension-runtime.md)：当前运行时决策和兼容退出条件。
- [当前设计规则](DESIGN.md)：视觉 token、布局、组件、Drawer 和历史只读规则。
- [协作规范](../AGENTS.md)：仓库操作规则。
