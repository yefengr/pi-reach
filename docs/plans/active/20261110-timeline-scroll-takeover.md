# 消息列表滚动接管与加载更早修复方案

- 日期：2026-11-10
- 用途：供实施者在分支 `bugfix/261110-timeline-scroll-takeover` 上修复的依据；本文不是当前实现说明。
- 项目级状态：见 [ROADMAP](../../ROADMAP.md)，不在本文另设状态表。
- 当前事实来源：[ARCHITECTURE「时间线视口」相关段落](../../ARCHITECTURE.md)、[DESIGN「实时与只读历史」](../../DESIGN.md#实时与只读历史)、[ADR-20261031](../../adr/20261031-motion-layers-ios-spring.md)。实现完成后再把成立的事实同步至长期文档。
- 前序方案：[时间线视口协调层重构](20261022-timeline-viewport-coordinator.md)。本文只修补其上的五处行为，不改变协调层的分层。

## 1. 背景与范围

用户反馈：往回滚动、加载更早消息时页面会来回跳动；每次加载的条数偏少。排查另发现三处会让用户滚动与自动滚动互相争抢的缺口。五项均已获用户确认修改（2026-11-10）。

| # | 事项 | 性质 | 是否改规则 |
| --- | --- | --- | --- |
| 1 | 加载更早的一页并入时漏补阅读位置 | 缺陷，用户反馈的主因 | 否 |
| 2 | 向前翻页一页由 80 条增至 160 条，协议与 Extension 的单次上限同步调到 160 | 体验调整 | 协议参考随之更新 |
| 3 | 跟随中向下滚动被当成回看 | 缺陷 | 否 |
| 4 | 过程组收起保持期间，用户一按下留白即被撤掉 | 缺陷 | 是，修订 ADR-20261031，用户已确认 |
| 5 | 「最新」平滑滚动被轻点打断后瞬间贴底 | 小缺陷 | 否 |

### 不改动

- Relay：不解析 inner payload，单次条数上限与它无关。
- 首次打开与重连恢复的条数（`TIMELINE_RECENT_LIMIT`，30）。
- 「最新」长距离先瞬时靠近、只平滑最后一屏的规则。
- 到底判定只容忍像素舍入误差、回看后只有主动滚回真正底部或点击「最新」才恢复跟随（ADR-20261031 的 2026-11-05 修订）。
- 动效时长、曲线与 token；不引入列表虚拟化或新依赖。

### 证据边界

第 1、3、4、5 项的现状结论来自对 `TimelineViewportCoordinator` 与 `ScrollIdleGate` 的状态机模拟（假布局、假时钟），没有真机或真实浏览器复现记录。实施时每项先写出能失败的测试，再修改实现；测试写不出失败时停下并报告，不凭本文直接改。

## 2. 涉及文件

| 文件 | 相关项 |
| --- | --- |
| `pwa/src/lib/pwa/timeline-viewport-coordinator.ts` | 1、3、4、5 |
| `pwa/src/lib/pwa/use-timeline-viewport.ts` | 1 |
| `pwa/src/lib/pwa/scroll-idle-gate.ts` | 1（如需新增入口） |
| `pwa/src/lib/pwa/timeline-viewport-observers.ts` | 3 |
| `pwa/src/lib/pwa/timeline-follow-motion.ts`（`CollapseHoldTransition`） | 4 |
| `pwa/src/lib/pwa/timeline-history-loader.ts`、`timeline-local-pager.ts` | 2 |
| 对应的 `*.node.test.ts`、`*.browser.test.tsx` | 全部 |

`timeline-viewport-coordinator.ts` 已超过 600 行。本次属于存量文件的小范围改动，不要求拆分；新增逻辑优先写成私有方法，不继续加长 `advance()` 与 `scroll()`。

## 3. 第 1 项：加载更早并入时漏补阅读位置

### 现状

用户发起的一页取回后，由 `useTimelineEarlier` 经 `whenScrollIdle` 暂存，等 `ScrollIdleGate` 判定静止才并入。并入那次提交触发 `core.notify("commit")`，`advance()` 在回看分支里按 `this.anchor` 恢复位置。

两处「用户是否还在操作」的判断不一致：

- `ScrollIdleGate`：没有触摸按住，且距最后一次 **scroll 事件** 200ms。
- `TimelineViewportUserInput.blocked()`：按住中，或距最后一次**输入**（`engage()`，以及 `touch()` 的按下与抬起）200ms。输入不要求位置真的变化。

`advance()` 开头遇到 `blocked()` 直接返回，回看分支的锚点恢复一并被跳过。于是「门禁已放行、输入仍在暂停」时，页并入但位置不补，画面显示新页顶部的内容，直到输入暂停结束后的那一帧才被拉回。

已模拟确认的触发方式：

1. 触摸：手指拖动后停住超过 200ms 再抬起，没有惯性。抬起时门禁立即放行，而 `touch(false)` 刚把输入暂停延长 200ms。错位持续约 200ms。
2. 桌面：已滚到顶，滚轮或触控板惯性的 wheel 事件仍在到达，但位置不变、没有 scroll 事件。门禁放行，输入一直暂停。错位持续到停手后 200ms；期间若位置发生变化，`scroll()` 的输入分支会把错位后的位置记为新的阅读锚点，不再拉回，相当于跳过一整页。
3. 一页加载期间轻点屏幕，并入落在抬起后的 200ms 内。

### 目标行为

- 前插那次提交，无论输入是否处于暂停，都在绘制前把阅读位置补回前插前的那一行。依据是 DESIGN 已有规则：历史前插允许以语义锚点补偿位置，目的是稳住同一段内容。
- 用户发起的一页，只在触摸结束、且输入与滚动都静止 200ms 后并入。

### 实现要求

**1a. 前插补偿不受输入暂停阻挡（实施时撤回）。** 原计划在输入暂停期间也补偿前插。实施时发现既有测试按上一轮修复回看争抢时（[ADR-20261031 的 2026-11-05 修订](../../adr/20261031-motion-layers-ios-spring.md#修订用户回看优先于自动滚动2026-11-05)）的决定，有意在手指按住与惯性期间不写滚动位置：iOS 此时由系统滚动线程持有位置，程序写入会被覆盖或来回争夺。跳动的真正来源是 1b 的计时错位：门禁对齐后，用户发起的页只在输入与滚动都静止后并入，正常路径会在绘制前补偿。因此不做 1a；只保留把回看分支的锚点恢复提成共用方法。不经暂存的替换与补齐分页在按住期间到达时，仍等输入静止后补偿，维持原决定。

**1b. 门禁与输入暂停使用同一组活动信号。** 在 `use-timeline-viewport.ts` 中：

- 观察器的 `engage` 回调在 `core.engage()` 之后同时记一次门禁活动（可直接调用 `idleGate.scrolled()`，或在 `ScrollIdleGate` 上新增含义更准确的入口并更新其类注释）。
- `touch(false)` 时，在 `idleGate.touch(false)` 之前先记一次门禁活动，使抬起后的 200ms 两边一致。
- `handleScroll` 中把 `idleGate.scrolled()` 移到 `core.scroll()` 之后。两处时间戳分别读取，门禁的时间不早于输入暂停的时间，门禁就不会先放行。

`LatestEntryVisibility` 自带的门禁不在本项范围内，保持现状。

**1c. 核对回看中未经输入观察的滚动。** `scroll()` 在回看、非输入暂停路径下只更新 `lastTop`，不更新 `this.anchor`。先写测试：回看中、输入暂停已过期，位置发生一次变化（没有 `engage()`，也没有待确认的 `receipt` 或 `prependGuard`），随后 `notify("commit")`。若位置被拉回旧锚点，则在该路径上按当前位置重新捕获锚点，与详情暂停分支的做法一致；若测试显示没有拉回，本条不改，并在 PR 描述中说明。

### 测试

`timeline-viewport-coordinator.node.test.ts`：

- 回看中调用 `historyPrepend()`，在输入暂停窗口内前插提交：提交返回时位置已补偿，`prependGuard` 已开启。
- 同上但处于按住状态：位置已补偿。
- 输入暂停窗口内的普通提交（不是前插）在回看中不写入位置，保持现有行为。
- 1c 的场景。

`scroll-idle-gate.node.test.ts` 或 `use-timeline-viewport.browser.test.tsx`：

- 抬起前已静止超过 200ms：暂存的工作在抬起 200ms 后才执行，不在抬起当时执行。
- 只有 wheel、没有 scroll 事件时，暂存的工作不执行；最后一次 wheel 之后 200ms 执行。

`timeline-viewport.integration.browser.test.tsx`：补一条「拖动、停住、抬起」后前插的回归，逐帧断言锚点行的位置按整像素不变。采样窗口只覆盖抬起后 300ms 左右。

## 4. 第 2 项：向前翻页一页增至 160 条

### 现状

`TIMELINE_PAGE_SIZE = 80`（`timeline-history-loader.ts`），在线会话与只读历史的本地分页共用。协议 schema 把 `session_sync.limit` 限制在 1–80，Extension 对超出范围的请求返回错误。

### 决定（2026-11-10 用户确认）

协议与 Extension 的单次上限一起调到 160，Relay 不涉及。发布顺序仍是先 PWA 后 Extension，新 PWA 会先连到旧 Extension：旧 Extension 的 strict schema 收到 `limit > 80` 会回复 `protocol_upgrade_required`。沿用 `tool_details` 遇到同一回复时补发一次的先例：PWA 收到该回复且本次请求超过 80 条时，当前加载器降为每次 80 条并重发同一段，此后不再尝试 160；其他错误或降级后的再次拒绝照常失败。

### 实现

- 协议包新增 `MAX_SESSION_SYNC_LIMIT = 160` 与 `LEGACY_SESSION_SYNC_LIMIT = 80`；schema 上限改为前者，省略 `limit` 时仍默认 80。
- Extension 的校验与错误信息改用 `MAX_SESSION_SYNC_LIMIT`，默认页大小保持 80。
- PWA `TIMELINE_PAGE_SIZE` 改为 160；加载器按单次上限切分缺口，记录 `protocol_error.code`，按上面的规则降级一次。响应因字节上限提前截断时，现有的继续推进逻辑不变。

### 测试

- 协议契约：160 通过，161 拒绝，省略时默认 80。
- Extension：`limit: 160` 返回 160 条；161 返回 `invalid_cursor`。
- PWA 加载器：一页 160 条一次请求；旧 Extension 拒绝后同一页拆成两次 80 条、下一页直接按 80；其他错误与降级后的再次拒绝不重试。
- 依赖页大小的既有浏览器测试按 160 更新预期。

### 需留意

列表没有虚拟化，阅读锚点的捕获会遍历列表的直接子元素。页变大后长会话的滚动开销随之上升，需在长会话中确认没有明显掉帧。

## 5. 第 3 项：跟随中向下滚动被当成回看

### 现状

`scroll()` 的输入暂停分支里，跟随中只要位置变化后不在底部，就调用 `userRead()`，不区分方向。`interrupt()` 同样不带方向：有程序运动在进行时，任何方向的滚轮、按键或超过 4px 的拖动都结束跟随。

已模拟确认的后果：

- 按住期间内容增长，手指向下带一点但没追上新的底部，跟随结束。
- 回看后甩回底部、刚恢复跟随，惯性或回弹未结束时内容又增长一行，下一次 scroll 事件使跟随再次结束。
- 逐帧接续进行中滚轮向下，跟随结束。

输出较快时跟随状态反复翻转，「N 条新输出」入口随之闪动。

### 目标行为

跟随中只有向上的用户移动才算回看。向下移动但未到底时保持跟随，自动写入照常暂停到输入静止，再由普通跟随从实际位置继续。符合 DESIGN 的现有表述：用户主动回看并离开底部才结束跟随，追赶中的暂时离底不算回看。

### 实现要求

**3a. `scroll()` 的输入暂停分支按方向判断。** 跟随且未暂停、位置不在底部时：

- `current < this.lastTop - EPSILON`：向上，调用 `userRead()`，与现状相同。
- 否则只更新 `this.lastTop`，保持跟随。

该分支里写入 `lastTop` 时取 `Math.min(current, bottom)`。iOS 回弹期间 `scrollTop` 会超过滚动范围，随后回落；不夹住的话，回落会被判成向上移动。

回看中滚到底恢复跟随的判断（`!this.following && Math.min(current, bottom) > Math.max(0, this.lastTop)`）不变。

**3b. `interrupt` 带方向。** 观察器的 `interrupt` 事件增加方向参数，取值为向上、向下或未知：

- 滚轮：`deltaY < 0` 为向上，`deltaY > 0` 为向下。
- 按键：`ArrowUp`、`PageUp`、`Home` 与 `Shift+空格` 为向上；`ArrowDown`、`PageDown`、`End` 与空格为向下。
- 触摸：手指向下移动（`clientY` 增大）为向上回看，手指向上移动为向下。
- 鼠标按在滚动条上：未知。

`TimelineViewportCoordinator.interrupt()` 接收方向：

- 向上或未知：现有行为，满足条件时 `userRead()`。
- 向下，且处于跟随、未暂停：不调用 `userRead()`。若有程序运动或逐帧接续（`motion`、`glide`、`handoff`、`mode === "latest"`），以 `exit(true)` 结束它们并保持跟随意图，清除 `userInput.interruptedMotion`，再 `schedule()`。必须结束 `glide`：`FollowGlide` 自带位置，保留它会在输入静止后从旧位置继续写入，把用户拉回去。
- 向下，且处于回看：不处理，交给 `scroll()`。

第 4 项会调整 `exit()` 对收起保持的处理，本项的 `exit(true)` 走同一套转交逻辑。

### 测试

`timeline-viewport-coordinator.node.test.ts`：

- 跟随、按住、内容增长、位置向下但未到底：仍跟随；静止后回到底部。
- 回看中滚到底恢复跟随，输入暂停窗口内内容增长，位置再向下移动几像素：仍跟随。
- 位置超过滚动范围后回落（模拟回弹）且期间内容增长：仍跟随。
- 逐帧接续中向下 `interrupt`：仍跟随；后续没有从旧位置发出的写入，实际位置不回退。
- 逐帧接续中向上 `interrupt`：结束跟随，保持现状。
- 跟随、输入暂停窗口内向上移动 2px 以上：结束跟随，保持现状。

`use-timeline-viewport.browser.test.tsx`：观察器按 `deltaY` 符号、按键与触摸方向报告正确的方向。

既有测试中把「向下未到底」断言为结束跟随的用例按新规则改写，并在 PR 描述中逐条列出。

## 6. 第 4 项：收起保持期间用户接管不再一次撤掉留白

### 现状

跟随中过程组收起时，`CollapseHoldTransition` 把收回的高度暂留为列表末尾的伪元素空白，等后续输出填入，可持续数秒。`touch(true)`、`userRead()` 与 `interrupt()` 都经 `exit()` 调用 `hold.finish()`，空白立即清除，浏览器把滚动位置夹回，内容瞬间下移，最多等于暂留的高度。按下但未移动的轻点也会触发，内容在手指下移位可能点错目标。`details()` 与 `followOwnSend()` 已对同一问题做了保留或转交处理，用户输入路径没有。

### 目标行为

- 按下、轻点、滚轮或拖动都不会一次撤掉留白。
- 用户向上滚动时，留白随实际位置等量缩减：只保留让当前位置仍可到达所需的部分，缩减到 0 即结束。
- 用户没有回看（轻点后抬起、仍在跟随）时，输入静止后保持过渡按原规则继续：等内容填满，或本轮已结束时平滑收回。
- 回看期间内容继续填入时，留白只减不增，不写入滚动位置。
- 换绑、重置、「最新」、`settle` 仍立即结束保持。本端发送仍转交发送过程。

验收标准：从按下到留白用完的任意一帧，内容相对视口的位移不超过用户自己造成的滚动量，按整像素比较。

### 实现要求

以下是建议的做法，实施者可在满足目标行为与测试的前提下调整内部结构。

- 协调器新增一个与 `sendHold` 平行的槽位（下称 `userHold`），存放被用户接管的保持过渡。
- `touch(true)`、`userRead()`、第 3 项的向下 `interrupt` 在调用 `exit()` 之前，按 `details()` 现有写法把 `holdMotion` 摘出（它同时是 `motion` 时一并置空），`exit()` 之后放入 `userHold`。此时若存在 `sendHold`，同样转入 `userHold`，不让 `exit()` 结束它。
- `userHold` 的推进：每次 `scroll()` 以及 `advance()` 的 `blocked()` 提前返回之前，用实际位置调用 `track(layout.top())`；返回 true 时结束并清空。回看分支里同样推进，可与现有的 `trimPausedHold` 合并。
- `CollapseHoldTransition.track()` 目前只按所需高度缩减。收起的 CSS 过渡尚未结束时被接管，仍须保留全部 `reserve`，否则随后的收缩会让浏览器逐帧夹住位置。给 `track` 增加时间参数，或增加一个阶段推进入口，使收起阶段内保持 `reserve`、收起时钟结束后才按实际位置缩减。接口变化同步到 `ViewportHoldMotion` 类型与测试夹具。
- 重新接管：`advance()` 通过输入暂停检查后，若 `userHold` 存在、处于跟随且未暂停、没有其他 `motion`，把它放回 `motion` 与 `holdMotion`，`mode` 设为 `"activity"`，与 `details(false)` 的恢复写法一致。
- 活动区撤下时的 `release()` 通知要同时到达 `userHold`。
- `bind()`、`reset()`、`latest()`、`settle()` 结束 `userHold`；`followOwnSend()` 把它并入 `sendHold`。
- `collapse()` 在 `userHold` 存在时到达：按现有「已有其他过程拥有滚动」的分支处理，不新建第二个保持过渡。

### 规则与文档

本项改变了 ADR-20261031「修订：过程组先收起再出正文，收起时组头原位」第 2 条中「用户滚动……结束保持」的结束方式。用户已于 2026-11-10 确认。按 ADR 只追加的约定，在该 ADR 末尾新增带日期的修订节，写明：用户接管不再一次撤掉留白，留白随用户的实际位置缩减；轻点后仍在跟随时保持过渡继续。不改写原段落。

### 测试

`timeline-viewport-coordinator.node.test.ts`（夹具已有 `holdMotion` 与 `reach`，按新接口扩展）：

- 保持中 `touch(true)`：位置不变，保持未结束。
- 保持中轻点（按下后抬起、无移动）并静止 200ms：仍跟随，保持过渡回到 `motion`，后续内容填满后正常结束。
- 保持中向上滚动 x：留白缩减 x，位置等于用户滚到的位置；滚动量超过留白后保持结束。
- 回看中内容填入：留白缩减，不产生滚动写入。
- 活动区撤下时保持位于 `userHold`：`release` 生效，重新接管后平滑收回。
- `reset()`、`latest()`、`bind()` 结束 `userHold`。
- 既有用例「an upward user input ends the hold and keeps reading」按新规则改写。

`timeline-follow-motion.browser.test.tsx`：收起阶段内被接管时仍保留全部 `reserve`；收起结束后按实际位置缩减，伪元素高度与属性在用完时清除。

`timeline-viewport.integration.browser.test.tsx`：长对话中过程组收起后的保持期内模拟按下与向上拖动，逐帧断言组头位置的变化不超过滚动量。

## 7. 第 5 项：「最新」被轻点打断后不再瞬间贴底

### 现状

「最新」的原生平滑滚动进行中，`touch(true)` 经 `exit()` 停止滚动，阅读意图仍为跟随（`latest()` 已先 `reset()`）。没有移动就抬起时，输入静止 200ms 后普通跟随把剩余距离瞬间写完。`latest()` 在输入暂停期间被调用时走的也是同一条路径：直接改为 `"follow"`，静止后瞬间贴底。

### 目标行为

「最新」的行程被输入暂停推迟或打断、而用户没有回看时，输入静止后按「最新」的动画规则走完剩余距离：超过两屏先瞬时靠近，只平滑最后一屏。轻点不关闭跟随的规则不变。

### 实现要求

- 把 `latest()` 中「可选的瞬时靠近、平滑写入、进入 `"latest"` 模式」提取为私有方法。
- 新增标记表示有待续的「最新」行程。两处置位：`latest()` 因输入暂停而未能启动动画时；`touch(true)` 发现 `mode === "latest"` 时（在 `exit()` 之前判断）。
- `advance()` 通过输入暂停检查后，若标记存在、处于跟随且未暂停、允许动画，清除标记并调用上述私有方法；本帧不再走普通跟随写入。不允许动画时按现有即时路径。
- `userRead()`、`reset()`、`bind()`、`followOwnSend()`、`settle()` 清除标记。

### 测试

`timeline-viewport-coordinator.node.test.ts`：

- 「最新」动画中轻点，静止后：发出一次平滑写入，没有先瞬间写到底。
- 输入暂停期间调用 `latest()`，静止后：同上；距离超过两屏时先有一次瞬时靠近。
- 「最新」动画中向上拖动：结束跟随，标记清除，之后没有写入。
- 减少动态效果下：静止后即时贴底，保持现状。

## 8. 文档同步

实现合并前在同一 PR 内完成：

- [ARCHITECTURE](../../ARCHITECTURE.md)：更新前插暂存的静止条件（输入与滚动都静止）、前插补偿不受输入暂停阻挡、收起保持被用户接管后的处理、跟随中按方向判断回看。
- [DESIGN](../../DESIGN.md)：只在现有表述与新行为不一致处修改。预计涉及「平滑滚动例外」中自动滚动服从用户接管的描述，以及「实时与只读历史」中用户回看的描述，补充向下移动不算回看。不新增规则条目。
- [ADR-20261031](../../adr/20261031-motion-layers-ios-spring.md)：追加第 4 项的修订节。
- `pwa/src/components/pwa/use-auto-load-earlier.ts` 等处提到一页条数或静止条件的注释随实现更新。
- 事项结束时按文档生命周期归档本文并更新 ROADMAP。

第 1、3、5 项落在 DESIGN 现有规则之内，文档修改只是让描述与实现一致。实施中若发现需要新增或改变 DESIGN 的约束条款，先停下向用户说明依据、影响和替代方案。

## 9. 实施顺序与提交

五项互相独立，但第 3、4 项都修改 `exit()` 周边逻辑。建议顺序与提交划分：

1. 第 1 项。
2. 第 2 项。
3. 第 3 项。
4. 第 4 项，包含 ADR 修订。
5. 第 5 项。
6. 文档同步。

每项一个提交，提交信息按仓库约定，例如 `fix(pwa): 加载更早并入时在绘制前补回阅读位置`。第 4 项风险最高；若实现或回归出现难以收敛的问题，可拆到单独的 PR，不阻塞前三项。

## 10. 验证

在 `pwa/` 下执行，或使用 `pnpm --filter pwa <命令>`：

- `pnpm typecheck`、`pnpm lint`。
- `pnpm test:unit`：至少包含 `timeline-viewport-coordinator`、`scroll-idle-gate`、`timeline-history-loader`、`timeline-local-pager`、`timeline-follow-glide`。
- Browser Mode 只运行直接覆盖改动的文件：`use-timeline-viewport.browser.test.tsx`、`timeline-viewport.integration.browser.test.tsx`、`timeline-follow-motion.browser.test.tsx`、`use-auto-load-earlier.browser.test.tsx`、`message-list.browser.test.tsx`。
- 仓库根执行 `pnpm check:docs` 与 `git diff --check`。

测试须能在 Linux CI 上稳定运行：几何断言按整像素比较，计时窗口为慢机器留出余量，不依赖关闭事件的时序。

更广的回归以 PR 的 CI 为准。推送 `bugfix/*` 分支会部署并覆盖 staging，推送前须取得用户授权，并用 `gh variable get STAGING_BRANCH_DEPLOY` 核对是否暂停。

### 真机验收

自动化通过后仍需在原设备上确认，取得证据前事项状态为 `待验收`：

1. iOS 主屏 PWA：慢速向上拖动阅读，停住后抬起，重复至触发多次加载更早，不出现跳到其他内容再跳回。
2. 桌面触控板：甩到顶部并持续惯性，加载更早并入后停在原来那一行。
3. Pi 输出期间在底部附近上下小幅滑动，跟随不反复开关，「N 条新输出」不闪动。
4. Pi 输出期间过程组收起后立即按住或轻点屏幕，内容不跳动。
5. 回看较远处点击「最新」，途中轻点一次，随后平滑到底。

可用 `window.__PI_REACH_VIEWPORT__` 记录位置变化的来源，辅助判断单帧异常。

## 11. 风险

- 第 1a 项在 iOS 按住或惯性期间写入滚动位置可能被系统覆盖。用户发起的页有门禁保证并入时已静止，覆盖只可能发生在替换与补齐分页上，由现有的 1 秒前插保护兜底；真机验收第 1 条覆盖。
- 第 1b 项使桌面上持续的滚轮输入推迟并入，顶部的加载中状态会比现在多停留到停手后 200ms。这与「手势结束且静止后才前插」的规则一致。
- 第 3 项放宽了结束跟随的条件。用户向下滑动后停在离底部一段距离处时，输入静止后会被自动带到底部，这是跟随状态下的预期行为。
- 第 4 项新增一个保持过渡的归属状态，退出路径增多。每条结束路径都要有测试，避免伪元素空白残留。

## 12. 实施记录（2026-11-10）

在 `bugfix/261110-timeline-scroll-takeover` 实施五项，尚未提交。与上文计划的差异：

- 第 1 项撤回 1a（原因见第 3 节），1b 改在 `ScrollIdleGate` 内实现：按下、抬起与不产生滚动的输入都重新计时，「最新」入口的出现时机共用该门禁，随之与 DESIGN 的表述对齐。1c 测试复现了拉回，已修复。
- 第 2 项按用户追加的要求把协议与 Extension 上限一起调到 160，见第 4 节。
- 第 4 项实施中发现必须先按保留空白时的滚动范围判断用户意图、再缩减空白，否则缩减后当前位置就是新底部，向上回看会被误判为到底；同时修正测试夹具，使测量与真实布局一致（暂留空白计入物理底部）。
- 第 5 项：点「最新」本身会清除输入暂停，只有手指仍按在列表上时才会被推迟，测试按此编写。

既有测试中按旧规则断言的用例已改写：向下接管结束跟随（协调器 2 条、视口 Hook 1 组、发送 1 组）、用户回看结束收起保持（协调器 2 条）、前插与只读历史中写死一页 80 条的预期（PWA 浏览器测试 4 个文件）。

验证（容器内的独立副本，依赖为 Linux 版本）：PWA `lib/pwa` 全部 Node 测试、协议契约、Extension 历史分页、PWA 类型检查与 lint、Extension 与协议包类型检查通过；浏览器测试覆盖视口 Hook、视口集成、跟随运动、发送、交接、自动加载更早、消息列表、`use-timeline`、只读历史与 `pwa-app` 中历史与滚动相关用例，均通过。真机验收见第 10 节，尚未进行。
