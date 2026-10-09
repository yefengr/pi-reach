# Pi Reach 自托管部署

本文记录 Relay/PWA 的仓库部署入口和服务器准备要求。Deploy PWA & Relay 工作流采用单次构建、staging 验证、production 审批后同 digest 晋升；功能分支推送由 Deploy branch to staging 工作流自动部署 staging，供合并前测试；本机脚本仍只用于生产备用部署、同步根 Compose 和首次初始化，不自动经过 staging。

这套 staging 能力需要先手工安装新版服务器入口、独立 Compose、受限密钥、GitHub Environment 和 Caddy 路由。仓库代码存在不代表远程环境已初始化或真机验收已通过；在这些准备完成前，不触发包含新流程的版本发布。2026-09-30 移除的旧 `site-test`／`relay-test` 和 test/promote 状态文件不恢复。当前本机命令仍只选择 scope：

```text
./scripts/deploy-self-hosted.sh [pwa|relay|both]
  本机构建 -> SSH 传输 -> 更新所选服务 -> 健康检查与公网检查 -> 清理旧镜像
```

省略 scope 时默认 `both`。本机备用部署没有隔离测试阶段，须单独授权并在执行前完成受影响验证（见仓库根 `AGENTS.md` 的常用验证）。本机脚本默认不推送 Docker Hub，镜像经 SSH 传输，不要求服务器从镜像仓库拉取应用镜像；自动部署则由服务器从 GHCR 按摘要拉取。本机 Buildx 构建仍需能够取得 Dockerfile 使用的基础镜像和构建依赖。Caddy 只在首次初始化或域名/端口变化时调整，普通版本部署不修改 Caddy。

Node 工程使用根 pnpm workspace；开发工具链由根 `package.json`、`.node-version` 和 `pnpm-workspace.yaml` 固定。私有共享包 `packages/protocol` 由根安装的 `prepare` 与 workspace 构建流程产出；PWA 及 E2E Host、Owner 的 Docker 构建输入均包含其源码，并通过根 workspace 安装和构建，不依赖独立发布的共享包。PWA Dockerfile 位于 `pwa/`，构建上下文必须是仓库根，由 `pwa/Dockerfile.dockerignore` 限定可复制的输入。PWA 在 Node 构建阶段生成 `pwa/dist/`，运行镜像以非 root Nginx 托管 `/usr/share/nginx/html`，不运行 Node 应用服务器。Nginx 配置真源为 [`pwa/nginx.conf.template`](../pwa/nginx.conf.template)，由容器入口使用 `PORT` 渲染，默认端口仍为 3000；保留 curl 和根路径健康检查。入口 HTML 的公开默认 Relay 由启动脚本注入，生产和测试使用同一镜像，见「PWA 运行时配置」。

PWA 根路径返回 307 到 `/app`；`/app/` 规范化到 `/app`，`/app/<子路径>`（如 `/app/settings`）返回应用入口 HTML 并由前端识别；其他缺失页面和资源返回 404，不统一回退到 HTML。HTML、`/sw.js` 和 `/manifest.webmanifest` 使用 `Cache-Control: no-cache`，存在的 `/assets/` 哈希资源使用长期 immutable 缓存。`pnpm start` 和 E2E 启动脚本仅供本地 Vite preview，生产运行方式以 Dockerfile 为准。

这是已有环境的版本发布流程，不是空服务器的一键初始化流程；首次初始化仍需按下文完成服务器准备和 Caddy 配置。系统职责和数据边界见 [ARCHITECTURE](ARCHITECTURE.md)，部署步骤以本文件及下列脚本、配置为准。

## 文件职责

| 文件 | 作用 | 是否提交 |
|---|---|---|
| `docker-compose.yml` | 生产 Relay 与 PWA，固定项目 `pi-reach` | 是 |
| `docker/staging/compose.yml` | 测试 Relay 与 PWA，固定项目 `pi-reach-staging`；手工安装为测试目录的 `docker-compose.yml` | 是 |
| `deploy.env.example` | 部署变量模板，不含真实值 | 是 |
| `deploy.env` | 本机真实 SSH/服务器配置 | 否，已加入 `.gitignore` |
| `scripts/deploy-self-hosted.sh` | 本机按 scope 部署并验收 | 是 |
| `.github/workflows/deploy.yml` | 单次构建、staging、production 审批与晋升 | 是 |
| `.github/workflows/deploy-staging.yml`、`scripts/deploy-branch.mjs` | 功能分支推送后选择改动组件、构建并只部署 staging | 是 |
| `scripts/deploy-ci.mjs`、`scripts/deploy-smoke.mjs` | runner 端组件对齐、快照核对、HTTPS/WebSocket smoke | 是 |
| `scripts/deploy-release.sh` | 上线核对后创建或修复标签与 Release | 是 |
| `pwa/docker-entrypoint.d/40-runtime-config.sh` | 非 root 容器启动时校验并注入公开 Relay metadata | 是 |
| `scripts/deploy-from-ci.sh` | 自动部署的服务器端入口，只能由受限 SSH 密钥触发；由维护者手工安装到服务器 | 是 |
| `/etc/caddy/Caddyfile` | 服务器 HTTPS 与反向代理 | 服务器 root 配置，不由部署脚本修改 |

`deploy.env` 不得保存私钥、服务器密码或 Docker Hub Token。SSH 私钥由本机 SSH 客户端和 `~/.ssh/config` 管理；需要 Docker Hub 登录时，在交互式终端中单独执行 `docker login`。

## 一次性准备

### 本机

要求：

