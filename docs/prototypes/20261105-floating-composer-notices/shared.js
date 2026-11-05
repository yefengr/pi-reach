// 评审稿交互：只模拟界面状态，不接真实连接或协议。
(() => {
  const $ = (id) => document.getElementById(id);
  const svg = (d, size = 20, cls = "") => `<svg class="${cls}" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
  const icons = {
    spin: () => svg('<path d="M21 12a9 9 0 1 1-6.2-8.6"/>', 16, "spin"),
    refresh: () => svg('<path d="M21 12a9 9 0 1 1-3-6.7L21 8"/><path d="M21 3v5h-5"/>'),
    menu: () => svg('<path d="M4 7h16M4 12h16M4 17h16"/>'),
    more: () => svg('<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>'),
    plus: () => svg('<path d="M12 5v14M5 12h14"/>'),
    up: () => svg('<path d="M12 19V5M5 12l7-7 7 7"/>', 18),
    down: () => svg('<path d="M12 5v14M5 12l7 7 7-7"/>', 16),
    x: (s = 16) => svg('<path d="M18 6 6 18M6 6l12 12"/>', s),
    wifiOff: () => svg('<path d="M2 2l20 20"/><path d="M8.5 16.5a5 5 0 0 1 7 0"/><path d="M5 12.9a10 10 0 0 1 5.2-2.8"/><path d="M19 12.9a10 10 0 0 0-2.3-1.6"/><path d="M12 20h.01"/>', 16),
    cloudOff: () => svg('<path d="m2 2 20 20"/><path d="M5.8 5.8A7 7 0 0 0 9 19h8.5a4.5 4.5 0 0 0 1.3-.2"/><path d="M21.5 15.5A4.5 4.5 0 0 0 17.5 10h-1.8A7 7 0 0 0 10 5.1"/>', 24),
    alert: () => svg('<circle cx="12" cy="12" r="10"/><path d="M12 8v4M12 16h.01"/>', 16),
    check: () => svg('<circle cx="12" cy="12" r="10"/><path d="m8 12 3 3 5-6"/>', 16),
    file: () => svg('<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/>', 24),
    laptop: () => svg('<rect x="4" y="5" width="16" height="11" rx="2"/><path d="M2 19h20"/>', 16),
    gear: () => svg('<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>'),
  };

  const SESSION = "修复 relay 重连退避";
  const QUEUED = ["改完后再跑一次重连相关的测试", "顺便把 onClose 的重复监听去掉", "确认 MAX_DELAY 的单位是毫秒", "最后整理一下提交说明"];
  const STREAM_TEXT = "补充一点：钳制之后需要照常调用 schedule() 重新排期，否则第 7 次及以后的重试不会触发。我已经在 backoff.ts 里加了这一行，并补了一条测试，模拟连续失败 8 次，断言每次都重新排期，且延迟不超过 MAX_DELAY。接下来跑相关测试，确认没有破坏原有的退避曲线。";
  const MESSAGES = [
    ["user", "帮我看一下 relay 的重连退避为什么会在 30 秒后停住"],
    ["pi", "<p>原因在 <code>backoff.ts</code>：重试次数到 6 之后，延迟被钳到 <code>MAX_DELAY</code>，但计时器没有重新排期，所以看起来像停住了。</p><p>修复方法是在钳制后照常调用 <code>schedule()</code>，并补一条测试覆盖第 7 次重试。要我直接改吗？</p>"],
    ["user", "改吧，顺便看看断线时 onClose 是不是注册了两次"],
    ["pi", "<p>确认了：<code>connect()</code> 每次重连都会再注册一次 <code>onClose</code>，旧的监听没有移除，所以一次断线会触发两次重连计时。</p><p>修改分两步：</p><p>1. 把监听注册移到连接对象创建时，只注册一次；</p><p>2. 重连前先清理上一轮的计时器，避免两个计时器同时运行。</p><p>这两处改完后，重连间隔会严格按退避曲线增长，不会出现忽快忽慢的情况。</p>"],
    ["user", "好，改完跑一下测试"],
    ["pi", "<p>已修改 <code>backoff.ts</code> 与 <code>relay-connection.ts</code>，新增两条测试：</p><p>· 连续失败 8 次后仍会重新排期；</p><p>· 一次断线只触发一次重连计时。</p><p>相关测试全部通过。还有一处可以顺带优化：网络恢复事件到来时，可以跳过当前等待，立即重试一次，减少恢复后的等待时间。要一起改吗？</p>"],
  ];

  const state = { viewport: "mobile", queue: "0", atts: "0", conn: "ok", error: "off", install: "on", theme: "light" };
  const list = $("list"), device = $("device"), main = $("main"), footer = $("footer"), footerInner = $("footerInner"), topLayer = $("topLayer");
  let following = true, lastUserInput = 0, streamTimer = null, outageTimers = [], toastTimer = null;

  // —— 消息列表 ——
  function renderMessages() {
    list.innerHTML = MESSAGES.map(([who, html]) => who === "user" ? `<div class="msg msg-user">${html}</div>` : `<div class="msg">${html}</div>`).join("");
  }

  // —— 标题区：不再显示任何连接或退出状态 ——
  function renderTitle() {
    const noSession = state.conn === "nosession";
    $("titlebar").innerHTML = `
      <button class="icon-btn only-mobile" type="button" aria-label="打开导航" id="openNav">${icons.menu()}</button>
      <span class="title only-mobile">${noSession ? "MacBook Pro" : SESSION}</span>
      <div class="title-stack only-desktop">${noSession ? "" : `<div class="name">${SESSION}</div><div class="dir">pi-reach</div>`}</div>
      <button class="icon-btn only-desktop" type="button" aria-label="刷新应用" title="刷新应用">${icons.refresh()}</button>
      ${noSession ? "" : `<button class="icon-btn only-mobile" type="button" aria-label="更多">${icons.more()}</button>`}`;
    $("openNav").addEventListener("click", () => setNav(true));
  }

  // —— 侧栏与移动导航：安装提示在底部、电脑入口上方 ——
  function navMarkup() {
    const install = state.install === "on" ? `<div class="install" role="note"><b>安装 Pi Reach</b><p>添加到主屏幕，像应用一样打开。</p><button class="btn" type="button">安装</button><button class="icon-btn" type="button" aria-label="关闭安装提示" data-close-install>${icons.x()}</button></div>` : "";
    return `<div class="side-brand"><i aria-hidden="true"></i>Pi Reach</div>
      <div class="side-list"><div class="side-group">在线</div><div class="side-row" aria-current="true">${SESSION}</div><div class="side-row">整理发布说明</div>
      <div class="side-group">本地历史</div><div class="side-row">附件上传重试</div><div class="side-row">侧栏宽度调整</div></div>
      <div class="side-foot">${install}<div class="computer"><span class="pick">${icons.laptop()}MacBook Pro</span><button class="icon-btn" type="button" aria-label="设置">${icons.gear()}</button></div></div>`;
  }
  function renderNav() {
    $("sidebar").innerHTML = navMarkup();
    $("mobileNav").innerHTML = navMarkup();
    document.querySelectorAll("[data-close-install]").forEach((b) => b.addEventListener("click", () => set("install", "off")));
  }
  function setNav(open) {
    $("mobileNav").toggleAttribute("data-open", open);
    $("scrim").toggleAttribute("data-open", open);
  }
  $("scrim").addEventListener("click", () => setNav(false));

  // —— 浮动输入区 ——
  footerInner.innerHTML = `
    <button class="latest" type="button" id="latest" data-state="leave">${icons.down()}最新</button>
    <div class="grow drawer-wrap" id="drawerWrap"><div class="grow-inner"><div class="drawer" id="drawer"></div></div></div>
    <div class="card" id="card">
      <div class="grow" id="hintWrap"><div class="grow-inner"><div class="hint" id="hint" role="status"></div></div></div>
      <div class="grow" id="tilesWrap"><div class="grow-inner"><div class="tiles" id="tiles"></div></div></div>
      <textarea id="input" rows="1" aria-label="消息" placeholder="给 Pi 发消息"></textarea>
      <div class="card-foot"><button class="icon-btn" type="button" aria-label="添加附件" id="attach">${icons.plus()}</button><button class="send" type="button" aria-label="发送" id="send">${icons.up()}</button></div>
    </div>`;

  const input = $("input");
  // 草稿换行一次到位，不做高度过渡
  input.addEventListener("input", () => { input.style.height = "auto"; input.style.height = `${Math.min(input.scrollHeight, 160)}px`; });

  function readOnly() { return state.conn === "exited" || state.conn === "history"; }

  function renderDrawer() {
    const n = readOnly() ? 0 : Number(state.queue);
    if (n > 0) $("drawer").innerHTML = `<div class="drawer-head">排队中 ${n} 条</div><div class="drawer-list">${QUEUED.slice(0, n).map((t, i) => `<div class="q-row"><span class="q-index">${i + 1}</span><span class="q-text">${t}</span><button class="icon-btn" type="button" aria-label="撤回">${icons.x()}</button></div>`).join("")}</div>`;
    $("drawerWrap").toggleAttribute("data-open", n > 0);
  }
  function renderTiles() {
    const n = readOnly() ? 0 : Number(state.atts);
    if (n > 0) $("tiles").innerHTML = `<div class="tile" data-kind="image" title="screenshot.png"><span class="tile-x">${icons.x(12)}</span></div><div class="tile" title="backoff.log"><span class="doc">${icons.file()}</span><span class="tile-x">${icons.x(12)}</span></div>`;
    $("tilesWrap").toggleAttribute("data-open", n > 0);
  }

  // 提示行：只有动态图标用运行色，文字与「立即重试」保持中性色
  const HINTS = {
    early: () => `${icons.spin()}<span class="msg-text">正在重新连接…</span>`,
    late: () => `${icons.spin()}<span class="msg-text">无法连接 Relay，正在自动重试…</span><button class="text-action" type="button" id="retry"><span>立即重试</span></button>`,
    nonet: () => `${icons.wifiOff()}<span class="msg-text">网络不可用，恢复后自动重新连接</span>`,
    exited: () => `<span class="msg-text">这个 Pi 已退出，会话记录已保存在本地历史</span>`,
    history: () => `<span class="msg-text">这是本地保存的历史记录，只能阅读</span>`,
  };
  function renderHint() {
    const make = HINTS[state.conn];
    if (make) $("hint").innerHTML = make();
    $("hintWrap").toggleAttribute("data-open", Boolean(make));
    $("retry")?.addEventListener("click", retryNow);
    const ro = readOnly();
    input.readOnly = ro;
    input.placeholder = ro ? "无法发送消息" : "给 Pi 发消息";
    if (ro) { input.value = ""; input.style.height = ""; }
    $("send").disabled = ro;
    $("attach").disabled = ro;
  }

  function renderEmpty() {
    const noSession = state.conn === "nosession";
    $("empty").hidden = !noSession;
    list.hidden = noSession;
    footer.hidden = noSession;
    if (!noSession) return;
    $("empty").innerHTML = `<span class="e-icon">${icons.cloudOff()}</span><h2>无法连接 Relay</h2><p>${icons.spin()}正在自动重试…</p><button class="btn" type="button" id="emptyRetry">立即重试</button>`;
    $("emptyRetry").addEventListener("click", () => {
      $("empty").innerHTML = `<span class="e-icon">${icons.cloudOff()}</span><h2>无法连接 Relay</h2><p>${icons.spin()}正在重新连接…</p>`;
      outageTimers.push(setTimeout(() => {
        $("empty").innerHTML = `<h2>有 2 个在线的 Pi</h2><p style="color:var(--secondary)">从导航中选择一个 Pi</p>`;
        showToast("连接已恢复");
      }, 1200));
    });
  }

  // —— 顶部浮层：局部错误卡片（与 Toast 同族）与 Toast ——
  function floatCard(kind, text, multi) {
    const el = document.createElement("div");
    el.className = `float-card${kind === "toast" ? " toast" : ""}`;
    el.dataset.state = "enter";
    if (multi) el.dataset.multi = "";
    el.setAttribute("role", "status");
    el.innerHTML = `<span class="fc-icon ${kind === "toast" ? "ok" : "error"}">${kind === "toast" ? icons.check() : icons.alert()}</span><span class="fc-text">${text}</span><button class="icon-btn" type="button" aria-label="关闭">${icons.x()}</button>`;
    requestAnimationFrame(() => requestAnimationFrame(() => { el.dataset.state = "shown"; }));
    return el;
  }
  function leave(el, after) {
    if (!el || el.dataset.state === "leave") return;
    el.dataset.state = "leave";
    setTimeout(() => { el.remove(); after?.(); }, 140);
  }
  let errorEl = null;
  function renderError() {
    if (state.error === "off") { const el = errorEl; errorEl = null; leave(el, syncTop); syncTop(); return; }
    const text = state.error === "long" ? "无法读取这段会话。请更新电脑上的 Pi 后重试。" : "无法加载更早的历史记录。";
    if (errorEl) { errorEl.querySelector(".fc-text").textContent = text; errorEl.toggleAttribute("data-multi", state.error === "long"); syncTop(); return; }
    errorEl = floatCard("error", text, state.error === "long");
    errorEl.querySelector(".icon-btn").addEventListener("click", () => set("error", "off"));
    topLayer.prepend(errorEl);
    syncTop();
  }
  function showToast(text) {
    clearTimeout(toastTimer);
    topLayer.querySelector(".toast")?.remove();
    const el = floatCard("toast", text, false);
    el.querySelector(".icon-btn").addEventListener("click", () => leave(el));
    topLayer.append(el);
    toastTimer = setTimeout(() => leave(el), 4000);
  }

  // —— 视口：底部留白随输入区实际高度同步；跟随时逐帧贴底，回看时不动 ——
  const BASE_TOP = 24, BOTTOM_GAP = 8;
  let topExtra = 0;
  function pin() { list.scrollTop = list.scrollHeight; }
  function syncBottom() {
    list.style.setProperty("--pad-bottom", `${footer.hidden ? 24 : footer.offsetHeight + BOTTOM_GAP}px`);
    if (following) pin();
  }
  // 错误卡片盖住顶部一条正文：顶部留白同步加长并补偿滚动位置，正文不动
  function syncTop() {
    const next = errorEl && errorEl.dataset.state !== "leave" ? errorEl.offsetHeight + 8 : 0;
    const delta = next - topExtra;
    if (!delta) return;
    topExtra = next;
    list.style.setProperty("--pad-top", `${BASE_TOP + topExtra}px`);
    if (following) pin(); else list.scrollTop += delta;
  }
  new ResizeObserver(syncBottom).observe(footer);
  new ResizeObserver(syncTop).observe(topLayer);

  const atBottom = () => list.scrollHeight - list.clientHeight - list.scrollTop <= 2;
  ["wheel", "touchstart", "touchmove", "keydown", "pointerdown"].forEach((ev) => list.addEventListener(ev, () => { lastUserInput = performance.now(); }, { passive: true }));
  list.addEventListener("scroll", () => {
    // 只有用户的滚动改变跟随状态；程序贴底与浏览器钳制不算回看
    if (performance.now() - lastUserInput < 600) following = atBottom();
    main.toggleAttribute("data-scrolled", list.scrollTop > 0);
    updateLatest();
    renderNotes();
  });
  function updateLatest() {
    const show = !following && list.scrollHeight - list.clientHeight - list.scrollTop > 120;
    $("latest").dataset.state = show ? "shown" : "leave";
  }
  $("latest").addEventListener("click", () => { following = true; list.scrollTo({ top: list.scrollHeight, behavior: "smooth" }); updateLatest(); renderNotes(); });
  $("toMiddle").addEventListener("click", () => { following = false; list.scrollTop = (list.scrollHeight - list.clientHeight) / 2; updateLatest(); renderNotes(); });
  $("toBottom").addEventListener("click", () => { following = true; pin(); updateLatest(); renderNotes(); });

  // —— Pi 流式输出：跟随时逐字贴底，回看时不打扰 ——
  $("stream").addEventListener("click", () => {
    if (streamTimer) return stopStream();
    const msg = document.createElement("div");
    msg.className = "msg streaming";
    list.append(msg);
    let i = 0;
    $("stream").setAttribute("aria-pressed", "true");
    $("stream").textContent = "停止输出";
    streamTimer = setInterval(() => {
      i += 3;
      msg.textContent = STREAM_TEXT.slice(0, i);
      if (following) pin();
      updateLatest();
      if (i >= STREAM_TEXT.length) stopStream();
    }, 80);
  });
  function stopStream() {
    clearInterval(streamTimer); streamTimer = null;
    list.querySelector(".msg.streaming")?.classList.remove("streaming");
    $("stream").setAttribute("aria-pressed", "false");
    $("stream").textContent = "Pi 开始输出";
  }

  // —— 断线流程：3 秒内不提示，3 秒后转圈，10 秒后给原因与立即重试 ——
  function clearOutage() { outageTimers.forEach(clearTimeout); outageTimers = []; }
  $("outage").addEventListener("click", () => {
    clearOutage();
    set("conn", "ok", true);
    notesExtra = "已断线，3 秒内不提示…";
    renderNotes();
    outageTimers.push(setTimeout(() => { set("conn", "early", true); notesExtra = "断线 3 秒：提示行出现「正在重新连接…」"; renderNotes(); }, 3000));
    outageTimers.push(setTimeout(() => { set("conn", "late", true); notesExtra = "断线 10 秒：说明原因并给出「立即重试」"; renderNotes(); }, 10000));
  });
  function retryNow() {
    clearOutage();
    set("conn", "early", true);
    notesExtra = "立即重试中…";
    renderNotes();
    outageTimers.push(setTimeout(() => { set("conn", "ok", true); notesExtra = ""; showToast("连接已恢复"); renderNotes(); }, 1200));
  }
  $("toast").addEventListener("click", () => showToast("设置已保存"));

  // —— 评审说明 ——
  let notesExtra = "";
  const CONN_NOTES = {
    ok: "正常连接：标题区不显示「已连接」，输入框没有提示行。",
    early: "断线 3 秒后：只有转圈图标是运行色，文字中性色，不提供操作。",
    late: "断线 10 秒后：说明原因，并给出文字操作「立即重试」，点击后模拟 1.2 秒恢复并弹出 Toast「连接已恢复」。",
    nonet: "无网络：中性色，不提供重试；仍可写草稿。",
    exited: "Pi 已退出：同一个白色输入框，只读，占位文字「无法发送消息」；不再提供「选择其他 Pi」。",
    history: "阅读本地历史：与 Pi 已退出相同的只读输入框，只换提示文字。",
    nosession: "未打开会话：没有输入框，断线说明放在主区空态；点「立即重试」模拟恢复。",
  };
  function renderNotes() {
    const mode = state.conn === "nosession" ? "" : `<p><span class="mode-pill" data-mode="${following ? "follow" : "read"}">${following ? "跟随：停在最新" : "回看：内容不动"}</span></p>`;
    $("notes").innerHTML = `<h2>当前状态</h2>${mode}<p>${CONN_NOTES[state.conn]}</p>${notesExtra ? `<p><b>${notesExtra}</b></p>` : ""}
      <h3>建议这样看</h3><ul>
      <li>停在底部，切换排队 0 → 4：最新内容随抽屉同步上移，始终露在抽屉上方。</li>
      <li>点「滚到中部」后再切换排队或附件：正在读的内容不动，抽屉直接盖住底部。</li>
      <li>点「Pi 开始输出」再切换排队：跟随时新文字始终可见。</li>
      <li>打开局部错误：卡片浮在标题区下方，正文不被推开；回到顶部仍能看到第一行。</li>
      <li>点「模拟一次断线」：按真实时长观察 3 秒和 10 秒两档提示。</li>
      <li>手机视口点左上角菜单，看安装提示在导航底部的位置。</li></ul>
      <h3>模拟与未覆盖</h3><ul><li>时长与曲线取自现有 token；iOS 键盘、减少动态效果与矮窗口未模拟。</li><li>「最新」入口按离底 120px 显示，正式规则为超过一屏。</li></ul>`;
  }

  // —— 控制条 ——
  function set(key, value, fromFlow = false) {
    if (key === "conn" && !fromFlow) { clearOutage(); notesExtra = ""; }
    state[key] = value;
    document.querySelectorAll(`.seg[data-key="${key}"] button`).forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.value === value)));
    apply(key);
  }
  function apply(key) {
    if (key === "viewport") { device.dataset.viewport = state.viewport; setNav(false); fitDevice(); }
    if (key === "theme") document.documentElement.dataset.theme = state.theme;
    if (key === "install") renderNav();
    if (key === "error") renderError();
    if (key === "conn") { renderTitle(); renderEmpty(); renderHint(); renderDrawer(); renderTiles(); }
    if (key === "queue") renderDrawer();
    if (key === "atts") renderTiles();
    renderNotes();
  }
  document.querySelectorAll(".seg").forEach((seg) => seg.addEventListener("click", (e) => {
    const b = e.target.closest("button");
    if (b) set(seg.dataset.key, b.dataset.value);
  }));

  // 窄屏（如在手机上评审桌面画面）时整体等比缩放，不挤压内部布局
  function fitDevice() {
    const natural = state.viewport === "desktop" ? 980 : 390;
    device.style.zoom = String(Math.min(1, device.parentElement.clientWidth / natural));
  }
  addEventListener("resize", fitDevice);

  renderMessages();
  Object.keys(state).forEach((k) => set(k, state[k]));
  requestAnimationFrame(pin);
})();
