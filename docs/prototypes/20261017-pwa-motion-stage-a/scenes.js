/* 阶段 A：原生 DOM 流程模拟，不读取 Pi、网络或持久化数据。 */
window.StageAScenes = (() => {
  const F = window.StageAFixtures, M = window.StageAMotion;
  const escape = value => String(value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const button = (action, text, extra = '') => `<button type="button" data-action="${action}" ${extra}>${text}</button>`;
  const icons = {arrow:'<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 19V5m-6 6 6-6 6 6"/></svg>', check:'<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12 4 4L19 6"/></svg>'};
  function markup() {
    return `<section data-scene="composer" class="scene-stage">
      <div class="scene-conversation"><div class="scene-user">请帮我整理这次界面评审的重点。</div><p>先保持内容与输入不变，再比较反馈是否清晰。</p><p class="scene-muted">接下来可以继续输入，发送只演示本地状态。</p></div>
      <div class="scene-composer"><textarea data-action="draft" aria-label="演示消息草稿" placeholder="继续讨论界面细节…" rows="3">请保留我的输入，比较两种反馈。</textarea><div class="scene-toolbar"><span class="scene-muted">本地演示</span><span class="scene-model-label">Sonnet · balanced</span>${button('send', `<span class="scene-press">${icons.arrow}</span>`, 'class="scene-send" aria-label="模拟发送"')}</div></div><p class="scene-status" data-slot="send-status" role="status">不会发送到 Pi；输入始终保留。</p></section>
      <section data-scene="menus" class="scene-stage"><h3>模型与思考</h3><p class="scene-muted">长名称、选中项与列表边缘</p><div class="scene-nav-list">${['界面评审 · 在线 Pi','阅读器过渡 · 本地历史','输入反馈 · 本地历史'].map((s,i)=>button('nav-select',`<span>${s}</span><small>${i?'今天 14:20':'workspace · 空闲'}</small>`,'class="scene-nav-row" aria-pressed="'+(!i)+'"')).join('')}</div><div class="scene-menu-anchor">${button('menu-toggle','模型与思考 ▾','aria-expanded="false"')}<div class="scene-menu" data-slot="menu" hidden></div></div><p class="scene-status" data-slot="model-status">${escape(F.models[0])} · balanced</p></section>
      <section data-scene="attachments" class="scene-stage"><h3>附件与文件获取</h3><p class="scene-muted">固定进度槽；所有进度与错误均为演示。</p><div data-slot="attachments"></div><div class="scene-actions">${button('attachment-add','添加演示卡片')}</div><p class="scene-status" data-slot="attachment-status" role="status">可模拟失败、取消和就绪交接。</p></section>
      <section data-scene="activity" class="scene-stage"><div class="scene-scroll" data-slot="timeline" tabindex="0" aria-label="可滚动演示时间线"><p>先看结论，再检查实现过程。</p><p class="scene-muted">展开内容时保持当前阅读位置；增量更新不会重新播放入场。</p>${button('thinking-toggle','<span>检查表面与输入反馈</span><span data-slot="thinking-arrow">⌄</span>','class="scene-fold" aria-expanded="false"')}<div data-slot="thinking-body" hidden><p class="scene-muted">先保留中文正文、雾蓝主操作与可辨识焦点，再比较外圆角和轻微抬升。用户决定何时展开。</p></div>${button('tools-toggle','<span>读取 2 个文件 · 运行 1 条命令</span><span data-slot="tools-arrow">⌄</span>','class="scene-fold" aria-expanded="false"')}<div data-slot="tools-body" hidden><p class="scene-mono">read docs/DESIGN.md · 完成</p><p class="scene-mono">read src/theme.css · 完成</p><p class="scene-mono">check layout · 运行状态见下方</p></div><div class="scene-running"><span class="scene-indicator" data-slot="running-icon" aria-hidden="true"><i></i><i></i><i></i></span><span data-slot="activity-status">运行中 · 检查布局</span></div><div data-slot="increments"></div></div><div class="scene-actions">${button('activity-run','运行')}${button('activity-complete','完成')}${button('activity-stop','中断')}${button('activity-unknown','未知')}${button('activity-increment','追加内容')}${button('activity-latest','最新')}</div><p class="scene-muted" data-slot="follow-status">手动展开后不自动跟随。</p></section>
      <section data-scene="confirm" class="scene-stage"><h3>重置演示内容</h3><div class="scene-card"><strong>界面评审的临时选择</strong><p>这里只重置本版的演示内容，不删除文件或浏览器数据。</p>${button('confirm-open','重置演示内容','class="scene-danger"')}</div><p class="scene-status" data-slot="confirm-status" role="status">尚未重置。</p></section>
      <section data-scene="images" class="scene-stage"><h3>布局预览.png</h3><p class="scene-muted">本地已加载 PNG · 只读图片</p>${button('image-open',`<img alt="本地布局预览缩略图"/>`,'class="scene-image-source" aria-label="打开布局预览图片"')}<div class="scene-actions">${button('image-source-toggle','隐藏／显示来源')}</div><p class="scene-status">可在预览中隐藏来源，比较淡化回退。</p></section>
      <section data-scene="readers" class="scene-stage"><h3>产物与工具输出</h3><div class="scene-card"><strong>review-notes.md</strong><p class="scene-muted">文件 · 本地固定文本</p>${button('file-open','打开文件阅读器')}</div><div class="scene-card"><strong>read · preview.ts</strong><p class="scene-mono">${escape(F.longPath)}</p><p class="scene-muted">工具 · 已完成</p>${button('tool-open','打开工具阅读器')}</div><p class="scene-muted">阅读器支持长文、代码、Diff 和原始输出。HTML 仅作为文本。</p></section>
      <section data-scene="transitions" class="scene-stage"><h3>会话切换</h3><div class="scene-actions">${['A','B','C'].map(x=>button('session-'+x,'会话 '+x,'aria-pressed="'+(x==='A')+'"')).join('')}</div><div class="scene-session" data-slot="session"><strong>会话 A · 界面评审</strong><p>当前内容保持安静，快速切换只显示最后目标。</p></div><div class="scene-skeleton" data-slot="skeleton" hidden aria-label="演示加载中"><i></i><i></i><i></i></div><div class="scene-actions">${button('loading-toggle','模拟加载')}${button('transition-replay','重播切换／加载')}${button('settings-open','设置覆盖层')}</div><p class="scene-status" data-slot="transition-status" role="status">会话 A</p></section>
      <section data-scene="copy" class="scene-stage scene-copy"><h3>复制与原位反馈</h3><div class="scene-actions">${button('copy-text-mode','中文','aria-pressed="false"')}${button('copy-code-mode','代码','aria-pressed="true"')}${button('copy-fail','模拟复制失败')}</div><div class="scene-code"><div class="scene-code-toolbar"><span data-slot="copy-language">JavaScript</span>${button('copy-code','<span data-slot="copy-icon" class="scene-icon-slot">复制</span>','aria-label="复制当前内容"')}</div><pre tabindex="0" data-slot="copy-text">${escape(F.code)}</pre></div><p class="scene-status" data-slot="copy-status" role="status" aria-live="polite">可直接选中文本；复制会调用真实剪贴板。</p><div class="scene-toast" data-slot="copy-toast" hidden>✓ 已复制</div></section>`;
  }
  function mount(host, initialConfig) {
    let config = {...initialConfig}, disposed = false, currentScene = config.scene;
    const motion = M.scope(() => config), modalMotion = M.scope(() => config), business = M.scope(() => config);
    const semantic = () => config.motion === 'semantic';
    let state, dialog = null, source = null, closing = false, dialogKind = '', closeTimer, menuTrigger;
    let fetchGeneration = 0, copyGeneration = 0, switchGeneration = 0;
    let readerMode = 'text', copyMode = 'code', imageScale = 1, attachmentTimer, copyTimer, resetRequested = false;
    let finishClose = null, sendGeneration = 0, loadingTimer, menuGeneration = 0;
    const foldGeneration = {thinking:0,tools:0};
    const q = slot => host.querySelector(`[data-slot="${slot}"]`);
    const action = name => host.querySelector(`[data-action="${name}"]`);
    function defaults() { return {model:F.models[0], thinking:'balanced', menu:'root', attachment:'idle', cards:1, activity:'run', increments:0, session:'A', loading:false}; }
    function applyTokens(el) {
      for (const key of ['theme','palette','variant','elevation','density','input','motion','reduced','rate']) el.dataset[key] = String(key==='reduced' ? config.reduced || matchMedia('(prefers-reduced-motion: reduce)').matches : config[key]);
      el.style.setProperty('--review-rate',config.rate);
    }
    function visibleSource(el) { if (!el?.isConnected || el.hidden || el.closest('[hidden]')) return false; const r=el.getBoundingClientRect(); return r.width>0 && r.height>0 && r.bottom>0 && r.top<innerHeight && r.right>0 && r.left<innerWidth; }
    function imageBounds(image) {
      if(!image?.complete || !image.naturalWidth || !visibleSource(image)) return null;
      const r=image.getBoundingClientRect(), scale=Math.min(r.width/image.naturalWidth,r.height/image.naturalHeight);
      const width=image.naturalWidth*scale, height=image.naturalHeight*scale;
      return {x:r.x+(r.width-width)/2,y:r.y+(r.height-height)/2,width,height};
    }
    function validImageSource() {
      const image=source?.querySelector('img'), r=imageBounds(image);if(!r)return null;
      if(r.x<0||r.y<0||r.x+r.width>innerWidth||r.y+r.height>innerHeight)return null;
      for(let p=image.parentElement;p;p=p.parentElement){const style=getComputedStyle(p),b=p.getBoundingClientRect();if(/auto|scroll|hidden|clip/.test(style.overflowX) && (r.x<b.left||r.x+r.width>b.right))return null;if(/auto|scroll|hidden|clip/.test(style.overflowY) && (r.y<b.top||r.y+r.height>b.bottom))return null;}
      return r;
    }
    function focusSource() {
      if(disposed)return;
      const active=document.activeElement;
      if(active && active!==document.body && active!==document.documentElement && !dialog?.contains(active) && visibleSource(active))return;
      const target = visibleSource(source) ? source : host.querySelector(`:scope > section[data-scene="${config.scene}"] button:not([hidden]):not(:disabled)`);
      if (visibleSource(target) && !host.closest('[inert]')) target.focus({preventScroll:true});
    }
    function closeDialog(immediate = false) {
      if (!dialog || (closing && !immediate)) return;
      const node=dialog, currentTransform=getComputedStyle(node).transform;
      const currentImageBounds=dialogKind==='image'?imageBounds(node.querySelector('img')):null;
      closing=true;modalMotion.clear();node.inert=true;
      const finish=()=>{
        if(dialog!==node)return;
        modalMotion.clear();finishClose=null;node.close();node.remove();dialog=null;
        M.release(closeDialog);closing=false;focusSource();
        if(resetRequested){resetRequested=false;reset();q('confirm-status').textContent='已重置本版演示内容；没有删除真实数据。';action('confirm-open')?.focus({preventScroll:true});}
      };
      finishClose=finish;
      if(immediate){finish();return;}
      let ms=140, animation;
      const panel=['file','tool','settings'].includes(dialogKind)||(dialogKind==='image'&&node.dataset.imageMode==='panel');
      if(dialogKind==='image'&&!panel){
        const image=node.querySelector('img'),base=imageBounds(image),from=currentImageBounds||base,to=validImageSource();
        if(semantic()&&imageScale===1&&base&&from&&to&&!motion.reduced()){
          node.dataset.sharedActive='true';ms=220;
          const transformTo=r=>`translate(${r.x-base.x}px,${r.y-base.y}px) scale(${r.width/base.width},${r.height/base.height})`;
          animation=modalMotion.animate(image,[{transform:transformTo(from),opacity:1},{transform:transformTo(to),opacity:1}],ms,image,'exit');
        }else animation=modalMotion.animate(node,[{opacity:1},{opacity:0}],ms,node,'exit');
      }else if(panel){
        const width=node.offsetWidth, transform=currentTransform==='none'?null:new DOMMatrixReadOnly(currentTransform);
        const offset=Math.max(0,Math.min(width,transform?.m41||0));
        ms=semantic()?Math.max(40,200*(1-offset/width)):200;
        animation=modalMotion.animate(node,[{transform:currentTransform},{transform:`translateX(${width}px)`}],ms,node,'panel');
      }else animation=modalMotion.animate(node,[{opacity:1,transform:currentTransform},{opacity:0,transform:`translateY(${semantic()?6:8}px)`}],ms,node,'exit');
      // finished 可拒绝；真实时钟兜底与视觉时长严格相同，不使用业务慢放。
      closeTimer=modalMotion.later(finish,modalMotion.duration(ms));
      animation?.finished.then(finish,()=>{});
    }
    function openDialog(kind, origin, body) {
      closeMenu(false); M.claim(closeDialog); if (dialog) closeDialog(true); M.claim(closeDialog);
      source=origin; dialogKind=kind; closing=false;
      dialog=document.createElement('dialog'); dialog.className='prototype-dialog scene-dialog-'+kind;
      dialog.setAttribute('aria-label', ({confirm:'重置演示内容',image:'布局预览图片',file:'文件阅读器',tool:'工具阅读器',settings:'设置覆盖层演示'})[kind]);
      dialog.innerHTML=body; applyTokens(dialog);
      if(kind==='image')dialog.dataset.imageMode=config.variant==='candidate'&&semantic()?'shared':'panel';
      dialog.dataset.pageHidden=String(document.hidden);document.body.append(dialog);
      dialog.addEventListener('cancel', event=>{event.preventDefault();closeDialog();});
      dialog.addEventListener('click', event=>{
        if (event.target===dialog) { const r=dialog.getBoundingClientRect(); if(event.clientX<r.left||event.clientX>r.right||event.clientY<r.top||event.clientY>r.bottom) closeDialog(); }
        const b=event.target.closest('[data-action]'); if(b && !closing) onDialogAction(b.dataset.action,b);
      });
      dialog.showModal();
      const panel=['file','tool','settings'].includes(kind) || (kind==='image' && dialog.dataset.imageMode==='panel');
      if(panel)modalMotion.animate(dialog,[{transform:'translateX(100%)'},{transform:'translateX(0)'}],200,dialog,'panel');
      else if(kind!=='image')modalMotion.animate(dialog,[{opacity:0,transform:`translateY(${semantic()?6:8}px)`},{opacity:1,transform:'translateY(0)'}],semantic()?200:180,dialog,'reveal');
      (dialog.querySelector('[autofocus]') || dialog.querySelector('button'))?.focus();
      return dialog;
    }
    const dialogHeader = title => `<header class="scene-dialog-header"><strong>${title}</strong>${button('dialog-close','关闭','aria-label="关闭并返回来源"')}</header>`;
    function openImage(origin) {
      imageScale=1;
      const node=openDialog('image',origin,dialogHeader('布局预览.png · 本地图片')+`<div class="scene-image-tools">${button('zoom-out','缩小')}${button('zoom-reset','100%')}${button('zoom-in','放大')}${button('image-hide-source','隐藏来源以测试回退')}</div><div class="scene-image-stage"><img class="scene-preview-image" alt="界面布局预览"/></div><p class="scene-dialog-note">本地只读 PNG；放大后关闭采用淡化回退。</p>`);
      node.querySelector('img').src=F.imageSrc;
      if(node.dataset.imageMode==='shared') {
        const image=node.querySelector('img'),from=validImageSource(),to=imageBounds(image);
        if(from&&to&&!motion.reduced()){
          node.dataset.sharedActive='true';
          modalMotion.animate(image,[{transform:`translate(${from.x-to.x}px,${from.y-to.y}px) scale(${from.width/to.width},${from.height/to.height})`},{transform:'none'}],260,image,'reveal');
          modalMotion.later(()=>{if(node.isConnected)node.dataset.sharedActive='false';},modalMotion.duration(260));
        }else modalMotion.animate(node,[{opacity:0},{opacity:1}],120,node,'reveal');
      }
    }
    function readerContent() {
      if(readerMode==='diff') return `<div class="scene-diff">${F.diff.map(row=>`<div class="scene-diff-${row.kind}">${escape(row.text)}</div>`).join('')}</div>`;
      const content=readerMode==='raw'?F.raw:readerMode==='code'?F.code:Array.from({length:18},(_,i)=>`第 ${i+1} 节 · 阅读与操作\n${F.text}`).join('\n\n')+'\n\n—— 长文结束 ——';
      return `<pre class="scene-reader-text" tabindex="0">${readerMode==='text'?escape(F.longPath)+'\n\n':''}${escape(content)}</pre>`;
    }
    function openReader(kind,origin) {
      readerMode='text';
      const node=openDialog(kind,origin,dialogHeader(kind==='file'?'review-notes.md':'read · src/preview.ts')+`<div class="scene-reader-tabs">${[['text','文本'],['code','代码'],['diff','结构化 Diff'],['raw','原始输出']].map(([key,label])=>button('reader-'+key,label,'aria-pressed="'+(key==='text')+'"')).join('')}</div><div class="scene-reader-body" tabindex="0">${readerContent()}</div><footer class="scene-reader-footer">${button('reader-end','滚到末尾')}${button('reader-drag-demo','演示回弹')}<span class="scene-muted">拖动头部可返回；按钮同样可用。</span></footer>`);
      const header=node.querySelector('header'); let start=null, offset=0;
      header.addEventListener('pointerdown',event=>{if(event.target.closest('button') || closing)return; modalMotion.clear();node.style.transform='';start=event.clientX;offset=0;header.setPointerCapture(event.pointerId);});
      header.addEventListener('pointermove',event=>{if(start===null||closing)return; offset=Math.max(0,event.clientX-start); if(!motion.reduced())node.style.transform=`translateX(${offset}px)`;});
      const end=()=>{if(start===null)return;start=null;if(closing)return;if(offset>100)closeDialog();else{modalMotion.animate(node,[{transform:`translateX(${offset}px)`},{transform:'none'}],180);node.style.transform='';}};
      header.addEventListener('pointerup',end); header.addEventListener('pointercancel',()=>{offset=0;end();});
    }
    function onDialogAction(name,b) {
      if(name==='dialog-close'||name==='confirm-cancel')closeDialog();
      else if(name==='confirm-accept'){resetRequested=true;closeDialog();}
      else if(name==='image-hide-source'){action('image-open').hidden=true;b.textContent='来源已隐藏 · 关闭将淡化回退';}
      else if(name.startsWith('zoom-')){modalMotion.clear();dialog.dataset.sharedActive='false';imageScale=name==='zoom-reset'?1:Math.max(.5,Math.min(3,imageScale+(name==='zoom-in'?.25:-.25)));dialog.querySelector('img').style.transform=`scale(${imageScale})`;dialog.querySelector('[data-action="zoom-reset"]').textContent=Math.round(imageScale*100)+'%';}
      else if(name.startsWith('reader-')) {
        const mode=name.slice(7), body=dialog.querySelector('.scene-reader-body');
        if(mode==='end'){body.scrollTop=body.scrollHeight;return;}
        if(mode==='drag-demo'){modalMotion.animate(dialog,[{transform:'translateX(0)'},{transform:'translateX(64px)'},{transform:'translateX(0)'}],400,dialog,'panel');return;}
        readerMode=mode; body.innerHTML=readerContent();body.scrollTop=0;
        dialog.querySelectorAll('.scene-reader-tabs button').forEach(x=>x.setAttribute('aria-pressed',String(x===b)));
      }
    }
    function closeMenu(restore=true,immediate=false) {
      const menu=q('menu');if(!menu||menu.hidden)return;
      const generation=++menuGeneration;menu.inert=true;action('menu-toggle').setAttribute('aria-expanded','false');
      if(restore)menuTrigger?.focus({preventScroll:true});
      if(immediate){menu.hidden=true;return;}
      motion.animate(menu,[{opacity:1},{opacity:0}],semantic()?110:120,menu,'exit');
      motion.later(()=>{if(generation===menuGeneration)menu.hidden=true;},motion.duration(semantic()?110:120));
    }
    function renderMenu(view='root') {
      menuGeneration++;state.menu=view; const menu=q('menu');menu.hidden=false;menu.inert=false;menu.setAttribute('role','group');menu.setAttribute('aria-label','模型与思考选项');
      menu.innerHTML=view==='root'?button('menu-models','切换模型 →')+button('menu-thinking','思考级别 →')+button('menu-close','关闭菜单'):button('menu-back','← 返回')+`<div class="scene-menu-scroll">${(view==='models'?F.models:['minimal','balanced','high','extended']).map((item,i)=>button(view==='models'?'model-'+i:'thinking-'+i,`<span>${escape(item)}</span><span>${(view==='models'?state.model:state.thinking)===item?'✓':''}</span>`,'aria-pressed="'+((view==='models'?state.model:state.thinking)===item)+'"')).join('')}</div>`;
      action('menu-toggle').setAttribute('aria-expanded','true');
      const scroll=menu.querySelector('.scene-menu-scroll');
      if(scroll){const edge=()=>{scroll.dataset.top=scroll.scrollTop>2;scroll.dataset.bottom=scroll.scrollHeight-scroll.clientHeight-scroll.scrollTop>2;};scroll.addEventListener('scroll',edge);requestAnimationFrame(()=>{if(!disposed)edge();});}
      const r=menu.getBoundingClientRect(), bounds=host.getBoundingClientRect();menu.style.maxWidth=Math.max(180,Math.min(340,bounds.width-32,innerWidth-32))+'px';menu.style.right=r.right>Math.min(bounds.right,innerWidth)?'0':'auto';
      if(scroll)scroll.style.maxHeight=Math.max(132,Math.min(228,innerHeight-r.top-72))+'px';
      menu.style.top='calc(100% + 8px)';menu.style.bottom='auto';
      if(menu.getBoundingClientRect().bottom>innerHeight-16 && menuTrigger.getBoundingClientRect().top>240){menu.style.top='auto';menu.style.bottom='calc(100% + 8px)';}
      menu.querySelector('button')?.focus();motion.animate(menu,semantic()?[{opacity:0,transform:'translateY(3px) scale(.98)'},{opacity:1,transform:'none'}]:[{opacity:0},{opacity:1}],semantic()?150:120,menu,'reveal');
    }
    function renderAttachments() {
      const text={idle:'尚未获取',fetching:'演示获取中',failed:'演示失败 · 可重试',cancelled:'已取消 · 可重新获取',ready:'完成 · 等待阅读器交接',opened:'已就绪 · 可查看'}[state.attachment];
      q('attachments').innerHTML=state.cards?`<div class="scene-card scene-attachment"><div><strong>review-notes.md</strong><p class="scene-muted">文本 · 4 KB · 本地固定样例</p></div>${button('attachment-remove','移除')}<div class="scene-progress-slot"><span data-slot="fetch-label">${text}</span><progress max="100" value="${state.attachment==='opened'||state.attachment==='ready'?100:0}" aria-label="演示获取进度"></progress></div><div class="scene-actions">${button('fetch-start',state.attachment==='failed'?'重试':'演示获取',['fetching','ready','opened'].includes(state.attachment)?'disabled':'')}${button('fetch-fail','模拟失败',state.attachment==='ready'||state.attachment==='opened'?'disabled':'')}${button('fetch-cancel','取消',state.attachment==='fetching'||state.attachment==='ready'?'':'disabled')}${button('attachment-view',state.attachment==='opened'?'查看就绪文件':'尚未就绪',state.attachment==='opened'?'':'disabled')}</div></div>`:'<p class="scene-muted">没有演示附件。</p>';
    }
    function fetchStart(origin) {
      if(state.attachment==='fetching'||state.attachment==='ready')return;
      fetchGeneration++;const generation=fetchGeneration;business.cancelTimer(attachmentTimer);state.attachment='fetching';renderAttachments();let progress=0;
      const tick=()=>{if(generation!==fetchGeneration||disposed)return;progress+=25;const bar=q('attachments').querySelector('progress');if(!bar)return;bar.value=progress;q('fetch-label').textContent=`演示获取 ${progress}%`;
        if(progress<100){attachmentTimer=business.later(tick,260);return;}
        state.attachment='ready';renderAttachments();q('fetch-label').textContent='完成 · 内容就绪';
        attachmentTimer=business.later(()=>{if(generation!==fetchGeneration)return;state.attachment='opened';renderAttachments();q('attachment-status').textContent=config.variant==='baseline'?'演示完成态停留 600ms 后交接。':'演示内容就绪后直接交接；不是网络实测。';openReader('file',action('attachment-view')||origin);},config.variant==='baseline'?600:0);
      }; attachmentTimer=business.later(tick,260);
    }
    function activity(status) {
      state.activity=status;const labels={run:'运行中 · 检查布局',complete:'已完成 · 检查布局',stop:'已中断 · 用户停止',unknown:'状态未知 · 无完成确认'};
      q('activity-status').textContent=labels[status];q('running-icon').hidden=status!=='run';q('activity-status').dataset.status=status;
    }
    function toggleFold(kind,b) {
      const body=q(kind+'-body'), expanded=b.getAttribute('aria-expanded')!=='true';
      const from=body.hidden?0:body.getBoundingClientRect().height;
      body.hidden=false;const target=expanded?body.scrollHeight:0;
      b.setAttribute('aria-expanded',String(expanded));q(kind+'-arrow').style.transform=expanded?'rotate(180deg)':'';
      const ms=semantic()?(expanded?180:140):(expanded?160:120),generation=++foldGeneration[kind];
      motion.animate(body,[{height:from+'px',opacity:expanded?.3:1,overflow:'hidden'},{height:target+'px',opacity:expanded?1:0,overflow:'hidden'}],ms,kind,'resize');
      motion.later(()=>{if(generation===foldGeneration[kind])body.hidden=!expanded;},motion.duration(ms));
      q('follow-status').textContent='已保留当前阅读位置；点击「最新」可跳到末尾。';
    }
    function switchSession(target) {
      const generation=++switchGeneration;state.session=target;
      host.querySelectorAll('[data-action^="session-"]').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.action==='session-'+target)));
      motion.animate(q('session'),[{opacity:.15},{opacity:1}],config.motion==='semantic'?150:240,'session');
      if(generation===switchGeneration){q('session').innerHTML=`<strong>会话 ${target} · ${target==='A'?'界面评审':target==='B'?'阅读器过渡':'输入反馈'}</strong><p>这是本地固定内容，草稿与其他选择保持不变。</p>`;q('transition-status').textContent='会话 '+target;}
    }
    function showLoading(loading) {
      state.loading=loading;q('skeleton').hidden=!loading;q('session').hidden=loading;
      q('transition-status').textContent=loading?'演示加载中 · 再点一次完成':'加载完成 · 固定内容';
      action('loading-toggle').textContent=loading?'完成演示加载':'模拟加载';
    }
    function replayTransition() {
      business.cancelTimer(loadingTimer);showLoading(true);
      loadingTimer=business.later(()=>{showLoading(false);switchSession(state.session==='A'?'B':'A');},1100);
    }
    function clearCopy() {copyGeneration++;business.cancelTimer(copyTimer);q('copy-icon').textContent='复制';q('copy-toast').hidden=true;}
    function copyFailure() {clearCopy();q('copy-status').textContent='复制未成功。请选中上方内容，使用系统复制。';}
    function changeCopyMode(mode) {
      clearCopy();copyMode=mode;q('copy-text').dataset.kind=mode;q('copy-text').textContent=mode==='text'?F.text:F.code;q('copy-language').textContent=mode==='text'?'中文文本':'JavaScript';
      action('copy-text-mode').setAttribute('aria-pressed',String(mode==='text'));action('copy-code-mode').setAttribute('aria-pressed',String(mode==='code'));
      q('copy-status').textContent='内容已切换；可选中手动复制。';
    }
    async function copyCode() {
      const generation=++copyGeneration,mode=copyMode;
      try {if(!navigator.clipboard?.writeText)throw new Error('unavailable');await navigator.clipboard.writeText(mode==='text'?F.text:F.code);if(disposed||generation!==copyGeneration)return;
        business.cancelTimer(copyTimer);q('copy-icon').innerHTML=icons.check;q('copy-status').textContent=mode==='text'?'已复制中文。':'已复制代码。';q('copy-toast').hidden=config.variant!=='baseline';motion.animate(q('copy-icon'),[{opacity:.2},{opacity:1}],120,q('copy-icon'),'feedback');
        copyTimer=business.later(()=>{q('copy-icon').textContent='复制';q('copy-toast').hidden=true;},2000);
      }catch{if(disposed||generation!==copyGeneration)return;copyFailure();}
    }
    function onClick(event) {
      const b=event.target.closest('[data-action]');if(!b||!host.contains(b)||disposed)return;
      const name=b.dataset.action;
      if(name==='send'){
        const generation=++sendGeneration;
        if(semantic())motion.animate(b.querySelector('.scene-press'),[{transform:'scale(.97)'},{transform:'scale(1)'}],120,b,'press');
        q('send-status').textContent='模拟：已受理（不发送）';
        business.later(()=>{if(generation===sendGeneration)q('send-status').textContent='模拟：正在执行';},350);
        business.later(()=>{if(generation===sendGeneration)q('send-status').textContent='模拟：已完成；输入已保留。';},1300);
      }
      else if(name==='menu-toggle'){menuTrigger=b;if(q('menu').hidden)renderMenu();else closeMenu();}
      else if(name==='menu-models'||name==='menu-thinking')renderMenu(name==='menu-models'?'models':'thinking');
      else if(name==='menu-back')renderMenu();else if(name==='menu-close')closeMenu();
      else if(name.startsWith('model-')||name.startsWith('thinking-')){if(name.startsWith('model-'))state.model=F.models[Number(name.slice(6))];else state.thinking=['minimal','balanced','high','extended'][Number(name.slice(9))];q('model-status').textContent=state.model+' · '+state.thinking;closeMenu();}
      else if(name==='nav-select'){host.querySelectorAll('[data-action="nav-select"]').forEach(x=>x.setAttribute('aria-pressed',String(x===b)));}
      else if(name==='attachment-add'){
        if(state.cards)return;
        state.cards=1;renderAttachments();
        if(semantic())motion.animate(q('attachments'),[{opacity:0,transform:'translateY(4px)'},{opacity:1,transform:'none'}],160);
      }
      else if(name==='attachment-remove'){fetchGeneration++;business.cancelTimer(attachmentTimer);state.cards=0;state.attachment='idle';renderAttachments();action('attachment-add').focus();}
      else if(name==='fetch-start')fetchStart(b);
      else if(name==='fetch-fail'||name==='fetch-cancel'){fetchGeneration++;business.cancelTimer(attachmentTimer);state.attachment=name==='fetch-fail'?'failed':'cancelled';renderAttachments();action('fetch-start')?.focus();}
      else if(name==='attachment-view'&&state.attachment==='opened')openReader('file',b);
      else if(name==='thinking-toggle'||name==='tools-toggle')toggleFold(name.split('-')[0],b);
      else if(name==='activity-increment'){const scroll=q('timeline'), top=scroll.scrollTop;state.increments++;const p=document.createElement('p');p.textContent=`增量 ${state.increments} · 继续核对输入与阅读稳定性。`;q('increments').append(p);scroll.scrollTop=top;q('follow-status').textContent=`新增 ${state.increments} 条；未抢回底部。`;}
      else if(name==='activity-latest'){q('timeline').scrollTop=q('timeline').scrollHeight;q('follow-status').textContent='已回到最新内容。';}
      else if(name.startsWith('activity-'))activity(name.slice(9));
      else if(name==='confirm-open')openDialog('confirm',b,dialogHeader('重置演示内容？')+'<div class="scene-dialog-content"><p>仅重置本版演示内容。不会删除文件、消息或浏览器数据。</p><div class="scene-actions">'+button('confirm-cancel','取消','autofocus')+button('confirm-accept','确认重置','class="scene-danger"')+'</div></div>');
      else if(name==='image-open')openImage(b);
      else if(name==='image-source-toggle')action('image-open').hidden=!action('image-open').hidden;
      else if(name==='file-open'||name==='tool-open')openReader(name==='file-open'?'file':'tool',b);
      else if(name.startsWith('session-'))switchSession(name.slice(8));
      else if(name==='loading-toggle'){business.cancelTimer(loadingTimer);showLoading(!state.loading);}
      else if(name==='transition-replay')replayTransition();
      else if(name==='settings-open')openDialog('settings',b,dialogHeader('设置 · 局部转场演示')+'<div class="scene-dialog-content"><h3>外观</h3><p>主题由上方评审控制切换。</p><h3>阅读与输入</h3><p>工作区保持原位，只有覆盖层移动。</p><p class="scene-muted">本例不创建真实设置页面，不写入偏好。</p>'+button('dialog-close','返回演示工作区')+'</div>');
      else if(name==='copy-code')copyCode();
      else if(name==='copy-text-mode'||name==='copy-code-mode')changeCopyMode(name==='copy-text-mode'?'text':'code');
      else if(name==='copy-fail')copyFailure();
    }
    function outside(event){if(!q('menu').hidden&&!host.querySelector('.scene-menu-anchor').contains(event.target))closeMenu(false);}
    function keydown(event){if(q('menu').hidden)return;if(event.key==='Escape'){event.preventDefault();event.stopPropagation();closeMenu();}else if(['ArrowDown','ArrowUp'].includes(event.key)&&q('menu').contains(event.target)){event.preventDefault();const buttons=[...q('menu').querySelectorAll('button')],i=buttons.indexOf(document.activeElement);buttons[(i+(event.key==='ArrowDown'?1:-1)+buttons.length)%buttons.length].focus();}}
    function settleVisuals() {
      motion.clear();
      if(q('menu').inert)q('menu').hidden=true;
      ['thinking','tools'].forEach(kind=>{foldGeneration[kind]++;q(kind+'-body').hidden=action(kind+'-toggle').getAttribute('aria-expanded')==='false';});
      if(dialog){
        if(closing)finishClose?.();
        else {modalMotion.clear();dialog.dataset.sharedActive='false';dialog.style.transform='';applyTokens(dialog);}
      }
    }
    function cancelSceneWork() {
      business.clear();fetchGeneration++;copyGeneration++;switchGeneration++;sendGeneration++;
      if(state.attachment==='fetching'||state.attachment==='ready'){state.attachment='cancelled';renderAttachments();}
      if(/已受理|正在执行/.test(q('send-status').textContent))q('send-status').textContent='模拟已取消；输入已保留。';
      if(state.loading)showLoading(false);
      q('copy-icon').textContent='复制';q('copy-toast').hidden=true;
    }
    function update(next) {
      if(Object.keys(next).every(key=>next[key]===config[key]))return;
      const changed=next.scene!==currentScene;
      const visualChanged=['reduced','rate','motion'].some(key=>next[key]!==config[key]);
      if(changed){closeMenu(false,true);closeDialog(true);cancelSceneWork();}
      config={...next};
      if(changed||visualChanged)settleVisuals();
      currentScene=next.scene;applyTokens(host);
      host.querySelectorAll('[data-scene]').forEach(section=>section.hidden=section.dataset.scene!==config.scene);
      if(dialog)applyTokens(dialog);
    }
    function reset() {
      resetRequested=false;closeDialog(true);motion.clear();modalMotion.clear();business.clear();
      fetchGeneration++;copyGeneration++;switchGeneration++;sendGeneration++;menuGeneration++;
      state=defaults();copyMode='code';host.innerHTML=markup();action('image-open').querySelector('img').src=F.imageSrc;renderAttachments();applyTokens(host);
      host.querySelectorAll('[data-scene]').forEach(section=>section.hidden=section.dataset.scene!==config.scene);
    }
    function replay(){
      settleVisuals();if(dialog)closeDialog(true);
      if(config.scene==='menus'){menuTrigger=action('menu-toggle');closeMenu(false,true);renderMenu('models');return;}
      if(config.scene==='activity'){activity('run');action('tools-toggle').click();return;}
      if(config.scene==='transitions'){replayTransition();return;}
      if(config.scene==='attachments'){fetchGeneration++;business.cancelTimer(attachmentTimer);state.cards=1;state.attachment='idle';renderAttachments();}
      if(config.scene==='images')action('image-open').hidden=false;
      const names={composer:'send',attachments:'fetch-start',confirm:'confirm-open',images:'image-open',readers:'file-open',copy:'copy-code'};
      action(names[config.scene])?.click();
    }
    let inView=true;
    function visibility(){host.dataset.pageHidden=String(document.hidden||!inView);if(dialog)dialog.dataset.pageHidden=String(document.hidden);}
    const observer = new IntersectionObserver(entries=>{inView=entries[0].isIntersecting;visibility();});observer.observe(host);
    const preference=matchMedia('(prefers-reduced-motion: reduce)');const preferenceChange=()=>{settleVisuals();host.dataset.reduced=String(config.reduced||preference.matches);if(dialog)dialog.dataset.reduced=host.dataset.reduced;};
    host.addEventListener('click',onClick);host.addEventListener('keydown',keydown);document.addEventListener('pointerdown',outside);document.addEventListener('visibilitychange',visibility);preference.addEventListener('change',preferenceChange);
    reset();visibility();preferenceChange();
    return {update,replay,reset,dispose(){disposed=true;observer.disconnect();motion.clear();business.clear();closeDialog(true);modalMotion.clear();copyGeneration++;host.removeEventListener('click',onClick);host.removeEventListener('keydown',keydown);document.removeEventListener('pointerdown',outside);document.removeEventListener('visibilitychange',visibility);preference.removeEventListener('change',preferenceChange);}};
  }
  return {mount};
})();