- Docker Engine/OrbStack/Docker Desktop；
- Docker Buildx；
- `ssh`、`scp`、`gzip`、`curl`；
- SSH 别名已经写入本机 `~/.ssh/config`；
- SSH 登录账号能够直接运行 `docker` 和 `docker-compose`。

创建本机配置：

```bash
cp deploy.env.example deploy.env
$EDITOR deploy.env
chmod 600 deploy.env
```

最小配置示例（使用占位符，不要直接照抄真实信息；版本仅为示例，发布时使用本次核验的镜像标签）：

```dotenv
DEPLOY_SSH=your-ssh-alias
DEPLOY_USER=your-deploy-user
REMOTE_DIR=/home/your-deploy-user/pi-reach
IMAGE_NAMESPACE=pi-reach-local
RELAY_VERSION=v0.0.1
PWA_VERSION=v0.0.1
PUBLISH_IMAGES=0
PWA_URL=https://pwa.example.com/app
RELAY_URL=https://relay.example.com
KEEP_IMAGE_ARCHIVE=0
KEEP_IMAGE_VERSIONS=3
```

先验证 SSH：

```bash
ssh "$DEPLOY_USER@$DEPLOY_SSH" \
  'uname -m && docker info --format "Server={{.ServerVersion}}" && docker-compose version'
```

服务器必须是 `x86_64/amd64` 或 `aarch64/arm64`。部署账号需要能够执行：

```bash
docker info
docker-compose version
docker load
docker-compose up -d
```

### 服务器

服务器部署目录可以提前创建：

```bash
mkdir -p /home/your-deploy-user/pi-reach
```

服务器使用 rootful Docker 时，部署账号通常加入 Docker 用户组。该权限接近 root，只应授予专用部署账号：

```bash
sudo groupadd --system docker  # 已存在时忽略错误
sudo usermod -aG docker your-deploy-user
```

重新登录后验证：

```bash
id
docker info
docker-compose version
```

服务器不需要安装 Caddy 才能运行容器；Caddy 是宿主机上的一次性 HTTPS 入口。

## 自动部署

常规版本由 [Deploy PWA & Relay 工作流](../.github/workflows/deploy.yml)发布，GHCR 基础决策见 [ADR-20261001](adr/20261001-ci-deploy-ghcr.md)，当前 staging 晋升决策见下方 ADR-20261006：

1. 版本 PR 完成 CI 和评审后合入 `main`；也可手动选择组件运行，但非 `main` 一律拒绝。已有正式标签的组件在 plan 跳过。
2. GitHub 托管 runner 只构建所选组件一次，推送 GHCR 并附来源证明，输出不可变 digest。
3. staging 用受限密钥读取生产当前两个健康组件的快照。所选组件使用本次 build digest；未选组件对齐生产实际 digest，先 Relay 后 PWA。部署后再次核对 staging 两组件的 image/source，并执行 HTTPS、路由、缓存、运行时 Relay、静态资源、Worker/manifest、404 和 WebSocket challenge 检查。地址缺失不跳过。
4. staging 成功后，production Environment 等待维护者审批。审批人先核对本次 run/提交/digest 的真实 iOS、Android 配对、消息、文件、手势、后台恢复及同 origin 缓存升级记录；smoke 不替代真机。
5. 审批后重新核对 staging 组合和未选生产组件，漂移则停止并重新测试。production 直接使用 build digest，不重新构建。健康检查或 `up` 失败按实际旧 image ID 回滚，并使工作流失败。
6. 生产两组件镜像/source 与受测组合一致，且公网 smoke 通过后，才创建所选组件的注解标签和 Release。staging 不创建正式标签/Release。

staging 晋升决策见 [ADR-20261006](adr/20261006-staging-promotion.md)。不维护长期 test/release 分支。

### 功能分支部署 staging

合并前的真机测试由 [Deploy branch to staging 工作流](../.github/workflows/deploy-staging.yml)完成，决策见 [ADR-20261009](adr/20261009-branch-staging.md)：

1. 仓库所有者推送 `bugfix/<名称>` 或 `feature/<名称>`（单层）分支，且改动了 PWA 或 Relay 的构建输入时自动运行；只改文档等其他文件不触发。也可在这些分支上手动运行 workflow_dispatch，重新部署当前提交。
2. `scripts/deploy-branch.mjs` 按分支相对 `main` 分叉点的全部改动选组件：`pwa/`、`pi-extension/install.sh` 选 PWA，`relay/` 选 Relay，`packages/protocol/`、根 `package.json`、锁文件、workspace 配置、`.npmrc`、`pi-extension/package.json` 两者都选。触发路径与这份清单由测试保持一致。
3. 构建只按 digest 推送 GHCR，不移动公开版本标签；镜像版本取分支上的 `package.json`，来源 revision 为分支提交，无需改版本号。
4. 部署沿用 staging 的对齐、部署、快照核对和 smoke：未选组件对齐生产当前实际 digest。运行摘要记录分支和提交；不输出晋升凭据、不进入 production、不创建标签或 Release。
5. 同一分支的新推送取消仍在构建的旧运行；已开始的部署不取消，排队中的部署只保留最新一次，staging 最终是最后一次推送的内容。

分支部署会覆盖 staging：等待审批的发布在批准时会检测到漂移并停止，需要从 `main` 重新运行发布；发布候选做真机验收期间不要推送功能分支。分支部署与发布的 staging 作业同时写入时，服务器锁拒绝后到者，重新运行即可。分支部署不等待 CI，结果只用于测试，不能作为发布验收证据。被替换的分支镜像在服务器上成为悬空镜像，下次 production 部署清理时删除。

