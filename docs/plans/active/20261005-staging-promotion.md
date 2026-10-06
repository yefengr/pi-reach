# 同机隔离测试环境与 GitHub Actions 晋升方案

## 文档用途与授权边界

本文供接手实施的智能体和维护者使用，保留成文时的目标、推荐路线、验收和停止条件；后续实施取舍见文末记录，不代表远程测试环境已经创建或真机验收通过。当前部署实现说明以 [DEPLOYMENT](../../DEPLOYMENT.md)、代码和实际运行证据为准；项目级事项状态只在 [ROADMAP](../../ROADMAP.md) 维护，本文不另建状态表。

维护者已确认保持本方案并授权本地仓库批次 0–4，包括分支、ROADMAP 登记、代码、验证和部署文档。服务器/GitHub 初始化、版本变更、提交、push、PR、合并及生产发布仍须分别授权。

本文不是修改代码、部署配置、ROADMAP 或已有 ADR 的授权，也不是提交、推送、创建 PR、修改 GitHub Environment、操作服务器或发布版本的授权。接手者开始写入前应向用户确认实施范围；提交、push、PR、合并、服务器初始化和生产部署分别取得对应授权。

PWA `0.0.16` 是成文时拟定的下一候选版本，不是本方案要求立即修改的版本号。正式发布暂缓，先建设并验证测试流程。不要把本方案与版本发布绑定为一次未经确认的提交或部署。

## 已确认方向与待核验事项

维护者已确认：

- 测试与正式环境共用同一台服务器，通过不同域名访问。
- 测试 PWA：`https://test-pi-reach.yefengr.cn/app`。
- 测试 Relay：`https://test-pi-reach-relay.yefengr.cn`。
- 维护者告知两个测试子域名已经配置；成文时未核验 DNS、证书或公网可达性。
- 发布流程放在 GitHub Actions：先部署测试环境，测试通过后，再通过人工审批晋升正式环境。
- 测试与生产使用同一个镜像 digest，不在验收后重新构建。

以下属于推荐实现，而不是已经生效的服务器配置：测试 Compose 项目名 `pi-reach-staging`；Relay/PWA 宿主端口分别为 `3002/3003`；独立部署目录、密钥和资源限制。服务器初始化前必须核对端口占用、目录、工具版本、可用资源和权限，不能据此直接执行远程写入。

## 当前基线与需要闭合的问题

### 接手时先刷新基线

2026-10-05 复核时，`origin/main` 为 `b9f2f55`，已包含 PR #48 的手势实现、PR #49/#50 的 Extension 标签与 GitHub Release 自动化以及 PR #51；主线 PWA 版本为 `0.0.15`。本方案当时作为未跟踪文件位于无关的文档分支上，提交时应与该分支的其他改动分开。

以上是时间点快照。接手者应重新 fetch 并以最新主线为基准，不从旧功能分支或文档分支直接扩展实现，不按 ahead/behind 数量猜测未合并内容。

在保留本方案和其他既有改动的前提下创建新的功能分支。分支命名遵循项目约定。不要顺手修改或回退 Extension npm/GitHub Release 工作流。

### 现有入口

