# 参与贡献

感谢你关注 Pi Reach。本文说明如何反馈问题和提交改动；开发环境与常用命令见 README 的[本地开发](README.md#本地开发)，协作与验证约定见 [AGENTS.md](AGENTS.md)。

## 反馈问题

- Bug 与功能建议请通过 [Issue 模板](https://github.com/yefengr/pi-reach/issues/new/choose)提交。
- 安全漏洞不要公开提交，请按[安全策略](SECURITY.md)使用私密漏洞报告。
- 不要在 issue、日志或截图中附带配对码、私钥、token 或会话内容。

## 提交改动

1. 较大的改动先开 issue 讨论方向。涉及架构、协议、配对、UI 或安全方向时，先阅读[已关闭决策](docs/adr/20260518-closed-decisions.md)。
2. 从 `main` 创建分支，按 [AGENTS.md](AGENTS.md) 的工作规则修改；行为变更需要附带自动化测试。
3. 提交前运行受影响的验证命令和 `git diff --check`；改动文档时运行 `pnpm check:docs`。
4. 提交 Pull Request，按模板填写摘要与验证结果。PR 可以用中文或英文，Codex 会用同一语言自动评审。
5. CI 检查 `verify` 通过、评审意见处理完毕后，由维护者以变基或压缩方式合并。

贡献的代码按 [MIT 许可证](LICENSE)发布。

---

# Contributing

Thanks for your interest in Pi Reach. This guide covers reporting issues and submitting changes. For the development setup and common commands, see [Development](README.en.md#development) in the README; collaboration and verification rules are in [AGENTS.md](AGENTS.md) (in Chinese).

## Reporting issues

- Use the [issue templates](https://github.com/yefengr/pi-reach/issues/new/choose) for bugs and feature requests.
- Do not report security vulnerabilities publicly. Follow the [security policy](SECURITY.md) and use private vulnerability reporting.
- Never include pairing codes, private keys, tokens, or session content in issues, logs, or screenshots.

## Submitting changes

1. Open an issue to discuss larger changes first. For changes to architecture, protocol, pairing, UI, or security direction, read the [closed decisions](docs/adr/20260518-closed-decisions.md) first.
2. Branch from `main` and follow the working rules in [AGENTS.md](AGENTS.md). Behavior changes need automated tests.
3. Before submitting, run the affected verification commands and `git diff --check`; run `pnpm check:docs` when you change documentation.
4. Open a pull request and fill in the template's summary and verification sections. Pull requests may be written in Chinese or English; Codex reviews them automatically in the same language.
5. Once the CI check `verify` passes and review comments are resolved, a maintainer merges the pull request by rebase or squash.

Contributions are released under the [MIT License](LICENSE).
