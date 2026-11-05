// 评审稿交互：只切换模拟状态，不接任何真实接口。
const state = { ring: "ring-num", tip: "off", deskTile: "square", hintPos: "card", scheme: "d", queue: "5", atts: "4", upload: "draft", hint: "off", viewport: "mobile", theme: "light" };
const expanded = new Set();
const LIMIT = 3;

const svg = (path) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${path}</svg>`;
const ICON = {
  clock: svg('<circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>'),
  up: svg('<path d="m5 12 7-7 7 7"/><path d="M12 19V5"/>'),
  pencil: svg('<path d="M21.2 6.8a2.8 2.8 0 0 0-4-4L3.8 16.2 2 22l5.8-1.8z"/>'),
  x: svg('<path d="M18 6 6 18"/><path d="m6 6 12 12"/>'),
  file: svg('<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/>'),
  down: svg('<path d="m6 9 6 6 6-6"/>'),
  up2: svg('<path d="m18 15-6-6-6 6"/>'),
  plus: svg('<path d="M5 12h14"/><path d="M12 5v14"/>'),
  slash: svg('<path d="M22 2 2 22"/>'),
  retry: svg('<path d="M3 12a9 9 0 0 1 15-6.7L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-15 6.7L3 16"/><path d="M8 16H3v5"/>'),
  clip: svg('<path d="m21.4 11.1-9.2 9.2a6 6 0 0 1-8.5-8.5l8.6-8.6a4 4 0 0 1 5.7 5.7l-8.6 8.6a2 2 0 0 1-2.8-2.8l8.5-8.5"/>'),
  check: svg('<path d="M20 6 9 17l-5-5"/>'),
  square: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor"/></svg>',
};

// 第 1、2 条排队消息自带附件，用于展示行内回形针计数。
const QUEUE_ATTS = [1, 2, 0, 0, 0];
const QUEUE = ["再补一条：失败提示文案改成“已重新开始上传”", "测试里加上断线恢复的用例", "顺便检查暂停按钮在离线时的禁用态", "最后把改动整理成一个提交说明", "跑一遍 pnpm lint"];
const ATTS = [
  { name: "upload-error.log", size: "12.4 KiB", kind: "file" },
  { name: "暂停恢复截图.png", size: "386 KiB", kind: "image" },
  { name: "relay-trace.json", size: "1.2 MiB", kind: "file" },
  { name: "设计稿-附件区.pdf", size: "2.8 MiB", kind: "file" },
];
const HINT = "连接恢复后才能发送";
const EXT = (name) => name.split(".").pop().toUpperCase();

const queueItems = () => QUEUE.slice(0, Number(state.queue));
const attItems = () => ATTS.slice(0, Number(state.atts)).map((item, index) => {
  if (state.upload === "failed") return index === 1 ? { ...item, failed: true } : index === 0 ? { ...item, tip: true } : item;
  if (state.upload !== "uploading") return index === 0 ? { ...item, tip: true } : item;
  // 上传中：首件完成、第二件进行中、其余等待，与真实逐件进度一致。
  return index === 0 ? { ...item, done: true, tip: true } : index === 1 ? { ...item, progress: 48 } : { ...item, waiting: true };
});

function queueRow(text, index, numbered, first) {
  return `<div class="row${first ? " first" : ""}">
    ${numbered ? `<span class="row-index">${index + 1}</span>` : ""}
    <span class="row-status" title="排队中">${ICON.clock}</span>
    <span class="row-text">${text}</span>
    ${QUEUE_ATTS[index] ? `<span class="row-clip" title="${QUEUE_ATTS[index]} 个附件" aria-label="${QUEUE_ATTS[index]} 个附件">${ICON.clip}${QUEUE_ATTS[index]}</span>` : ""}
    <span class="row-actions"><button class="icon-btn" type="button" aria-label="插入到会话">${ICON.up}</button><button class="icon-btn" type="button" aria-label="撤回编辑">${ICON.pencil}</button></span>
  </div>`;
}

function attRow(item, first) {
  const meta = item.done ? `<span class="row-meta" style="color: var(--complete)">已就绪</span>`
    : item.progress !== undefined ? `<span class="row-meta">${item.progress}%</span>`
      : item.waiting ? `<span class="row-meta">等待上传</span>` : `<span class="row-meta">${item.size}</span>`;
  return `<div class="row${first ? " first" : ""}">
    <span class="thumb" data-kind="${item.kind}">${item.kind === "file" ? ICON.file : ""}</span>
    <span class="row-name" title="${item.name}">${item.name}</span>${meta}
    <span class="row-actions"><button class="icon-btn" type="button" aria-label="${item.progress !== undefined ? "取消" : "移除"} ${item.name}">${ICON.x}</button></span>
    ${item.progress !== undefined ? `<span class="row-progress"><i style="--p:${item.progress}%"></i></span>` : ""}
  </div>`;
}

/** 前 LIMIT 行常显，其余放入可动画的折叠区；collapsible 为 false 时全部常显。 */
function collapsibleRows(key, rows, collapsible, unit, limit = LIMIT) {
  if (!collapsible || rows.length <= limit) return rows.join("");
  const open = expanded.has(key);
  const rest = rows.length - limit;
  return `${rows.slice(0, limit).join("")}
    <div class="more"${open ? " data-open" : ""} data-more="${key}"><div class="more-inner">${rows.slice(limit).join("")}</div></div>
    <button class="toggle" type="button" data-toggle="${key}" data-rest="${rest}" data-unit="${unit}" aria-expanded="${open}">${ICON.down}<span>${open ? "收起" : `还有 ${rest} ${unit}`}</span></button>`;
}

function head(title, count, first) {
  return `<div class="row row-head${first ? " first" : ""}"><h2>${title}</h2><span class="count">${count}</span></div>`;
}

const cardHtml = (inner = "") => `<div class="card">${inner}
  <textarea rows="1" placeholder="向 Pi 发送消息…" aria-label="消息"></textarea>
  <div class="card-foot">
    <div class="card-tools"><button class="icon-btn" type="button" aria-label="添加附件">${ICON.plus}</button><button class="icon-btn" type="button" aria-label="Pi 命令">${ICON.slash}</button></div>
    <div class="card-actions"><span class="model">Sonnet 5.5 · medium</span><button class="send" type="button" aria-label="停止任务">${ICON.square}</button></div>
  </div>