| 入口 | 已核对的行为 | 新流程需要处理的边界 |
| --- | --- | --- |
| [`docker-compose.yml`](../../../docker-compose.yml) | 项目名 `pi-reach`，容器 `pi-reach-relay`/`pi-reach-pwa`，只绑定 `127.0.0.1:3000/3001` | 测试项目、容器和端口不能与生产冲突 |
| [PWA/Relay 部署工作流](../../../.github/workflows/deploy.yml) | 最新主线显示名为 `Deploy PWA & Relay`；版本变化或手动选择组件，构建 GHCR 镜像，经 production 审批部署，随后打标签和 Release | 插入 staging 部署与验证依赖，保留构建输出 digest 和组件选择 |
| [`deploy-from-ci.sh`](../../../scripts/deploy-from-ci.sh) | 接受严格的三字段 `deploy <pwa\|relay> <镜像:v版本@digest>` 请求；目录和仓库前缀来自受限 SSH 入口；固定生产容器名；按仓库保留最新 3 个镜像标签，跳过任一容器正在使用的镜像 | 环境不能由客户端自报；测试密钥不能操作生产；部署与回滚必须引用不可变镜像；服务器上的副本不随自动部署更新 |
| [`deploy-self-hosted.sh`](../../../scripts/deploy-self-hosted.sh) | 本机备用部署直接更新生产，上传根 Compose，使用部署目录内的锁 | 不静默改变其生产默认行为；若需要测试入口，另行明确范围并补测试 |
| [`pwa-app.tsx`](../../../pwa/src/components/pwa/pwa-app.tsx) | 默认 Relay 固定为生产地址，初始化、旧默认值迁移和空输入回退都消费该默认值 | 测试容器需提供测试默认值，不能只替换 PWA 域名 |
| [PWA 镜像](../../../pwa/Dockerfile)与 [Nginx 配置](../../../pwa/nginx.conf.template) | 静态构建由非 root Nginx 托管；目前运行时主要配置为端口 | 在同一镜像中提供经过校验的非敏感运行时配置 |
| [Service Worker](../../../pwa/src/app/sw.ts)与 [Vite 配置](../../../pwa/vite.config.ts) | 预缓存应用入口及静态资源，应用导航支持离线回退 | 环境配置不能在离线启动、缓存升级或重新安装时变成另一环境的默认值 |

部署入口目前先按 digest 拉取，再打版本标签，并把版本标签交给 Compose。两套环境共用 Docker 镜像存储后，不能依赖可变本地标签完成隔离或回滚。

现有清理不是全局 prune，而是按仓库保留最新若干标签，并跳过任一容器正在使用的镜像。两套环境共用同一镜像仓库、各自持锁后，风险在于并发：生产执行 `up -d` 替换容器后、健康检查完成前，旧镜像已不被任何容器使用；若此时 staging 部署结束并执行清理，可能删掉生产即将回滚到的镜像。

