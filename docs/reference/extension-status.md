# 扩展状态约定

其他 Pi 扩展可以选择把简短状态显示在 Pi Reach 的会话状态卡片和抽屉里。Pi Reach 不读取本地 `ctx.ui.setStatus()` 的内容；同一条状态要在终端和 PWA 显示时，由扩展分别发布。

## 发布到远程页面

`pi-reach:status` 是远程发布接口。文字会发送到已授权且已订阅的浏览器，并经过 Relay。不要发布凭据、令牌或仅供本机查看的信息。Pi Reach 不从自由文本中识别秘密。Relay 实现不解析、不记录状态内容，但当前载荷不做应用层端到端加密，Relay 运营方技术上可读。

通过 `pi.events` 使用两个事件：

| 事件 | 发送方 | 载荷 |
| --- | --- | --- |
| `pi-reach:status` | 适配扩展 | `{ version: 1, key, label, text?, tone?, section? }` |
| `pi-reach:status-request` | Pi Reach | `{ version: 1 }`，请求重发当前状态 |

建议用稳定、带扩展前缀的 `key`（例如 `build-check:ci`）区分条目；同一个 `key` 后到覆盖先到。`label` 用作名称，`text` 是状态文字。不提供 `text` 或文本清理后为空时清除该条。`tone` 仅识别 `warning`、`error`；`section` 可选 `context`、`usage`、`session`，未指定或不认识时放到用量和会话之间。与同块内置字段重名的条目不展示。

Pi Reach 清除终端控制码、折叠换行和空白，把上报内容作为纯文本显示。`key` 超过 64 字符时忽略；`label` 和 `text` 分别截断到 12 和 160 字符。最多保留 12 条，超出时按 `key` 排序取前 12 条。未知版本或无效载荷被忽略。Pi 重载或退出清空已登记条目。

## 例子

在扩展加载阶段注册监听。Pi Reach 在会话启动和重载后请求重发，因为共享事件通道不会补发历史事件。发送时不需要探测 Pi Reach 是否已安装。

```ts
let current: string | undefined;

function publishStatus() {
  pi.events.emit("pi-reach:status", {
    version: 1,
    key: "build-check:ci",
    label: "CI",
    text: current,
    section: "session",
  });
}

pi.events.on("pi-reach:status-request", (event) => {
  if (event?.version === 1) publishStatus();
});

function setBuildStatus(text?: string) {
  current = text;
  publishStatus();
}
```

会话状态不写入 Pi Reach 正式时间线或离线历史。传输、订阅生命周期和错误处理见[会话状态订阅](protocol/protocol-v2.md#会话状态订阅)。