协议有变更时，仍须在 PWA 部署完成后再批准 Extension 的 npm 待审版本（见「Extension npm 发布」）。部署 Relay 会让在线连接短暂断开，可选择合适的时机批准。

production 与本机备用入口共用生产目录的 `.pi-reach-deploy-lock`。staging 固定先取得生产目录锁，再取得测试目录锁，保护共享镜像存储中的回滚窗口；已有锁直接拒绝，不自动等待或抢占。staging 不清理镜像，生产仍保留当前及最新若干标签并保护任意容器使用的镜像。部署或快照期间会暂时阻止另一环境操作，这是同机安全取舍。

自动部署不上传 Compose 或服务器入口。脚本变更后，维护者单独同步新版生产入口和测试入口，确认生产固定命令兼容后再触发新流程。严格 Compose 契约与根／测试 Compose 必须同步维护；自定义字段、隐式 `.env`、Compose override 都不能绕过绑定检查。

### 一次性配置

GitHub（仓库 Settings → Environments）：

- 配置 `staging`、`production` 两个 Environment。production 只允许 `main` 并设置维护者 Required reviewers；staging 允许 `main`、`bugfix/*`、`feature/*`，不设审批人。未信任 PR 不得获得密钥。
- 仓库 Ruleset `staging-branches` 作用于 `refs/heads/bugfix/*`、`refs/heads/feature/*`，限制创建和更新，只允许仓库 admin 绕过；不限制删除，合并后可正常删除分支。它保证只有 admin 能用这两类分支部署 staging；增加非 admin 协作者前先核对。
- 每个 Environment 分别设置 Secrets：`DEPLOY_SSH_KEY`、`DEPLOY_KNOWN_HOSTS`、`DEPLOY_HOST`、`DEPLOY_USER`。两套密钥独立，不复用个人密钥；staging 只有 `contents: read`，production 在审批后才使用标签/Release 写权限。
- 每个 Environment 分别设置必填 Variables：`PWA_URL`（HTTPS `/app`）和 `RELAY_URL`（HTTPS Relay 基地址）；SSH 非 22 端口设置 `DEPLOY_PORT`。留空立即失败，不产生假绿灯。测试地址不能填写生产域名，既有 production 配置需另行核对。
- 服务器不是 `linux/amd64` 时，设仓库变量 `DEPLOY_PLATFORM`（如 `linux/arm64`）。

本机生成专用密钥，不复用个人密钥；私钥只放进上面的 Secret：

```bash
ssh-keygen -t ed25519 -N "" -C pi-reach-github-deploy -f ~/.ssh/pi-reach-github-deploy
ssh-keyscan -t ed25519 your-server-host   # 输出即 DEPLOY_KNOWN_HOSTS；非 22 端口加 -p，主机写作 [host]:port
```

`ssh-keyscan` 的结果须与服务器上 `ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub` 显示的指纹一致后再使用。

服务器上，把脚本复制到部署目录下（路径与 `REMOTE_DIR` 一致）：

```bash
# 本机执行
ssh your-deploy-user@your-ssh-alias 'mkdir -p /home/your-deploy-user/pi-reach/bin'
scp scripts/deploy-from-ci.sh your-deploy-user@your-ssh-alias:/home/your-deploy-user/pi-reach/bin/
ssh your-deploy-user@your-ssh-alias 'chmod 755 /home/your-deploy-user/pi-reach/bin/deploy-from-ci.sh'
```

再在部署账号的 `~/.ssh/authorized_keys` 末尾加一行（整条写在同一行，公钥取自 `pi-reach-github-deploy.pub`）：

```text
restrict,command="PI_REACH_REMOTE_DIR=/home/your-deploy-user/pi-reach PI_REACH_IMAGE_PREFIX=ghcr.io/your-github-owner /home/your-deploy-user/pi-reach/bin/deploy-from-ci.sh" ssh-ed25519 AAAA... pi-reach-github-deploy
```

`restrict` 禁止端口转发、终端和用户 rc 文件，`command=` 固定服务器入口。生产旧固定命令未指定环境时仍为 production；未知环境值拒绝。入口接受严格的三字段 `deploy <pwa|relay> <前缀>/pi-reach-<组件>:vX.Y.Z@sha256:<摘要>`，以及两字段 `snapshot <production|staging>`。快照只读固定健康容器对应实际 image ID 的版本、来源 revision、允许仓库 RepoDigest，stdout 仅完整 JSON，不返回容器环境或秘密；无法核验的本地备用镜像会阻止晋升。

`deploy` 的写入环境不接受客户端选择。Compose 使用 `仓库@digest`，版本标签仅保留用于展示/清理；回滚使用更新前实际 image ID，不重新解析可变标签。可选 `PI_REACH_KEEP_IMAGE_VERSIONS` 控制生产保留数（默认 3）。

配置后用这把密钥自检，确认它拿不到 shell，也不能转发端口：

```bash
ssh -i ~/.ssh/pi-reach-github-deploy -o IdentitiesOnly=yes your-deploy-user@your-server-host id
# 预期：✗ Rejected request. Expected: deploy <pwa|relay> ...，退出码 1
ssh -i ~/.ssh/pi-reach-github-deploy -o IdentitiesOnly=yes -o ExitOnForwardFailure=yes -N \
  -R 18082:127.0.0.1:22 your-deploy-user@your-server-host
# 预期：Error: remote port forwarding failed for listen port 18082，立即退出
```

转发检查使用 `-R`：远程转发在建立连接时向服务器申请，被 `restrict` 拒绝后立即失败。`-L` 的监听在本机建立，只有实际连接该端口时服务器才拒绝（`administratively prohibited`），命令本身会一直等待，不适合作为自检。

