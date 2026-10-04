// 效果稿场景与明暗切换：只切换静态状态，不接真实文件、Relay 或网络。
(function () {
  const SCENES = ['chat', 'image', 'markdown', 'loading', 'errors', 'confirm', 'large', 'offline'];
  const THEMES = ['light', 'dark'];
  const state = { scene: 'chat', theme: 'light' };

  function pick(list, value, fallback) {
    return list.indexOf(value) >= 0 ? value : fallback;
  }

  function fromUrl() {
    const params = new URLSearchParams(window.location.search);
    return {
      scene: pick(SCENES, params.get('scene'), 'chat'),
      theme: pick(THEMES, params.get('theme'), 'light'),
    };
  }

  function render(syncUrl) {
    document.documentElement.dataset.theme = state.theme;
    document.body.dataset.scene = state.scene;
    document.body.dataset.theme = state.theme;

    const select = document.getElementById('scene-select');
    if (select) select.value = state.scene;

    const toggle = document.getElementById('theme-toggle');
    if (toggle) {
      const toDark = state.theme === 'light';
      toggle.setAttribute('aria-label', toDark ? '切换到深色外观' : '切换到浅色外观');
      toggle.setAttribute('aria-pressed', String(state.theme === 'dark'));
    }

    if (syncUrl) {
      const params = new URLSearchParams(window.location.search);
      params.set('scene', state.scene);
      params.set('theme', state.theme);
      window.history.replaceState(null, '', window.location.pathname + '?' + params.toString());
    }
  }

  Object.assign(state, fromUrl());
  render(false);

  const select = document.getElementById('scene-select');
  if (select) {
    select.addEventListener('change', function () {
      state.scene = pick(SCENES, select.value, 'chat');
      render(true);
    });
  }

  const toggle = document.getElementById('theme-toggle');
  if (toggle) {
    toggle.addEventListener('click', function () {
      state.theme = state.theme === 'dark' ? 'light' : 'dark';
      render(true);
    });
  }

  // 静态效果稿：阻止误触提交导致页面重载，不实现真实发布或下载。
  const composer = document.querySelector('.composer');
  if (composer) {
    composer.addEventListener('submit', function (event) {
      event.preventDefault();
    });
  }
})();
