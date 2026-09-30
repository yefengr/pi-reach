## 摘要 / Summary

<!-- 改了什么、为什么改；关联 issue 写 Closes #编号。可以用中文或英文。 / What changed and why; link issues with "Closes #N". Chinese or English is fine. -->

## 验证 / Verification

<!-- 列出实际运行的命令与结果；没有运行的说明原因。 / List the commands you ran and their results; explain anything you skipped. -->

- [ ] 受影响的验证命令，如 `pnpm verify` 或 `pnpm --filter <包名> test` / Affected verification commands
- [ ] `git diff --check`
- [ ] 改动文档时运行 `pnpm check:docs` / `pnpm check:docs` for documentation changes

## 检查 / Checklist

- [ ] 行为变更附带了自动化测试 / Behavior changes include automated tests
- [ ] 不包含配对码、私钥、token 或会话内容 / No pairing codes, private keys, tokens, or session content
- [ ] 涉及协议、配对、架构或安全方向时，已核对[已关闭决策](https://github.com/yefengr/pi-reach/blob/main/docs/adr/20260518-closed-decisions.md) / Checked the closed decisions for protocol, pairing, architecture, or security changes