### 首次运行

GHCR 上新建的镜像包默认私有，服务器无法匿名拉取。首次 staging 前，维护者在 GitHub Packages 确认 `pi-reach-relay` 与 `pi-reach-pwa` 已设为 Public 并关联本仓库（公开后不能再改回私有）；这项变更单独授权。若新包直到首次构建后才出现，staging 拉取会失败，设为公开后重新运行 staging，不能绕过测试直接批准生产。两个镜像只含开源代码与构建产物，不含配置或密钥。

### 失败、修复与重跑

- staging 失败或审批前取消不写生产。失败候选的版本号可能已在 `main`：修复 PR 合入后手动运行工作流，构建同一个未发布版本的新 digest，重新完成 staging 与真机验收；旧 run 的通过结果不能复用。
- 整条流水线串行，包括审批等待期。GitHub 同一 concurrency group 只保留一个运行中和一个 pending run，新 pending 会替换旧 pending；被取消版本须从当前 `main` 手动补跑并重新验收。
- 重跑 production 先核对本次 build 输出、staging 当前组合与生产未选组件。staging 被覆盖、来源变更或生产未选组件漂移时，重新运行完整候选流程，不能生产直达。
- 已上线且镜像/source 仍与本次 run 一致的组件不重复重启，但仍进行公网检查。若所有所选正式标签均指向本次提交且完整受测组合仍在线，可进行仅 Release 补建：不写 Docker、不使用旧 staging 作为新验收证据。标签已创建、Release 创建失败时，重跑失败 production 作业可以补建；标签属于其他提交则拒绝。
- `up` 或容器健康失败会尝试恢复实际旧 image ID；恢复失败须立即检查服务器。公网失败可能意味着镜像已上线，但没有标签/Release；不把工作流失败当作已经恢复生产。
- 多组件不是原子事务：先成功的组件可能已上线，后续失败不自动撤回前一个组件；运行摘要按组件记录实际更新。快照、部署请求之间不构成持锁的跨组件事务，备用部署须避免在晋升期间执行；最终快照会检测组合漂移并阻止 Release。
- 镜像清理失败只警告。锁冲突和遗留锁先确认没有进程再人工处理，不能自动删锁。

### staging 一次性初始化

此节必须另获服务器/GitHub 操作授权；不由普通版本工作流执行。

1. 核验 DNS/TLS、Compose 兼容能力、端口、目录、磁盘/CPU/内存余量和权限。测试使用 `127.0.0.1:3002`／`3003`；发现占用先重新确认映射并同步严格契约，不直接改端口。
2. 创建独立测试目录，把 `docker/staging/compose.yml` 安装为该目录的 `docker-compose.yml`。维护者安装并保护新版入口；不允许 CI 上传执行脚本。根生产 Compose 不必新增默认 Relay 变量，但生产入口必须在首个候选晋升前同步新版。
3. 新建独立 staging SSH 密钥，其 `authorized_keys` 固定命令设置 `PI_REACH_DEPLOY_ENVIRONMENT=staging`、`PI_REACH_REMOTE_DIR=<测试目录>`、`PI_REACH_PRODUCTION_DIR=<生产目录>`、`PI_REACH_IMAGE_PREFIX=<允许前缀>`。客户端不能传这些值；路径实际解析后必须不同。
4. staging 固定服务器环境还须提供 `PI_REACH_DEFAULT_RELAY_URL` 和以下实测限额；Compose 不读取隐式 `.env`，变量须由维护者保护的固定命令或入口 wrapper 提供，不能由 CI 请求注入：

   | 变量 | 用途 |
   | --- | --- |
   | `PI_REACH_STAGING_RELAY_CPUS` / `PI_REACH_STAGING_PWA_CPUS` | 正数 CPU 限额 |
   | `PI_REACH_STAGING_RELAY_MEMORY` / `PI_REACH_STAGING_PWA_MEMORY` | Docker 内存单位的限额 |
   | `PI_REACH_STAGING_RELAY_PIDS_LIMIT` / `PI_REACH_STAGING_PWA_PIDS_LIMIT` | PID 限额 |

   数值由实际资源和 smoke 决定，不把测试 fixture 数字当作部署建议。
5. 使用核验过的生产 Relay 版本和 digest 初始化测试 Relay。旧 PWA 镜像没有运行时 Relay 能力，不部署为测试 PWA；首个候选必须包含新版 PWA（选择 pwa 或 both），由候选流程首次启动它。
6. 保留生产所有 Caddy 路由，新增测试 PWA/Relay 域名分别代理 loopback `3003`／`3002`；validate 完整配置后 reload。共享 Caddy reload 有生产影响风险，不能当作零风险操作。
7. 配置两套 Environment，核对 host key 指纹、分支限制和密钥拒绝 shell/转发。测试 Relay 验证 HTTPS 与 WebSocket；测试 PWA 在首个候选时补验 HTTPS、实际默认 Relay 与配置拒绝路径。最后核对生产容器、镜像和路由未变化。

测试 Pi/身份、浏览器 profile、配对存储应独立。不同 origin 隔离 SW/IndexedDB，但不隔离生产 Pi；不复制生产身份或浏览器数据库。

## PWA 运行时配置

`PI_REACH_DEFAULT_RELAY_URL` 是公开地址，不包含密钥。未设置时镜像沿用 `https://pi-reach-relay.yefengr.cn`，生产根 Compose 无需变更；显式空值或非法值拒绝启动。staging Compose 用必填插值拦截漏配，且首个受测 PWA 启动后 smoke 核对实际地址，不能回落生产。

