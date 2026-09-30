# 安全策略

**简体中文** · [English](#security-policy)

Pi Reach 通过 Relay 远程操作你电脑上正在运行的 Pi coding agent，而 Pi 可以在电脑上执行命令。安全问题可能直接影响用户的电脑，请私下报告，不要公开披露。

## 报告漏洞

请通过 GitHub 的私密漏洞报告提交：打开仓库的 [Security](https://github.com/yefengr/pi-reach/security) 页面，点击 **Report a vulnerability**，或直接打开[提交表单](https://github.com/yefengr/pi-reach/security/advisories/new)。报告只有维护者可见。

不要在公开 issue、讨论区或 Pull Request 中披露漏洞细节。

报告中请尽量说明：

- 受影响的组件与版本，例如 Extension 版本，以及使用的是公共实例还是自托管的 Relay 与 PWA；
- 复现步骤与实际影响；
- 可行的修复思路（如有）。

报告中不要附带真实的私钥、配对码、token 或他人的会话内容；需要示例时请使用测试数据。

## 处理流程

- 维护者会尽快确认收到报告，并与你私下沟通修复方案和披露时间。
- 修复发布后，会通过 GitHub Security Advisory 公开说明。

## 范围

在范围内：

- 本仓库的 Pi Extension（npm 包 `@yefengr/pi-reach`）、Relay 与 PWA；
- 维护者运营的公共实例：PWA `https://pi-reach.yefengr.cn` 与 Relay `https://pi-reach-relay.yefengr.cn`。

以下属于已知的设计边界，不视为漏洞，详见[协议与安全说明](docs/reference/protocol/README.md#trust-model)：

- 没有应用层端到端加密：Relay 运营方可以读取会话内容，并可冒充已配对的浏览器发送指令；
- 电脑、浏览器或手机本身被攻陷后的风险。

测试公共实例时不要影响其他用户：不做拒绝服务测试，不访问或修改他人的数据。

## 支持的版本

项目仍处于早期阶段，只为最新发布的版本提供安全修复。

---

# Security Policy

[简体中文](#安全策略) · **English**

Pi Reach remotely controls the Pi coding agent running on your computer through a Relay, and Pi can run commands on that computer. A security issue can directly affect users' machines, so please report it privately instead of disclosing it publicly.

## Reporting a vulnerability

Use GitHub's private vulnerability reporting: open the repository's [Security](https://github.com/yefengr/pi-reach/security) tab and click **Report a vulnerability**, or go straight to the [report form](https://github.com/yefengr/pi-reach/security/advisories/new). Only maintainers can see the report.

Do not disclose vulnerability details in public issues, discussions, or pull requests.

If possible, include:

- the affected component and version, such as the Extension version, and whether you used the public instances or a self-hosted Relay and PWA;
- steps to reproduce and the actual impact;
- a possible fix, if you have one.

Do not include real private keys, pairing codes, tokens, or other people's conversations in the report; use test data for examples.

## What happens next

- The maintainer will acknowledge the report as soon as possible and work with you privately on a fix and a disclosure timeline.
- Once a fix is released, it will be described in a GitHub Security Advisory.

## Scope

In scope:

- the Pi Extension (npm package `@yefengr/pi-reach`), Relay, and PWA in this repository;
- the public instances run by the maintainer: the PWA at `https://pi-reach.yefengr.cn` and the Relay at `https://pi-reach-relay.yefengr.cn`.

The following are known design boundaries rather than vulnerabilities; see the [protocol and security reference](docs/reference/protocol/README.md#trust-model) (Chinese):

- there is no application-layer end-to-end encryption, so the Relay operator can read conversations and could impersonate a paired browser to send instructions;
- risks after the computer, browser, or phone itself is compromised.

When testing the public instances, do not affect other users: no denial-of-service testing, and do not access or modify other people's data.

## Supported versions

Pi Reach is at an early stage. Security fixes are provided for the latest release only.
