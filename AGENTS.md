# Pi Reach — Monorepo

本仓库是 Pi Reach monorepo。当前主要使用 Pi coding agent 协作；Pi 的主 Agent、`subagent` 和项目 skills 是默认工作流。

## 项目结构

| 目录 | 技术栈 | 职责 |
|---|---|---|
| `pi-extension/` | Node + TypeScript | Pi 扩展、Daemon、配对与远程会话协议 |
| `relay/` | Node + TypeScript + ws | WebSocket Relay、endpoint registry 与 ACL 路由 |
| `pwa/` | Vite + React + TypeScript | 浏览器 PWA；产品路由均位于 `/app` 下（如 `/app/settings`），根路径 `/` 重定向至 `/app` |

`packages/protocol/` 是浏览器可用的共享协议包，提供 TypeScript 类型、Zod schema 与纯编解码；包边界和分发方式见 [ARCHITECTURE](docs/ARCHITECTURE.md#工程与构建边界)。

## 工作规则

- 修改前先读取目标子项目的 `AGENTS.md`、相关代码、测试和配置。
- 只修改用户明确授权的范围；不自动扩大到无关子项目或文档。
- 当前分支可以直接开发，不要求使用特定终端、pane、worktree 或外部编排工具。
- Node 工程使用根 pnpm workspace；从仓库根执行 `pnpm install --frozen-lockfile`，版本与安装策略以根 `package.json`、`.node-version`、`pnpm-workspace.yaml` 和 `.npmrc` 为准。不要在子项目创建独立锁文件或 workspace 配置。
- 构建、测试和 lint 可使用根命令或 `pnpm --filter <包名> <命令>`；也可在对应子项目目录执行原命令。Relay 包名为 `@pi-reach/relay`，已纳入根验证。
- 公共协议改在 `packages/protocol/`，两端旧入口保持薄适配；共享包不得引入 SDK、Node 专用 API、React 或连接生命周期。修改共享源码后，局部测试或类型检查前先执行 `pnpm --filter @pi-reach/protocol build`；根 `pnpm typecheck` / `pnpm test` 自动完成此前置步骤，持续开发可另开 `pnpm dev:protocol`。
- 行为变更必须提供适当的自动化验证；最终执行受影响验证和 `git diff --check`。
- 不自动执行 `git commit`、`git push`、Pull Request、生产发布或其他外部副作用，除非用户明确授权。
- 发现现有未提交改动时，保留并基于当前工作区继续，不回退用户改动。
- 涉及架构、协议、配对、UI 或安全方向时，先阅读 [`docs/adr/20260518-closed-decisions.md`](docs/adr/20260518-closed-decisions.md)，不要静默推翻已关闭决策。
- 独立 PWA UI/Mantine 迁移批次按项目技能执行；涉及叠层、焦点或 Portal 时同时执行对应的 overlay 验证技能。
- 产品术语、当前架构和设计分别见 [`docs/CONTEXT.md`](docs/CONTEXT.md)、[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)、[`docs/DESIGN.md`](docs/DESIGN.md)。历史方案与待实施原型不能替代这些当前说明，也不能作为未获准实现的授权。

## 文档管理规范

### 基本原则

- 以下文档布局和生命周期遵循全局默认规范；项目文档已有更具体事实时，使用链接引用，不另建重复真源。
- 同一当前事实或事项状态只保留一个权威来源；允许保留注明时间或版本的历史快照，但不得把历史摘要当作当前事实维护。
- 当前文档中的实现说明须核对代码、配置和后续结束记录；目录位置、草案已记录、原型已确认或旧段落的“实现中”均不能单独决定项目状态。已实现范围与未覆盖验收分别说明，不通过补勾历史 checkbox 伪造完成。
- 不因规范存在自动创建空文档或空目录；只有内容确有需要且获得明确授权时才创建。
- 需要跨会话跟踪、多人协作、重要决策或长期留痕的事项才使用路线图和方案文档；小型修复、局部调整和一次性操作不强制登记。

### 文档职责

- `README.md` 是项目入口；`AGENTS.md` 只记录项目协作、命令、范围和验证规范。
- `docs/CONTEXT.md`、`docs/DESIGN.md`、`docs/ARCHITECTURE.md`、`docs/DEPLOYMENT.md` 分别维护稳定业务背景、设计系统、当前架构和部署运维事实；没有相应内容时不创建。
- `docs/BACKLOG.md` 保存尚未确定开发的候选事项；`docs/ROADMAP.md` 保存已确定事项及唯一项目级状态，状态使用 `待开始`、`进行中`、`阻塞`、`已完成`、`已取消`。
- 已有 Issues、Projects、Jira 等权威任务系统时，沿用其状态约定，仓库文档只保留必要链接，不双写状态。
- `docs/plans/active/` 保存尚未结束的详细方案，`docs/plans/completed/` 保存已完成、已取消或被替代的方案及验证和遗留风险；归档不代表实现完成，方案不独立维护当前项目级事项状态。
- `docs/reference/` 保存长期参考；`docs/adr/` 记录重要决策原因并原则上只追加；`docs/prototypes/` 保存可评审原型，但不作为当前实现真源。
- 协议、部署等专项文档按上述职责归入对应长期文档或参考目录；消费者通过链接引用，不复制维护协议、部署或状态事实。

### 生命周期与命名

- 纳入跟踪的候选事项确认开发后，从 `BACKLOG` 移入 `ROADMAP`，并由事项入口链接活动方案；使用其他任务系统时执行等效流转。
- 事项完成时，先将仍有效事实同步到对应长期真源，再归档已有方案，最后更新权威事项状态；取消或被替代的方案也归档并记录结束原因及替代关系。
- 原型状态只使用 `草稿`、`评审中`、`已确认`、`已失效`，与事项状态相互独立；原型失效时记录替代关系，长期规则提炼到对应项目真源。
- 方案、原型说明和 ADR 等事件型 Markdown 文档默认使用 `YYYYMMDD-<主题>.md`；长期文档使用稳定名称。多文件产物默认使用 `YYYYMMDD-<主题>/` 目录，内部沿用原生格式和专项约定，不强制将 HTML、SQL 等产物改为 Markdown。
- `.task-context.md` 只用于当前复杂任务恢复，可保留必要状态快照，但不作为项目级状态真源；不属于项目长期文档，不进入 `BACKLOG`、`ROADMAP` 或方案归档体系。

### 现有历史文档

- 新建方案使用 `docs/plans/active/`，结束后归档到 `docs/plans/completed/`；归档不代表历史待办已实现，也不重新授权执行旧方案。
- [`docs/adr/20260518-closed-decisions.md`](docs/adr/20260518-closed-decisions.md) 汇总已关闭决策；后续新增或更新的重要决策使用 `docs/adr/`。
- [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md) 是部署事实来源；新建部署文档遵循其职责，不复制维护内容。
- `.pi/tmp/` 仅用于当前任务的临时截图、日志、证据和调试产物，不作为项目真源。

## 常用验证

```bash
pnpm typecheck
pnpm lint
pnpm test
pnpm build
pnpm test:relay
pnpm test:e2e
pnpm verify:release
```

`pnpm verify` 串行执行 workspace 的类型检查、lint、测试和构建，包含 Node Relay、部署脚本模拟测试和 Service Worker production 专项，但不启动 Playwright 或 Docker E2E；`pnpm test:e2e` 串行执行 PWA 本地生产预览、Docker Protocol v2 和真实浏览器双 Owner 回归；`pnpm verify:release` 组合两者。`pnpm test:relay` 单独构建并验证 Relay。局部验证使用 `pnpm --filter pwa <命令>`、`pnpm --filter @yefengr/pi-reach <命令>`、`pnpm --filter @pi-reach/relay <命令>` 或在对应目录执行。PWA 与 Relay Docker 构建均使用仓库根上下文：`docker build -f pwa/Dockerfile .`、`docker build -f relay/Dockerfile .`。

只运行与当前变更相关的命令；跨项目共享协议或部署配置变更时扩大验证范围。

## 发布

发布、推送和部署必须在本地验证通过后按用户授权执行。PWA 的 Docker 发布和服务器部署说明以 [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md)、`pwa/push-docker.sh` 和 `scripts/deploy-self-hosted.sh` 为准。

## 已关闭决策

[`docs/adr/20260518-closed-decisions.md`](docs/adr/20260518-closed-decisions.md) 是已关闭的产品与架构决策记录。提出方向变化前必须先核对该文件，并在需要时显式说明证据和影响；新增重要决策使用 `docs/adr/`。