</div>`;

// —— 现状：复刻当前结构，折叠为直接切片，无过渡 ——
function renderCurrent() {
  const q = queueItems();
  const a = attItems();
  let html = "";
  if (q.length) {
    const open = expanded.has("cur-q");
    const visible = q.length > LIMIT && !open ? q.slice(0, LIMIT) : q;
    html += `<section class="cur-queue">${q.length > 1 ? `<div class="cur-head"><h2>排队的消息</h2><span class="count">${q.length}</span></div>` : ""}
      <div class="cur-panel">${visible.map((text, i) => queueRow(text, i, q.length > 1, i === 0)).join("")}
      ${q.length > LIMIT ? `<button class="cur-more" type="button" data-plain="cur-q">${open ? "收起" : `还有 ${q.length - LIMIT} 条`}</button>` : ""}</div></section>`;
  }
  if (state.hint === "on") html += `<p class="cur-hint">${HINT}</p>`;
  if (a.length) {
    const canCollapse = a.length > 2 && state.upload !== "uploading";
    const open = expanded.has("cur-a");
    const visible = canCollapse && !open ? a.slice(0, 2) : a;
    html += `<section class="cur-atts"><div class="cur-grid">${visible.map((item) => `<div class="cur-card">
        <span class="thumb" data-kind="${item.kind}">${item.kind === "file" ? ICON.file : ""}</span>
        <span class="cur-meta"><span class="row-name">${item.name}</span><span class="row-meta">${item.progress !== undefined ? `${item.progress}%` : item.done ? "已就绪" : item.waiting ? "等待上传" : item.size}</span></span>
        <span class="row-actions"><button class="icon-btn" type="button" aria-label="移除 ${item.name}">${ICON.x}</button></span></div>`).join("")}</div>
      ${canCollapse ? `<button class="cur-toggle" type="button" data-plain="cur-a">${open ? ICON.up2 : ICON.down}${open ? "收起" : `展开全部（${a.length}）`}</button>` : ""}</section>`;
  }
  const topIsCard = !q.length && state.hint === "off" && !a.length;
  return { html: html + cardHtml(), overlapRadius: topIsCard ? 32 : null };
}

// —— A：排队与附件各自一块面板，同结构、同折叠、同按钮 ——
function renderA() {
  const q = queueItems();
  const a = attItems();
  const panels = [];
  if (q.length) {
    const rows = q.map((text, i) => queueRow(text, i, q.length > 1, i === 0 && q.length === 1));
    panels.push(`<section class="panel" aria-label="排队的消息">${q.length > 1 ? head("排队的消息", q.length, true) : ""}<div class="scroll">${collapsibleRows("a-q", rows, true, "条")}</div></section>`);
  }
  if (a.length) {
    const rows = a.map((item, i) => attRow(item, i === 0 && a.length === 1));
    panels.push(`<section class="panel" aria-label="附件">${a.length > 1 ? head("附件", a.length, true) : ""}<div class="scroll">${collapsibleRows("a-a", rows, state.upload !== "uploading", "个")}</div></section>`);
  }
  let html = panels.length ? `<div class="tray-a">${panels.join("")}</div>` : "";
  if (state.hint === "on") html += `<p class="a-hint">${HINT}</p>`;
  const overlapRadius = panels.length ? 12 : state.hint === "on" ? null : 32;
  return { html: html + cardHtml(), overlapRadius };
}

// —— B：托盘进入输入框卡片顶部，卡片始终在最上方 ——
function renderB() {
  const q = queueItems();
  const a = attItems();
  const sections = [];
  if (q.length) {
    const rows = q.map((text, i) => queueRow(text, i, q.length > 1, i === 0 && q.length === 1));
    sections.push(`<div class="card-section">${q.length > 1 ? head("排队的消息", q.length, true) : ""}<div class="scroll">${collapsibleRows("b-q", rows, true, "条")}</div></div>`);
  }
  if (a.length) {
    const rows = a.map((item, i) => attRow(item, i === 0 && a.length === 1));
    sections.push(`<div class="card-section">${a.length > 1 ? head("附件", a.length, true) : ""}<div class="scroll">${collapsibleRows("b-a", rows, state.upload !== "uploading", "个")}</div></div>`);
  }
  if (state.hint === "on") sections.push(`<div class="card-section"><div class="row row-hint first"><span class="row-text">${HINT}</span></div></div>`);
  const tray = sections.length ? `<div class="card-tray">${sections.join("")}</div><div class="card-tray-end"></div>` : "";
  return { html: cardHtml(tray), overlapRadius: 32 };
}

// —— 抽屉内分段：小标题行 + 按组折叠；两组同时存在时每组只露 2 行 ——
function drawerSection(key, title, rows, collapsible, unit, limit) {
  const label = rows.length > 1 ? `<div class="row section-label first"><span class="section-title">${title}</span><span class="count">${rows.length}</span></div>` : "";
  if (!label) rows[0] = rows[0].replace('class="row', 'class="row first');
  return `<div class="drawer-section">${label}${collapsibleRows(key, rows, collapsible, unit, limit)}</div>`;
}

function drawerHtml(sections, hint) {
  if (!sections.length && !hint) return "";
  const hintRow = hint ? `<div class="row row-hint first"><span class="row-text">${HINT}</span></div>` : "";
  return `<section class="drawer" aria-label="排队与提示">${hintRow}<div class="scroll">${sections.join("")}</div></section>`;
}

// —— C（改进）：排队、附件与提示收在输入框后的同一块抽屉里，分段并按组折叠 ——
function renderC() {
  const q = queueItems();
  const a = attItems();
  const limit = q.length && a.length ? 2 : LIMIT;
  const sections = [];
  if (q.length) sections.push(drawerSection("c-q", "排队的消息", q.map((text, i) => queueRow(text, i, q.length > 1, false)), true, "条", limit));
  if (a.length) sections.push(drawerSection("c-a", "附件", a.map((item) => attRow(item, false)), state.upload !== "uploading", "个", limit));
  const drawer = drawerHtml(sections, state.hint === "on");
  return { html: drawer + cardHtml(), overlapRadius: drawer ? 16 : 32 };
}

// —— D：附件以横排块进入输入框卡片，排队收在卡片后的抽屉里；提示行不进抽屉 ——
function attTile(item) {
  const status = item.done ? `<span class="tile-status" style="color: var(--complete)">已就绪</span>`
    : item.progress !== undefined ? `<span class="tile-status">${item.progress}%</span>`
      : `<span class="tile-status">${item.waiting ? "等待上传" : item.size}</span>`;
  return `<div class="tile" role="group" aria-label="${item.name}">
    <span class="thumb" data-kind="${item.kind}">${item.kind === "file" ? ICON.file : ""}</span>
    <span class="tile-meta"><span class="tile-name" title="${item.name}">${item.name}</span>${status}</span>
    <button class="icon-btn" type="button" aria-label="${item.progress !== undefined ? "取消" : "移除"} ${item.name}">${ICON.x}</button>
    ${item.progress !== undefined ? `<span class="tile-progress"><i style="--p:${item.progress}%"></i></span>` : ""}
  </div>`;
}

// 圆圈进度：直径 36、线宽 3；等待上传不画圆环，整块降到 opacity-disabled；可选在圆心显示百分比（对应 Mantine RingProgress）。
function ring(progress) {
  const r = 16.5, c = 2 * Math.PI * r;
  const label = state.ring === "ring-num" && progress > 0 ? `<span class="ring-num">${progress}</span>` : "";
  return `<span class="ring" role="progressbar" aria-valuenow="${progress}" aria-valuemin="0" aria-valuemax="100"><svg viewBox="0 0 36 36" aria-hidden="true">
    <circle cx="18" cy="18" r="${r}" class="ring-track"/><circle cx="18" cy="18" r="${r}" class="ring-bar" stroke-dasharray="${c}" stroke-dashoffset="${c * (1 - progress / 100)}"/></svg>${label}</span>`;
}

// 手机：72 方块，图片铺满，文件显示图标、扩展名与大小；移除为右上角角标，命中区 44。
function attSquare(item) {
  const phase = item.failed ? "failed" : item.progress !== undefined ? "uploading" : item.waiting ? "waiting" : item.done ? "done" : "draft";
  const body = item.kind === "image" ? "" : `${ICON.file}<span class="sq-ext">${EXT(item.name)}</span><span class="sq-size">${item.size}</span>`;
  const ringed = state.ring !== "bar";
  const overlay = phase === "uploading" ? (ringed ? `<span class="sq-overlay">${ring(item.progress)}</span>` : `<span class="sq-overlay">${item.progress}%</span><span class="tile-progress"><i style="--p:${item.progress}%"></i></span>`)
    : phase === "waiting" ? (ringed ? "" : `<span class="sq-overlay">等待</span>`)
      : phase === "failed" ? `<span class="sq-overlay sq-failed"><button class="icon-btn" type="button" aria-label="重试 ${item.name}">${ICON.retry}</button></span>`
        : "";
  const label = phase === "uploading" ? "取消" : "移除";
  const tip = item.tip && state.tip !== "off" ? `<span class="tip tip-${state.tip}" aria-hidden="true">${item.name}</span>${state.tip === "native" ? '<span class="tip-cursor" aria-hidden="true"></span>' : ""}` : "";
  return `<div class="sq" data-kind="${item.kind}" data-state="${phase}" role="group" aria-label="${item.name}" title="${item.name}">${tip}
    <span class="sq-face">${body}${overlay}</span>
    <button class="sq-remove" type="button" aria-label="${label} ${item.name}"><span>${ICON.x}</span></button>
  </div>`;
}

function renderD() {
  const q = queueItems();
  const a = attItems();
  const hintOn = state.hint === "on";
  const sections = q.length ? [drawerSection("d-q", "排队的消息", q.map((text, i) => queueRow(text, i, q.length > 1, false)), true, "条", LIMIT)] : [];
  const drawer = drawerHtml(sections, false);
  // 卡片内提示始终渲染插槽，出现与隐藏走 0fr↔1fr 高度过渡。
  const cardHint = state.hintPos === "card" ? `<div class="hint-slot"${hintOn ? " data-open" : ""}><div class="hint-inner"><p class="card-hint">${HINT}</p></div></div>` : "";
  const mobile = state.viewport === "mobile" || state.deskTile === "square";
  const strip = a.length ? `<div class="att-strip${mobile ? " att-strip-sq" : ""}" aria-label="附件">${a.map(mobile ? attSquare : attTile).join("")}</div>` : "";
  const outside = hintOn && state.hintPos === "outside" ? `<p class="a-hint">${HINT}</p>` : "";
  // 提示在卡片上方时它是最上方元素：文字无底色，退回 24 渐隐。
  const overlapRadius = outside ? null : drawer ? 16 : 32;
  return { html: outside + drawer + cardHtml(cardHint + strip), overlapRadius };
}

const RENDER = { current: renderCurrent, a: renderA, b: renderB, c: renderC, d: renderD };
const NOTES = {
  current: { tag: "对照", title: "现状", items: [
    "只有输入框卡片在最上方时，正文从 32 圆角两侧滑入卡片下方；",
    "有排队、提示或附件时退回“上方 24 渐隐 + 10 空白带”，两种衔接不一致；",
    "排队：单面板、外置标题、超过 3 条折叠，按钮在面板内；附件：独立卡片、双列、超过 2 件折叠，按钮在面板外；",
    "展开／收起直接切片，高度一次跳到位。"],
    cost: [] },
  a: { tag: "推荐", title: "A 统一面板（分离）", items: [
    "排队与附件各一块 panel 面板：同为 44 行、发丝线分隔、标题与计数放进面板首行；",
    "两者同一折叠规则：超过 3 项折叠，面板内“还有 N 条／个”，箭头随状态旋转；",
    "展开／收起用过程组同款 0fr↔1fr 行高过渡（collapse-in 400 / out 280，内容曲线），内容淡入并下移 8；",
    "最上方是面板时也重叠：列表延伸到面板上沿以下 12，正文从面板圆角滑入；只有提示行在最上方时保留 24 渐隐。"],
    cost: ["桌面附件从双列卡片改为单列行，2 件以上时更高；", "附件缩略图从 32 缩到 24；", "提示行单独在最上方时仍是旧衔接。"] },
  b: { tag: "候选", title: "B 合入输入框卡片", items: [
    "排队、附件、提示行都进入输入框卡片顶部，卡片永远在最上方，衔接与无附件时完全一致；",
    "同一卡片内分区，以发丝线隔开文本框；折叠规则与动画同 A；",
    "输入区始终是一个物体，高度只向上生长。"],
    cost: ["排队消息是“已发出”，放进草稿卡片里语义混淆；聚焦时整张卡片变强调色边框，排队区也被包含；", "卡片 32 圆角下行内容需额外内缩，可用宽度变小；", "与 DESIGN“附件区在输入框外上方”冲突最大。"] },
  c: { tag: "候选", title: "C 收拢抽屉（改进）", items: [
    "排队、附件与提示合并成一块抽屉，左右各内缩 8，下沿压在输入框后面；",
    "抽屉内分段：提示行在最上，其下“排队的消息 N”“附件 N”各带小标题与计数；",
    "按组折叠：两组同时存在时每组露 2 行，只有一组时露 3 行；上传中的附件不折叠；",
    "提示行成为抽屉的一行，有底色，任何组合都能重叠衔接（抽屉圆角 16）。"],
    cost: ["附件（草稿）与排队（已发出）同在抽屉，靠分段区分；", "提示行改为抽屉行，需调整 DESIGN 中提示行的位置规则；", "两组都多时抽屉仍较高，靠 236 的滚动上限兜底。"] },
  d: { tag: "已选", title: "D 附件进卡片 + 排队抽屉", items: [
    "附件属于草稿，以横排附件块放进输入框卡片顶部（与 Claude、Codex 一致），超出宽度横向滚动，不折叠；",
    "桌面附件块 52 高：缩略图、名称、大小或进度、移除；手机改为 72 方块：图片铺满，文件显示图标、扩展名与大小，右上角移除角标（命中区 44），进度、等待、失败与就绪以覆盖层表达；",
    "排队消息收在卡片后的抽屉里，超过 3 条折叠，展开收起有过渡；",
    "提示行不进抽屉：放在卡片内顶部一行，出现与隐藏以 collapse-in／out 高度过渡并淡化（发送过渡期间即时完成）；也可切到“卡片上方”对比。"],
    cost: ["手机方块不显示文件名（title／读屏仍可读），同类文件需靠扩展名与大小区分；", "附件较多时需横向滚动；", "提示在卡片上方时，最上方是无底色文字，衔接退回 24 渐隐；", "DESIGN 需改：附件区位置与排布、排队面板样式、提示行位置（若放卡片内）。"] },

};

function renderNotes() {
  const note = NOTES[state.scheme];
  document.getElementById("notes").innerHTML = `<span class="tag">${note.tag}</span><h2>${note.title}</h2><ul>${note.items.map((item) => `<li>${item}</li>`).join("")}</ul>
    ${note.cost.length ? `<h3>代价</h3><ul>${note.cost.map((item) => `<li>${item}</li>`).join("")}</ul>` : ""}`;
}

const device = document.getElementById("device");
const list = document.getElementById("list");
let following = true;

function render() {
  const { html, overlapRadius } = RENDER[state.scheme]();
  document.getElementById("composer").innerHTML = html;
  if (overlapRadius === null) {
    device.removeAttribute("data-overlap");
    device.style.setProperty("--overlap", "0px");
    device.style.setProperty("--lead", "var(--space-composer)");
  } else {
    device.setAttribute("data-overlap", "");
    device.style.setProperty("--overlap", `calc(var(--fade) + ${overlapRadius}px)`);
    device.style.setProperty("--lead", "var(--fade)");
  }
  device.dataset.viewport = state.viewport;
  // 真实 Tooltip 经 Portal 渲染不受裁切；原型演示时临时取消附件行的裁切。
  device.toggleAttribute("data-tip", state.tip !== "off");
  document.documentElement.dataset.theme = state.theme;
  document.querySelectorAll(".seg").forEach((seg) => seg.querySelectorAll("button").forEach((button) => button.setAttribute("aria-pressed", String(state[seg.dataset.key] === button.dataset.value))));
  renderNotes();
  if (following) list.scrollTop = list.scrollHeight;
}

document.querySelectorAll(".seg").forEach((seg) => seg.addEventListener("click", (event) => {
  const button = event.target.closest("button");
  if (!button) return;
  state[seg.dataset.key] = button.dataset.value;
  expanded.clear();
  render();
}));

document.getElementById("composer").addEventListener("click", (event) => {
  const plain = event.target.closest("[data-plain]");
  if (plain) {
    const key = plain.dataset.plain;
    expanded.has(key) ? expanded.delete(key) : expanded.add(key);
    render();
    return;
  }
  const toggle = event.target.closest("[data-toggle]");
  if (!toggle) return;
  // 只切换属性，不重渲染，保证过渡从当前高度开始。
  const key = toggle.dataset.toggle;
  const open = !expanded.has(key);
  open ? expanded.add(key) : expanded.delete(key);
  document.querySelector(`[data-more="${key}"]`).toggleAttribute("data-open", open);
  toggle.setAttribute("aria-expanded", String(open));
  toggle.querySelector("span").textContent = open ? "收起" : `还有 ${toggle.dataset.rest} ${toggle.dataset.unit}`;
});

// 跟随贴底：footer 过渡导致列表变矮时逐帧保持底部，模拟时间线视口的跟随行为。
list.addEventListener("scroll", () => { following = list.scrollHeight - list.scrollTop - list.clientHeight < 4; });
new ResizeObserver(() => { if (following) list.scrollTop = list.scrollHeight; }).observe(list);

document.getElementById("peek").addEventListener("click", () => { following = false;
  // 无重叠时把末行放进 24 渐隐中段；有重叠时让末行滑到最上方表面上沿以下 12。
  const offset = 88 + (device.hasAttribute("data-overlap") ? 16 : -12);
  list.scrollTop = list.scrollHeight - list.clientHeight - offset;
});
document.getElementById("hintAnim").addEventListener("click", () => {
  state.hint = state.hint === "on" ? "off" : "on";
  const slot = document.querySelector(".hint-slot");
  if (state.scheme !== "d" || !slot) { render(); return; }
  slot.toggleAttribute("data-open", state.hint === "on");
  document.querySelectorAll('.seg[data-key="hint"] button').forEach((button) => button.setAttribute("aria-pressed", String(button.dataset.value === state.hint)));
});
document.getElementById("bottom").addEventListener("click", () => { following = true; list.scrollTop = list.scrollHeight; });

render();
