# 会话附件原件预览与保存

- 日期：2026-10-27
- 用途：让正式消息中的附件可从在线 Pi 取回原件，在阅读 Drawer 中预览并保存；本文不是当前实现说明。
- 决策：[ADR-20261027](../../adr/20261027-attachment-original-fetch.md)
- 项目级状态：见 [ROADMAP](../../ROADMAP.md)，不在本文另设状态表。
- 当前事实来源：[ARCHITECTURE「会话附件」](../../ARCHITECTURE.md#会话附件)、[「会话文件发布与获取」](../../ARCHITECTURE.md#会话文件发布与获取)与[会话协议](../../reference/protocol/protocol-v2.md#会话文件发布与获取)。

## 1. 背景与现状

| 位置 | 现状 |
| --- | --- |
| `pwa/src/components/pwa/attachment-cards.tsx` | 正式消息、pending 和队列复用只读卡片；缩略图只是 `<img>`，无点击入口 |
| `packages/protocol/src/session/attachments.ts` | 持久化的附件元数据（`pi-reach:attachments-v1`）含 `attachment_id`、`file_name`、`mime_type`、`byte_length`、`sha256` 和可选预览，不含本地路径 |
| `pi-extension/src/attachments/store.ts` | `attachment_id` → 路径只存在内存 `byAttachment`，Pi 重启后丢失 |
| `pi-extension/src/attachments/storage-path.ts` | 原件路径为 `<root>/<YYYY-MM-DD>/<attachment_id>/<safeAttachmentFileName(file_name)>`，日期取首次开始接收时的本地日期 |
| `pi-extension/src/files/reader.ts` | `FileReaderRuntime` 通过注入的 `resolve(scope, id)` 取得源路径，安全打开、分片读取并计算 SHA-256 |
| `pwa/src/lib/pwa/file-transfer.ts` | 文件 controller 以 `publication_id` 为键管理任务、缓存和状态，发送 `file_open` |

## 2. 已确认决定（2026-10-27）

1. 取回后同时提供预览与保存，与发布文件一致。
2. 当前会话已授权的任何 Owner 都可取回，不按发送者限定。
3. 旧版内联 image block 不纳入。
4. 只在在线、当前会话、当前分支的正式消息上提供；只读历史、pending、队列和草稿不提供。
5. 点击后才获取原件，不自动拉取。

**非目标**：离线或历史中取回、浏览器持久缓存原件、断点续传、任意范围读取、新的 HTTP 或 Relay 存储、附件清理或配额。

## 3. 设计

### 3.1 协议（`packages/protocol`）

- 新增客户端 frame `file_attachment_open`：沿用 `file_open` 的 channel 与 scope 字段，携带 `id` 与 `attachment_id`，不携带路径或文件名。不用 `attachment_` 前缀，因为 Extension 按该前缀把 frame 交给上传存储（`pi-extension/src/runtime/attachment_binding.ts`）。
- `file_opened` 的 `publication_id` 改为与新增 `attachment_id` 二选一（strict union，二者同时出现或都缺失时拒绝）；其余字段不变。
- `file_read`、`file_chunk`、`file_close`、`file_closed`、`file_error` 按 `transfer_id` 复用，不改。
- 旧 Extension 无法解码新 frame，由 `peer_channel` 回复 `protocol_upgrade_required`；PWA 仅对 `file_attachment_open` 请求把它映射为 `unsupported`（`pwa/src/lib/pwa/file-transfer-requests.ts`），在卡片上提示升级电脑端扩展，其他请求的该错误仍交给父运行态。

### 3.2 Extension：附件解析

在 `pi-extension/src/runtime/file_binding.ts` 为 `FileReaderRuntime` 增加附件 resolver，与发布文件共用资源额度、idle 回收和 scope 失效。解析顺序：

1. **资格**：用当前分支的 `attachmentRecords(manager)`（`pi-extension/src/timeline/attachment_content.ts`）查找绑定到正式消息的元数据，取得目标 `attachment_id` 的 descriptor；不在当前分支或未绑定时返回 `not_available`。客户端 ID 只用于查找，不参与路径拼接。
2. **定位**：不读取上传 store 的内存表（它绑定上传租约，Pi 重启后不存在），统一按 `storage-path.ts` 规则推导：在根目录下严格匹配 `YYYY-MM-DD` 的目录中倒序查找 `<attachment_id>` 子目录（拒绝符号链接目录），文件名取 `safeAttachmentFileName(file_name)`；未命中时兼容早期布局 `<root>/<sha256(sessionId)>/<attachment_id>.bin`。成功结果按附件 ID 做有界缓存（64 项），每次仍重新核对分支资格。根目录与上传共用 `defaultAttachmentRoot()`。
3. **安全打开**：复用 `pi-extension/src/files/safe-open.ts`，拒绝符号链接、非普通文件和根目录外路径；大小须等于 descriptor 的 `byte_length`，否则返回 `file_changed`。
4. **完整性**：读取结束时 SHA-256 须等于 descriptor 的 `sha256`，不一致时返回 `file_changed` 而不是发送末片；PWA 也以历史元数据中的摘要再次校验。
5. **展示信息**：`file_opened` 的名称与 MIME 取自 descriptor，预览能力沿用 `content-type.ts` 与 `image-structure.ts` 的检查。

### 3.3 PWA

- 文件 controller 的描述泛化为 `FileSourceDescriptor`（`pwa/src/lib/pwa/file-source.ts`），状态与缓存键由 `fileKey()` 生成（发布文件沿用 `publication_id`，附件为 `attachment:<id>`），请求按来源发送 `file_open` 或 `file_attachment_open`；缓存、pin、单任务与 15 秒超时不变。
- 正式消息的附件卡片由 `SentAttachmentCards` 渲染：图片与文本附件的缩略图和名称组成查看入口，右侧操作位为取消、下载或保存（44px），打开既有 `published-file-reader` Drawer；pending、队列、草稿和只读历史保持只读卡片。
- 图片在 Drawer 中走既有图片阅读与手势；文本走受限文本阅读；其他类型只提供保存。获取中、失败、需更新 Pi 的状态沿用发布文件的文案与位置，按需补充附件专属文案。
- 切换电脑、Pi 或历史时，附件取回与发布文件共用「获取未完成」确认。

## 4. 文档同步（随实现完成）

- [ARCHITECTURE「会话附件」](../../ARCHITECTURE.md#会话附件)：删除「不能从 PWA 下载原件」，补充在线取回边界与解析来源。
- [DESIGN「组件规则」](../../DESIGN.md#组件规则)「会话附件」：改写「无原件下载或大图弹窗」，补充可点击条件与状态。
- [会话协议](../../reference/protocol/protocol-v2.md#会话附件)：新增 `attachment_open` 与 `file_opened` 来源字段。

## 5. 验证

| 层 | 内容 |
| --- | --- |
| protocol | `attachment_open` 与 `file_opened` union 的接受与拒绝（未知字段、双来源、缺来源） |
| Extension | 资格：其他分支、未绑定、伪造 ID；定位：内存命中、重启后推导、跨午夜、目录缺失；安全：符号链接、非普通文件、大小或摘要不符、读取中修改；资源额度与发布文件共享 |
| PWA | controller 按来源区分任务与缓存；卡片在正式在线消息上可点击、其他状态只读；`unsupported_type` 提示更新 Pi；Drawer 打开、关闭与回焦 |
| E2E | 真实 Relay 双 Owner：PNG 与二进制附件取回、长度与摘要一致、另一 Owner 可取回、Pi 重启后仍可取回、旧 Extension 提示更新 |

最终执行受影响包的 typecheck、lint、test，PWA 浏览器组件测试只跑直接覆盖的文件，另跑 `pnpm test:e2e`、`pnpm check:docs` 与 `git diff --check`。

## 6. 风险

- 日期目录查找在附件极多时有额外目录读取；先用记录日期命中，回退扫描只读目录名，不读取文件内容。
- 原件在电脑端被修改后不可取回；这是有意的完整性边界，不提供旧版本。
- 安全打开只支持 macOS 与 Linux。
- 协议发布须先部署 PWA 再发布 Extension。

## 7. 实施步骤

1. protocol：新增 frame 与 union，补 schema 测试。
2. Extension：附件 resolver 与路径推导，接入 `file_binding`，补单元测试。
3. PWA：controller 来源泛化、卡片入口、Drawer 复用与文案，补组件测试。
4. E2E 与文档同步，按第 5 节验证后交付。

## 8. 实施记录（2026-10-27）

分支 `feature/261027-attachment-original-preview`，本地实现，未提交。

| 层 | 主要改动 |
| --- | --- |
| protocol | `frames.ts` 新增 `fileAttachmentOpenFrameSchema`，`file_opened` 改为来源二选一的 union；`files.test.ts` 补接受与拒绝用例 |
| Extension | 新增 `files/attachment-source.ts`；`files/reader.ts` 来源泛化、附件长度与摘要校验、原文件名；`runtime/file_binding.ts`、`timeline/v2_service.ts` 接入新 frame；`attachments/storage-path.ts` 导出共用根目录 |
| PWA | 新增 `lib/pwa/file-source.ts`、`components/pwa/sent-attachment-cards.tsx`；controller、请求匹配、门面、阅读器与时间线改用来源描述；`UserMessage` 在线正式消息接入新卡片；中英文案；状态展厅「文件」补已发送附件样例 |
| E2E | `e2e/real/pi-reach-live.spec.ts` 中另一 Owner 刷新后下载二进制附件核对 SHA-256，并在阅读器打开图片附件 |

文档同步已完成第 4 节三处。

本地验证：protocol 测试；Extension 全量测试；PWA 全部 Node 测试与直接受影响的 Browser Mode 文件；根 `pnpm typecheck`、`pnpm test:relay`、`pnpm build`；`pnpm test:e2e:pwa`。Docker 支撑的 `pnpm test:e2e:protocol` 与 `pnpm test:e2e:remote`（含本次新增的跨 Owner 取回步骤）在开发容器内无法访问宿主机发布的端口，尚未运行，须在宿主机或 CI 外补跑后才能结束本事项。
