/* 单一计时与动画所有者；取消不依赖 finished promise。 */
window.StageAMotion = (() => {
  let activeDialog = null, originalOverflow = '';
  function scope(getConfig) {
    const timers = new Set(), animations = new Map();
    const reduced = () => getConfig().reduced || matchMedia('(prefers-reduced-motion: reduce)').matches;
    const duration = ms => reduced() ? Math.min(100, ms) : ms * getConfig().rate;
    const curves = {press:'cubic-bezier(.2,0,.2,1)', reveal:'cubic-bezier(0,0,0,1)', resize:'cubic-bezier(.2,0,0,1)', panel:'cubic-bezier(.2,0,0,1)', feedback:'cubic-bezier(.2,0,.2,1)', exit:'cubic-bezier(.3,0,1,1)'};
    function later(fn, ms) {
      const id = setTimeout(() => { timers.delete(id); fn(); }, ms);
      timers.add(id); return id;
    }
    function cancelTimer(id) { clearTimeout(id); timers.delete(id); }
    function animate(el, frames, ms = 180, key = el, curve = 'resize') {
      animations.get(key)?.cancel();
      if (!el?.animate) return;
      if (reduced()) frames = frames.map(frame => ({opacity: frame.opacity ?? 1}));
      const animation = el.animate(frames, {duration:duration(ms), easing:curves[curve], fill:'none'});
      animations.set(key, animation);
      animation.finished.then(() => { if (animations.get(key) === animation) animations.delete(key); }, () => {});
      return animation;
    }
    function clearAnimations() { animations.forEach(a => a.cancel()); animations.clear(); }
    function clear() { timers.forEach(clearTimeout); timers.clear(); clearAnimations(); }
    return {later, cancelTimer, animate, clear, clearAnimations, reduced, duration};
  }
  return {
    scope,
    claim(close) {
      if (activeDialog && activeDialog !== close) activeDialog(true);
      if (!activeDialog) originalOverflow = document.documentElement.style.overflow;
      activeDialog = close; document.documentElement.style.overflow = 'hidden';
    },
    release(close) {
      if (activeDialog !== close) return;
      activeDialog = null; document.documentElement.style.overflow = originalOverflow;
    },
  };
})();