非 root 启动脚本校验 URL 并原子替换入口 HTML 的 `meta[name="pi-reach-default-relay-url"]`。接受绝对 HTTP(S)/WS(S) 与合法自托管路径/query，拒绝凭据、fragment、空白和注入字符；公网两环境必须 HTTPS/WSS。meta 缺失、重复、非法或不可写时拒绝启动，不打印原配置。dev/preview 的源入口包含公开生产默认 meta。

浏览器默认值只有这个 meta 入口：初始化、旧默认迁移、空输入回退和设置页默认展示一致，用户显式保存的自定义 Relay/配对语义不改变。Service Worker 预缓存实际 `/app` 注入 HTML，并为运行时入口使用独立、按构建 revision 的导航缓存；全新离线启动和旧 worker 交接不能读取旧无配置导航壳。配置不新增 fetch，也不按环境重新构建镜像。

本地真实镜像验收使用 `node pwa/scripts/verify-runtime-image.mjs <已构建镜像>`，固定同一个 image ID，启动生产、测试和缺省配置并检查入口，验证非法值、缺 meta、只读注入失败后清理临时容器。它不连接 Relay，不证明真机、远程 HTTPS 或生产晋升。

## 部署

本机脚本用于备用发布、更新 `docker-compose.yml` 与首次初始化。命令形式为：

```bash
./scripts/deploy-self-hosted.sh [pwa|relay|both]
```

`pwa` 只处理 PWA 镜像和 `pwa` 服务，`relay` 只处理 Relay 镜像和 `relay`，`both` 处理两者；不带参数等价于 `both`。`deploy.env` 中的 `SCOPE` 不会覆盖命令行选择和默认值。已移除的 `test`、`promote` 参数按用法错误拒绝。

远端 Docker 检查通过后，脚本会在 `REMOTE_DIR` 下原子创建 `.pi-reach-deploy-lock`；同一部署目录已有运行中部署或遗留锁时，会在本机构建、镜像传输和 `docker-compose up` 前拒绝执行。正常退出及可处理的错误或中断会释放锁；`SIGKILL`、网络硬断等情况可能留下 stale lock。遇到锁冲突时，先核对本机和服务器均无部署进程，再在服务器手工执行 `rmdir /实际/REMOTE_DIR/.pi-reach-deploy-lock`。脚本不会自动抢占或删除未知锁。

脚本会：

1. 读取未提交的 `deploy.env`，检查 SSH、Docker 与 Compose；
2. 只为所选 scope 构建对应服务器架构的镜像，可选推送远程镜像；
3. 上传 `docker-compose.yml`，只压缩并传输所选镜像，并记录远端镜像 ID 摘要；
4. 用 Compose 规范化配置，与服务器入口内的完整生产契约比较；禁止隐式 `.env`／Compose override，解析或匹配失败时不传输应用镜像、不更新服务；
5. 只更新所选服务，并等待每个容器变为 `healthy`；
6. 按 scope 检查 `RELAY_URL` 的 `/health` 与 `PWA_URL`，变量留空时跳过对应检查；
7. 在服务器和本机分别清理所选服务的旧镜像：每个镜像仓库保留本次部署的标签及最新的其他标签，共 `KEEP_IMAGE_VERSIONS` 个（默认 3），删除更旧的标签和带 `pi-reach.image` 标签的悬空镜像。

镜像清理只处理本次部署的 `pi-reach-relay`、`pi-reach-pwa` 仓库和带 `pi-reach.image` 标签的悬空镜像，跳过任何容器（包括已停止容器）正在使用的镜像；`KEEP_IMAGE_VERSIONS=0` 关闭清理。清理只在健康检查和公网检查通过后执行，失败时只输出警告，不改变部署结果。

单服务 scope 解析 Compose 时会把未选服务的镜像变量替换为固定无效占位符，未选服务不会出现在 build、transfer 或 `docker-compose up` 操作中。日志中的部署元数据只包含 scope、所选镜像引用与 ID 摘要，不打印 `deploy.env` 内容、SSH 凭据或有效配置正文。

部署后人工打开 PWA 复核，建议至少检查：

- 页面资源和静态文件正常；
- PWA 设置中的 Relay URL 正确；
- 新二维码扫描或粘贴配对流程；
- device/endpoint 列表、当前 endpoint 选择和连接状态；
- 发送消息、接收输出、刷新页面后的本地历史；
- 浏览器 Console 和 Relay 日志无异常。

脚本不执行自动回滚；若更新服务后健康检查或公网检查失败，应先核对实际容器状态并单独确认恢复方案（例如检出上一个可用提交后重新部署），不把脚本退出失败理解为线上环境已自动恢复。

## 镜像模式

### 默认：本地构建并传输

```dotenv
PUBLISH_IMAGES=0
```

镜像只在本机 Buildx 和服务器 Docker 中存在，标签由 `IMAGE_NAMESPACE`、`RELAY_VERSION` 和 `PWA_VERSION` 组成；构建时附加 `pi-reach.image=relay|pwa` 镜像标签，供清理步骤识别被新版本顶替后失去标签的本项目镜像。每次部署递增所选服务的版本，避免同一标签指向不同构建。服务器 Compose 使用脚本注入的 `RELAY_IMAGE`、`PWA_IMAGE`；本机入口在加载后解析并使用实际 image ID 运行，版本标签仅用于追溯和清理，不会把本机命名空间写入仓库文件。

如服务器是 `x86_64`，脚本相当于构建：

