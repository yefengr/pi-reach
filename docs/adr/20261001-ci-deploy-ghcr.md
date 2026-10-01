# ADR-20261001: PWA 与 Relay 经 GHCR 自动部署

- 状态：已接受
- 日期：2026-10-01

## 背景

Extension 已由 Release 工作流在版本号合并后自动提交 npm 待审，维护者批准后上线。PWA 与 Relay 仍由维护者在本机运行 `scripts/deploy-self-hosted.sh`：本机构建镜像，`docker save` 经 SSH 传到服务器，再手工打标签、写 Release。

这条路径有几个问题：

- 本机是 arm64、服务器是 amd64，镜像需跨架构构建，较慢；构建依赖本机网络，2026-10-01 部署 PWA 0.0.3 时，Buildx 构建器连不上 Docker Hub，前两次部署失败。
- 镜像不进入任何仓库，线上运行的是哪次构建只能靠本机记录核对；标签与 Release 全靠手工。
- 服务器无法访问 Docker Hub，但实测可以访问 GHCR（`ghcr.io` 与 `pkg-containers.githubusercontent.com`）。

业界常见做法是 CI 构建不可变镜像并推送到镜像仓库，按版本与摘要部署；单机 Compose 场景多由 CI 在审批后通过 SSH 触发服务器拉取。服务器没有 OIDC 一类的免密钥认证，通行做法是受保护环境中的专用部署密钥，并在服务器端限制它能执行的命令。公开仓库不应在生产服务器上运行自托管 runner。

## 决策

1. 新增 Deploy 工作流：`relay/package.json` 或 `pwa/package.json` 的版本号变更合并到 `main` 后（或手动运行），在 GitHub 托管 runner 上构建服务器架构的镜像，以 `GITHUB_TOKEN` 推送到 `ghcr.io/<owner>/pi-reach-relay|pi-reach-site:vX.Y.Z`，并附 GitHub 构建来源证明。GHCR 镜像包设为公开，服务器拉取不需要凭据。
2. 部署作业使用 `production` Environment：需维护者批准，只允许 `main`，SSH 私钥、主机公钥、主机与账号均为该环境的 Secrets。
3. 服务器的 `authorized_keys` 以 `restrict` 与 `command=` 把这把专用密钥限定为执行 `scripts/deploy-from-ci.sh`。脚本只接受 `deploy <site|relay> <前缀>/pi-reach-<site|relay>:vX.Y.Z@sha256:<摘要>`：按摘要拉取并打版本标签，只更新所选服务；健康检查失败时恢复部署前的镜像。它与本机脚本共用部署锁，不修改 `docker-compose.yml`、Caddy 或自身。
4. 公网检查通过后，工作流在本次提交上创建注解标签 `relay-vX.Y.Z`／`pwa-vX.Y.Z` 与 GitHub Release（不标记 Latest）。
5. 本机 `deploy-self-hosted.sh` 保留，用于备用发布、更新 Compose 文件与首次初始化。

## 后果

- 发布 PWA 或 Relay 只需合并版本号 PR 并批准部署；构建不再受本机网络与架构影响，线上镜像可按摘要和来源证明追溯。
- 「服务器不从镜像仓库拉取应用镜像」只对本机脚本成立；自动部署依赖服务器能访问 GHCR。
- GitHub 中保存一把能在服务器上执行部署脚本的私钥，其权限受 Environment 审批、分支限制和 `command=` 约束；部署账号仍在 docker 组内，脚本被替换即可越权，因此脚本只由维护者手工安装。
- `docker-compose.yml` 或 `deploy-from-ci.sh` 变更后，须用本机脚本或手工同步到服务器，自动部署不会带上它们。
- 协议变更仍须先部署 PWA 再批准 Extension 的 npm 待审版本（[ADR-20260927](20260927-run-end-event.md)）。