自动部署不上传服务器上的 `docker-compose.yml`，也不更新服务器上的 `deploy-from-ci.sh`（见 [DEPLOYMENT](../../DEPLOYMENT.md#自动部署)）。生产 Compose 或部署入口的任何变更，都要在依赖它的版本晋升前，由维护者单独同步到服务器。

已核对的相邻测试包括 [`deploy-from-ci.test.mjs`](../../../scripts/deploy-from-ci.test.mjs)、[`deploy-self-hosted.test.mjs`](../../../scripts/deploy-self-hosted.test.mjs)、[`deploy-release-notes.test.mjs`](../../../scripts/deploy-release-notes.test.mjs)、[PWA runtime 测试](../../../pwa/src/lib/pwa/runtime.node.test.ts)与 [PWA 路由测试](../../../pwa/scripts/pwa-routing.test.mjs)。后续修改优先扩展这些真源，不另造一套部署测试系统。

## 目标与非目标

目标是让维护者在真实 HTTPS、生产构建、Service Worker 和真实设备条件下验证候选版本，然后把实际受测的镜像晋升生产。失败或取消的测试发布不得影响现有生产服务。

本方案不改变 Protocol v2、Relay 业务行为、Extension 产品能力、配对模型或移动手势；不新增账号、常驻 daemon、业务后端、自托管 GitHub runner、第二台服务器或新的编排平台；不直接恢复旧的 test/promote 状态文件体系。

协议、信任边界和 Pi 生命周期继续遵守 [已关闭决策](../../adr/20260518-closed-decisions.md)。这是对当前单环境部署流程的明确调整，实施后需新增 ADR 解释改变原因，不能改写旧 [GHCR 自动部署 ADR](../../adr/20261001-ci-deploy-ghcr.md)来伪造历史。

## 隔离设计

### 服务与入口

推荐新增 `docker/staging/compose.yml`，保留根生产 Compose 的默认行为。两者可以共用镜像，但不能共用运行实例。

| 项目 | 正式环境 | 测试环境（拟定） |
| --- | --- | --- |
| Compose 项目 | `pi-reach` | `pi-reach-staging` |
| Relay 容器 | `pi-reach-relay` | `pi-reach-staging-relay` |
| PWA 容器 | `pi-reach-pwa` | `pi-reach-staging-pwa` |
| Relay 宿主监听 | `127.0.0.1:3000` | `127.0.0.1:3002` |
| PWA 宿主监听 | `127.0.0.1:3001` | `127.0.0.1:3003` |
| 部署目录与锁 | 现有生产目录与锁 | 独立目录与锁 |
| SSH 部署密钥 | production Environment | staging Environment |
| Pi、配对和身份 | 正式使用 | 专用测试身份及 Pi |

共用 Caddy，新增两个测试域名的 HTTPS 反向代理，不替换生产域名或路由。测试服务只监听宿主 loopback；配置需支持 Relay WebSocket。端口表只是建议，发现占用时先报告并重新冻结映射。

给测试容器配置 CPU、内存等限制，数值由实际服务器资源和 smoke 结果决定。不要未经测量写死过低上限。初始化前检查生产资源余量；日常测试避免压测同一台服务器。

不同 origin 自然隔离 Service Worker、Cache Storage 和 IndexedDB，但不能代替 Relay、Pi 身份和部署权限隔离。不要复制生产浏览器数据库或电脑端配对存储作为测试起点。保持 Relay 无业务持久化，不为 staging 新增数据库。

### 受限部署入口

复用 `scripts/deploy-from-ci.sh` 的严格参数解析、健康检查、锁和回滚机制。推荐新增服务器端环境选择配置（例如 `PI_REACH_DEPLOY_ENVIRONMENT=staging`），只由 `authorized_keys` 的固定命令指定，不增加客户端可任意选择环境、目录、Compose 文件或容器的请求参数。

生产旧密钥与默认调用应保持兼容；未知环境值必须拒绝。服务器上的生产入口是手工安装的副本，脚本变更后需由维护者同步，且同步后的脚本在生产固定命令不变时仍须按原行为工作。staging 入口应绑定测试 Compose、固定项目名、测试容器和测试端口。执行拉取、启动或清理前验证配置与环境一致，误放生产 Compose 时必须停止，而不是继续更新生产容器。

Compose 部署目标使用 `仓库@sha256:...` 等不可变引用。记录并恢复实际的旧镜像，而不是重新解析可能已被另一环境改写的标签。版本标签可保留用于展示和追溯，不得成为运行时唯一真源。

staging 禁止全局 `prune` 和跨环境镜像清理。清理必须保留两个环境当前运行及回滚所需的镜像，且不能与另一环境的“替换容器至健康检查完成”窗口并发；可选做法包括 staging 不清理、清理前取得另一环境的锁，或按环境记录并保护回滚镜像。保持生产既有保留策略，并用测试覆盖并发场景。错误输出和日志不得包含私钥、配对码、token 或会话正文。

受限密钥约束的是入口命令，不是 Docker 的强权限沙箱。部署账号拥有 Docker 权限、同机共享内核和磁盘等风险仍存在；脚本和固定命令应由维护者安装、保护，不允许 CI 上传并执行任意脚本，也不能把逻辑隔离宣称为宿主级安全隔离。

## PWA 运行时配置

构建产物不按环境分叉，不用不同 `VITE_*` 参数构建两份镜像，也不在浏览器源码里按测试域名硬编码分支。

推荐在容器启动时注入默认 Relay URL（拟用公开变量 `PI_REACH_DEFAULT_RELAY_URL`）。该配置只含公开地址，不包含任何密钥或服务器凭据。优先评估把配置嵌入应用入口 HTML，例如受控 metadata，并让浏览器复用一个配置读取入口：这可以随所属 origin 的离线应用壳保存，不额外依赖首次启动后的配置请求。

具体注入方式尚未实现，接手者须先验证 Nginx 非 root 写权限、URL 校验/转义、Vite preview、测试入口，以及 Serwist 预缓存和导航回退的兼容性。若该路线不可行，先回报证据；改用独立配置文件时，必须同时确定在线/离线缓存策略和失败语义，不能只新增一个 fetch 后回落生产默认值。

实施前必须冻结缺省语义，二选一，不得含糊：

- **镜像必填**：任何环境缺少该变量时容器都拒绝启动。生产 Compose 需新增生产地址，并在包含该能力的首个版本晋升前同步到服务器；否则新镜像在生产启动失败并触发回滚。
- **镜像缺省为生产地址**：未设置时沿用当前生产默认值，生产 Compose 无需变更；staging Compose 必须用 `${PI_REACH_DEFAULT_RELAY_URL:?...}` 等方式强制提供，且非法值仍须拒绝启动。此时“staging 漏配”依赖 Compose 拦截，需有测试证明。

必须满足：

- 正式环境默认地址保持当前行为；测试 Compose 明确提供测试 Relay 地址。
- 测试配置缺失、非法或注入失败时拒绝启动，不静默使用生产 Relay；拦截发生在哪一层按上文冻结的语义写明。
- 配置不能引入脚本/HTML 注入、额外业务接口或向客户端泄露秘密。
- `PwaApp` 初始化、旧默认值迁移和空输入回退使用一致的默认值来源。
- 保留用户显式保存的自定义 Relay 和既有配对语义，不借此禁止自托管 Relay 或重写生产数据。
- 离线冷启动、Worker 更新与刷新仍得到所属环境的配置；不得为配置可用性破坏现有离线壳。
- smoke 使用新 origin/专用 profile，并核对实际 Relay 地址；不要把旧 profile 中显式保存的生产 Relay 当作配置验证成功。

容器运行时配置不同，不等于重新构建镜像。验收需分别核对镜像 digest 与环境配置；生产使用同一镜像，按冻结的缺省语义得到生产地址。

## GitHub Actions 发布与晋升

在现有 `.github/workflows/deploy.yml` 上扩展，不复制整套构建、SSH、Release 流程。保持当前组件选择、GHCR 来源证明、生产审批和发布后标签规则。

```text
版本 PR → CI / Codex 评审 → 维护者合并 main
→ plan → build（一次，输出各组件 digest）
→ staging 部署 → staging smoke
→ 维护者确认真机验收并批准 production
→ production 部署同一 digest → 公网检查 → 标签 / Release
```

### 候选被拒后的修复路径

staging 在版本号合并进 main 后才触发，因此候选失败或被拒时，main 上已有一个未上线的版本号。现有工作流的 push 触发只看 `package.json` 路径，plan 还会比较前后版本号，修复提交不会自动重新进入 staging。实施时必须明确并测试一种路径，例如：

- 修复合并后手动触发工作流：以新提交重新构建同一版本号，GHCR 版本标签会被覆盖为新 digest，staging 与 production 只认本次运行的 digest；
- 或者约定被拒版本作废，修复 PR 再次升级版本号。

无论选哪种，都不得把上一次运行的 staging 结果当作新 digest 的证据，被拒版本也不得创建标签或 Release。

### 环境与权限

新增 GitHub `staging` Environment，使用独立 SSH 部署密钥和独立环境配置，建议仅允许可信 `main` 部署；`production` 继续保持维护者审批和 main 限制。构建仍在 GitHub 托管 runner 执行，不在生产服务器上运行自托管 runner。

两套环境可沿用现有名称，通过 Environment 分开赋值：Secrets 为 `DEPLOY_SSH_KEY`、`DEPLOY_KNOWN_HOSTS`、`DEPLOY_HOST`、`DEPLOY_USER`；Variables 为 `DEPLOY_PORT`、`PWA_URL`、`RELAY_URL`。主机公钥需核对，不关闭 SSH host key 校验。真实值不写入仓库；服务器目录由受限入口绑定，不由客户端传入。

staging 的 `PWA_URL` 指向测试 `/app`，`RELAY_URL` 指向测试 Relay 基地址。验证所需地址和 Secret 缺失时立即失败，不用“留空跳过”产生假绿灯。production 已有配置需单独核对，不自动覆盖。

未信任的 PR 不得获得环境密钥或服务器部署权限。staging job 不需要标签/Release 的写权限；production 在所有前置通过且获审批后才使用必要写权限。处理 SSH 临时文件的清理路径，包括失败与取消。

### 组件、并发与重跑

只构建和晋升所选组件，但 staging 受测组合必须与晋升后的生产组合一致：部署候选前，把 staging 中未选组件对齐到生产当前运行的 digest，而不是沿用 staging 上的旧版本或上次被拒的候选。对齐结果和两个组件的 digest 一并写入运行摘要。选择 `both` 时保持先 Relay 后 PWA。环境必须始终具备完整的 PWA/Relay 组合，不能因只发 PWA 就省略测试 Relay。

production job 必须依赖 staging 部署与 smoke 成功，不得通过 `always()`、`continue-on-error`、可选结果或手动生产直达入口绕过。手动触发也必须经过 staging。

候选镜像 digest、源提交、组件版本和测试结果记录在同一次工作流的输出/摘要中。production 直接消费 build 的 digest，不在审批后重新构建，也不把可变 GHCR 标签当作受测镜像。

推荐保持整条发布流水线串行，等待 production 审批期间不让另一次候选部署覆盖同一个 staging；服务器按环境分别持锁防止同环境冲突。若将来允许覆盖，必须另行设计验收证据与当前候选的一致性，不能复用旧的通过结果。

注意 GitHub `concurrency` 的语义：同一组只保留一个运行中和一个排队的运行，新的排队运行会取消之前排队的那个。真机验收和审批可能持续数天，期间合并的版本变更可能被静默取消。实施时需说明这是否可接受，并在运行摘要或文档中给出被取消版本的补跑方式。

staging 不创建正式版本标签或 Release。已发布组件仍按现有标签跳过；重跑要区分构建、测试、已完成生产部署与 Release 补建，不得把旧标签误当作本次运行的测试证据。首次初始化使用已核验的固定镜像摘要，不绕过已发布版本保护来覆盖公开版本标签。

生产健康检查失败，复用回滚并让工作流失败；公网检查失败时，不为该失败组件创建标签或 Release，说明线上可能已更新。多组件部署不是跨组件原子事务：若前一个组件已成功上线，后一个组件失败，必须分别报告实际状态，不能声称整体恢复。测试失败或审批前取消，生产维持原样。协议发布顺序仍为先 PWA 上线，再批准 Extension npm 版本。

### 自动验证与人工验收

staging smoke 至少检查：

- HTTPS 与目标域名正确，PWA `/app` 可访问，关键静态资源和 Worker/manifest 可取得。
- PWA 路由、缓存响应头及运行时 Relay 配置正确；错误页不是“全部回退 index.html”。
- 测试 Relay `/health` 可访问，WebSocket 能到达测试实例；不要用 `/health` 成功替代 WebSocket 验证。
- 当前候选的组件 digest、源提交、环境配置可追溯，测试与生产目标明确分离。

这些 smoke 不能证明配对、模型调用、全部功能或真机交互正确。实际端到端操作应使用专用测试 Pi/身份，先确认设备、浏览器 profile、操作范围和模型用量，不对生产会话执行验证命令。

人工记录至少包含受测工作流/提交/digest、设备和系统/浏览器版本、网页或 standalone 模式、步骤和结果。关键流程包括配对/重连、消息收发、文件阅读、五个手势、滚动与图片缩放、后台恢复，以及同一测试 origin 下旧版到新版的 Service Worker/缓存升级。不同 origin 的全新安装不能证明升级路径。

保留 [真实设备发布门槛](20260824-pwa-hardening.md)：至少一台真实 iOS 和一台真实 Android 的关键流程通过。没有证据时不得声称移动端完成验收或继续生产晋升。production 审批人需先确认这些记录；不额外复制一套审批系统，也不以 Chromium viewport/CDP 代替真机。

## 实施顺序与范围

### 1. 仓库实现

重新核对最新主线、根与目标子项目 AGENTS、上述部署入口和直接消费者，向用户确认写入范围后再实施：

1. 冻结环境选择、目录/Compose 绑定、不可变镜像和回滚契约；补部署模拟测试。
2. 新增 staging Compose；实现受限入口环境隔离，保持生产默认兼容。
3. 实现并验证 PWA 运行时配置，不引入环境专属镜像。
4. 扩展工作流的 staging、smoke、production 依赖和摘要；补工作流/Release 相邻验证。
5. 独立审查同机隔离、秘密处理、缓存/配置、候选一致性和失败路径。
6. 把已实现事实更新到 DEPLOYMENT；新增部署流程 ADR。仅在与当前结构或规则直接相关时更新 ARCHITECTURE/AGENTS，不改无关公开文档。

预计涉及：`docker/staging/compose.yml`、`scripts/deploy-from-ci.sh`及测试、`.github/workflows/deploy.yml`及相邻测试、PWA Dockerfile/入口和配置消费者及测试、`docs/DEPLOYMENT.md` 和新 ADR。新增 smoke 或启动辅助脚本按现有目录职责放置。名单是实施建议，不是未经确认的无限写入白名单。

不要新增常驻自维护 daemon、协议字段、新的锁机制或生产业务 API（staging 复用现有目录锁，只是放在独立目录下）；不要顺便重构超长 `PwaApp`。若推荐路线不可行、需要修改共享协议、扩展 UI、增加服务器服务或扩大权限，暂停并返回最小证据与替代方案。

### 2. 一次性服务器与 GitHub 初始化

仓库验证和独立审查通过后，向用户申请这部分的明确授权，再执行：

- 只读核对 DNS、TLS、端口、Compose/Caddy 版本、当前容器、目录、磁盘和资源余量。
- 准备独立测试目录、Compose 和受保护的服务器部署入口；安装固定受限命令的独立 staging SSH 密钥。
- 按冻结的缺省语义，在包含运行时配置能力的首个版本晋升前，把生产 Compose 和更新后的生产部署入口同步到服务器，并确认现有生产容器不受影响。
- 用生产当前的 Relay digest 初始化 staging Relay。已发布的 PWA 镜像都不具备运行时配置能力，受限入口也只接受 GHCR 上的正式版本镜像，因此初始化阶段不部署 staging PWA，也不能拿旧 PWA 镜像误连生产后当作初始化成功；staging PWA 由首个候选版本首次部署。
- 新增 Caddy 测试域名路由，先验证完整配置再 reload；保留所有生产路由。Caddy reload 属于共享基础设施变更，不能称为无风险或零生产影响。
- 创建/核对 GitHub staging Environment、受限分支、Secrets 和 Variables。不得从日志或方案复制私钥。
- 启动测试 Relay，核对生产容器、镜像和访问路径未被改变，再验证测试 Relay 的 HTTPS 和 WebSocket。测试 PWA 的 HTTPS 和默认 Relay 在首个候选部署时验证。

域名已配置不代表其余步骤已完成。若缺少权限、Secret、测试 Pi 或真机，只完成已授权且可验证部分并报告阻塞，不填补虚构结果。

### 3. 首次候选与晋升

基础设施就绪后，另行授权版本 PR 和发布。拟以 PWA `0.0.16` 验证新链路，但版本号应重新核对，避免与其他发布冲突。

按正式版本流程走一次 staging：首次部署 staging PWA，并补做初始化时留下的测试 PWA HTTPS、默认 Relay 和配置缺失拒绝启动验证；取得自动与真机证据后，再由维护者批准 production。同一镜像摘要贯穿测试、上线和 Release。未经单独授权，不代合并 PR、启用自动合并或批准生产部署。

## 验证与验收标准

仓库实现应提供以下自动化证据：

| 范围 | 必须验证的行为 |
| --- | --- |
| 受限入口 | 非法请求/未知环境在 Docker 写操作前拒绝；客户端不能切环境；生产兼容；staging 只操作测试 Compose/容器/锁 |
| 镜像与回滚 | 按 digest 部署；本地标签变动不影响另一环境或回滚；失败恢复实际旧镜像；生产替换容器至健康检查完成期间，staging 清理不会删除生产回滚镜像 |
| Compose | 项目、名字、端口不冲突；只绑定 loopback；资源限制可用；选择一个服务不重建另一个；生产 Compose 与冻结的缺省语义一致 |
| 运行时配置 | 生产/测试同 digest；默认、空输入与迁移一致；按冻结语义，staging 缺配置或坏配置均拒绝启动；保留自定义设置；无注入或秘密暴露 |
| 离线与升级 | 同 origin 下正确缓存所属环境配置；全新安装、断网冷启动、旧 Worker/新版应用切换与刷新不误连另一 Relay |
| 工作流 | staging 失败/取消不进入生产；人工审批前不部署生产；晋升不重建；手动触发也经过测试；staging 未选组件已对齐生产 digest；候选被拒后的修复路径不复用旧证据；只有上线核对成功后创建标签/Release |

命令从根 `package.json` 及 [PWA 规范](../../../pwa/AGENTS.md)取得，不把历史测试数量当作验收。接手者先核对 CLI 和 pnpm 可用性，按当前工作区运行相关验证。建议顺序为部署脚本目标测试、PWA 配置/缓存目标测试与构建，再执行根 `pnpm verify`；跨部署配置的正式交付按影响扩大到相关 Docker/E2E。需要使用模型、登录态或外部服务的测试先确认权限和用量。

已有相关命令：

```bash
node --test scripts/deploy-from-ci.test.mjs scripts/deploy-self-hosted.test.mjs scripts/deploy-release-notes.test.mjs
pnpm test:scripts
pnpm verify
pnpm test:e2e
pnpm check:docs
git diff --check
```

新增测试也必须被实际验证和现有入口覆盖，不能只跑旧文件。Docker 验收需用同一候选镜像分别启动两套配置，证明二者实际解析各自 Relay 且 digest 相同；仅 mock 成功不算运行时镜像验收。

全流程完成需同时具备：仓库验证、独立审查、测试域名 HTTPS/WebSocket、真实功能和真机证据，以及一次经过授权的同 digest 晋升及上线核对。只完成仓库实现时应明确服务器/真机/生产未覆盖，不归档方案或把项目状态标为完成。

## 停止条件与交接结果

遇到以下情况，停止受影响步骤：生产资源不足；测试 Compose 指向生产容器；配置会回退到生产 Relay；生产 Compose 或部署入口尚未按新语义同步就要晋升；staging 组合与生产组合不一致；必须重建镜像才能晋升；测试证据与待审批 digest 不一致；缺少真实设备验收；需要扩大共享协议、外部权限或生产变更范围。

接手者交付时说明实际改动、自动验证与真机结果、镜像/配置证据、尚未执行的初始化和发布步骤、剩余风险及下一项所需授权。长期当前事实更新到 DEPLOYMENT/ARCHITECTURE，决策原因写入新 ADR；本方案结束时按项目文档生命周期归档，ROADMAP 保持唯一项目级状态来源。

## 本地仓库实施记录（2026-10-06）

本次实施基于 `origin/main` 的 `b9f2f55`，在独立短期功能分支完成，不创建长期 test/release 分支。仅实施本地仓库批次 0–4；未改版本、提交、push、创建 PR、初始化服务器/GitHub 环境或发布。以下是本次证据快照，不替代 ROADMAP 的项目级状态。

### 已落地与路线收敛

- 新增独立 staging Compose。服务器入口以 Compose 自身的完整规范化输出与可信模板比较，禁止隐式 `.env`／override，不新增服务器 Node/jq 依赖；资源变量必填，实际值留待资源核验。
- `deploy` 保持三字段兼容，写环境由受限服务器固定命令绑定。新增两环境固定容器只读快照供未选组件对齐、审批后和重跑核对；运行使用 digest，回滚使用实际旧 image ID。本机备用入口仍只操作生产，但同样使用实际 image ID，并保持完整生产 Compose 契约校验。
- staging 不清理镜像，固定先持生产原目录锁再持测试原目录锁，覆盖 production 和本机备用清理对测试回滚窗口的影响；不新增锁机制或状态文件体系。
- 选择「镜像缺省生产、staging Compose 必填」语义。公开 Relay 通过入口 metadata 注入，四处默认值消费者同源；增加镜像能力 label，staging 在启动 PWA 前拒绝旧无运行时配置镜像。首次候选必须包含新版 PWA。
- 工作流单次 build → staging 完整组合与 smoke → production 审批及快照复核 → 同 digest 上线核对 → 标签/Release。未发布同版本修复从新 main 手动重跑；公开标签不覆盖，标签已创建但 Release 失败可补建。审批后校验测试/生产 origin 不重合，旧 run 不复用已被替换候选的通过证据。
- 已同步操作约束至 [DEPLOYMENT](../../DEPLOYMENT.md)，决策记录为 [ADR-20261006](../../adr/20261006-staging-promotion.md)。自动工作流不上传服务器入口或 Compose，后续安装仍独立授权。

### 验证证据

- 部署模拟、CI 组合/失败/重跑、SSH 权限与清理、Release 补建、smoke、真实 Compose 规范化测试通过；新增测试纳入既有 `pnpm test:scripts` 通配入口，不另造验证体系。
- PWA 类型检查、lint、Node/Browser Mode、production Service Worker 专项及构建通过。全新离线安装、不同注入配置、空输入回退和同 origin 旧 worker 交接由 Playwright 自动验证。
- `pnpm test:e2e` 通过，包括本地生产浏览器、Docker Protocol v2 和隔离真实双 Owner；未使用生产身份或真实模型操作。审查后仅收紧 URL 校验，已重跑相关 Node/启动脚本、类型/lint/构建与真实镜像，缓存链路源码未再变化。
- 最终真实镜像 ID 为 `sha256:043f45ba0a874c0d103ff64ce69d94dbe3103f63b793f3b64c1390cd8cb70a9b`。同一 ID 的缺省生产、显式生产、显式测试均解析正确 Relay；显式空值、非法值、非规范 IPv4、缺 meta、只读注入均拒绝启动。该本地 image ID 不是 GHCR 发布 digest，不声称已完成远程同 digest 晋升。
- 独立审查覆盖环境/秘密/回滚/清理/缓存/组合/重跑风险矩阵。唯一 P2 是 shell 接受浏览器拒绝的前导零 IPv4，已补失败回归、统一拒绝并独立复核关闭，无未关闭 P0–P3 finding。
- 根 `LC_ALL=C pnpm verify` 退出 0。默认 UTF-8 locale 下，主线未改动的 Extension Release 脚本在 macOS Bash 3.2 上存在中文紧邻变量解析失败；核对哈希与主线一致后，仅设置进程 locale 完成验证，未修改该脚本或 Extension 工作流。保留既有 lint 警告，不称默认环境的原命令通过。
- 文档链接（含本次未跟踪的新文档）和 `git diff --check` 通过。

临时验证与审查证据位于 `.pi/tmp/logs/staging-*` 和 `.pi/tmp/staging-review-*-manifest.json`，不作为长期事实来源或提交产物。

### 后续门槛

远程 DNS/TLS、Caddy、端口/资源、受限密钥、服务器入口同步、GitHub Environment 和首个候选均未执行；真实 iOS／Android、真实生产升级和经过授权的首次晋升未验收。下一步先取得服务器/GitHub 初始化授权，再按 DEPLOYMENT 的一次性要求核验并安装；版本 PR、提交/发布、真机操作和生产批准继续分别授权。本方案保留 active，不因仓库实现完成而归档或标记全流程完成。