```bash
docker buildx build --platform linux/amd64 --load \
  --tag pi-reach-local/pi-reach-pwa:v0.0.1 --file pwa/Dockerfile .

docker buildx build --platform linux/amd64 --load \
  --tag pi-reach-local/pi-reach-relay:v0.0.1 --file relay/Dockerfile .
```

Relay 镜像同样以仓库根为构建上下文，使用根锁文件构建 Node 服务和私有共享协议包。运行层使用非 root Node 用户，自包含生产依赖；入口为 `node dist/main.js`，端口仍由 `PI_REACH_RELAY_PORT` 控制，健康检查仍为 `/health`。资源与超时配置见 [Relay README](../relay/README.md#resource-limits)。停止容器时应预留不小于 Relay shutdown deadline 的时间。

本地隔离 Relay 验收使用 `docker/e2e/compose.yml`。其 runner 会按该文件重新构建、重建服务，临时 overlay 不会自动继承到 runner 内部。验收前核对容器 image ID 和入口；不能用线上 PWA 启动成功代替 Node Relay 验收，也不能用本地通过推断远程版本已切换。

随后执行等价的流式传输：

```bash
docker save \
  pi-reach-local/pi-reach-relay:v0.0.1 \
  pi-reach-local/pi-reach-pwa:v0.0.1 \
  | gzip \
  | ssh your-deploy-user@your-ssh-alias 'gzip -dc | docker load'
```

服务器启动由脚本显式指定 Compose 文件、禁用隐式 `.env`，并注入实际 image ID；`up -d --pull never` 只更新所选服务。不要通过手工标签插值替代这些检查。

### 可选：同时推送远程镜像

只有明确需要给其他机器拉取镜像时才开启：

```dotenv
IMAGE_NAMESPACE=your-dockerhub-user
PUBLISH_IMAGES=1
```

先确保本机已经登录目标仓库：

```bash
docker login
```

此模式会额外执行 Buildx `--push`。它推送当前服务器架构的镜像；多架构公共发布仍可单独使用：

```bash
IMAGE=your-dockerhub-user/pi-reach-pwa ./pwa/push-docker.sh v0.0.1
IMAGE=your-dockerhub-user/pi-reach-relay ./relay/push-docker.sh
```

不要把 Token 写入 `deploy.env`、脚本、Compose 或 Git。

## Compose 运行结构

根生产 Compose 项目固定为 `pi-reach`，包含两个服务：

```text
Relay: 127.0.0.1:3000 -> 容器 3000（容器 pi-reach-relay）
PWA:   127.0.0.1:3001 -> 容器 3000（容器 pi-reach-pwa）
```

当前 [Compose](../docker-compose.yml) 的 Relay 服务没有业务卷或 SQLite membership 存储。Relay 的 endpoint registry 和 ACL 仅保存在内存中，重启后由 Host/Owner 重连重建；旧环境是否残留历史 volume 不在本流程中自动清理。PWA 不保存服务端业务会话数据，浏览器本地使用 IndexedDB；Host 身份、配对和 Pi 会话保存在运行 Pi 的电脑上，而不是这些 Relay/PWA 容器中。

PWA 的 Compose 服务名、容器名与镜像名为 `pwa`／`pi-reach-pwa`，部署变量为 `PWA_VERSION`／`PWA_IMAGE`。2026-10-01 之前的 `site`／`pi-reach-site`／`SITE_VERSION` 已停用，本机脚本遇到 `SITE_VERSION` 会提示改名。现有入口不自动移除 orphan 容器；若服务器仍有旧容器，先核对归属与端口并单独授权清理。

服务器上查看状态。Compose 文件的镜像变量只由部署脚本注入，手工排查直接按容器名查看，避免 `docker-compose ps` 因变量未设置而解析失败：

```bash
docker ps --filter name=pi-reach
docker logs --tail=100 pi-reach-relay
docker logs --tail=100 pi-reach-pwa
```

服务器本机健康检查：

```bash
curl http://127.0.0.1:3000/health
curl -I http://127.0.0.1:3001/app
```

## Caddy 一次性配置

普通版本部署不修改 Caddy。只有首次部署、域名变化或容器端口变化时才需要调整。

假设使用两个域名：

```text
pwa.example.com
relay.example.com
```

DNS 都指向服务器公网 IP，并在云厂商安全组/防火墙开放 TCP `80` 和 `443`。不要把 `3000`、`3001` 暴露到公网。

Caddyfile 追加：

```caddyfile
pwa.example.com {
    encode zstd gzip
    reverse_proxy 127.0.0.1:3001
}

relay.example.com {
    reverse_proxy 127.0.0.1:3000
}
```

应用配置前先检查：

```bash
sudo caddy fmt --overwrite /etc/caddy/Caddyfile
sudo caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
sudo systemctl reload caddy
```

Caddy 会自动申请和续期公开 HTTPS 证书，并自动转发 Relay 的 WebSocket Upgrade。客户端使用 HTTPS Relay URL：

```text
PWA Relay URL: https://relay.example.com
Pi extension:  https://relay.example.com
```

## 配对检查

二维码当前不携带 Relay 地址。切换到自建 Relay 后，必须在 PWA 设置中保存：

```text
https://relay.example.com
```

然后在 Pi 重新生成二维码：

```text
/pi-reach pair
```

配对超时时，先确认 PWA 和 Pi 使用同一个 Relay。服务器查看 Relay 日志：

```bash
docker logs -f pi-reach-relay
```

一次成功的配对应能看到 Pi 和浏览器两条认证连接。二维码或复制代码包含一次性凭据，不要写入文档、日志、Issue 或聊天记录。

## 发布脚本

`pwa/push-docker.sh` 和 `relay/push-docker.sh` 支持通过 `IMAGE` 覆盖镜像名：

```bash
IMAGE=your-dockerhub-user/pi-reach-pwa ./pwa/push-docker.sh v0.0.1
IMAGE=your-dockerhub-user/pi-reach-relay ./relay/push-docker.sh
```

不传 `IMAGE` 时使用 `REGISTRY_NAMESPACE`，再没有时使用本地占位命名空间。日常服务器部署不需要调用这两个发布脚本，直接执行 `./scripts/deploy-self-hosted.sh` 即可。

## Extension npm 发布

Extension 以 `@yefengr/pi-reach` 发布到 npm。常规发布由 Extension npm 工作流（`.github/workflows/release.yml`）完成：`pi-extension/package.json` 的版本号变更合并到 `main` 后，工作流以 npm trusted publishing（GitHub OIDC）认证，运行 `pi-extension/publish-npm.sh --stage` 把新版本提交到 npm 待审区，维护者在 npmjs.com 用双重验证批准后才正式上线。仓库和 GitHub 中不保存 npm token。版本号一经发布不可复用。

`publish-npm.sh` 确认该版本尚未发布，运行 Extension 的 `pnpm verify`，用 `pnpm pack` 打包并检查 tarball，再以公开访问上传这个 tarball。默认直接发布；`--stage` 改为执行 `npm stage publish` 提交待审，需要 npm 11.15.0 或更高版本。

发布步骤：

1. 协议有变更时先部署 PWA，再发布 Extension（[ADR-20260927](adr/20260927-run-end-event.md)）；可核对线上 PWA 的脚本是否已包含新增的帧或事件类型。
2. 修改 `pi-extension/package.json` 的 `version`，经 Pull Request 合并到 `main`。
3. Extension npm 工作流确认版本号确有变化且 npm 上尚无该版本后提交待审；版本号未变的推送（如只改依赖）或该版本已发布时跳过。也可在 Actions 页面手动运行，此时不比较版本号。提交成功后，工作流在本次提交上打 `extension-vX.Y.Z` 注解标签（原因见「版本标签与 GitHub Release」）。
4. 在 npmjs.com 的 Staged Packages 中核对并批准，或在交互式终端执行 `npm stage list @yefengr/pi-reach` 与 `npm stage approve <stage-id>`；批准需要双重验证。
5. 上线后由 Extension GitHub Release 工作流基于该标签自动创建 Release，见「版本标签与 GitHub Release」。

npm 侧一次性配置（需要网页登录与双重验证）：

- 在包设置的 Trusted publishing 中添加 GitHub Actions：用户 `yefengr`、仓库 `pi-reach`、工作流文件 `release.yml`，Environment 留空，不勾选允许直接 `npm publish`（`npm stage publish` 始终允许）。工作流文件改名时同步修改此配置；只改工作流显示名称不受影响。
- Extension npm 工作流跑通后，把包设置的 Publishing access 改为 “Require two-factor authentication and disallow tokens”，并撤销可跳过双重验证的 token。

本地发布（备用）：

- 认证使用交互式终端的 `npm login` 或环境变量 `NPM_TOKEN`。使用 `NPM_TOKEN` 时，脚本写入只引用该变量的临时 npmrc，token 不落盘。
- `bash pi-extension/publish-npm.sh --stage` 提交待审，不需要双重验证。不加 `--stage` 时直接发布：交互式会话需要输入验证码，非交互环境（CI、agent 的 shell）只能使用可跳过双重验证的 token；包设置禁止 token 后，token 只能提交待审。
- 可跳过双重验证的细粒度 token 不能执行 `npm unpublish`。

核对：

```bash
npm view @yefengr/pi-reach version
```

新版本在批准或直接发布后才出现在 registry。npm 异步处理上传（返回 202），新版本通常几分钟后才可见，可能超过脚本直接发布时约 60 秒的确认等待；脚本此时只给出警告，稍后用 `npm view` 核对即可。处理完成前对同一个包执行 `npm deprecate` 会返回 422。首次发布新包时，npm 会自动生成 `0.0.0-stage` 占位版本，无需处理。发布后按 [Extension 协作规范](../pi-extension/AGENTS.md)在仓库之外安装并加载新版本。

## 版本标签与 GitHub Release

PWA 与 Relay 在上线核对后，由 Deploy PWA & Relay 工作流在实际受测的 `main` 源提交上打注解标签并创建同名 Release；同版本修复候选的标签指向修复后的受测提交，不沿用被拒候选。Extension 的标签仍由 Extension npm 工作流在提交待审时创建，Release 由 [Extension GitHub Release 工作流](../.github/workflows/extension-github-release.yml)在 npm 上线后创建；下面的手工命令只用于本机备用部署或工作流无法运行时，仍须单独授权：

| 组件 | 标签 | 版本来源 |
|---|---|---|
| Extension | `extension-vX.Y.Z` | `pi-extension/package.json`，即 npm 上的 `@yefengr/pi-reach@X.Y.Z` |
| PWA | `pwa-vX.Y.Z` | `pwa/package.json`；部署时 `PWA_VERSION` 使用 `vX.Y.Z` |
| Relay | `relay-vX.Y.Z` | `relay/package.json`；部署时 `RELAY_VERSION` 使用 `vX.Y.Z` |

- PWA 与 Relay 在部署并核对后打标签。Extension 在提交 npm 待审时打标签，上线后才创建 Release，因此有标签而没有 Release 的 Extension 版本表示仍在待审或未获批准。同一提交可以同时带多个组件的标签。
- Extension 的标签不能等到上线后再打：工作流的 `GITHUB_TOKEN` 没有 `workflows` 权限，目标提交的 `.github/workflows` 与 `main` 最新提交不一致时，GitHub 拒绝创建标签（HTTP 403 `Resource not accessible by integration`）。提交待审时本次提交仍是最新提交；待审期间若有其他改动工作流的提交合入，该步骤会失败，需手工打标签。
- Extension GitHub Release 工作流按计划每 30 分钟检查一次，也可在 Actions 页面手动运行。GitHub 只尽力调度定时任务，实际间隔可能长达数小时，新增或修改定时配置后也可能隔数小时才开始触发；批准上线后需要尽快看到 Release 时手动运行。npm 上已有当前版本而 Release 缺失时，基于已有标签创建 Release 并标记 Latest；尚未批准时跳过，下次再查；已上线但缺少标签时失败。Release 说明包含 npm 链接，以及自上一个已在 npm 上线的 `extension-v*` 版本以来涉及 `pi-extension/` 或 `packages/protocol/` 的非发布提交；未获批准版本的标签不作为起点。手动运行时可填写历史版本补建，补建的 Release 不标记 Latest。
- 缺少 Extension 标签时，由维护者用具备 `workflow` 权限的账号执行下方第一行命令打标签（`<commit>` 为 `pi-extension/package.json` 版本号变为该版本的提交），再手动运行 Extension GitHub Release 工作流创建 Release。
- 仓库 60 天没有活动时，GitHub 会停用定时工作流，需在 Actions 页面重新启用。
- Release 说明写该组件的变更与发布去向（npm 版本，或线上地址与镜像标签）。Extension 的 Release 标记为 Latest，其余不标记。

每个上线的组件各执行一组命令；各组件版本号相互独立，`--verify-tag` 要求标签已推送到远端：

```bash
git tag -a extension-vX.Y.Z -m "Extension X.Y.Z" <commit> && git push origin extension-vX.Y.Z
gh release create extension-vX.Y.Z --verify-tag --title "Extension X.Y.Z" --notes-file extension.md --latest

git tag -a pwa-vX.Y.Z -m "PWA X.Y.Z" <commit> && git push origin pwa-vX.Y.Z
gh release create pwa-vX.Y.Z --verify-tag --title "PWA X.Y.Z" --notes-file pwa.md --latest=false

git tag -a relay-vX.Y.Z -m "Relay X.Y.Z" <commit> && git push origin relay-vX.Y.Z
gh release create relay-vX.Y.Z --verify-tag --title "Relay X.Y.Z" --notes-file relay.md --latest=false
```

## 故障排查

### `docker compose` 不存在

服务器可能安装的是独立命令：

```bash
docker-compose version
```

服务器入口使用 `docker-compose`，要求支持 `--env-file`、`--project-directory` 与 `config --format json` 的 Compose v2 或更新兼容版本。初始化前用实际命令核验；仅有旧 Compose v1 时停止，不自动安装或替换工具。JSON 仅由 Compose 规范化后整体比较，不要求服务器安装 Node/jq。

### Docker Hub 超时

先区分失败发生在本机基础镜像/依赖获取、可选镜像推送，还是 SSH 镜像传输。`PUBLISH_IMAGES=0` 只关闭应用镜像推送，不消除本机构建对基础镜像和依赖源的需求；服务器接收的是本机传输的镜像，不需要从 Docker Hub 拉取这些应用镜像。

本机脚本默认使用 `docker-container` 驱动的 Buildx 构建器，它不继承 Docker 守护进程的代理设置。守护进程能拉取镜像、构建却在解析 `docker/dockerfile` 时超时，可改用 `docker` 驱动的构建器，例如 `BUILDER=<构建器名> ./scripts/deploy-self-hosted.sh pwa`（`docker buildx ls` 查看可用构建器）。自动部署在 GitHub 托管 runner 上构建，不受本机网络影响。

### 容器不是 healthy

```bash
docker ps --filter name=pi-reach
docker logs --tail=200 pi-reach-relay
docker logs --tail=200 pi-reach-pwa
curl http://127.0.0.1:3000/health
curl -I http://127.0.0.1:3001/app
```

### HTTPS 失败

确认：

- DNS A/AAAA 记录指向服务器；
- TCP `80/443` 已开放；
- Caddyfile 校验通过；
- 容器本机端口正常；
- Caddy 服务状态为 `active`。

```bash
sudo systemctl status caddy --no-pager
sudo journalctl -u caddy -n 100 --no-pager
```

不要为了绕过证书问题把客户端改成公网 `ws://`，生产环境必须使用 HTTPS/WSS。

## 安全边界

部署脚本不会：

- 读取、上传或修改 SSH 私钥；
- 读取或保存服务器密码、Docker Hub Token；
- 修改 `/etc/caddy/Caddyfile`；
- 重启 Docker daemon；
- 停止无关容器；
- 执行 `docker system prune`，或删除本项目镜像仓库和 `pi-reach.image` 标签以外的镜像；
- 在默认模式下向 Docker Hub 推送应用镜像，或要求服务器拉取这些应用镜像。

服务器入口仅接受严格的部署和固定容器只读快照请求，不执行任意命令，不修改 Compose、Caddy 或自身。staging、production 使用各自 Environment 密钥；production 在维护者审批后可用，均不能登录终端或转发端口。staging 密钥可读取固定生产镜像快照，但写入环境只由服务器固定命令指定。

受限命令不是 Docker 权限沙箱：同机共享内核、磁盘和高权限部署账号仍有风险。入口、Compose 与固定命令必须由维护者安装并保护，不能允许 CI 上传任意脚本后执行。
