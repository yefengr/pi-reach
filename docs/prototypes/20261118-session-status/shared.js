// 会话状态原型：场景数据均为合成样例，只模拟展示与手势，不接协议。
(function () {
  "use strict";

  // 桌面布局常量，对应 DESIGN 的侧栏、gutter 与阅读列宽
  const SIDEBAR_SPACE = 292; // 侧栏 280 + 左侧 12
  const GUTTER = 20;
  const READING_WIDTH = 680;
  const CARD_WIDTH = 248;
  const CARD_RIGHT = 12;
  const CARD_GAP = 16;
  const CARD_LANE = CARD_WIDTH + CARD_RIGHT + CARD_GAP;
  const DESK_HEIGHT = 760;
  // 与 Pi 终端状态栏一致的上下文着色阈值
  const LEVEL_HIGH = 70;
  const LEVEL_FULL = 90;
  // 手势：方向锁定距离与惯性投影时长（简化）
  const AXIS_LOCK = 8;
  const PROJECTION_MS = 200;
  // 移动抽屉中扩展文字同行显示的大致字数上限（原型按字数近似，实现时按实际宽度判断）
  const EXT_INLINE_CHARS = 18;

  const SESSION = {
    name: "修复触屏导航焦点圈并恢复键盘焦点提示",
    path: "/Users/yefeng/code/pi-reach",
    computer: "MacBook Pro",
  };
  const BASE_USAGE = { input: 1240000, output: 48200, cacheRead: 982000, cacheWrite: 121000, hit: 87.3 };
  const BRANCH = "bugfix/261117-mobile-navigation-focus";

  const SCENES = {
    normal: { kind: "live", ctx: { tokens: 84000, window: 200000, auto: true }, usage: BASE_USAGE, cost: 1.284, sub: false, branch: BRANCH,
      note: "常规在线会话。上下文只用文字呈现，不画进度条；百分比保持中性色，只有偏高、将满时附加着色标签。" },
    high: { kind: "live", ctx: { tokens: 156000, window: 200000, auto: true }, usage: { ...BASE_USAGE, input: 3410000, cacheRead: 2870000 }, cost: 3.912, sub: false, branch: BRANCH,
      note: "占用 ≥ 70%：百分比旁出现琥珀色「偏高」标签，与 Pi 终端的警告阈值一致；状态不只靠颜色表达。" },
    full: { kind: "live", ctx: { tokens: 187000, window: 200000, auto: false }, usage: { ...BASE_USAGE, input: 5120000, cacheRead: 4300000 }, cost: 6.035, sub: false, branch: BRANCH,
      note: "占用 ≥ 90% 且关闭了自动压缩：百分比旁出现红色「将满」标签。是否在这里提供「压缩上下文」入口待评审，原型未放。" },
    compacted: { kind: "live", ctx: { tokens: null, window: 200000, auto: true }, usage: { ...BASE_USAGE, input: 3410000, cacheRead: 2870000 }, cost: 3.958, sub: false, branch: BRANCH,
      note: "刚压缩后 Pi 也不知道当前占用（终端显示 ?/200k），要到下一次回复结束才更新。累计用量与费用不随压缩清零。" },
    subscription: { kind: "live", ctx: { tokens: 31000, window: 400000, auto: true }, usage: { input: 212000, output: 9800, cacheRead: 160000, cacheWrite: 30500, hit: 71.2 }, cost: 0.412, sub: true, branch: null,
      note: "订阅计费时按 Pi 的口径仍显示估算费用并标注「订阅」；工作目录不是 Git 仓库时不显示分支行，不补占位。" },
    waiting: { kind: "waiting",
      note: "已连接、尚未收到第一份状态快照。快照随会话建立发送，正常只闪现很短时间。" },
    legacy: { kind: "legacy",
      note: "电脑上的 Pi Reach 扩展未声明状态能力（旧版本）：不推送也不报错，只提示更新扩展。" },
    history: { kind: "history",
      note: "本地历史或 Pi 已退出：没有实时状态。桌面不显示卡片；移动抽屉只保留会话信息并说明原因。" },
  };

  // 已适配扩展通过事件约定上报的状态（合成样例）：按 key 排序，与终端状态栏一致
  // section 由扩展指定放入哪一块；未指定或无法识别时放进上下文、用量之后的无标题块
  const EXT_STATUSES = [
    { key: "ci-watch", label: "CI", text: "verify 通过 · 3 分钟前", section: "session" },
    { key: "quota", label: "额度", text: "5 小时窗口已用 82%", tone: "warning", section: "usage" },
    { key: "todo", label: "待办", text: "3 项未完成：补充 Relay 重试测试、更新部署文档、核对 staging 配置" },
  ];
  const EXT_SECTIONS = ["context", "usage", "session"];

  const ICON = {
    branch: '<svg class="i" viewBox="0 0 24 24"><line x1="6" x2="6" y1="3" y2="15"/><circle cx="18" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M18 9a9 9 0 0 1-9 9"/></svg>',
  };

  const state = { scene: "normal", viewport: "desktop", width: 1440, sidebar: "open", ext: false };

  const $ = (id) => document.getElementById(id);
  const esc = (text) => String(text).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

  function formatTokens(count) {
    if (count < 1000) return String(count);
    if (count < 10000) return (count / 1000).toFixed(1) + "k";
    if (count < 1000000) return Math.round(count / 1000) + "k";
    return (count / 1000000).toFixed(1) + "M";
  }

  function contextView(ctx) {
    // 刚压缩后占用未知：只保留虚线外框，不显示数值
    if (ctx.tokens === null) return { level: "unknown", pct: null, value: "", tag: "" };
    const pct = Math.round((ctx.tokens / ctx.window) * 100);
    if (pct >= LEVEL_FULL) return { level: "full", pct, value: pct + "%", tag: "将满" };
    if (pct >= LEVEL_HIGH) return { level: "high", pct, value: pct + "%", tag: "偏高" };
    return { level: "normal", pct, value: pct + "%", tag: "" };
  }

  function ctxMeta(ctx) {
    // 占用未知时只给窗口大小，不另加解释文字
    const used = ctx.tokens === null ? "窗口 " + formatTokens(ctx.window) : formatTokens(ctx.tokens) + " / " + formatTokens(ctx.window);
    return used + (ctx.auto ? " · 自动压缩" : " · 自动压缩已关闭");
  }

  // 与数值同号的小饼图：细外框加扇形，示意占用比例；不用带圆头的弧线，避免看成加载转圈
  function ring(view) {
    const sector = view.pct === null ? "" : '<circle class="ring-fill" cx="12" cy="12" r="5" pathLength="100" stroke-dasharray="' + Math.min(view.pct, 100) + ' 100"/>';
    return '<svg class="ring" data-level="' + view.level + '" viewBox="0 0 24 24" aria-hidden="true"><circle class="ring-track" cx="12" cy="12" r="10"/>' + sector + "</svg>";
  }

  function ctxValue(view) {
    return '<span class="value num">' + ring(view) + esc(view.value) + "</span>";
  }

  function tag(view) {
    return view.tag ? '<span class="level-tag" data-level="' + view.level + '">' + view.tag + "</span>" : "";
  }

  function costText(scene) {
    return "$" + scene.cost.toFixed(3) + (scene.sub ? " · 订阅" : "");
  }

  function usageRows(usage) {
    return [
      ["输入", formatTokens(usage.input)], ["输出", formatTokens(usage.output)],
      ["缓存读取", formatTokens(usage.cacheRead)], ["缓存写入", formatTokens(usage.cacheWrite)],
      ["缓存命中率", usage.hit.toFixed(1) + "%"],
    ];
  }

  /* ---------- 桌面卡片 ---------- */

  // 两端统一顺序：上下文 → 用量 → 未指定区块的扩展 → 会话；扩展条目排在所在块的内置行之后
  function cardBody(scene) {
    // 本地历史不显示卡片，也没有可渲染的状态
    if (scene.kind === "history") return "";
    if (scene.kind === "waiting") return '<p class="placeholder"><span class="pulse" aria-hidden="true"></span>正在获取状态…</p>';
    if (scene.kind === "legacy") return '<p class="placeholder">这台电脑上的 Pi Reach 扩展版本较旧，暂不提供状态。更新扩展后可查看。</p>';
    const view = contextView(scene.ctx);
    const grid = usageRows(scene.usage).concat([["费用", costText(scene)]])
      .map(([k, v]) => "<dt>" + k + '</dt><dd class="num">' + esc(v) + "</dd>").join("");
    const context = '<div class="card-ctx-head"><span class="label">上下文</span>' + tag(view) + ctxValue(view) + "</div>"
      + '<div class="card-ctx-meta num">' + esc(ctxMeta(scene.ctx)) + "</div>" + cardExtRows(extFor("context"));
    const usage = '<dl class="card-grid">' + grid + "</dl>" + cardExtRows(extFor("usage"));
    const blocks = [context, usage, cardExtRows(extFor("other")), cardSession(scene)].filter(Boolean);
    return blocks.join('<div class="card-sep"></div>');
  }

  // 桌面会话块只有分支：会话名与目录已在标题区
  function cardSession(scene) {
    const branch = scene.branch
      ? '<div class="card-branch" title="' + esc(scene.branch) + '">' + ICON.branch + "<span>" + esc(scene.branch) + "</span></div>"
      : "";
    return branch + cardExtRows(extFor("session"));
  }

  function extFor(section) {
    if (!state.ext) return [];
    return EXT_STATUSES.filter((item) => (EXT_SECTIONS.includes(item.section) ? item.section : "other") === section);
  }

  function cardExtRows(items) {
    if (!items.length) return "";
    const rows = items.map((item) => "<dt>" + esc(item.label) + '</dt><dd class="ext-text"' + toneAttr(item) + ' title="' + esc(item.text) + '">' + esc(item.text) + "</dd>").join("");
    return '<dl class="card-grid ext">' + rows + "</dl>";
  }

  function toneAttr(item) {
    return item.tone ? ' data-tone="' + item.tone + '"' : "";
  }

  function renderCard() {
    $("statusCard").innerHTML = '<h3 class="card-title">会话状态</h3>' + cardBody(SCENES[state.scene]);
  }

  /* ---------- 桌面布局：按主区宽度决定卡片显隐 ---------- */

  function computeLayout() {
    const scene = SCENES[state.scene];
    const main = state.width - (state.sidebar === "open" ? SIDEBAR_SPACE : 0);
    const colWidth = Math.min(READING_WIDTH, main - GUTTER * 2);
    const centered = (main - colWidth) / 2;
    const wanted = scene.kind !== "history";
    // 阅读列让位：卡片放不下时正文左移到刚好让出卡片，左移到 gutter 仍放不下才隐藏卡片
    const threshold = READING_WIDTH + CARD_LANE + GUTTER;
    const maxLeft = main - CARD_LANE - colWidth;
    const fits = colWidth === READING_WIDTH && maxLeft >= GUTTER;
    const left = fits && wanted ? Math.min(centered, maxLeft) : centered;
    const shift = Math.round(centered - left);
    return { main, colWidth, left, shift, visible: wanted && fits, fits, wanted, threshold };
  }

  function renderDesk() {
    const layout = computeLayout();
    const desk = $("desk");
    desk.style.width = state.width + "px";
    desk.dataset.sidebar = state.sidebar;
    const mainEl = $("deskMain");
    mainEl.style.left = (state.sidebar === "open" ? SIDEBAR_SPACE : 0) + "px";
    for (const el of [$("deskColumn"), $("deskComposer")]) {
      el.style.left = layout.left + "px";
      el.style.width = layout.colWidth + "px";
    }
    $("laneGuide").style.left = (layout.left + layout.colWidth) + "px";
    $("statusCard").classList.toggle("is-hidden", !layout.visible);
    $("statusCard").setAttribute("aria-hidden", String(!layout.visible));
    fitDesk();
    renderLayoutNote(layout);
  }

  function fitDesk() {
    const available = $("stage").clientWidth;
    const scale = Math.min(1, available / state.width);
    $("desk").style.transform = "scale(" + scale + ")";
    $("deskFit").style.width = Math.round(state.width * scale) + "px";
    $("deskFit").style.height = Math.round(DESK_HEIGHT * scale) + "px";
  }

  function renderLayoutNote(layout) {
    const sidebarExtra = state.sidebar === "open" ? SIDEBAR_SPACE : 0;
    const windowThreshold = layout.threshold + sidebarExtra;
    let status;
    if (!layout.wanted) status = "本场景不显示卡片";
    else if (!layout.visible) status = "宽度不足，卡片隐藏";
    else status = layout.shift > 0 ? "卡片显示，正文左移 " + layout.shift + "px" : "卡片显示，正文居中";
    $("layoutNote").innerHTML = "<b>" + status + "</b>：主区 " + layout.main + "px；显示卡片需主区 ≥ " + layout.threshold
      + "px，即窗口 ≥ " + windowThreshold + "px（侧栏" + (state.sidebar === "open" ? "展开" : "收起") + "）。虚线为阅读列右缘。<br>"
      + esc(SCENES[state.scene].note);
  }

  /* ---------- 移动抽屉 ---------- */

  function drawerSession(scene) {
    const branchRow = scene.kind === "live" && scene.branch
      ? '<div class="m-row stack"><span class="k">分支</span><span class="m-branch">' + ICON.branch + "<span>" + esc(scene.branch) + "</span></span></div>"
      : "";
    return '<section class="m-section"><h3>会话</h3><div class="m-group">'
      + '<div class="m-row stack pair"><span class="m-name">' + esc(SESSION.name) + '</span><span class="m-meta">' + esc(SESSION.computer) + "</span></div>"
      + '<div class="m-row stack"><span class="k">工作目录</span><input class="m-path" readonly value="' + esc(SESSION.path) + '" aria-label="工作目录"></div>'
      + branchRow + (scene.kind === "live" ? mobileExtRows(extFor("session")) : "") + "</div></section>";
  }

  function drawerLive(scene) {
    const view = contextView(scene.ctx);
    const ctx = '<section class="m-section"><h3>上下文</h3><div class="m-group"><div class="m-row stack">'
      + '<div class="m-ctx-head"><span class="k">占用</span>' + tag(view) + ctxValue(view) + "</div>"
      + '<span class="k num" style="font-size:13px">' + esc(ctxMeta(scene.ctx)) + "</span></div>" + mobileExtRows(extFor("context")) + "</div></section>";
    const rows = usageRows(scene.usage).concat([["费用", costText(scene)]])
      .map(([k, v]) => '<div class="m-row"><span class="k">' + k + '</span><span class="v num">' + esc(v) + "</span></div>").join("");
    const usage = '<section class="m-section"><h3>用量</h3><div class="m-group">' + rows + mobileExtRows(extFor("usage")) + '</div><p class="m-note">本会话累计，压缩后不清零。</p></section>';
    const other = extFor("other").length ? '<section class="m-section" aria-label="其他状态"><div class="m-group">' + mobileExtRows(extFor("other")) + "</div></section>" : "";
    return ctx + usage + other;
  }

  // 短文字与名称同行右对齐；放不进一行时换到名称下方左对齐，不在右侧折成多行
  function mobileExtRows(items) {
    return items.map((item) => {
      const stack = item.text.length > EXT_INLINE_CHARS ? " stack" : "";
      return '<div class="m-row' + stack + '"><span class="k">' + esc(item.label) + '</span><span class="v ext-text"' + toneAttr(item) + ">" + esc(item.text) + "</span></div>";
    }).join("");
  }

  function renderDrawer() {
    const scene = SCENES[state.scene];
    let status = "";
    if (scene.kind === "live") status = drawerLive(scene);
    if (scene.kind === "waiting") status = '<section class="m-section"><h3>状态</h3><div class="m-group"><div class="m-row"><span class="placeholder"><span class="pulse" aria-hidden="true"></span>正在获取状态…</span></div></div></section>';
    if (scene.kind === "legacy") status = '<section class="m-section"><h3>状态</h3><div class="m-group"><div class="m-row"><span class="placeholder">这台电脑上的 Pi Reach 扩展版本较旧，暂不提供状态。更新扩展后可查看。</span></div></div></section>';
    if (scene.kind === "history") status = '<p class="m-note history-note">没有运行中的 Pi，不提供上下文与用量。</p>';
    // 与桌面卡片同序：状态在前，会话信息在后
    $("drawerBody").innerHTML = status + drawerSession(scene);
  }

  /* ---------- 手机手势：左滑打开、右滑关闭，跟手并按过半提交 ---------- */

  const phone = $("phone");
  const drawer = $("drawer");
  const scrim = $("scrim");
  let open = false;
  let drag = null;
  let returnFocus = null;

  function drawerWidth() { return drawer.getBoundingClientRect().width || 320; }

  function paint(offset) {
    const width = drawerWidth();
    drawer.style.transform = "translateX(" + offset + "px)";
    scrim.style.opacity = String(1 - offset / width);
  }

  function setOpen(next, focusTarget) {
    open = next;
    phone.classList.add("is-anim");
    phone.classList.toggle("is-closing", !next);
    phone.classList.toggle("is-open", next);
    drawer.style.transform = next ? "translateX(0)" : "translateX(100%)";
    scrim.style.opacity = next ? "1" : "0";
    drawer.toggleAttribute("inert", !next);
    drawer.setAttribute("aria-hidden", String(!next));
    $("openDrawer").setAttribute("aria-expanded", String(next));
    if (next) {
      returnFocus = focusTarget || null;
      $("closeDrawer").focus({ preventScroll: true });
    } else if (returnFocus) {
      returnFocus.focus({ preventScroll: true });
      returnFocus = null;
    }
  }

  function ignoreTarget(target) {
    return target.closest("[data-swipe-ignore], input, .m-top");
  }

  phone.addEventListener("pointerdown", (event) => {
    if (event.button !== 0 || ignoreTarget(event.target)) return;
    if (open && !event.target.closest(".m-drawer, .m-scrim")) return;
    drag = { id: event.pointerId, x: event.clientX, y: event.clientY, axis: null, offset: open ? 0 : drawerWidth(), lastX: event.clientX, lastT: event.timeStamp, v: 0 };
  });

  phone.addEventListener("pointermove", (event) => {
    if (!drag || event.pointerId !== drag.id) return;
    const dx = event.clientX - drag.x;
    const dy = event.clientY - drag.y;
    if (!drag.axis) {
      if (Math.abs(dx) < AXIS_LOCK && Math.abs(dy) < AXIS_LOCK) return;
      drag.axis = Math.abs(dx) > Math.abs(dy) ? "x" : "y";
      // 关闭时只认左滑，打开时只认右滑；右滑打开导航不在本原型范围
      const wrongWay = open ? dx < 0 : dx > 0;
      if (drag.axis === "y" || wrongWay) { drag = null; return; }
      phone.setPointerCapture(event.pointerId);
      phone.classList.remove("is-anim");
      phone.classList.add("is-dragging");
    }
    const width = drawerWidth();
    const base = open ? 0 : width;
    drag.offset = Math.max(0, Math.min(width, base + dx));
    const dt = Math.max(1, event.timeStamp - drag.lastT);
    drag.v = (event.clientX - drag.lastX) / dt;
    drag.lastX = event.clientX;
    drag.lastT = event.timeStamp;
    paint(drag.offset);
  });

  function endDrag(event) {
    if (!drag || event.pointerId !== drag.id) return;
    const wasDragging = drag.axis === "x";
    const projected = drag.offset + drag.v * PROJECTION_MS;
    drag = null;
    if (!wasDragging) return;
    phone.classList.remove("is-dragging");
    setOpen(projected < drawerWidth() / 2, open ? returnFocus : null);
  }
  phone.addEventListener("pointerup", endDrag);
  phone.addEventListener("pointercancel", endDrag);

  $("openDrawer").addEventListener("click", (event) => setOpen(true, event.currentTarget));
  $("closeDrawer").addEventListener("click", () => setOpen(false));
  scrim.addEventListener("click", () => setOpen(false));
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && open) setOpen(false);
  });

  /* ---------- 示意时间线 ---------- */

  const TIMELINE = '<div class="bubble">移动端点按导航后焦点圈还在，帮我看下原因并修掉</div>'
    + '<div class="reply"><span class="process">已思考 · 读取 3 个文件</span>'
    + "<p>触屏点按后焦点留在导航入口，浏览器把它当作键盘焦点显示了焦点圈。改为只在键盘操作时显示焦点提示：</p>"
    + '<div class="code">.pwa-nav-trigger:focus:not(:focus-visible) {\n  outline: none;\n}</div>'
    + "<p>已补充触屏与键盘两种输入的浏览器测试，Composer 留白也按实际输入能力判断。</p></div>"
    + '<div class="bubble">顺便检查一下桌面键盘导航</div>'
    + '<div class="reply"><span class="process">运行中 · 执行测试</span></div>';
  document.querySelectorAll("[data-timeline]").forEach((el) => { el.innerHTML = TIMELINE; });

  /* ---------- 控件 ---------- */

  const REVIEW = {
    desktop: [
      "阅读列让位：卡片放不下时正文与输入区左移到刚好让出卡片（侧栏展开时窗口 ≥ 1268px 显示，≥ 1524px 回到居中）；收展侧栏或拖动窗口时正文随之平移。",
      "上下文用与文字同号的小饼图示意占用：平时为中性灰，偏高、将满时扇形与标签同色；刚压缩时只剩虚线外框。",
      "本地历史不显示卡片；等待与旧扩展场景仍占位显示提示，是否也应隐藏。",
      "标题区右侧只保留刷新，卡片不放入标题区，避免与目录副标题抢首行。",
      "扩展适配：默认只显示 Pi 内置状态；有扩展按约定上报时，可指定放入上下文、用量或会话块，排在该块内置行之后；未指定的放在用量与会话之间的无标题块。每条为短名称加单行文字（过长省略，悬停看全文），琥珀与红色只用于扩展声明的提醒与错误。",
    ],
    phone: [
      "标题区右侧「信息」图标改为打开本抽屉，原会话信息弹层合并进末尾的「会话」分组，不再保留两个入口；分组顺序与桌面卡片一致；电脑名作为会话名下方的副标题（不带运行状态，运行、退出与只读已由输入区表达），工作目录与分支相邻。",
      "在会话区左滑打开（跟手、过半提交），右滑或点遮罩、关闭按钮、Escape 关闭；右滑打开导航保持不变。",
      "抽屉底色与分组沿用设置页的 iOS 式分组列表（grouped-bg 上的 surface 分组），宽度与移动导航相同。",
      "用量明细在移动端完整列出；是否在上下文分组提供「压缩上下文」入口待定。",
      "扩展适配：放置规则与桌面相同，短文字与名称同行，过长时换到名称下方完整显示；没有适配的扩展时整组不出现。",
    ],
  };

  function renderNotes() {
    $("reviewList").innerHTML = REVIEW[state.viewport].map((item) => "<li>" + esc(item) + "</li>").join("");
    if (state.viewport === "phone") $("layoutNote").textContent = SCENES[state.scene].note;
  }

  function setPressed(attr, value) {
    document.querySelectorAll(".seg [" + attr + "]").forEach((btn) => {
      btn.setAttribute("aria-pressed", String(btn.getAttribute(attr) === value));
    });
  }

  function render() {
    renderCard();
    renderDrawer();
    if (state.viewport === "desktop") renderDesk();
    renderNotes();
  }

  document.addEventListener("click", (event) => {
    const btn = event.target.closest("button, a");
    if (!btn) return;
    if (btn.tagName === "A") { event.preventDefault(); return; }
    if (btn.dataset.themeSet) {
      document.documentElement.dataset.theme = btn.dataset.themeSet;
      setPressed("data-theme-set", btn.dataset.themeSet);
      return;
    }
    if (btn.dataset.viewportSet) {
      state.viewport = btn.dataset.viewportSet;
      document.body.dataset.viewport = state.viewport;
      setPressed("data-viewport-set", state.viewport);
      $("deskFit").hidden = state.viewport !== "desktop";
      phone.hidden = state.viewport !== "phone";
      render();
      return;
    }
    if (btn.dataset.extSet) {
      state.ext = btn.dataset.extSet === "some";
      setPressed("data-ext-set", btn.dataset.extSet);
      render();
      return;
    }
    if (btn.dataset.sidebarSet) {
      state.sidebar = btn.dataset.sidebarSet;
      setPressed("data-sidebar-set", state.sidebar);
      renderDesk();
      return;
    }
  });

  $("sceneSelect").addEventListener("change", (event) => { state.scene = event.target.value; render(); });
  $("widthRange").addEventListener("input", (event) => {
    state.width = Number(event.target.value);
    $("widthOut").textContent = String(state.width);
    renderDesk();
  });
  window.addEventListener("resize", () => { if (state.viewport === "desktop") fitDesk(); });

  // 允许用查询参数直达状态，便于截图核对：?view=phone&scene=high&theme=dark&width=1280&open=1
  const params = new URLSearchParams(location.search);
  if (params.get("scene") in SCENES) { state.scene = params.get("scene"); $("sceneSelect").value = state.scene; }
  if (params.get("width")) { state.width = Number(params.get("width")); $("widthRange").value = String(state.width); $("widthOut").textContent = String(state.width); }
  if (params.get("sidebar") === "closed") { state.sidebar = "closed"; setPressed("data-sidebar-set", "closed"); }
  if (params.get("theme") === "dark") { document.documentElement.dataset.theme = "dark"; setPressed("data-theme-set", "dark"); }
  if (params.get("ext") === "1") { state.ext = true; setPressed("data-ext-set", "some"); }
  document.body.dataset.viewport = "desktop";
  render();
  if (params.get("view") === "phone") {
    document.querySelector('[data-viewport-set="phone"]').click();
    if (params.get("open") === "1") setOpen(true);
  }
})();
