# 会话文件发布、查看与下载实施方案

本文保留会话文件发布、查看与下载的原始设计，并补充实施结束记录。截至 `416fe96`，`publish_file`、文件读取协议及正式 PWA 界面已实现，相关自动化、隔离真实链路与代码评审修复已完成，代码已提交并推送到 PR #31。此次归档结束的是本地实现任务，不表示 PR 已合并、产品已部署，或真机验收已通过；未覆盖项见[遗留风险与发布边界](#103-遗留风险与发布边界)。项目级事项状态只由 [ROADMAP](../../ROADMAP.md) 维护。

第 1–8 节是基于 `c192257` 的实施前设计快照，保留当时的建议名称、复用点和验收要求，不代表功能仍待实现，也不是现行接口的真源。第 9 节记录方案阶段的[独立效果稿](../../prototypes/20261003-session-file-publishing/page.html)及其验证范围；原型状态仍为「评审中」，本次归档不修改原型或把模拟按钮当作真实传输。实际实施结果与验证证据见[实施结束记录](#10-实施结束记录)。当前架构、协议和设计分别以 [ARCHITECTURE](../../ARCHITECTURE.md#会话文件发布与获取)、[会话协议](../../reference/protocol/protocol-v2.md#会话文件发布与获取)及[设计规范](../../DESIGN.md#组件规则)为准。

## 1. 目标与边界

用户在 PWA 与 Pi 交互时，能看到 Pi 明确交付的图片，并查看或下载电脑上的其他成果文件。保留现有链路：

```text
Pi 发布电脑文件引用 → 原生会话保存引用 → PWA 展示
PWA 获取文件 → Relay 转发请求 → 在线 Extension 读取 → Relay 转发分片 → PWA 预览或保存
```

发布的是源文件引用，不是副本或历史版本。路径可以在项目外，只要 Pi 进程有权读取且目标为普通文件。PWA 不能自行提交任意路径读取电脑。

不做目录浏览、正文路径自动识别、文件版本管理、快照仓库、独立记录数据库、文件变化监听、后台下载任务、自动断点续传、HTTP 文件服务、常驻进程或 Relay 文件存储。不为已有上传附件自动增加下载入口，不改其既有卡片和保留策略。不把发布的图片自动注入模型视觉上下文。

## 2. 已确认的产品决策

| 决策 | 实施约束 |
| --- | --- |
| 发布范围 | Pi 可读取的任意普通文件，不限当前项目；获取只能指向真实发布记录。 |
| 发布时机 | Agent 交付报告、效果图等面向用户的成果时可主动发布；不自动发布所有读取、修改、临时或调试文件。其他文件可按用户要求发布。 |
| 接收者 | 沿用会话访问权限，所有有权访问该会话的已配对 PWA 都能获取，不另设文件收件人。 |
| 保存与恢复 | 引用随 Pi 原生会话保存。恢复原会话后可再次获取；不另建文件数据库、定期检查或维护源文件。 |
| 原件上限 | 单文件最多 **50 MiB**，`MiB = 1024 × 1024` 字节；每次实际获取也检查，不只相信发布时的大小。 |
| 图片获取 | 受支持图片 **≤10 MiB** 时，在当前查看区域附近自动获取；10–50 MiB 手动点击，超上限不传输。 |
| 其他文件 | 手动点击。文本可只读查看并下载；PDF、Office、压缩包等首版只下载。 |
| 图片查看 | 对话内直接展示，点击进入单张查看，支持缩放、移动、关闭和下载；不做图集或编辑。 |
| 中断 | 未完成传输停止并释放临时数据，手动从头重试；自动加载失败后也不循环重试。已完整获取的内容不因短暂断网消失。 |
| 切换目标 | 有未完成传输时，切换电脑、Pi、会话或本地历史前先确认；留下则继续，确认后取消再切换。设置页、大图查看不算切换。 |
| 文本阅读 | Markdown 排版阅读，其他文本显示原文；限制预览长度，完整原件可下载。不执行 HTML、SVG、脚本，不自动获取文档引用的远程图片或本地文件。 |
| PWA 展示 | 图片直接嵌入对话，其他文件用文件名、大小和操作组成的轻量文件行。发布记录可见后展示，不等整轮结束，不藏在工具折叠内容里，不重复一份工具图片。 |
| CLI 展示 | 使用原生工具调用和简短文本结果，不新增面板、文件卡片或图片预览；PWA 后续取文件不再产生模型工具调用，不在 CLI 输出逐片进度。 |

CLI 示例中工具名暂用 `publish_file`：

```text
publish_file
  path: /workspace/pi-reach/output/效果图.png

已发布文件引用：效果图.png · PNG · 860 KiB
```

“已发布”仅表示引用已保存、可以按权限获取，不表示某个 PWA 已收到原件。工具失败应明确返回失败，不写成功发布记录。发布成功不要求此刻有 PWA 在线。

## 3. 实施前的实现与复用点

| 当前证据 | 对本功能的意义 |
| --- | --- |
| `pi-extension/src/timeline/runtime.ts` 的 `appendDeferredCustom()`、`toSystemEvent()` | 原生 custom entry 已能进入有序实时事件和历史恢复，可承载发布引用，不建第二套历史。 |
| `pi-extension/src/timeline/tool_lifecycle.ts` 的 `toolTimelineEvent()` | 当前正式 tool event 投影的是 `message.content`，不是任意 tool-result `details`。不能只把文件描述放进 details 就认为 PWA 会收到。 |
| `pi-extension/src/timeline/publication.ts` | 正式事件须先可恢复，再按既有序号发布；不能绕开此链路直接伪造一条广播。 |
| `pi-extension/src/index.ts` 的 `session_start`、`session_tree`、`session_shutdown` | 复用真实 SessionManager 和运行时切换边界，不按 cwd 猜测另一个进程是原 Pi。 |
| `pi-extension/src/runtime/owner_router.ts`、`create_owner_binding.ts` | Owner 来自 Relay 注入的 `source_owner_id`，已有 pairing、route identity 和每 Owner 服务边界。 |
| `pi-extension/src/timeline/v2_service.ts` 的 `validateRequest()` | 可复用 channel/session 门禁；普通 leaf 追加不能被误作分支切换取消文件读取。 |
| `packages/protocol/src/session/{schema,frames,codec}.ts` | strict schema、方向类型表及 codec 必须一起闭合；不能只添加 TypeScript 类型。 |
| `pwa/src/components/pwa/message-list.tsx` | 当前 custom 默认隐藏；应仅投影本功能的合法 custom 记录，而不是开放所有未知 custom。 |
| `pwa/src/components/pwa/timeline-content.tsx`、`tool-output.tsx` | 已有 Markdown 与工具图片展示，但文件预览必须使用更受限的资源策略，不能直接继承普通 Markdown 的外部资源行为。 |
| `pwa/src/components/pwa/pwa-app.tsx`、`pwa-confirm-actions.ts` | 复用连接清理、真实目标切换与确认层；不能在普通 render、设置页切换或 leaf 推进时重置任务。 |

Pi 提供的原生工具 `content` 用于模型可读结果，`details` 可保存结构化数据；没有 entry renderer 的原生 custom entry 不额外显示在 CLI。本功能采用下面的单一记录来源，不同时在 details、数据库和 custom 中维护三份完整发布元数据。

## 4. 推荐的发布记录设计

### 4.1 一个轻量发布工具

建议注册 `publish_file({ path })`，首版一次发布一个文件，多文件可调用多次。不解析聊天正文，不拦截每次 write/bash 自动发布。工具说明明确“仅发布面向用户交付的文件，图片可能被授权 PWA 自动获取”。这不是审批或防止 Agent 误发敏感内容的沙箱。

执行顺序：

1. 取得工具上下文对应的当前 SessionManager，捕获 session 与当前分支上下文；相对路径以 Pi 工作目录解析，拒绝空路径、NUL 和无效输入。
2. 解析源路径，检查可读普通文件、大小和有界文件头。目录、设备、socket、FIFO 等都拒绝；不执行文件、不修改权限、不移动源文件。
3. 通过既有 `appendDeferredCustom()` 追加一次正式发布记录。追加前复核上下文未切换；先完成可能失败的文件检查，再做这次提交。
4. 返回简短成功文本。tool result 的 details 如需包含关联信息，只保留发布 entry ID，不再复制完整记录。不得在追加成功后等待浏览器下载或因其离线改报发布失败。

### 4.2 单一权威记录

建议 custom type 为 `pi-reach:published-file-v1`，原生 entry ID 同时作为 `publication_id`。它不是新的协议版本，也不是另建 UUID 注册表。

```text
原生 custom entry
  id                         → publication_id / 正式 event_id
  customType                 → pi-reach:published-file-v1
  data.source_path           → 发布时解析的电脑规范绝对路径
  data.file_name              → 显示/保存用文件名
  data.mime_type              → 发布时识别的类型
  data.byte_length           → 发布时大小
  data.tool_call_id           → 本次发布工具调用，用于防止重复展示
```

记录留在已有会话文件中，遵循原生 branch；不存原件、hash 版本档案或外部数据库。`source_path` 是读取依据，类型和大小只是发布时信息，每次读取重新核验。

**建议本发布记录的 wire 投影只发送 entry ID、文件名、类型、大小和 tool call 关联，文件行不展示绝对路径。** 原生记录中的路径仍是唯一真源；客户端拿发布 ID 请求，服务器从当前 branch 的原生记录找路径。实现投影时在 `toSystemEvent()` 的本 custom 分支中处理，实时、历史使用同一投影，不能因隐藏本地字段跳过正式 `event_seq`。既有工具参数和用户正文仍可能包含路径，本方案不承诺全会话路径脱敏；新文件错误响应不得带入底层路径或异常正文。

本方案不依赖原生 tool result `details` 穿透现有协议。custom 发布记录是唯一可渲染对象；工具行可以保留状态，但对本工具成功结果不再生成第二个文件入口。异常工具记录照常显示错误。

### 4.3 恢复与重复发布

- Pi 重新打开同一原生会话后，从其当前 branch 读取记录即可。可以复用已有分支投影作内存索引，但索引不是新真源，也不定期访问磁盘文件。
- PWA 必须先连接这个实际在线 endpoint、完成原会话握手和历史同步。旧 endpoint 的本地历史不会自动绑定到同 cwd 的新进程；不按文件名、目录或时间猜测目标。
- 只读本地历史可展示文件名称；没有匹配的在线会话不能新取原件。刷新后也不承诺原件离线可用。
- branch 切换后，不在当前 branch 中的发布记录不再可取；普通消息追加不使祖先中的发布记录失效。
- 同一路径再次发布是另一个发布事件，不按路径合并或覆盖旧消息；实时/历史重放则按原 event ID 去重。
- 源文件内容变更后，再次获取读取当前位置上的当前内容；已经加载到页面的内容不自动刷新。删除或移动后返回文件不可用，不扫描电脑寻找替代文件。

## 5. 文件读取协议与资源生命周期

以下名称和参数是**原始方案的推荐实现契约**，保留为实施前设计记录；现行接口以[会话协议](../../reference/protocol/protocol-v2.md#会话文件发布与获取)为准。设计目标是单条简单按需读取链路，预览与下载共用，不复制完整上传状态机。

### 5.1 建议帧

Client 请求共同携带 `protocol_version: 2`、`id`、`channel_id`、`session_id`。外层 route 继续绑定 device/endpoint/runtime，Owner 只从 Relay 来源取；Server 定向响应携带 `target_channel_id`、`in_reply_to`、`session_id`。不在稳定 `session_hello/session_ready`、user blocks、queue item 或 TimelineEvent 外层新增字段。

| 方向与帧 | 业务字段 | 行为 |
| --- | --- | --- |
| C→S `file_open` | `publication_id` | 核验当前 branch 中发布记录，打开文件，取得当前类型、大小；仅返回元信息，不立即推送全文件。 |
| S→C `file_opened` | `publication_id, transfer_id, file_name, mime_type, byte_length, preview` | 对应这次读取，不代表磁盘快照。`preview` 为 strict 判别联合：`{kind:"image", width, height}`、`{kind:"text"}` 或 `{kind:"none"}`。服务器从当前文件头鉴别，仅当图片格式与像素预算均通过时返回 image；否则仍可下载但不能自动预览。PWA 再结合当前字节数决定自动加载。 |
| C→S `file_read` | `transfer_id, offset` | 按服务器期望的连续位置拉取下一片；不接受路径或任意范围读取。 |
| S→C `file_chunk` | `transfer_id, offset, data_base64, final`；末片带 `total_bytes, sha256` | 最后核验完整字节数和本次传输摘要。空文件以合法空末片完成，不套用禁止空数据的上传分片 schema。 |
| C→S `file_close` | `transfer_id` | 用户取消、切换目标或结束时释放资源；不是删除源文件。 |
| S→C `file_closed` | `transfer_id` | 对匹配请求返回释放结果；重复关闭须安全，不借此关闭其他 Owner 的读取。 |
| S→C `file_error` | 请求关联、可选 `transfer_id`、固定 `code` | 局部失败，不携带系统错误正文、私密路径或文件内容。 |

建议固定错误类别：`not_available`（缺失记录/文件）、`permission_denied`、`not_regular_file`、`too_large`、`file_changed`、`invalid_transfer`、`offset_mismatch`、`busy`、`io_error`。请求与响应必须 strict 校验且闭合方向集合，不能将新帧塞进未定义的 generic action payload。

普通 leaf 更新不应中断读取，因此读取帧不携带会随追加变化的精确 leaf 条件。每次请求仍检查 channel/session、真实 branch 中的发布资格及传输绑定；显式 branch reset 时清除旧传输。只认本 channel/Owner 的 `transfer_id`，同一 Owner 的多个标签也不能互相结算请求。

### 5.2 最小传输状态机

```text
引用可用 → 获取元信息 → 等待手动确认或连续拉片 → 完整校验 → 就绪
                         └→ 失败 / 取消 → 释放 → 手动从头重试
```

推荐首版用 **64 KiB 原始字节分片、每个读取任务最多一片在途**。收到前一片才请求下一片，避免额外 ACK/重传协议。每个请求设置有界超时；超时进入手动重试，不无限等待、不自动重发。活读取期间，同一 `file_open.id` 重复到达复用已绑定的句柄，不重复分配；完成后不为下载建立长期幂等日志。可复用 Base64、摘要和严格响应关联的已有实现；不复用上传的磁盘预留、retain、discard、租约恢复或成功墓碑逻辑。

实施初始资源建议：每个 PWA 同时一个原件传输，Extension 最多八个活读取句柄，空闲句柄 30 秒释放。所有上限都在分配前检查；同页面可见的其他自动图片等待前一件完成，不构成跨页面后台队列。这些是工程起点，不是额外用户需求；修改时须附对应慢网、并发和内存验证。

- 句柄绑定 Owner/channel/runtime/session/branch generation/publication。channel 关闭、Owner 撤销、Relay 断线、session/branch 切换、reload/shutdown 时释放；取消要能打断正在等待的读取。
- 每片读取前后核验取消信号与来源仍有效，限制实际读取字节；结束、失败、取消都关闭句柄。关闭失败不得谎报资源已释放；超时兜底不替代正常清理。
- 打开时及读取结束时比较同一句柄的文件属性，检测到源文件变化则失败，不把新旧内容拼成一次成功。hash 只证明本次传输字节完整，**不承诺无副本条件下对任意并发写入提供原子快照**。
- 已打开文件若被路径替换，不能中途重新按路径打开另一份文件继续。重新获取是新的读取，重新核验路径和权限。
- PWA 收齐并校验前不展示半张图片或触发成功下载。释放已消费 Base64 和中间缓冲；Blob URL 由共享获取结果拥有，内联图片与查看器共用，最后消费者释放时回收。
- 页面只缓存当前查看需要的完整原件；有界淘汰离屏、未被查看器使用的内容，但短断线不无条件清空已显示内容。不写 IndexedDB 或 Service Worker 原件缓存。50 MiB 加解码与 Blob 可能有多份短时内存，须实测手机峰值，不能把文件上限等同于内存上限。

### 5.3 路径与内容安全

发布时将相对路径解析为规范绝对路径。允许普通路径通过现有系统符号链接解析到真实普通文件，但记录的是解析后的目标；取文件时不跟随后来替换的链接去读另一位置。建议采用规范路径复核、拒绝最终 symlink 的只读打开、打开后 `fstat` 对比及非普通文件拒绝；不能把仅一次 `exists/stat` 当完整安全保证。

打开阶段也要防止检查后文件被替换为 FIFO 而永久阻塞。在支持的平台使用 `O_RDONLY | O_NOFOLLOW | O_NONBLOCK` 打开后立即核验普通文件，再开始读取；`O_NOFOLLOW` 本身不能阻止 FIFO 阻塞。其他平台必须先验证等价的有界打开方案，没有安全保证时明确将文件读取标为不可用，不以 `Promise.race` 超时冒充底层操作已取消。发布检查与正式获取都覆盖这个竞态；不调用上传目录创建/权限修改函数，也不改变源文件权限。

类型先作有界内容识别，不能只看后缀或模型给定的 MIME。自动图片首版建议限定 PNG/JPEG/WebP/GIF，SVG 只作源码或下载。建议用文件头的尺寸预算限制解码（起点 20 百万像素）；无法可靠识别或超预算时保留下载，不强制解码。文本按有界 UTF-8 识别，二进制或不支持编码转为下载，不把任意字节硬解成 Markdown。

访问权限不依赖随机 ID 的不可猜测性。客户端提交 publication ID 后，由服务器查真实当前 branch 的记录并核验 Owner，不信浏览器自报路径、大小、MIME 或发布资格。前后端都不能因为路径曾出现在正文或工具参数里就视为已发布。

沿用[现有信任模型](../../adr/20260518-closed-decisions.md)：链路有 TLS 和身份认证，但没有应用层端到端加密；Relay 运营方具备看到内容的能力。已授权 PWA 可按指令操作 Pi，本功能不是 Agent 误发布文件的防护沙箱，也不新增工具审批。敏感文件不能因有“发布”动作就视为可安全公开。

## 6. PWA 呈现与交互

### 6.1 会话中的发布内容

仅识别本功能合法 custom payload，按正式事件顺序渲染；继续隐藏其他未知 custom。发布事件是可见内容边界，不能被相邻成功工具摘要收进去。用 `tool_call_id` 只抑制本发布工具的重复文件展示，不影响原有 read 等工具直接返回的图片。

图片元信息可见后，在可视区域附近尝试打开；只有当前 `file_opened.preview.kind === "image"` 且大小不超过 10 MiB 才自动拉片。较大但可预览的图片显示手动获取；`preview.kind === "none"` 仅下载，不能因为旧发布元数据仍是图片就强行解码。类型变成文本时改为手动查看。自动请求失败后锁定为待重试，不因重渲染或滚动循环请求。

其他文件行展示文件名、发布时大小及「查看／下载」。读取后以当前真实大小更新该次展示，不改写历史发布记录。默认不展示完整电脑路径、请求 ID、底层异常或协议 JSON。

### 6.2 图片与文本阅读器

- 图片：复用已获取结果，单张查看器有缩小、放大、还原、下载、关闭；支持触摸缩放和拖动，不新增图库。未获取的大图先展示明确获取操作。
- 文本：推荐桌面复用工具阅读器的右侧 720px 模式，移动端全屏；是独立的文件阅读内容，不套用工具命令标题或行号到 Markdown 正文。
- Markdown 使用受限配置：禁 raw HTML、远程/本地图片自动加载、iframe 和脚本；普通 HTTP(S) 文字链接仅用户点击后在新页打开，拦截其他危险 scheme。代码、JSON、HTML、SVG 等显示转义原文，不进入同源可执行预览。
- 文本预览建议最多 1 MiB 文本，并限制 DOM/高亮工作量；明确“仅显示部分内容”，原件下载不截断。首版可以共用完整有界获取，不另开范围预览协议；UTF-8 截断不能破坏尾部码点。
- 遵循既有 Portal、单层遮罩、焦点回归、Escape 和系统返回规则；打开查看器不切断连接，不弹出输入键盘。关闭后回到来源文件及阅读位置。

### 6.3 下载与目标切换

点击「下载」先获取原件，完成后通过浏览器 Blob 下载或可用的系统文件分享/保存能力交给用户。移动浏览器若需要新的用户手势，显示「保存文件」让用户点击；不自动反复触发下载。可表达“文件已就绪／已交给浏览器”，不能声称已保存到某个系统目录。文件名保持合法原名并作必要保存名净化。

下载/预览进行中，切换真实目标通过现有确认机制处理。若同样存在附件上传，不堆叠两次确认：使用一次说明受影响上传与获取的确认，成功确认后各自取消，再提交目标切换。用户选择留下则不能先行清理 channel 或部分任务。删除非当前配对、重选同一目标、设置页及查看器不算切换；远端强制切 session、退出或撤权不等待本地确认，立即终止旧任务。

### 6.4 状态文案起点

| 状态 | 展示与操作 |
| --- | --- |
| 小图片待加载 | 保留图片区域，显示「正在获取图片…」。 |
| 大图片待操作 | 文件名、大小、「图片较大，点击获取」及获取按钮。 |
| 获取中 | 文件局部进度与取消，不把进度广播进聊天或 CLI。 |
| 就绪 | 展示图片/文本或保存入口；不继续显示下载进度条。 |
| 断线/读取失败 | 原位置短原因＋「重试」；不会自动续传。 |
| 文件不存在 | 「电脑上的文件已不存在或无法读取」，保留文件名。 |
| 超过上限 | 「文件超过 50 MiB，暂不支持获取」，不传原件。 |
| 离线历史 | 保留名称与大小，说明「连接并打开原会话后可获取」，不冒充在线。 |
| 切换确认 | 「切换将取消尚未完成的文件获取」＋「留下」「取消获取并切换」。 |

## 7. 修改范围与实施顺序

文件名为建议分工，不要求机械创建所有模块；保持现有源码大小约束。共享协议和生命周期由主实现负责人统一管理，不并行改同一契约。

| 步骤 | 主要范围 | 可验收结果 |
| --- | --- | --- |
| 1. 冻结共享契约 | `packages/protocol/src/session/` 新增发布描述/文件帧 schema；同步 `schema.ts` 类型表、`frames.ts` union、`index.ts` exports 和直接 fixtures | 严格方向、未知字段、空文件、分片/大小/类型边界测试通过；旧稳定握手 shape 不变。 |
| 2. 发布与原生恢复 | Extension 建议 `src/files/publish.ts`；`index.ts` 注册工具；`timeline/runtime.ts` 定点 custom 投影 | 真正 SessionManager 可保存/恢复，CLI 简短，PWA 元信息按同一正式事件序列出现；不中断进行中的 Agent。 |
| 3. 受限文件读取 | 建议 `src/files/reader.ts`、`runtime/file_binding.ts`；接入 Owner 服务、路由与清理 | 只读已发布普通文件，分片完整；撤权、取消、源文件变化和句柄失败路径有测试。 |
| 4. 客户端运行态 | 建议 `pwa/src/lib/pwa/file-transfer.ts`、`use-published-files.ts`；`pwa-app.tsx` 分发与 scope 门禁 | 按请求匹配、无自动续传，切换确认及旧回执隔离正确，不改连接状态所有者。 |
| 5. UI 投影与阅读器 | `message-list.tsx`、`conversation-timeline.tsx`、新发布文件行/图片/阅读器组件、双语词条 | 不重复/不折叠发布内容，图片按门槛加载，安全文本阅读与移动操作可用。 |
| 6. 整合与发布准备 | 文档真源、包验证、SDK 加载、真实双 Owner 链路与浏览器 smoke | 获取前后 hash 一致，恢复原会话可取；独立审查收口后再按授权提交和发布。 |

直接测试消费者至少包括共享 `contract.test.ts`、PWA `protocol-v2.node.test.ts`/fixtures、Extension `runtime` 与 `timeline` 测试、PWA frame handler/连接生命周期/确认对话框/会话浏览器测试，以及 `pwa/e2e/real/pi-reach-live.spec.ts`。Relay 不解码 `ct`、帧上限不变，因此不新增 Relay 业务处理或升级其职责。

## 8. 验证清单与发布边界

### 自动化必须覆盖

- 发布：普通/空/中文和空格文件名、相对路径、项目外文件、目录/特殊文件/权限拒绝、超限、规范路径及 symlink/FIFO 竞态替换（打开不能阻塞）；失败无成功记录，成功不依赖 PWA 在线。
- 原生会话：真实 SessionManager 保存后重开、当前 branch 与兄弟 branch 隔离、压缩后仍可恢复、普通 leaf 追加不失效；先持久化后发布，实时/历史序号连续且不重复。
- 身份：Owner A/B 都有会话权限时可取；未配对/撤权拒绝；伪造 publication ID、浏览器自报路径、错误 channel/runtime/session、其他 channel 的 transfer ID 拒绝。
- 原件：0 字节、分片边界、50 MiB 边界、offset/重复/乱序/迟到片、取消/超时/断线/关闭失败、读取中源文件变化；实际句柄资源释放与原文件无改动，不只验证 spy。
- 自动图片：10 MiB 边界、发布后文件变大或换类型、解码失败/像素超限、可见区加载去重、失败不循环请求、关闭查看器不会提前回收仍在使用的 URL。
- 阅读安全：Markdown 排版、UTF-8/超长内容截断、二进制不误判文本、HTML/SVG/脚本不执行、外部图片与本地链接不自动读取、危险 URL 拒绝。
- 生命周期：设置/查看器不中断；真实目标切换留下/确认两条分支；上传与获取共存只弹一次；强制退出及时清理；已完成内容短断线保留，刷新不假装缓存原件。
- 展示：发布在本轮运行中可见，工具摘要不隐藏/复制图片；桌面/手机长文件名、焦点、滚动、Escape/返回、明暗主题及大图控件。

### 命令与真实链路

原始验收要求为：共享源码变更后，局部检查前先执行 `pnpm --filter @pi-reach/protocol build`；实施时执行受影响测试，再运行根 `pnpm typecheck`、`pnpm lint`、`pnpm test`、`pnpm build` 和 `git diff --check`。这是方案阶段制定的要求，实际实施阶段的验证及各次增量修复覆盖见[实施验证](#102-实施验证)，不以效果稿检查代替业务验证。

真实链路沿用项目隔离 Relay/Pi 双 Owner 环境，验证：由真实 Pi 发布文件、浏览器取回 hash/原名、两端权限、Pi 恢复原会话、会话切换取消和原件不被删除。至少手工验收 iOS Safari/已安装 PWA、Android 浏览器的图片缩放、系统返回和保存到文件；桌面移动 viewport 不替代真机结论。

发布仍先 PWA、后 Extension，Relay 无业务变更。新帧只在文件操作时使用，不主动广播原件帧；不增加 v1 fallback、旧正文路径迁移、旧上传原件下载适配或双读双写。不支持/超时只使本功能不可用并提示升级/刷新，不降级成 Base64 聊天或临时 HTTP。实施需检查旧缓存 PWA 对合法 custom 元信息和未知定向帧的实际行为，不能仅凭发布顺序声称无影响。提交、push、部署、npm 发布及本机更新仍分别授权。

## 9. 效果稿与评审（方案阶段记录）

[打开效果稿](../../prototypes/20261003-session-file-publishing/page.html)。原生 HTML/CSS 与少量场景切换脚本仅用于视觉评审，不接真实文件或 Relay，不实现发布与下载。

已制作会话主视图（图片＋文件行）、单张大图、Markdown 阅读、获取中、失败/缺失/超限、切换确认、大图待获取和离线历史。桌面与移动均沿用当前设计的阅读列、导航、字号和触控目标；主视图补深色。新增文件呈现属于本功能的拟议增量，不修改现有上传附件“无原件下载/无大图”的规则。CLI 仅使用本文的原生文本示意。

入口顶部的评审工具条可切换静态场景与浅深外观；它不属于产品界面。也可用 `?scene=chat|image|markdown|loading|errors|confirm|large|offline&theme=light|dark` 选择单一值直接打开画面。

| 画面 | 桌面 | 手机 |
| --- | --- | --- |
| 会话主视图 | [浅色](../../prototypes/20261003-session-file-publishing/screenshots/desktop-chat-light.png) · [深色](../../prototypes/20261003-session-file-publishing/screenshots/desktop-chat-dark.png) | [浅色](../../prototypes/20261003-session-file-publishing/screenshots/mobile-chat-light.png) · [深色](../../prototypes/20261003-session-file-publishing/screenshots/mobile-chat-dark.png) |
| 单张大图 | [查看](../../prototypes/20261003-session-file-publishing/screenshots/desktop-image-light.png) | [查看](../../prototypes/20261003-session-file-publishing/screenshots/mobile-image-light.png) |
| Markdown 阅读 | [查看](../../prototypes/20261003-session-file-publishing/screenshots/desktop-markdown-light.png) | [查看](../../prototypes/20261003-session-file-publishing/screenshots/mobile-markdown-light.png) |
| 获取中 | [查看](../../prototypes/20261003-session-file-publishing/screenshots/desktop-loading-light.png) | [查看](../../prototypes/20261003-session-file-publishing/screenshots/mobile-loading-light.png) |
| 失败、缺失与超限 | [查看](../../prototypes/20261003-session-file-publishing/screenshots/desktop-errors-light.png) | [查看](../../prototypes/20261003-session-file-publishing/screenshots/mobile-errors-light.png) |
| 切换确认 | [查看](../../prototypes/20261003-session-file-publishing/screenshots/desktop-confirm-light.png) | [查看](../../prototypes/20261003-session-file-publishing/screenshots/mobile-confirm-light.png) |
| 大图待获取 | [查看](../../prototypes/20261003-session-file-publishing/screenshots/desktop-large-light.png) | [查看](../../prototypes/20261003-session-file-publishing/screenshots/mobile-large-light.png) |
| 离线历史 | [查看](../../prototypes/20261003-session-file-publishing/screenshots/desktop-offline-light.png) | [查看](../../prototypes/20261003-session-file-publishing/screenshots/mobile-offline-light.png) |

原型内固定名称、大小、进度和文档内容都是模拟材料；`assets/sample-image.html` 是示例图源，PNG 由本地浏览器截图生成，不是真实发布的文件。缩放、下载、消息发送等产品按钮只表达视觉意图；只实现评审栏的场景/主题切换，阻止模拟输入区提交。完整手势、Portal 生命周期、真实下载与手机能力留给正式实现验证。

### 方案阶段验证覆盖

- 实施方案经独立只读审查：修正打开前 FIFO 替换可阻塞的问题，以及 `file_opened` 缺少当前图片预览资格的协议缺口；复核后无 P0–P3 finding。审查证明方案内部与源码接入点一致，不证明功能已实现。
- 使用项目已有 Playwright/Chromium 对八个场景执行桌面 1440×1000、手机 390×844 检查，并补主视图深色、320×740 窄屏，共 23 组、导出 18 张截图。检查可见内容溢出、44px 操作区、图像加载、内部滚动、页面错误及外部请求。桌面截图裁剪产品区，不包含评审栏。
- 可滚动阅读区、具备完整 title 的文件名省略及 1px 读屏标签为刻意布局，不作为可见文本溢出；未通过缩小字体或隐藏正文规避检查。
- 当前效果稿只覆盖中文静态画面。双语、真实触摸缩放/软键盘/安全区、下载保存、连接与协议、图片解码资源峰值、真实 iOS/Android、辅助技术及叠层焦点生命周期均未作功能验收。

原型状态仍为「评审中」，本次方案归档不变更原型评审状态。以上截图和文档审查仅证明方案阶段的覆盖，正式实现的结束范围如下。

## 10. 实施结束记录

### 10.1 实际交付与方案差异

本地实现及后续三项代码评审修复已完成。下表按提交记录实施范围，不替代当前架构、协议或项目级状态来源。

| 提交 | 实施结果与证据入口 |
| --- | --- |
| `57c6b47` | 实现原生文件引用发布、严格文件帧、Extension 受限读取与 PWA 文件行、图片和安全文本阅读器；接通真实会话入口、上传与获取的一次切换确认，以及完整原件保存。主要入口为 `pi-extension/src/files/`、`packages/protocol/src/session/files.ts`、`pwa/src/lib/pwa/file-transfer.ts` 和 `pwa/src/components/pwa/published-file-reader.tsx`。 |
| `2e46bc0` | 修复读取热路径反复重建发布索引的问题。每个 `file_read` 在入口与成功出口核验完整发布资格，底层 I/O 前后保留轻量 scope/取消、路径与同句柄检查；资格在读取或末片关闭等待中撤销时仍不能返回成功。 |
| `c87e3af` | 补足动画图片资源门禁：PNG/WebP 采用有界同句柄结构检查，GIF 在有界完整头内证明静态；动画或无法安全确认的图片只下载，不自动获取或进入图片阅读器。原件下载保持不变。 |
| `416fe96` | 修复真实 Pi 切换或会话重置后旧阅读器残留。controller 的缓存所有权身份经动态门面传播，失配时卸载旧 Drawer 并释放 pin、阅读锁、遮罩、滚动锁和返回监听；迟到关闭/退出回调不能影响新阅读器。短断线、普通 leaf/channel 更新与同目标不误关闭。 |

发布提交并非原始方案中“一次 append 成功即算发布”的简单事务。实际 SDK 可能先改内存再写盘，失败后也可能留下孤立 custom。实施采用当前分支的原生 custom 与后续成功 `publish_file` toolResult 均已落盘的双证明；未经确认的孤立记录可留在本机，但不展示、不可获取，不通过修改 SDK 私有状态伪造回滚。该差异已同步到[当前架构](../../ARCHITECTURE.md#会话文件发布与获取)。

发布工具的对外正式参数、实时 partial 和恢复投影均已脱敏，不仅是 custom 文件描述；本机原生参数与其他工具行为保持。图片结构检查证明有界预览资格，不认证压缩像素或 CRC 完整性，也不承诺浏览器解码器的全部安全性质。源文件仍是可变引用，不提供文件系统原子快照。

`530c585` 单独纳入原始方案和效果稿；本次只更新方案的实施记录并归档，效果稿文件、截图与评审状态保持原样。

### 10.2 实施验证

以下是各实施阶段已经取得的证据，不表示每次增量修复都重跑了所有命令或设备流程。

| 阶段 | 已取得证据 | 覆盖边界 |
| --- | --- | --- |
| 基础实现整合 | 根 `pnpm verify`、Extension 验证及后续 PWA 类型检查、lint、测试和构建通过。确定性测试 provider 驱动真实 SDK 生命周期，隔离 Docker Relay、Pi 与双 Owner 浏览器链路通过：原生发布确认、原名/长度/SHA-256 下载、图文阅读与新手势保存、刷新、Pi `--continue` 恢复、旧页面普通消息共存及 Relay 恢复。 | provider 证明真实 SDK 与传输生命周期，不证明模型自主选择发布。旧页面检查不等于真实 Service Worker 缓存升级；测试环境刻意阻断 SW，生产 SW 专项另行通过。 |
| 发布索引性能修复 | 受影响测试、Extension 验证及隔离双 Owner E2E 再次通过。真实 SessionManager 长分支、深路径与短读测试按资格解析调用次数验证，不依赖 CI 计时阈值；覆盖资格撤销、路径变化和实际句柄释放。 | 该次 E2E 在动画门禁和阅读器生命周期修复之前执行，不能作为后两项改动的端到端证据。 |
| 动画预览安全修复 | Extension 验证 648 项通过、1 项跳过；PWA controller 44 项、PublishedFile 与 PwaApp Browser 128 项通过；PWA 类型检查和 lint 通过。回归确认服务端拒绝预览时不进入 `<img>`，显式下载保留原件；真实原型静态 PNG 保留图片预览。 | 此次未重跑 Docker E2E，未实测手机解码 CPU/内存；跳过项不计为通过。 |
| 阅读器生命周期修复 | controller Node 51 项、PublishedFile/PwaApp/MessageList Browser 170 项通过；PWA 类型检查、lint、构建及空白检查通过。新增入口回归在旧实现中对 `bye`、`reset`、另一 Pi 选择均失败，修后通过；组件回归覆盖同 publication ID、旧回调隔离及资源清理。 | 此次未重跑 Docker E2E 或真机；lint 的两个既有 unused 警告和构建的大 chunk 警告仍在，未扩围处理。 |
| 提交 `416fe96` | GitHub CI 的 `checks`、全部 PWA Browser 分片、`docs` 与汇总 `verify` 均通过；前三项代码评审意见已实现修复并经过对应独立只读审查。 | CI 通过不表示 PR 已合并，也不表示全部 GitHub 评审线程已 resolve。本次文档更新是此提交之后的增量，仍须单独校验并按授权提交。 |

正式页面另完成桌面/移动 viewport、明暗主题、文件行/文本/图片的 Playwright 截图检查，没有观察到横向溢出。它们证明指定 viewport 的呈现，不是 iOS Safari、已安装 PWA 或 Android 真机验收。方案阶段的效果稿截图见第 9 节，与正式页面证据分开。

### 10.3 遗留风险与发布边界

- **真机验收未完成**：iOS Safari/已安装 PWA、Android 的触摸缩放、系统返回与保存到文件，以及最大原件获取的手机内存峰值，仍需发布前专项检查；未把 viewport 或 Node/Browser 回归写成真机通过。
- **真实链路覆盖仍有限**：隔离 Docker E2E 未强制制造获取中切换，相关取消、迟到回执及作用域隔离证据来自 reader/controller/binding 和真实入口 Browser 自动化。动画安全与阅读器生命周期修复后未重跑 Docker E2E，快速新 scope 重开与异步 history traversal 的额外交错也未单独注入。
- **图片安全与文件一致性有边界**：静态结构资格不等于压缩内容完整认证；不能无条件保证全部解码器安全。读取保留源路径和同句柄检查，但不提供快照、硬取消内核 I/O 或离线原件持久化。
- **既有测试时序风险保留**：此前图片阅读器的即时 unpin 断言曾失败，未修改无关旧断言；复跑、扩大回归及后续 CI 通过，不据此隐去慢机时序风险。
- **发布未执行**：代码已在功能分支提交并推送，PR #31 尚未合并；本轮不包含生产部署、Extension 发布或本机更新。发布仍按部署规范先 PWA、后 Extension，需分别授权，并完成适用的发布前检查。归档仅结束本地实现范围，不把未覆盖项勾选为完成。
