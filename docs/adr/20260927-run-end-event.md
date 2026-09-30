# ADR-20260927: 本轮结束事件与整次运行状态

- 状态：已接受
- 日期：2026-09-27

## 背景

[品牌刷新方案](../plans/active/20260925-pi-reach-brand-refresh.md)规定：Pi 的一轮回复（同一 `group_id` 的思考、工具与正文）结束后，在末尾显示一次完成时间；非当前查看的在线 Pi 跑完一轮时，侧栏显示后台完成提醒。两者都要求 PWA 可靠地知道「一轮是否结束」。

现有协议不能提供这一信号：

- Extension 在 `agent_start` 生成 `group_id`、在 `agent_end` 结束该组，但不向 PWA 发出结束通知，历史中也没有结束记录。
- endpoint metadata 的 `working` 跟随 Pi 的 `turn_start`／`turn_end`。一次运行包含多次模型调用，`working` 会在工具调用之间短暂变为 `false`，不能代表整次运行结束。

[已关闭决策](20260518-closed-decisions.md)「Protocol v2 inner schema」（2026-08-25）将 TimelineEvent 定为严格校验并冻结，不提供 v1 回退、双读双写或降级。新增事件类型需要显式决策。

## 决策

1. **新增本轮结束事件**：TimelineEvent 新增 `kind: "run_end"`，携带通用字段 `event_id`、`session_id`、`leaf_id`、`timestamp`，以及 `group_id` 和 `status`（`complete`／`interrupted`／`error`）。Extension 在 `agent_end` 时为当前组生成该事件，按现有 timeline marker 机制持久化，实时推送与历史回放使用同一事件。`status` 由本次运行的最终结果决定，具体映射在实施时随 Extension 测试确定。
2. **`working` 改为按整次运行计算**：Extension 在 `agent_start` 置 `working = true`、在 `agent_end` 置 `false`，不再跟随 `turn_start`／`turn_end`。字段名与类型不变，只改变语义。
3. **PWA 的使用方式**：以 `run_end` 判断一轮结束并显示轮末时间；以 `working` 由 `true` 变为 `false` 触发非当前会话的后台完成提醒。

## 兼容与发布顺序

- 严格 schema 下，旧版 PWA 收到 `run_end` 会解码失败。发布时须**先部署支持 `run_end` 的 PWA，再发布新 Extension**。
- 新版 PWA 必须容忍没有 `run_end` 的会话（旧 Extension 与旧历史），按方案中的降级规则处理：出现后续一轮即视为前一轮已结束；最后一轮在不处于运行状态时取该轮最后一个事件的时间。
- 不引入协议版本号变化或双读双写；`protocol_version` 仍为 2。本 ADR 修订「Protocol v2 inner schema」冻结范围，仅限新增 `run_end` 这一种事件。
- `packages/protocol` 的 schema、[会话协议](../reference/protocol/protocol-v2.md)与 contract 测试须在同一变更中更新。

## 后果

- 轮末时间与后台完成提醒有了可靠信号，不再依赖计时推断。
- 侧栏「运行中」状态在一次运行期间保持稳定，不在工具调用之间闪烁。
- 历史中新增一类事件；删除配对或清除本地数据时随其他正式事件一起删除，所有权不变。
- Extension 与 PWA 的发布需要按上述顺序协调。

## 备选方案

- **仅由 PWA 推断结束**（出现下一轮或 `working` 持续为 `false` 一段时间）：拒绝作为主方案。实时会话会有延迟与误判，只保留为旧数据的降级规则。
- **在 endpoint metadata 中增加「最近完成的 `group_id`」**：拒绝。metadata 不持久，历史回放无法得到结束信息。
- **只修正 `working`、不新增事件**：拒绝。只能用于在线会话，不能为历史中的每一轮提供结束时间。

## 非目标

本决策不增加思考时长、工具耗时统计、token 用量或模型归属等元数据，也不改变 `group_id` 的生成规则。
