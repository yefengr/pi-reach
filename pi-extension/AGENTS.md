# Pi Reach — Pi Extension（Node + TypeScript）

Pi Reach 的 Pi package：注册 `/pi-reach`，把当前 Pi 进程作为独立 endpoint 连接 Relay，并提供 Browser/PWA pairing 与 Protocol v2 timeline/actions。

产品术语见 [`../docs/CONTEXT.md`](../docs/CONTEXT.md)，三端职责、身份生命周期和状态所有权见 [`../docs/ARCHITECTURE.md`](../docs/ARCHITECTURE.md)。本文件保留 Extension 的实现约束、协作命令与验证要求，不重复维护架构正文。

本项目不提供 Agent Mesh、本地 broker、Pi-to-Pi 通信、room routing、membership、mesh tools 或 MCP mesh server。协议、安全边界与跨端契约见 [协议与安全总览](../docs/reference/protocol/README.md)、[`../docs/reference/protocol/protocol-v2.md`](../docs/reference/protocol/protocol-v2.md) 和 [`../docs/reference/protocol/pairing.md`](../docs/reference/protocol/pairing.md)。

## Stack

- Node 20+ / TypeScript 6
- ESM only（NodeNext）；TypeScript import 也必须带 `.js`
- 根 pnpm workspace；catalog、构建许可与安全 overrides 由 [`../pnpm-workspace.yaml`](../pnpm-workspace.yaml) 管理，不创建子项目锁文件，不使用 npm/yarn 安装
- Pi SDK types/test contract：`@earendil-works/pi-coding-agent`（peer + dev；生产包不私有安装 SDK）
- Relay transport：`ws`
- Host identity：`@napi-rs/keyring` + headless file fallback
- Schema：TypeBox / Zod（沿现有模块边界）；公共 wire schema 修改 `../packages/protocol/`，本地 `src/protocol/v2/` 保留薄适配、marker 与会话状态

## 常用命令

在仓库根安装依赖：`pnpm install --frozen-lockfile`。以下命令在 `pi-extension/` 执行，也可从根使用 `pnpm --filter @yefengr/pi-reach <命令>`：

```bash
pnpm typecheck
pnpm test
pnpm build
pnpm verify
```

`pnpm verify` 必须在 Extension 行为变更后通过。`pnpm test` 执行既有 Vitest 测试及 `scripts/` 的 Node 脚本测试；不要为区分 runner 而排除 `test/`。改动共享源码后，局部类型检查或测试前先执行根 `pnpm --filter @pi-reach/protocol build`，或使用根验证命令。生产 TypeScript 文件不超过 600 行。开发工具链以根配置为准，已发布包的 Node 支持范围仍由本包 `engines` 定义。

`pnpm build` 先构建共享包，再编译 Extension 并运行 `scripts/vendor-protocol.mjs` 内置公共代码、改写 JS 与声明引用；不得跳过 vendor 步骤发布。npm 包通过 `pnpm pack` 将 catalog / workspace 引用转换为实际版本；发布脚本只上传已检查的 tarball，不直接对含 catalog 的源码目录执行 `npm publish`。独立分发验收必须在仓库之外安装并加载该 tarball。完整发布流程与认证方式见 [DEPLOYMENT](../docs/DEPLOYMENT.md#extension-npm-发布)。

## Relay 配置

优先级：

1. `PI_REACH_RELAY`
2. `~/.pi/pi-reach/config.json`
3. 项目默认 Relay URL

用户输入使用 `http://` 或 `https://`；Extension 打开 WebSocket 时转换为 `ws://` 或 `wss://`。

相关命令：

- `/pi-reach set-relay <url>`
- `/pi-reach config`
- `/pi-reach pair`
- `/pi-reach devices`
- `/pi-reach revoke <shortid>`

## Endpoint 与 pairing 规则

- `device_id` 是 Host Ed25519 public key 的 canonical Base64 表示。
- 每个 Pi 进程生成随机 endpoint/runtime；同一进程内 Extension reload 保持该身份。
- QR 必须包含 endpoint/runtime；不得恢复 room hint 或旧 QR fallback。
- Owner→Host sender 只能使用 Relay 注入的 `source_owner_id`。
- Pairing 成功或撤销后，必须同步 `endpoint_update.authorized_owner_ids`。
- Relay 断线只进入 reconnecting/degraded，不通过重启 Pi 修复。

## 编码约定

- Strict TypeScript；优先 `unknown` + narrow，不使用无约束 `any`。
- ESM import：`import { foo } from "./bar.js"`。
- Boundary 严格校验；未知字段、旧版本、错误 route purpose 和 stale runtime fail closed。
- 确定性错误使用结构化 code/stage/retryable，不解析 stderr 推断状态。
- 不记录 private key、pairing token、完整 `ct` 或消息正文。
- 不自行实现 crypto primitive。
- 不提交 `dist/`。
