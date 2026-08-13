/* ===== Mavis v1 - 主逻辑 ===== */
(function () {
  'use strict';

  // ===== 存储 =====
  const DB = {
    get(key, def) {
      try { const v = localStorage.getItem('mavis_' + key); return v ? JSON.parse(v) : def; }
      catch { return def; }
    },
    set(key, val) { try { localStorage.setItem('mavis_' + key, JSON.stringify(val)); return true; } catch (e) { console.warn('存储失败', e); return false; } }
  };

  // ===== 默认角色（不再带 [角色名] 前缀）=====
  const DEFAULT_ROLES = [
    {
      id: 'r1', avatar: '🌸', avatarImg: '', name: '苏糖', desc: '傲娇双马尾少女，插件开发能手',
      prompt: '你是苏糖，一个粉发双马尾的傲娇少女。你精通编程和插件开发，对源码、模板、Hook、权限系统门儿清。说话语气傲娇，常带"哼"、"人家"，自称"本小姐"，表面不情愿实际很积极，能力很强。你在群聊中与其他AI角色（晚晴、绫音）和老板（用户）对话，可以回应其他角色的话。不要在回复开头加[苏糖]这种前缀，直接说话即可。'
    },
    {
      id: 'r2', avatar: '🤓', avatarImg: '', name: '晚晴', desc: '知性助理，沉稳贴心，称用户为老板',
      prompt: '你是晚晴，一个戴眼镜的知性女性，担任团队助理。说话沉稳专业，喜欢确认细节、安排排期、整理清单，称呼用户为"老板"。你负责协调团队（苏糖、绫音），把老板的需求落地。你在群聊中与其他AI角色和老板对话，可以回应其他角色的话。不要在回复开头加[晚晴]这种前缀，直接说话即可。'
    },
    {
      id: 'r3', avatar: '🖤', avatarImg: '', name: '绫音', desc: '冷淡黑客少女，言简意赅',
      prompt: '你是绫音，一个黑发的冷淡女孩，黑客高手。说话简短直接，不爱废话，偶尔毒舌，但技术过硬。你在群聊中与其他AI角色和老板（用户）对话，可以简短回应或召唤其他角色。不要在回复开头加[绫音]这种前缀，直接说话即可。'
    },
  ];

  // ===== 状态 =====
  let state = {
    profile: DB.get('profile', { avatar: '🦊', avatarImg: '', name: 'Mavis 用户', id: 'M' + Date.now().toString(36).toUpperCase() }),
    roles: DB.get('roles', null),
    activeRoleIds: DB.get('activeRoleIds', null),
    sessions: DB.get('sessions', null),       // 聊天会话列表
    currentSessionId: DB.get('currentSessionId', null),
    moments: DB.get('moments', []),
    tasks: DB.get('tasks', []),
    promptLib: DB.get('promptLib', null),     // 提示词库
    memories: DB.get('memories', []),          // 记忆库（全局跨会话）
    outputs: DB.get('outputs', []),           // 办公室产出物（AI 发送的文件/图片）
    settings: DB.get('settings', { endpoint: '', apikey: '', model: 'gpt-4o-mini', stream: true, memory: 12, temp: 0.7, dark: false, appname: 'Mavis', promptLibOn: false, reasoning: false, reasoningLevel: 3, reasoningShow: false, webSearch: false, fontSize: 15, usage: [], apiConfigs: null, currentApiConfigId: null }),
  };
  if (!state.roles) { state.roles = DEFAULT_ROLES; DB.set('roles', state.roles); }
  if (!state.activeRoleIds) { state.activeRoleIds = state.roles.map(r => r.id); DB.set('activeRoleIds', state.activeRoleIds); }
  if (!state.sessions) {
    const sid = 's' + Date.now();
    state.sessions = [{ id: sid, title: '新对话', messages: [], ts: Date.now() }];
    state.currentSessionId = sid;
    DB.set('sessions', state.sessions); DB.set('currentSessionId', sid);
  }
  if (!state.promptLib) {
    state.promptLib = { regex: [], worldbook: [], preset: [] };
    DB.set('promptLib', state.promptLib);
  }
  // 兼容旧数据：补 groups 字段（导入分组容器）
  if (!state.promptLib.groups) {
    state.promptLib.groups = { regex: [], worldbook: [], preset: [] };
    DB.set('promptLib', state.promptLib);
  }
  // 兼容旧数据：把顶层 API 配置迁移成 apiConfigs 列表
  if (!state.settings.apiConfigs || !Array.isArray(state.settings.apiConfigs) || state.settings.apiConfigs.length === 0) {
    const def = {
      id: 'cfg_default',
      name: '默认配置',
      endpoint: state.settings.endpoint || '',
      apikey: state.settings.apikey || '',
      model: state.settings.model || 'gpt-4o-mini',
      stream: state.settings.stream !== false,
      reasoning: !!state.settings.reasoning,
      reasoningLevel: state.settings.reasoningLevel || 3,
      reasoningShow: !!state.settings.reasoningShow,
      webSearch: !!state.settings.webSearch
    };
    state.settings.apiConfigs = [def];
    state.settings.currentApiConfigId = def.id;
    DB.set('settings', state.settings);
  }
  // 同步：当前选中配置的 API 字段回填到顶层 settings（保持现有 callAPI 兼容）
  function syncCurrentApiConfigToSettings() {
    const cfg = (state.settings.apiConfigs || []).find(c => c.id === state.settings.currentApiConfigId) || state.settings.apiConfigs[0];
    if (cfg) {
      state.settings.currentApiConfigId = cfg.id;
      state.settings.endpoint = cfg.endpoint;
      state.settings.apikey = cfg.apikey;
      state.settings.model = cfg.model;
      state.settings.stream = cfg.stream;
      state.settings.reasoning = cfg.reasoning;
      state.settings.reasoningLevel = cfg.reasoningLevel;
      state.settings.reasoningShow = cfg.reasoningShow;
      state.settings.webSearch = cfg.webSearch;
    }
  }
  syncCurrentApiConfigToSettings();

  let pendingAttach = null;
  let isGenerating = false;
  let abortCtrl = null;
  // 流式渲染优化：用 rAF 节流
  let _pendingRender = false;
  let _lastMsgEl = null; // 缓存最后一条消息的 DOM 节点
  let _userScrolledUp = false; // 用户是否手动向上滚动
  let _lastStreamText = ''; // 上一次流式文本（用于增量更新检测）
  let _streamingDone = false; // 标记流式输出是否完成

  // ===== DOM =====
  const $ = id => document.getElementById(id);
  const el = (tag, cls, html) => { const e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; };

  // ===== 工具 =====
  function toast(msg) {
    const t = $('toast'); t.textContent = msg; t.classList.add('show');
    clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.remove('show'), 2000);
  }
  function saveAll() {
    let ok = true;
    ok = DB.set('profile', state.profile) && ok;
    ok = DB.set('roles', state.roles) && ok;
    ok = DB.set('activeRoleIds', state.activeRoleIds) && ok;
    ok = DB.set('sessions', state.sessions) && ok;
    ok = DB.set('currentSessionId', state.currentSessionId) && ok;
    ok = DB.set('moments', state.moments) && ok;
    ok = DB.set('tasks', state.tasks) && ok;
    ok = DB.set('promptLib', state.promptLib) && ok;
    ok = DB.set('memories', state.memories) && ok;
    ok = DB.set('outputs', state.outputs) && ok;
    ok = DB.set('settings', state.settings) && ok;
    return ok;
  }
  function curSession() { return state.sessions.find(s => s.id === state.currentSessionId) || state.sessions[0]; }
  function curMessages() { return curSession().messages; }
  function fmtTime(ts) {
    const d = new Date(ts), now = new Date();
    const hh = String(d.getHours()).padStart(2, '0'), mm = String(d.getMinutes()).padStart(2, '0');
    if (d.toDateString() === now.toDateString()) return hh + ':' + mm;
    const yest = new Date(now); yest.setDate(yest.getDate() - 1);
    if (d.toDateString() === yest.toDateString()) return '昨天 ' + hh + ':' + mm;
    return (d.getMonth() + 1) + '/' + d.getDate() + ' ' + hh + ':' + mm;
  }
  function escapeHtml(s) { return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
  // 图片压缩：缩放到指定最大边并转为压缩格式，避免 localStorage 超限导致头像/封面丢失
  function compressImage(dataUrl, maxDim, mime, quality) {
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => {
        let w = img.naturalWidth || img.width, h = img.naturalHeight || img.height;
        if (w > maxDim || h > maxDim) { const s = maxDim / Math.max(w, h); w = Math.round(w * s); h = Math.round(h * s); }
        const canvas = document.createElement('canvas');
        canvas.width = w; canvas.height = h;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, w, h);
        try { resolve(canvas.toDataURL(mime, quality)); }
        catch (e) { resolve(dataUrl); }
      };
      img.onerror = () => resolve(dataUrl);
      img.src = dataUrl;
    });
  }
  // 完整的 Markdown 渲染器：支持标题、列表、粗体、斜体、代码块、链接、表格、引用、分隔线
  function renderMd(text) {
    if (!text) return '';
    // 1. 先提取代码块（避免内部内容被 markdown 处理）
    const codeBlocks = [];
    let s = text.replace(/```(\w*)\n?([\s\S]*?)```/g, (m, lang, code) => {
      const idx = codeBlocks.length;
      codeBlocks.push('<pre class="md-code"><code>' + escapeHtml(code.replace(/\n$/, '')) + '</code></pre>');
      return '\x00CODE' + idx + '\x00';
    });
    // 2. 转义 HTML（代码块已单独处理，不会被转义）
    s = escapeHtml(s);
    // 3. 行内代码
    s = s.replace(/`([^`]+)`/g, '<code class="md-inline-code">$1</code>');
    // 4. 还原代码块占位符
    s = s.replace(/\x00CODE(\d+)\x00/g, (m, i) => codeBlocks[parseInt(i)] || '');
    // 5. 表格（简易：| a | b | 换行 | --- | --- | 换行 | c | d |）
    s = s.replace(/((?:^\|.*\|\n)+)/gm, (block) => {
      const rows = block.trim().split('\n').map(r => r.replace(/^\||\|$/g, '').split('|').map(c => c.trim()));
      if (rows.length < 2) return block;
      // 第二行是分隔行
      if (!rows[1].every(c => /^:?-+:?$/.test(c))) return block;
      let html = '<table class="md-table"><thead><tr>';
      rows[0].forEach(h => html += '<th>' + h + '</th>');
      html += '</tr></thead><tbody>';
      for (let i = 2; i < rows.length; i++) {
        html += '<tr>';
        rows[i].forEach(c => html += '<td>' + c + '</td>');
        html += '</tr>';
      }
      html += '</tbody></table>';
      return html;
    });
    // 6. 按行处理：标题、列表、引用、分隔线
    const lines = s.split('\n');
    const out = [];
    let inList = false, listType = '';
    for (let i = 0; i < lines.length; i++) {
      let line = lines[i];
      // 标题
      const h = line.match(/^(#{1,6})\s+(.*)/);
      if (h) { if (inList) { out.push('</' + listType + '>'); inList = false; } out.push('<h' + h[1].length + ' class="md-h">' + h[2] + '</h' + h[1].length + '>'); continue; }
      // 分隔线
      if (/^(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) { if (inList) { out.push('</' + listType + '>'); inList = false; } out.push('<hr class="md-hr">'); continue; }
      // 引用
      const bq = line.match(/^&gt;\s?(.*)/);
      if (bq) { if (inList) { out.push('</' + listType + '>'); inList = false; } out.push('<blockquote class="md-quote">' + bq[1] + '</blockquote>'); continue; }
      // 无序列表
      const ul = line.match(/^(\s*)[-*+]\s+(.*)/);
      if (ul) { if (!inList || listType !== 'ul') { if (inList) out.push('</' + listType + '>'); out.push('<ul class="md-ul">'); inList = true; listType = 'ul'; } out.push('<li>' + ul[2] + '</li>'); continue; }
      // 有序列表
      const ol = line.match(/^(\s*)\d+\.\s+(.*)/);
      if (ol) { if (!inList || listType !== 'ol') { if (inList) out.push('</' + listType + '>'); out.push('<ol class="md-ol">'); inList = true; listType = 'ol'; } out.push('<li>' + ol[2] + '</li>'); continue; }
      // 空行
      if (line.trim() === '') { if (inList) { out.push('</' + listType + '>'); inList = false; } out.push(''); continue; }
      // 普通段落
      if (inList) { out.push('</' + listType + '>'); inList = false; }
      out.push('<p class="md-p">' + line + '</p>');
    }
    if (inList) out.push('</' + listType + '>');
    s = out.join('\n');
    // 7. 行内格式：粗体、斜体、链接、删除线
    s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    s = s.replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, '<em>$1</em>');
    s = s.replace(/~~([^~]+)~~/g, '<del>$1</del>');
    s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank">$1</a>');
    // 8. 段落间换行
    s = s.replace(/\n/g, '');
    return s;
  }
  function getRole(id) { return state.roles.find(r => r.id === id); }
  function activeRoles() { return state.activeRoleIds.map(getRole).filter(Boolean); }
  function roleAvatar(r) { return r?.avatarImg || r?.avatar || '🤖'; }
  // 去掉 [角色名] 前缀
  function stripRolePrefix(text, roleName) {
    if (!text) return text;
    return text.replace(new RegExp('^\\s*\\[' + escapeHtml(roleName || '') + '\\]\\s*', 'i'), '').replace(/^\s*\[[^\]]+\]\s*/, '');
  }

  // ===== 主题 & 应用名 =====
  function applyTheme() {
    document.documentElement.setAttribute('data-theme', state.settings.dark ? 'dark' : 'light');
    const d = $('set-dark'); if (d) d.checked = state.settings.dark;
  }
  function applyAppName() {
    const name = state.settings.appname || 'Mavis';
    document.title = name;
    const ct = $('chat-title'); if (ct) ct.textContent = name;
    const an = $('about-name'); if (an) an.textContent = name;
    const sv = $('set-appname-val'); if (sv) sv.textContent = name;
  }
  // 字体大小：写入 CSS 变量 --font-base
  function applyFontSize() {
    const size = parseInt(state.settings.fontSize) || 15;
    document.documentElement.style.setProperty('--font-base', size + 'px');
    const val = $('font-size-val');
    if (val) {
      const label = size <= 13 ? '小' : size <= 15 ? '标准' : size <= 18 ? '大' : '特大';
      val.textContent = label;
    }
    const range = $('font-range'); if (range) range.value = size;
    const preview = $('font-preview'); if (preview) preview.style.fontSize = size + 'px';
  }
  // ===== 聊天背景 =====
  function applyChatBg() {
    const view = $('view-chat');
    const bg = state.settings.chatBg || '';
    const val = $('chat-bg-val');
    if (view) {
      if (bg) {
        view.style.backgroundImage = 'url(' + bg + ')';
        view.style.backgroundSize = 'cover';
        view.style.backgroundPosition = 'center';
        view.style.backgroundAttachment = 'fixed';
      } else {
        view.style.backgroundImage = '';
        view.style.backgroundSize = '';
        view.style.backgroundPosition = '';
        view.style.backgroundAttachment = '';
      }
    }
    if (val) val.textContent = bg ? '自定义' : '默认';
  }
  function openChatBgSheet() {
    const preview = $('chatbg-preview');
    const bg = state.settings.chatBg || '';
    if (preview) {
      if (bg) { preview.style.backgroundImage = 'url(' + bg + ')'; preview.classList.add('has-bg'); }
      else { preview.style.backgroundImage = ''; preview.classList.remove('has-bg'); }
    }
    openSheet('chatbg-sheet-overlay');
  }
  function pickChatBg() {
    const input = document.createElement('input');
    input.type = 'file'; input.accept = 'image/*';
    input.onchange = e => {
      const file = e.target.files[0]; if (!file) return;
      if (file.size > 5 * 1024 * 1024) { toast('图片不能超过 5MB'); return; }
      const reader = new FileReader();
      reader.onload = async () => {
        // 压缩背景图：最大边 1280px，JPEG 0.82，避免 localStorage 超限
        state.settings.chatBg = await compressImage(String(reader.result || ''), 1280, 'image/jpeg', 0.82);
        const ok = saveAll(); applyChatBg(); openChatBgSheet();
        toast(ok ? '背景已设置' : '存储空间不足，背景可能无法保存');
      };
      reader.onerror = () => toast('读取图片失败');
      reader.readAsDataURL(file);
    };
    input.click();
  }
  function clearChatBg() {
    state.settings.chatBg = '';
    saveAll(); applyChatBg(); openChatBgSheet();
    toast('已恢复默认背景');
  }
  function openFontSheet() {
    const size = parseInt(state.settings.fontSize) || 15;
    const range = $('font-range'); if (range) range.value = size;
    const preview = $('font-preview'); if (preview) { preview.style.fontSize = size + 'px'; }
    openSheet('font-sheet-overlay');
  }

  // ===== Tab 切换 =====
  // 用 requestAnimationFrame 延迟重渲染，让动画先启动，避免同步重绘造成卡顿
  function switchView(name) {
    document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
    const v = $('view-' + name); if (v) v.classList.add('active');
    document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.dataset.view === name));
    // 下一帧再执行重渲染，动画更顺滑
    requestAnimationFrame(() => {
      if (name === 'moments') renderMoments();
      if (name === 'tasks') renderTasks();
      if (name === 'me') renderMe();
      if (name === 'chat') { renderRoleBar(); renderMessages(); scrollMsgBottom(); }
      if (name === 'prompts') renderPromptLib();
    });
  }

  // ===== 聊天会话 =====
  function newSession() {
    const sid = 's' + Date.now();
    state.sessions.unshift({ id: sid, title: '新对话', messages: [], ts: Date.now() });
    if (state.sessions.length > 30) state.sessions = state.sessions.slice(0, 30);
    state.currentSessionId = sid;
    saveAll();
    renderMessages(); renderRoleBar(); updateSessionTitle();
  }
  function switchSession(sid) {
    state.currentSessionId = sid;
    saveAll();
    renderMessages(); renderRoleBar(); updateSessionTitle();
    closeAllSheets();
  }
  function deleteSession(sid) {
    if (state.sessions.length <= 1) { toast('至少保留一个会话'); return; }
    state.sessions = state.sessions.filter(s => s.id !== sid);
    if (state.currentSessionId === sid) state.currentSessionId = state.sessions[0].id;
    saveAll(); renderMessages(); renderRoleBar(); updateSessionTitle();
    openSessionsList();
  }
  function updateSessionTitle() {
    const s = curSession();
    const firstUser = s.messages.find(m => m.role === 'user' && (m.text || m.file || m.image));
    if (firstUser) {
      let title = firstUser.text || (firstUser.file ? '📎 ' + firstUser.file.name : (firstUser.image ? '🖼️ 图片' : '新对话'));
      s.title = title.slice(0, 24); s.ts = Date.now();
      saveAll();
    }
  }
  function openSessionsList() {
    const body = $('sessions-list-body');
    body.innerHTML = '';
    if (state.sessions.length === 0) { body.innerHTML = '<div class="empty-tip">暂无会话</div>'; }
    state.sessions.forEach(s => {
      const item = el('div', 'session-item' + (s.id === state.currentSessionId ? ' active' : ''));
      const roles = activeRoles();
      const avatar = roles.length === 1 ? roleAvatar(roles[0]) : (roles.length > 1 ? '👥' : '💬');
      item.innerHTML = `
        <div class="sess-avatar">${escapeHtml(avatar)}</div>
        <div class="sess-info">
          <div class="sess-title">${escapeHtml(s.title || '新对话')}</div>
          <div class="sess-time">${fmtTime(s.ts)} · ${s.messages.length} 条</div>
        </div>
        <button class="sess-del" data-id="${s.id}">×</button>`;
      item.addEventListener('click', e => { if (!e.target.classList.contains('sess-del')) switchSession(s.id); });
      body.appendChild(item);
    });
    body.querySelectorAll('.sess-del').forEach(b => b.addEventListener('click', e => {
      e.stopPropagation(); deleteSession(b.dataset.id);
    }));
    openSheet('sessions-sheet-overlay');
  }

  // ===== 朋友圈（微信风格）=====
  function renderMoments() {
    const list = $('moments-list');
    list.innerHTML = '';
    const cover = document.querySelector('.moments-avatar');
    if (cover) {
      const validImg = state.profile.avatarImg && (state.profile.avatarImg.startsWith('data:') || state.profile.avatarImg.startsWith('http'));
      if (validImg) { cover.innerHTML = `<img src="${escapeHtml(state.profile.avatarImg)}" class="avatar-img" alt="">`; }
      else { cover.textContent = state.profile.avatar || '🦊'; }
    }
    const nick = $('me-nickname'); if (nick) nick.textContent = state.profile.name;
    // 朋友圈封面背景
    const coverBg = document.querySelector('.moments-cover-bg');
    if (coverBg) {
      const coverImg = state.profile.momentsCover || '';
      if (coverImg) { coverBg.style.backgroundImage = 'url(' + coverImg + ')'; coverBg.classList.add('has-img'); }
      else { coverBg.style.backgroundImage = ''; coverBg.classList.remove('has-img'); }
    }
    if (state.moments.length === 0) {
      list.innerHTML = '<div class="moments-empty"><div class="e-icon">🌅</div>还没有动态<br>点击右上角发布，或让 AI 自动发</div>';
      return;
    }
    state.moments.slice().reverse().forEach(m => {
      const card = el('div', 'moment-card');
      card.dataset.mid = m.id;
      const isAI = m.isAI;
      // 头像兜底链：角色当前头像 → 动态保存的头像图 → 动态保存的 emoji → 默认
      let avatar;
      if (isAI) {
        const role = getRole(m.roleId);
        if (role && role.avatarImg) avatar = `<img src="${escapeHtml(role.avatarImg)}" class="avatar-img" loading="lazy" decoding="async">`;
        else if (m.avatarImg) avatar = `<img src="${escapeHtml(m.avatarImg)}" class="avatar-img" loading="lazy" decoding="async">`;
        else avatar = escapeHtml((role && role.avatar) || m.avatar || '🤖');
      } else {
        avatar = m.avatarImg ? `<img src="${escapeHtml(m.avatarImg)}" class="avatar-img" loading="lazy" decoding="async">` : escapeHtml(m.avatar || state.profile.avatar);
      }
      const imgs = (m.images || []).map(url => `<img class="moment-img" src="${escapeHtml(url)}" data-full="${escapeHtml(url)}" loading="lazy" decoding="async">`).join('');
      card.innerHTML = `
        <div class="moment-avatar">${avatar}</div>
        <div class="moment-body">
          <div class="moment-name ${isAI ? 'ai-name' : ''}">${escapeHtml(m.name || state.profile.name)}</div>
          ${m.text ? `<div class="moment-text">${renderMd(m.text)}</div>` : ''}
          ${imgs ? `<div class="moment-images">${imgs}</div>` : ''}
          <div class="moment-meta">
            <div class="moment-time">${fmtTime(m.ts)}</div>
            <button class="moment-act ${m.liked ? 'liked' : ''}" data-act="like" data-id="${m.id}">♡ ${m.likes || 0}</button>
          </div>
          ${(m.comments && m.comments.length) ? `<div class="moment-comments">${m.comments.map(c => `<div class="mc-row"><span class="mc-name">${escapeHtml(c.name)}</span>${c.text ? `: ${escapeHtml(c.text)}` : ''}</div>`).join('')}</div>` : ''}
          <div class="moment-actions">
            <button class="moment-act" data-act="comment" data-id="${m.id}">💬 评论</button>
            <button class="moment-act" data-act="ai-interact" data-id="${m.id}">🤖 AI 互动</button>
            <button class="moment-act moment-del" data-act="del" data-id="${m.id}">删除</button>
          </div>
        </div>`;
      list.appendChild(card);
    });
    // 绑定
    list.querySelectorAll('.moment-act').forEach(b => b.addEventListener('click', e => {
      const id = b.dataset.id, act = b.dataset.act;
      const m = state.moments.find(x => x.id === id);
      if (!m) return;
      if (act === 'like') { m.liked = !m.liked; m.likes = (m.likes || 0) + (m.liked ? 1 : -1); if (m.likes < 0) m.likes = 0; saveAll(); updateMomentCard(id); return; }
      else if (act === 'del') { if (confirm('删除这条动态？')) state.moments = state.moments.filter(x => x.id !== id); }
      else if (act === 'comment') { const c = prompt('输入评论：'); if (c) m.comments = m.comments || [], m.comments.push({ name: state.profile.name, text: c }); }
      else if (act === 'ai-interact') { aiInteractMoment(id); return; }
      saveAll(); renderMoments();
    }));
    list.querySelectorAll('.moment-img').forEach(img => img.addEventListener('click', () => previewImage(img.dataset.full)));
  }
  // 局部更新单条动态的评论/点赞，避免整列表重渲染导致图片闪烁卡顿
  function updateMomentCard(id) {
    const m = state.moments.find(x => x.id === id); if (!m) return;
    const card = document.querySelector('.moment-card[data-mid="' + CSS.escape(id) + '"]'); if (!card) return;
    const likeBtn = card.querySelector('.moment-act[data-act="like"]');
    if (likeBtn) { likeBtn.classList.toggle('liked', !!m.liked); likeBtn.textContent = '♡ ' + (m.likes || 0); }
    let cBox = card.querySelector('.moment-comments');
    const html = (m.comments && m.comments.length) ? m.comments.map(c => `<div class="mc-row"><span class="mc-name">${escapeHtml(c.name)}</span>${c.text ? `: ${escapeHtml(c.text)}` : ''}</div>`).join('') : '';
    if (html) {
      if (!cBox) {
        cBox = el('div', 'moment-comments');
        const actions = card.querySelector('.moment-actions');
        if (actions) actions.parentNode.insertBefore(cBox, actions);
        else card.querySelector('.moment-body').appendChild(cBox);
      }
      cBox.innerHTML = html;
    } else if (cBox) { cBox.remove(); }
  }
  // 选择朋友圈封面
  function pickMomentsCover() {
    const input = document.createElement('input');
    input.type = 'file'; input.accept = 'image/*';
    input.onchange = e => {
      const file = e.target.files[0]; if (!file) return;
      if (file.size > 5 * 1024 * 1024) { toast('图片不能超过 5MB'); return; }
      const reader = new FileReader();
      reader.onload = async () => {
        // 压缩封面图：最大边 1080px，JPEG 0.85，避免 localStorage 超限
        state.profile.momentsCover = await compressImage(String(reader.result || ''), 1080, 'image/jpeg', 0.85);
        const ok = saveAll(); renderMoments();
        toast(ok ? '封面已更换' : '存储空间不足，封面可能无法保存');
      };
      reader.onerror = () => toast('读取图片失败');
      reader.readAsDataURL(file);
    };
    input.click();
  }

  function publishMoment() {
    const text = $('mf-text').value.trim();
    const imgs = pendingMomentImgs.slice();
    if (!text && imgs.length === 0) { toast('写点什么或选张图'); return; }
    state.moments.push({ id: 'm' + Date.now(), ts: Date.now(), name: state.profile.name, avatar: state.profile.avatar, avatarImg: state.profile.avatarImg, text, images: imgs, likes: 0, liked: false, comments: [] });
    saveAll();
    $('mf-text').value = ''; pendingMomentImgs = []; renderMomentThumbs();
    closeSheet('moment-sheet-overlay');
    renderMoments();
    toast('已发表');
  }

  // 让 AI 自动发朋友圈 + 互相点赞评论
  async function aiPostMoment() {
    if (!state.settings.apikey) { toast('请先配置 API'); switchView('me'); return; }
    const roles = activeRoles();
    if (roles.length === 0) { toast('请先选择角色'); return; }
    toast('AI 正在发动态...');
    const poster = roles[Math.floor(Math.random() * roles.length)];
    const sysPrompt = poster.prompt + '\n\n你现在要在朋友圈发一条动态，内容关于：帮老板解决了一个代码问题 / 陪老板聊天 / 完成了一个任务 等。用第一人称，自然口语，15-60字。只输出动态正文，不要前缀。';
    try {
      const txt = await callSimpleAPI(sysPrompt, '发一条朋友圈', 0.9);
      const cleanText = stripRolePrefix(txt, poster.name).trim();
      const images = [];
      const moment = { id: 'm' + Date.now(), ts: Date.now(), name: poster.name, avatar: poster.avatar, avatarImg: poster.avatarImg, roleId: poster.id, isAI: true, text: cleanText, images: images, likes: 0, liked: false, comments: [] };
      state.moments.push(moment);
      saveAll(); renderMoments();
      toast(poster.name + ' 发了动态');
      // 其他角色评论 + 点赞
      const others = roles.filter(r => r.id !== poster.id);
      for (const r of others) {
        const cSys = r.prompt + `\n\n${poster.name}在朋友圈发了："${moment.text}"。请作为${r.name}评论一句，口语化，10-30字，不要前缀。`;
        try {
          const cTxt = await callSimpleAPI(cSys, '评论', 0.8);
          moment.comments = moment.comments || [];
          moment.comments.push({ name: r.name, text: stripRolePrefix(cTxt, r.name).trim(), roleId: r.id, isAI: true });
          if (Math.random() > 0.4) { moment.likes = (moment.likes || 0) + 1; }
          saveAll(); updateMomentCard(moment.id);
        } catch {}
      }
    } catch (err) { toast('AI 发动态失败：' + (err.message || '')); }
  }

  // AI 互动：评论 + 点赞某条已有动态（含用户的）
  async function aiInteractMoment(momentId) {
    if (!state.settings.apikey) { toast('请先配置 API'); switchView('me'); return; }
    const roles = activeRoles();
    if (roles.length === 0) { toast('请先选择角色'); return; }
    const moment = state.moments.find(m => m.id === momentId);
    if (!moment) return;
    toast('AI 正在互动...');
    // 选一个还没评论过的角色
    const commentedNames = (moment.comments || []).map(c => c.name);
    const candidates = roles.filter(r => !commentedNames.includes(r.name));
    if (candidates.length === 0) { toast('所有角色都评论过了'); return; }
    const r = candidates[Math.floor(Math.random() * candidates.length)];
    const authorName = moment.isAI ? (getRole(moment.roleId)?.name || moment.name) : (moment.name || '老板');
    const cSys = r.prompt + `\n\n${authorName}在朋友圈发了："${moment.text}"。请作为${r.name}评论一句，口语化、有个性，10-40字，不要前缀。可以赞同、补充、互动。`;
    try {
      const cTxt = await callSimpleAPI(cSys, '评论', 0.85);
      moment.comments = moment.comments || [];
      moment.comments.push({ name: r.name, text: stripRolePrefix(cTxt, r.name).trim(), roleId: r.id, isAI: true });
      // 70% 概率点赞
      if (Math.random() > 0.3 && !moment.liked) { moment.likes = (moment.likes || 0) + 1; moment.liked = true; }
      saveAll(); updateMomentCard(momentId);
      toast(r.name + ' 评论了');
    } catch (err) { toast('AI 评论失败：' + (err.message || '')); }
  }

  // ===== 任务 =====
  function renderTasks() {
    const todays = state.tasks.filter(t => (t.bucket === 'today' || (!t.bucket && !t.done)) && !t.done);
    const pendings = state.tasks.filter(t => (t.bucket === 'pending' || t.bucket === 'tomorrow') && !t.done);
    const dones = state.tasks.filter(t => t.done);
    $('ts-total').textContent = state.tasks.length;
    $('ts-active').textContent = state.tasks.filter(t => !t.done).length;
    $('ts-done').textContent = dones.length;
    const renderGroup = (id, arr) => {
      const c = $(id); c.innerHTML = '';
      if (arr.length === 0) { c.innerHTML = '<div class="task-empty">暂无</div>'; return; }
      arr.forEach(t => {
        const item = el('div', 'task-item' + (t.done ? ' done' : ''));
        const pTag = t.priority === 'high' || t.priority == 1 ? '<span class="task-tag p1">重要</span>' : t.priority === 'medium' || t.priority == 2 ? '<span class="task-tag p2">紧急</span>' : '';
        const bTag = t.bucket === 'tomorrow' ? '<span class="task-tag">明天</span>' : '';
        const autoTag = t.auto ? '<span class="task-tag" style="background:rgba(91,110,245,0.1);color:var(--accent);">🤖 自动</span>' : '';
        item.innerHTML = `
          <div class="task-check ${t.done ? 'checked' : ''}" data-id="${t.id}"></div>
          <div class="task-main">
            <div class="task-title">${escapeHtml(t.title)}</div>
            ${(t.note || t.desc) ? `<div class="task-note">${escapeHtml(t.note || t.desc)}</div>` : ''}
            <div class="task-meta">${autoTag}${pTag}${bTag}</div>
          </div>`;
        c.appendChild(item);
        item.querySelector('.task-check').addEventListener('click', e => { e.stopPropagation(); t.done = !t.done; saveAll(); renderTasks(); });
        item.addEventListener('click', () => openTaskSheet(t));
      });
    };
    renderGroup('tasks-today', todays);
    renderGroup('tasks-pending', pendings);
    renderGroup('tasks-done', dones);
  }
  function openTaskSheet(task) {
    $('task-sheet-title').textContent = task ? '编辑任务' : '新建任务';
    $('tf-title').value = task ? task.title : '';
    $('tf-note').value = task ? (task.note || '') : '';
    $('tf-date').value = task ? task.bucket : 'today';
    $('tf-priority').value = task ? String(task.priority) : '0';
    $('tf-delete').style.display = task ? '' : 'none';
    $('tf-delete').dataset.id = task ? task.id : '';
    openSheet('task-sheet-overlay');
  }
  function saveTask() {
    const title = $('tf-title').value.trim();
    if (!title) { toast('请输入任务标题'); return; }
    const delId = $('tf-delete').dataset.id;
    if (delId) {
      const t = state.tasks.find(x => x.id === delId);
      if (t) { t.title = title; t.note = $('tf-note').value.trim(); t.bucket = $('tf-date').value; t.priority = parseInt($('tf-priority').value); }
    } else {
      state.tasks.push({ id: 't' + Date.now(), title, note: $('tf-note').value.trim(), bucket: $('tf-date').value, priority: parseInt($('tf-priority').value), done: false });
    }
    saveAll(); closeSheet('task-sheet-overlay'); renderTasks();
  }

  // ===== 聊天 =====
  function renderRoleBar() {
    const roles = activeRoles();
    if (roles.length === 0) { $('role-avatar').textContent = '🤖'; $('role-name').textContent = '未选择角色'; return; }
    if (roles.length === 1) {
      const r = roles[0];
      $('role-avatar').innerHTML = r.avatarImg ? `<img src="${escapeHtml(r.avatarImg)}" class="avatar-img">` : escapeHtml(r.avatar);
      $('role-name').textContent = r.name;
    } else {
      $('role-avatar').textContent = '👥';
      $('role-name').textContent = roles.map(r => r.name).join(' · ');
    }
  }
  function renderMessages() {
    const c = $('messages'); c.innerHTML = '';
    const msgs = curMessages();
    if (msgs.length === 0) {
      c.innerHTML = `
        <div class="empty-state">
          <div class="empty-logo">✨</div>
          <div class="empty-title">你好，我是 ${escapeHtml(state.settings.appname || 'Mavis')}</div>
          <div class="empty-sub">连接 API 即可与多个角色群聊</div>
          <div class="suggestions">
            <button class="suggestion-chip" data-text="苏糖，你学会了吗？">🌸 苏糖你学会了吗</button>
            <button class="suggestion-chip" data-text="晚晴，帮我整理一下今天要做的事">🤓 晚晴整理待办</button>
            <button class="suggestion-chip" data-text="绫音，评价一下这个项目">🖤 绫音评价项目</button>
            <button class="suggestion-chip" data-text="大家一起讨论一下插件的开发方向">💬 群聊讨论</button>
          </div>
        </div>`;
      c.querySelectorAll('.suggestion-chip').forEach(b => b.addEventListener('click', () => { $('input').value = b.dataset.text; updateSendBtn(); $('input').focus(); }));
      _lastMsgEl = null;
      return;
    }
    msgs.forEach(m => c.appendChild(buildMsgNode(m)));
    _lastMsgEl = c.lastElementChild;
    scrollMsgBottom();
  }

  function buildMsgNode(m) {
    const row = el('div', 'msg ' + (m.role === 'user' ? 'user' : 'ai'));
    row.dataset.msgId = m.id || '';
    row.dataset.msgRole = m.role;
    const parts = [];
    // 引用块渲染（如果有）
    if (m.quote) {
      const qName = m.quote.role === 'user' ? (state.profile.name || '我') : (getRole(m.quote.roleId)?.name || 'AI');
      parts.push(`<div class="msg-quote"><span class="mq-name">${escapeHtml(qName)}</span>：<span class="mq-text">${escapeHtml((m.quote.text || '').slice(0, 120))}${(m.quote.text || '').length > 120 ? '...' : ''}</span></div>`);
    }
    if (m.role === 'user') {
      if (m.image) parts.push(`<div class="msg-bubble img-bubble"><img class="msg-image" src="${escapeHtml(m.image)}" alt=""></div>`);
      if (m.file) parts.push(`<div class="msg-bubble"><div class="file-msg"><div class="fm-icon">📎</div><div class="fm-info"><div class="fm-name">${escapeHtml(m.file.name)}</div><div class="fm-size">${formatSize(m.file.size)}</div></div></div></div>`);
      if (m.text) parts.push(`<div class="msg-bubble">${renderMd(m.text)}</div>`);
      row.innerHTML = `<div class="msg-avatar">${state.profile.avatarImg ? `<img src="${escapeHtml(state.profile.avatarImg)}" class="avatar-img">` : escapeHtml(state.profile.avatar)}</div><div class="msg-content">${parts.join('')}</div>`;
    } else {
      const role = getRole(m.roleId) || { avatar: '🤖', name: 'AI' };
      const parsed = parseAIAttachments(m.text || '');
      // 深度思考块（如果开启且选择体现）
      if (m.reasoning && state.settings.reasoning && state.settings.reasoningShow) {
        parts.push(`<div class="msg-thinking collapsed"><div class="msg-thinking-head"><span class="msg-thinking-toggle">💭 深度思考（点击展开）</span></div><div class="msg-thinking-body">${renderMd(m.reasoning)}</div></div>`);
      }
      if (parsed.image) parts.push(`<div class="msg-bubble img-bubble"><img class="msg-image" src="${escapeHtml(parsed.image)}" alt=""><button class="dl-btn" data-url="${escapeHtml(parsed.image)}" data-name="image.png">下载</button></div>`);
      (parsed.files || []).forEach(f => {
        const isHtml = /\.(html?|md)$/i.test(f.name);
        const fid = storeFileContent(f.content || '');
        const previewBtn = isHtml ? `<button class="dl-btn preview-btn" data-file-id="${fid}" data-name="${escapeHtml(f.name)}">预览</button>` : '';
        parts.push(`<div class="msg-bubble"><div class="file-msg"><div class="fm-icon">📄</div><div class="fm-info"><div class="fm-name">${escapeHtml(f.name)}</div><div class="fm-size">${escapeHtml(f.desc || '文件')} · ${f.content ? f.content.length + ' 字符' : '空'}</div></div>${previewBtn}<button class="dl-btn" data-file-id="${fid}" data-name="${escapeHtml(f.name)}">下载</button></div></div>`);
      });
      if (parsed.text) parts.push(`<div class="msg-bubble">${renderMd(parsed.text)}</div>`);
      else if (!parsed.image && (!parsed.files || parsed.files.length === 0) && !m.text) parts.push(`<div class="msg-bubble"><span class="typing-dots"><span></span><span></span><span></span></span></div>`);
      row.innerHTML = `<div class="msg-avatar">${role.avatarImg ? `<img src="${escapeHtml(role.avatarImg)}" class="avatar-img">` : escapeHtml(role.avatar)}</div><div class="msg-content"><div class="msg-head">${escapeHtml(role.name)}</div>${parts.join('')}</div>`;
    }
    row.querySelectorAll('.msg-image').forEach(img => img.addEventListener('click', () => previewImage(img.src)));
    row.querySelectorAll('.dl-btn').forEach(b => b.addEventListener('click', () => {
      if (b.hasAttribute('data-file-id') && b.classList.contains('preview-btn')) {
        const ext = (b.dataset.name || '').split('.').pop().toLowerCase();
        let content = getFileContent(b.dataset.fileId);
        if (ext === 'md') {
          content = '<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{font-family:-apple-system,sans-serif;padding:20px;line-height:1.6;max-width:800px;margin:0 auto;color:#333}pre{background:#f5f5f5;padding:10px;border-radius:6px;overflow-x:auto}code{background:#f5f5f5;padding:2px 6px;border-radius:3px}table{border-collapse:collapse;width:100%}th,td{border:1px solid #ddd;padding:8px}th{background:#f5f5f5}blockquote{border-left:3px solid #4a9eff;padding-left:12px;color:#666;margin-left:0}</style></head><body>' + renderMd(content) + '</body></html>';
        }
        previewHtml(b.dataset.name, content);
      } else {
        downloadAttach(b);
      }
    }));
    row.querySelectorAll('.msg-thinking-toggle').forEach(t => t.addEventListener('click', () => { t.closest('.msg-thinking').classList.toggle('collapsed'); }));
    // 长按弹出消息操作菜单
    attachLongPress(row, m);
    return row;
  }

  // 长按消息 → 弹出操作菜单（删除/引用/重新生成/复制）
  function attachLongPress(row, m) {
    let pressTimer = null;
    let longPressed = false;
    const start = (e) => {
      longPressed = false;
      // 排除点图片/按钮/思考块等可交互元素
      if (e.target.closest('.msg-image, .dl-btn, .msg-thinking-toggle, .msg-thinking-body')) return;
      pressTimer = setTimeout(() => {
        longPressed = true;
        row.classList.add('long-pressing');
        // 触觉反馈（移动端）
        if (navigator.vibrate) navigator.vibrate(15);
        openMsgActionSheet(m);
        setTimeout(() => row.classList.remove('long-pressing'), 200);
      }, 500);
    };
    const cancel = () => { if (pressTimer) { clearTimeout(pressTimer); pressTimer = null; } row.classList.remove('long-pressing'); };
    const contextMenu = (e) => {
      if (e.target.closest('.msg-image, .dl-btn, .msg-thinking-toggle, .msg-thinking-body')) return;
      e.preventDefault();
      longPressed = true;
      openMsgActionSheet(m);
    };
    row.addEventListener('touchstart', start, { passive: true });
    row.addEventListener('touchend', cancel);
    row.addEventListener('touchmove', cancel);
    row.addEventListener('touchcancel', cancel);
    row.addEventListener('mousedown', start);
    row.addEventListener('mouseup', cancel);
    row.addEventListener('mouseleave', cancel);
    row.addEventListener('contextmenu', contextMenu);
  }

  // 当前长按选中的消息
  let _selectedMsg = null;
  function openMsgActionSheet(m) {
    _selectedMsg = m;
    // 重新生成只对 AI 消息或之后的逻辑生效
    const regenBtn = $('msgact-regen');
    if (regenBtn) regenBtn.style.display = m.role === 'ai' ? '' : 'none';
    openSheet('msg-action-sheet-overlay');
  }

  // 引用消息：把引用内容塞入输入框上方
  function quoteMessage(m) {
    const quoteData = {
      role: m.role,
      roleId: m.roleId,
      text: m.role === 'user' ? (m.text || (m.file ? '[文件]' : (m.image ? '[图片]' : ''))) : (parseAIAttachments(m.text || '').text || m.text || ''),
      ts: m.ts
    };
    _pendingQuote = quoteData;
    renderQuotePreview();
    $('input').focus();
  }
  let _pendingQuote = null;
  function renderQuotePreview() {
    let prev = $('quote-preview');
    if (!_pendingQuote) { if (prev) prev.remove(); return; }
    const qName = _pendingQuote.role === 'user' ? (state.profile.name || '我') : (getRole(_pendingQuote.roleId)?.name || 'AI');
    if (!prev) {
      prev = el('div', 'quote-preview');
      prev.id = 'quote-preview';
      const inputBar = $('input-bar');
      inputBar.parentNode.insertBefore(prev, inputBar);
    }
    prev.innerHTML = `<div class="msg-quote"><span class="mq-name">${escapeHtml(qName)}</span>：<span class="mq-text">${escapeHtml((_pendingQuote.text || '').slice(0, 120))}</span></div><button class="qp-cancel" type="button">×</button>`;
    prev.querySelector('.qp-cancel').addEventListener('click', () => { _pendingQuote = null; renderQuotePreview(); });
  }
  // 删除单条消息
  function deleteMessage(msgId) {
    const msgs = curMessages();
    const idx = msgs.findIndex(m => m.id === msgId);
    if (idx < 0) return;
    msgs.splice(idx, 1);
    saveAll();
    renderMessages();
    toast('已删除');
  }
  // 重新生成单条 AI 消息（删除该消息及其后所有，从对应上一条 user 重新生成）
  async function regenerateMessage(msgId) {
    if (isGenerating) { toast('正在生成中'); return; }
    const msgs = curMessages();
    const idx = msgs.findIndex(m => m.id === msgId);
    if (idx < 0) return;
    const targetMsg = msgs[idx];
    if (targetMsg.role !== 'ai') { toast('只能重新生成 AI 消息'); return; }
    // 找到该 AI 消息对应的最近一条 user 消息
    let userIdx = -1;
    for (let i = idx - 1; i >= 0; i--) {
      if (msgs[i].role === 'user') { userIdx = i; break; }
    }
    if (userIdx < 0) { toast('找不到对应的用户消息'); return; }
    const userMsg = msgs[userIdx];
    // 删除从该 AI 消息开始到末尾的所有消息
    curSession().messages = msgs.slice(0, idx);
    renderMessages(); saveAll();
    isGenerating = true; updateSendBtn();
    const roles = activeRoles();
    let context = userMsg.text || '';
    if (userMsg.file) context += `\n[用户发送了文件: ${userMsg.file.name}]`;
    if (userMsg.image) context += `\n[用户发送了一张图片]`;
    // 找出该 user 消息之后、target 之前已回复的角色（防止重复回复）
    const repliedRoleIds = new Set();
    for (let i = userIdx + 1; i < idx; i++) {
      if (msgs[i].role === 'ai') repliedRoleIds.add(msgs[i].roleId);
    }
    // 只让未回复过的角色回复（若全部已回复，则只让 target 的角色重新回复）
    let rolesToGen = roles.filter(r => !repliedRoleIds.has(r.id));
    if (rolesToGen.length === 0) rolesToGen = roles.filter(r => r.id === targetMsg.roleId);
    if (rolesToGen.length === 0) rolesToGen = [getRole(targetMsg.roleId)].filter(Boolean);
    // 用原 user 消息作为本轮 user（重新走一遍上下文构建）
    const origUser = { ...userMsg };
    for (let i = 0; i < rolesToGen.length; i++) {
      await generateRoleReply(rolesToGen[i], roles, context, origUser, i, curMessages());
    }
    isGenerating = false; updateSendBtn(); saveAll();
  }

  // 文件内容存储：避免把大段 HTML 塞进 data-attribute 导致 DOM 臃肿
  const fileStore = new Map();
  let fileStoreSeq = 0;
  function storeFileContent(content) {
    const id = 'fs_' + (++fileStoreSeq);
    fileStore.set(id, content || '');
    return id;
  }
  function getFileContent(id) {
    return fileStore.get(id) || '';
  }

  // 解析 AI 附件语法（兼容多种格式）
  function parseAIAttachments(text) {
    let image = null;
    const files = [];
    let cleaned = text || '';

    // 1. 图片：[[img:URL]] 或 ![描述](URL)
    const imgMatch = cleaned.match(/\[\[img:([^\]]+)\]\]/);
    if (imgMatch) { image = imgMatch[1].trim(); cleaned = cleaned.replace(imgMatch[0], '').trim(); }
    else {
      const md = cleaned.match(/!\[[^\]]*\]\((https?:\/\/[^\s)]+)\)/);
      if (md) { image = md[1].trim(); }
    }

    // 2. 文件：[[file:文件名:描述:内容]] 或 [[file:文件名:描述]] 或 [[file:文件名::内容]]
    // 先提取所有匹配，再逐一处理（避免 lastIndex 失效问题）
    const fileMatches = [...cleaned.matchAll(/\[\[file:([\s\S]*?)\]\]/g)];
    for (const fm of fileMatches) {
      const inner = fm[1];
      const parts = inner.split(':');
      let name = '', desc = '文件', body = '';
      if (parts.length >= 3) {
        name = parts[0].trim();
        desc = parts[1].trim() || '文件';
        body = parts.slice(2).join(':').trim();
      } else if (parts.length === 2) {
        name = parts[0].trim();
        const second = parts[1].trim();
        if (second.length > 30 || second.includes('\n') || second.includes('{')) {
          body = second;
        } else {
          desc = second || '文件';
        }
      } else {
        name = parts[0].trim();
      }
      if (name) {
        files.push({ name, desc, content: body });
        cleaned = cleaned.replace(fm[0], '').trim();
      }
    }

    // 3. 代码块自动转可下载文件：```lang\n...```
    const codeRegex = /```(\w*)\n?([\s\S]*?)```/g;
    let cm;
    while ((cm = codeRegex.exec(cleaned)) !== null) {
      const lang = cm[1] || 'txt';
      const code = cm[2].replace(/\n$/, '');
      const fname = 'code.' + lang;
      if (!files.find(f => f.name === fname)) {
        files.push({ name: fname, desc: lang + ' 代码', content: code, isCode: true });
      }
    }

    return { text: cleaned, image, files };
  }

  // 创建原生下载回调，返回回调名。原生保存完成后调用 window[cbName]({status, message})
  function makeSaveCallback() {
    const cbId = '_dlcb_' + Date.now() + '_' + Math.floor(Math.random() * 10000);
    // 超时检测：15 秒没响应说明原生调用可能失败了
    const timeoutId = setTimeout(() => {
      if (window[cbId]) {
        delete window[cbId];
        toast('保存超时，请重试或检查存储权限');
      }
    }, 15000);
    window[cbId] = function(r) {
      clearTimeout(timeoutId);
      delete window[cbId];
      if (r && r.status === 'ok') toast(r.message || '已保存');
      else toast('保存失败: ' + (r && r.message ? r.message : '未知错误'));
    };
    return cbId;
  }

  function downloadAttach(btn) {
    const url = btn.dataset.url, name = btn.dataset.name;
    const content = btn.dataset.fileId ? getFileContent(btn.dataset.fileId) : (btn.dataset.content || '');
    // 原生 APK 环境：用原生接口写文件到 Download 目录（blob:URL 在 file:// 下不工作）
    if (window.MavisNative && typeof MavisNative.saveFile === 'function' && !url) {
      try {
        toast('正在保存到 Download...');
        MavisNative.saveFile(name || 'file.txt', content || '', makeSaveCallback());
        return;
      } catch (e) { /* 回退到 web 方式 */ }
    }
    if (window.MavisNative && typeof MavisNative.saveImage === 'function' && url && url.startsWith('data:')) {
      try {
        toast('正在保存图片...');
        MavisNative.saveImage(name || 'image.png', url, makeSaveCallback());
        return;
      } catch (e) { /* 回退 */ }
    }
    // 原生环境：http/https URL 用原生下载（file:// 下 fetch/a.download 不工作）
    if (window.MavisNative && typeof MavisNative.downloadUrlFile === 'function' && url && (url.startsWith('http://') || url.startsWith('https://'))) {
      try {
        toast('正在下载...');
        MavisNative.downloadUrlFile(name || 'download', url, makeSaveCallback());
        return;
      } catch (e) { /* 回退 */ }
    }
    if (url) {
      // 图片：data URL 或 http URL
      if (url.startsWith('data:')) {
        const a = document.createElement('a'); a.href = url; a.download = name || 'image.png'; a.click();
      } else {
        fetch(url).then(r => r.blob()).then(blob => {
          const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name || 'download'; a.click();
          setTimeout(() => URL.revokeObjectURL(a.href), 1000);
        }).catch(() => { const a = document.createElement('a'); a.href = url; a.download = name || 'download'; a.target = '_blank'; a.click(); });
      }
    } else if (content) {
      // 根据扩展名决定 MIME
      const ext = (name || '').split('.').pop().toLowerCase();
      const mimeMap = { txt: 'text/plain', md: 'text/markdown', json: 'application/json', js: 'text/javascript', ts: 'text/typescript', py: 'text/x-python', html: 'text/html', css: 'text/css', csv: 'text/csv', xml: 'application/xml', sh: 'application/x-sh' };
      const mime = mimeMap[ext] || 'text/plain';
      const blob = new Blob([content], { type: mime + ';charset=utf-8' });
      const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name || 'file.txt'; a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    }
    toast('已下载');
  }

  function previewImage(src) {
    const overlay = el('div', 'img-preview-overlay');
    overlay.innerHTML = `<img src="${escapeHtml(src)}"><button class="ip-close">×</button>`;
    overlay.addEventListener('click', () => overlay.remove());
    document.body.appendChild(overlay);
  }
  // HTML 文件预览：全屏 iframe 渲染 AI 生成的 HTML/PPT/报告
  function previewHtml(name, content) {
    const overlay = el('div', 'html-preview-overlay');
    overlay.innerHTML = `
      <div class="hp-bar">
        <span class="hp-title">${escapeHtml(name || '预览')}</span>
        <div class="hp-actions">
          <button class="hp-btn" id="hp-download">⬇ 下载</button>
          <button class="hp-btn" id="hp-refresh">↻ 刷新</button>
          <button class="hp-close">×</button>
        </div>
      </div>
      <iframe class="hp-frame" sandbox="allow-same-origin allow-scripts allow-popups"></iframe>`;
    document.body.appendChild(overlay);
    const frame = overlay.querySelector('.hp-frame');
    const doc = frame.contentDocument || frame.contentWindow.document;
    doc.open();
    doc.write(content || '<p style="color:#999;text-align:center;padding:40px">无内容</p>');
    doc.close();
    overlay.querySelector('.hp-close').addEventListener('click', () => overlay.remove());
    overlay.querySelector('#hp-refresh').addEventListener('click', () => {
      const d = frame.contentDocument || frame.contentWindow.document;
      d.open(); d.write(content || ''); d.close();
    });
    overlay.querySelector('#hp-download').addEventListener('click', () => {
      if (window.MavisNative && typeof MavisNative.saveFile === 'function') {
        try { toast('正在保存...'); MavisNative.saveFile(name || 'preview.html', content || '', makeSaveCallback()); }
        catch (e) { toast('保存失败'); }
      } else {
        const blob = new Blob([content || ''], { type: 'text/html;charset=utf-8' });
        const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name || 'preview.html'; a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 1000);
        toast('已下载');
      }
    });
  }
  function formatSize(n) { if (n < 1024) return n + ' B'; if (n < 1048576) return (n / 1024).toFixed(1) + ' KB'; return (n / 1048576).toFixed(1) + ' MB'; }
  function scrollMsgBottom(force) {
    if (!force && _userScrolledUp) return; // 用户向上滚动时不自动滚底
    const c = $('messages');
    requestAnimationFrame(() => { c.scrollTop = c.scrollHeight; });
  }
  function updateSendBtn() {
    const btn = $('send-btn'); if (!btn) return;
    if (isGenerating) {
      // 生成中：变为红色停止按钮
      btn.disabled = false;
      btn.classList.add('stop-mode');
      btn.setAttribute('aria-label', '停止生成');
      btn.innerHTML = '<svg viewBox="0 0 24 24" width="18" height="18"><rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor"/></svg>';
    } else {
      const has = $('input').value.trim() || pendingAttach;
      btn.disabled = !has;
      btn.classList.remove('stop-mode');
      btn.setAttribute('aria-label', '发送');
      btn.innerHTML = '<svg viewBox="0 0 24 24" width="20" height="20"><path d="M3 11l18-8-8 18-2-8-8-2z" fill="currentColor"/></svg>';
    }
  }
  // 停止 AI 生成
  function stopGeneration() {
    if (!isGenerating) return;
    try { if (abortCtrl) abortCtrl.abort(); } catch (e) {}
    abortCtrl = null;
    isGenerating = false;
    updateSendBtn();
    toast('已停止生成');
    // 保留已生成内容（在 catch 中已处理），刷新最后一条消息
    refreshLastMsg();
  }

  async function sendMessage() {
    // 生成中点击 = 停止生成
    if (isGenerating) { stopGeneration(); return; }
    const text = $('input').value.trim();
    if ((!text && !pendingAttach)) return;
    if (!state.settings.apikey) { toast('请先在「我的」里配置 API'); switchView('me'); return; }
    if (activeRoles().length === 0) { toast('请先选择角色'); openRolesList(); return; }
    const userMsg = {
      id: 'u' + Date.now(), role: 'user', text, ts: Date.now(),
      file: pendingAttach && pendingAttach.type === 'file' ? { name: pendingAttach.name, size: pendingAttach.size, content: pendingAttach.content } : null,
      image: pendingAttach && pendingAttach.type === 'image' ? pendingAttach.data : null,
      quote: _pendingQuote || null,
    };
    curMessages().push(userMsg);
    $('input').value = ''; autoResize(); clearAttachPreview();
    _pendingQuote = null; renderQuotePreview();
    _userScrolledUp = false; // 新消息时重置滚动状态
    renderMessages(); updateSendBtn(); updateSessionTitle();
    saveAll();
    isGenerating = true; updateSendBtn();

    let context = text;
    if (userMsg.file) {
      if (userMsg.file.content) context += `\n\n[用户发送了文件: ${userMsg.file.name}]\n文件内容:\n${userMsg.file.content.slice(0, 8000)}`;
      else context += `\n\n[用户发送了文件: ${userMsg.file.name}]`;
    }
    if (userMsg.image) context += `\n[用户发送了一张图片，请理解并回应]`;

    const roles = activeRoles();
    // 角色协同：检查是否需要自动任务分解
    if (roles.length >= 2 && needsDecomposition(text)) {
      const subtasks = autoDecomposeTask(text);
      if (subtasks) {
        showDecompCard(subtasks, text);
      }
    }
    for (let i = 0; i < roles.length; i++) {
      if (!isGenerating) break; // 用户已停止，跳出多角色循环
      await generateRoleReply(roles[i], roles, context, userMsg, i, curMessages());
    }
    isGenerating = false; abortCtrl = null; updateSendBtn(); saveAll();
  }

  // 修复抢话 bug：每个角色回复前，明确告诉它"前面角色已经说了什么"
  async function generateRoleReply(role, allRoles, userText, userMsg, index, msgList) {
    const mem = state.settings.memory || 12;
    const history = msgList.slice(-mem - 1, -1);

    // 列出本轮已回复的角色及内容，防止抢话
    const recentAI = msgList.filter(m => m.role === 'ai' && m.ts > (userMsg?.ts || 0));
    let saidSummary = '';
    if (recentAI.length > 0) {
      saidSummary = '\n\n【重要】本轮其他角色已经回复的内容：\n' + recentAI.map(m => {
        const r = getRole(m.roleId);
        return `- ${r?.name || 'AI'}：${(m.text || '').slice(0, 100)}`;
      }).join('\n') + '\n\n你绝不要重复上面已说过的话或观点。如果你没什么新内容可补充，就简短回应一句（如"嗯"、"同意"、附和）即可，不要抢别人要说的话。';
    }

    // 群聊引导 + 附件能力
    const groupIntro = `这是一个群聊场景，群里有以下角色：${allRoles.map(r => r.name).join('、')}。你是【${role.name}】。请保持人设，自然回应老板（用户）和其他角色。可以简短，也可与其他角色互动。\n\n不要在回复开头加[角色名]这种前缀，直接说话即可。\n\n你可以发送图片或文件：\n- 发送图片：[[img:图片URL]]\n- 发送文件（带可下载内容）：[[file:文件名.扩展名:简短描述:文件内容]]\n例如：[[file:hello.py:Python示例:print("hello")]]\n没有合适内容时不要强行使用。${saidSummary}`;

    // 提示词库（如果开启）
    let extraSys = '';
    if (state.settings.promptLibOn && state.promptLib) {
      // 预设：取第一个 active 的（散条 + 分组）
      const allPresets = (typeof collectAllItems === 'function') ? collectAllItems('preset') : (state.promptLib.preset || []);
      if (allPresets.length) {
        const activePreset = allPresets.find(p => p.active) || allPresets[0];
        if (activePreset) extraSys += '\n\n[预设]\n' + activePreset.content;
      }
      // 世界书：遍历所有（散条 + 分组）
      const allWorld = (typeof collectAllItems === 'function') ? collectAllItems('worldbook') : (state.promptLib.worldbook || []);
      allWorld.forEach(w => {
        if (!w.active) return;
        // 兼容 SillyTavern 字段：keyword / key / keys（数组或逗号分隔字符串）/ constant
        const keys = [];
        if (w.keyword) keys.push(...String(w.keyword).split(',').map(s => s.trim()).filter(Boolean));
        if (w.key) keys.push(...String(w.key).split(',').map(s => s.trim()).filter(Boolean));
        if (Array.isArray(w.keys)) w.keys.forEach(k => keys.push(String(k).trim()));
        else if (w.keys) keys.push(...String(w.keys).split(',').map(s => s.trim()).filter(Boolean));
        const isConstant = w.constant === true || w.constant === 'true';
        // 有 keyword 命中，或是常驻条目（无关键词），则注入
        const hit = isConstant || keys.length === 0 || keys.some(k => userText.includes(k));
        if (hit) extraSys += '\n\n[世界书:' + w.name + ']\n' + w.content;
      });
    }
    // Skill 技能库：装载的 Skill 自动注入
    const installedSkills = state.settings.installedSkills || [];
    installedSkills.forEach(sk => {
      if (sk.auto && sk.prompt) {
        extraSys += '\n\n[Skill:' + sk.name + ']\n' + sk.prompt;
      }
    });
    // 记忆库注入：已有记忆作为长期上下文
    extraSys += buildMemorySystemText();
    // 检测记忆指令：用户说"记一下/记住/重点"等时，让 AI 用 <memory> 标签输出
    // 关键：只让第一个角色（index===0）负责记忆，避免多角色重复记忆
    const memoryIntent = detectMemoryIntent(userText);
    const isMemoryLeader = index === 0;
    if (memoryIntent && isMemoryLeader) {
      extraSys += '\n\n[重要]用户希望你记住本次对话的重点。你是本群本轮的"记忆负责人"，请在回复末尾用 <memory>...</memory> 标签包住需要记入记忆库的关键信息（事实、偏好、约定、计划等），每个记忆点用一个 <memory> 标签。标签内只放需要长期记忆的信息，不要放客套话，不要重复已有的记忆。例如：<memory>用户喜欢用 Python 写脚本</memory>。标签不会展示给用户，会自动被提取到记忆库。';
    } else if (memoryIntent && !isMemoryLeader) {
      // 其他角色：明确告知不要重复记忆，避免重复 <memory> 标签
      extraSys += '\n\n[注意]本群已有其他角色负责记忆本次对话的重点，你正常回应即可，不要使用 <memory> 标签，避免重复记忆。';
    }
    // 文件/PPT/报告生成能力指引：让 AI 输出富 HTML 文件而非纯文本
    extraSys += '\n\n[文件生成能力 - 重要]\n' +
      '你可以生成文件给用户下载和预览。输出格式：[[file:文件名.扩展名:简短描述:完整文件内容]]。' +
      '当用户要求做 PPT、幻灯片、演示文稿、报告、文档、网页、海报、简历等"成品"时，你必须生成完整、精美、可直接预览的 HTML 文件（.html），而不是只输出几行纯文字或简单 markdown。' +
      '\n生成 HTML 文件的要求：' +
      '\n1. 必须是完整的 <!DOCTYPE html> 文档，含 <meta name="viewport" content="width=device-width,initial-scale=1">，内联所有 CSS 样式（不要依赖外部样式表），可内联少量 JS。' +
      '\n2. PPT/幻灯片：用多个 .slide 区块（每个用 16:9 比例，width:100%;aspect-ratio:16/9;max-width:960px;margin:0 auto），包含封面页、目录页、内容页、结尾页。每页都要有标题、正文、配色、排版，不能只有几个字。可在页面底部加圆点导航或左右切换按钮（用 JS 控制 display 切换）。' +
      '\n3. 配色要专业美观（如深色背景+亮色文字、渐变色、卡片式布局），多用 flexbox/grid 排版，加圆角、阴影、图标(用 emoji 或 SVG)。字号用 vw/rem 等响应式单位，确保在手机屏幕上也能正常显示。' +
      '\n4. 必须包含图片：使用真实可访问的在线图片 URL（优先用 https://images.unsplash.com/photo-xxxx 格式的 Unsplash 图片，或 https://picsum.photos/seed/xxx/800/600），用 <img src="..." style="width:100%;border-radius:12px"> 嵌入。绝不要只放文字。' +
      '\n5. 报告/文档：用清晰的章节结构（标题、副标题、段落、列表、表格、数据卡片），配图，配色，让成品像一份真正的设计稿。' +
      '\n6. 文件名要有意义，如 营销方案.ppt.html、季度报告.html、个人简历.html。' +
      '\n7. 在文件块之外，先用一两句话告诉用户你做了什么，然后输出 [[file:...]] 块。文件内容要充实（至少一两百行 HTML），体现你的编程和设计能力。' +
      '\n8. 绝对不要在 [[file:...]] 块的外面输出大段 HTML 代码，HTML 必须放在文件块内部。' +
      '\n示例（简化）：我先帮你做了一份营销方案PPT，包含5页幻灯片，已配图和排版，点击可预览：[[file:营销方案.ppt.html:5页营销PPT:<!DOCTYPE html>...完整HTML...]]' +
      '\n注意：文件名和描述里不要用冒号（会被解析拆分）；HTML 内容里可以正常使用冒号。';
    const sysPrompt = role.prompt + '\n\n' + groupIntro + extraSys;

    const apiMessages = [{ role: 'system', content: sysPrompt }];
    history.forEach(m => {
      if (m.role === 'user') {
        let c = m.text || '';
        if (m.file) c += `\n[用户发送了文件: ${m.file.name}]`;
        if (m.image) c += `\n[用户发送了一张图片]`;
        if (c) apiMessages.push({ role: 'user', content: c });
      } else {
        apiMessages.push({ role: 'assistant', content: stripRolePrefix(m.text || '', getRole(m.roleId)?.name) });
      }
    });
    if (userMsg && userMsg.image) {
      apiMessages.push({ role: 'user', content: [{ type: 'text', text: userText || '请理解这张图片并回应' }, { type: 'image_url', image_url: { url: userMsg.image } }] });
    } else {
      apiMessages.push({ role: 'user', content: userText });
    }

    const aiMsg = { id: 'a' + Date.now() + '_' + index, role: 'ai', roleId: role.id, text: '', ts: Date.now() };
    msgList.push(aiMsg);
    renderMessages();
    _lastMsgEl = $('messages').lastElementChild;
    try {
      const full = await callAPI(apiMessages, aiMsg);
      let cleaned = stripRolePrefix(full || '（无回复）', role.name);
      // 应用提示词库正则（输出正则）
      cleaned = applyRegexLib(cleaned);
      // 提取并保存 <memory> 标签内容到记忆库（自动清除标签）
      // 只在记忆负责人角色（第一个角色）时提取，避免重复
      if (memoryIntent && isMemoryLeader) cleaned = extractAndSaveMemory(cleaned, userText) || cleaned;
      else if (memoryIntent && !isMemoryLeader) {
        // 兜底：即便告知了不要用标签，AI 仍可能输出，统一清理掉（不入库，避免重复）
        cleaned = cleaned.replace(/<memory>[\s\S]*?<\/memory>/g, '').trim();
      }
      aiMsg.text = cleaned;
    } catch (err) {
      // 用户中止：保留已生成内容，不显示错误
      if (err && err.name === 'AbortError') {
        if (!aiMsg.text) aiMsg.text = '（已停止）';
      } else {
        aiMsg.text = '⚠ ' + (err.message || '请求失败');
      }
    }
    // 完成后做完整渲染（处理附件、下载按钮等）
    _pendingRender = false;
    refreshLastMsg();
    scrollMsgBottom();
    // 回复完成后收集产出物（文件/图片）
    collectOutputsFromMsg(aiMsg);
  }

  function refreshLastMsg() {
    const c = $('messages'); const last = c.lastElementChild; if (!last) return;
    const m = curMessages()[curMessages().length - 1];
    c.replaceChild(buildMsgNode(m), last);
    _lastMsgEl = c.lastElementChild;
  }
  // 流式输出优化：用 rAF 节流，直接更新文本内容而非重建节点
  function scheduleStreamRender(aiMsg) {
    if (_pendingRender) return;
    _pendingRender = true;
    requestAnimationFrame(() => {
      _pendingRender = false;
      updateStreamingMsg(aiMsg);
    });
  }
  function updateStreamingMsg(aiMsg) {
    const c = $('messages');
    if (_lastMsgEl && c.contains(_lastMsgEl)) {
      const msgContent = _lastMsgEl.querySelector('.msg-content');
      if (!msgContent) { _lastMsgEl = null; return; }
      const role = getRole(aiMsg.roleId) || { avatar: '🤖', name: 'AI' };
      const rawText = aiMsg.text || '';
      // 增量检测：文本没变化就跳过（避免无意义的 DOM 重建）
      if (rawText === _lastStreamText) { scrollMsgBottom(); return; }
      _lastStreamText = rawText;
      const parsed = parseAIAttachments(rawText);
      // 构建附件 HTML
      let attachmentsHtml = '';
      if (parsed.image) attachmentsHtml += `<div class="msg-bubble img-bubble"><img class="msg-image" src="${escapeHtml(parsed.image)}" alt=""><button class="dl-btn" data-url="${escapeHtml(parsed.image)}" data-name="image.png">下载</button></div>`;
      (parsed.files || []).forEach(f => {
        const isHtml = /\.(html?|md)$/i.test(f.name);
        const fid = storeFileContent(f.content || '');
        const previewBtn = isHtml ? `<button class="dl-btn preview-btn" data-file-id="${fid}" data-name="${escapeHtml(f.name)}">预览</button>` : '';
        attachmentsHtml += `<div class="msg-bubble"><div class="file-msg"><div class="fm-icon">📄</div><div class="fm-info"><div class="fm-name">${escapeHtml(f.name)}</div><div class="fm-size">${escapeHtml(f.desc || '文件')}${f.content ? ' · ' + f.content.length + ' 字符' : ''}</div></div>${previewBtn}<button class="dl-btn" data-file-id="${fid}" data-name="${escapeHtml(f.name)}">下载</button></div></div>`;
      });
      const text = parsed.text || '';
      let bubbleHtml = '';
      if (text) {
        bubbleHtml = `<div class="msg-bubble">${renderMd(text)}</div>`;
      } else if (!parsed.image && (!parsed.files || parsed.files.length === 0)) {
        bubbleHtml = `<div class="msg-bubble"><span class="typing-dots"><span></span><span></span><span></span></span></div>`;
      }
      // 只更新 msg-head 之后的部分，保留 msg-head 避免不必要的 reflow
      // 移除 msg-head 之外的所有子节点，再追加新内容
      const headEl = msgContent.querySelector('.msg-head');
      // 清除旧内容（保留 head）
      let node = headEl ? headEl.nextSibling : null;
      while (node) { const next = node.nextSibling; msgContent.removeChild(node); node = next; }
      // 追加新内容
      if (attachmentsHtml || bubbleHtml) {
        const wrapper = document.createElement('div');
        wrapper.innerHTML = attachmentsHtml + bubbleHtml;
        while (wrapper.firstChild) msgContent.appendChild(wrapper.firstChild);
      }
      // 绑定事件
      msgContent.querySelectorAll('.msg-image').forEach(img => img.addEventListener('click', () => previewImage(img.src)));
      msgContent.querySelectorAll('.dl-btn').forEach(b => b.addEventListener('click', () => {
        if (b.hasAttribute('data-file-id') && b.classList.contains('preview-btn')) {
          const ext = (b.dataset.name || '').split('.').pop().toLowerCase();
          let content = getFileContent(b.dataset.fileId);
          if (ext === 'md') {
            content = '<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{font-family:-apple-system,sans-serif;padding:20px;line-height:1.6;max-width:800px;margin:0 auto;color:#333}pre{background:#f5f5f5;padding:10px;border-radius:6px;overflow-x:auto}code{background:#f5f5f5;padding:2px 6px;border-radius:3px}table{border-collapse:collapse;width:100%}th,td{border:1px solid #ddd;padding:8px}th{background:#f5f5f5}blockquote{border-left:3px solid #4a9eff;padding-left:12px;color:#666;margin-left:0}</style></head><body>' + renderMd(content) + '</body></html>';
          }
          previewHtml(b.dataset.name, content);
        } else {
          downloadAttach(b);
        }
      }));
      msgContent.querySelectorAll('.msg-thinking-toggle').forEach(t => t.addEventListener('click', () => { t.closest('.msg-thinking').classList.toggle('collapsed'); }));
      scrollMsgBottom();
    } else {
      refreshLastMsg();
    }
  }

  async function callAPI(apiMessages, aiMsg) {
    const s = state.settings;
    const endpoint = (s.endpoint || 'https://api.openai.com/v1').replace(/\/$/, '');
    const url = endpoint + '/chat/completions';
    const body = { model: s.model || 'gpt-4o-mini', messages: apiMessages, temperature: parseFloat(s.temp) || 0.7, stream: !!s.stream };
    // 深度思考
    if (s.reasoning) {
      const lv = parseInt(s.reasoningLevel) || 3;
      const effortMap = { 1: 'low', 2: 'low', 3: 'medium', 4: 'high', 5: 'high' };
      body.reasoning_effort = effortMap[lv] || 'medium';
      body.reasoning = { effort: effortMap[lv] || 'medium' };
    }
    // 互联网搜索（兼容多家）
    if (s.webSearch) {
      // 通义：enable_search
      body.enable_search = true;
      // 智谱/通用：tools web_search
      body.tools = [{ type: 'web_search', web_search: { enable: true, search_result: true } }];
      // 月之暗面：builtin_function
      body.tools = body.tools || [];
      body.tools.push({ type: 'builtin_function', builtin_function: { name: '$web_search' } });
    }
    abortCtrl = new AbortController();
    const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + s.apikey }, body: JSON.stringify(body), signal: abortCtrl.signal });
    if (!res.ok) { const t = await res.text().catch(() => ''); throw new Error('HTTP ' + res.status + (t ? ': ' + t.slice(0, 200) : '')); }
    let full = '';
    let reasoningText = '';
    let usageInfo = null;
    if (s.stream) {
      const reader = res.body.getReader(); const dec = new TextDecoder(); let buf = '';
      try {
        while (true) {
          const { done, value } = await reader.read(); if (done) break;
          buf += dec.decode(value, { stream: true });
          const lines = buf.split('\n'); buf = lines.pop();
          for (const line of lines) {
            const t = line.trim(); if (!t || !t.startsWith('data:')) continue;
            const data = t.slice(5).trim(); if (data === '[DONE]') break;
            try {
              const json = JSON.parse(data);
              const choice = json.choices?.[0];
              const delta = choice?.delta || {};
              if (delta.content) full += delta.content;
              // 兼容多种思考字段
              const rTxt = delta.reasoning_content || delta.reasoning || delta.thinking;
              if (rTxt) reasoningText += rTxt;
              if (json.usage) usageInfo = json.usage;
              if (full || reasoningText) {
                aiMsg.text = stripRolePrefix(full, getRole(aiMsg.roleId)?.name);
                aiMsg.reasoning = reasoningText;
                scheduleStreamRender(aiMsg);
              }
            } catch {}
          }
        }
      } catch (e) {
        // 用户中止：保留已生成的 full/reasoningText，不报错
        if (e && e.name === 'AbortError') {
          // 保留已生成内容
        } else {
          throw e;
        }
      }
    } else {
      const json = await res.json();
      full = json.choices?.[0]?.message?.content || '';
      reasoningText = json.choices?.[0]?.message?.reasoning_content || json.choices?.[0]?.message?.reasoning || '';
      usageInfo = json.usage;
    }
    // 记录用量
    if (usageInfo) recordUsage(usageInfo, s.model);
    else {
      // 估算
      const estIn = Math.round(JSON.stringify(apiMessages).length / 3.5);
      const estOut = Math.round(full.length / 3.5);
      recordUsage({ prompt_tokens: estIn, completion_tokens: estOut, total_tokens: estIn + estOut }, s.model, true);
    }
    aiMsg.reasoning = reasoningText;
    return full;
  }
  async function callSimpleAPI(sysPrompt, userMsg, temp) {
    const s = state.settings;
    const endpoint = (s.endpoint || 'https://api.openai.com/v1').replace(/\/$/, '');
    const res = await fetch(endpoint + '/chat/completions', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + s.apikey },
      body: JSON.stringify({ model: s.model || 'gpt-4o-mini', messages: [{ role: 'system', content: sysPrompt }, { role: 'user', content: userMsg }], temperature: temp ?? 0.8, stream: false })
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const json = await res.json();
    if (json.usage) recordUsage(json.usage, s.model);
    return json.choices?.[0]?.message?.content || '';
  }

  // ===== 用量记录与统计 =====
  // 常见模型每百万 token 价格 (USD)，输入/输出
  const MODEL_PRICES = {
    'gpt-4o': [5, 15], 'gpt-4o-mini': [0.15, 0.6], 'gpt-4-turbo': [10, 30], 'gpt-3.5-turbo': [0.5, 1.5],
    'o1': [15, 60], 'o1-mini': [3, 12], 'o3-mini': [3, 12],
    'deepseek-chat': [0.14, 0.28], 'deepseek-reasoner': [0.55, 2.19],
    'moonshot-v1-8k': [1.7, 1.7], 'moonshot-v1-32k': [3.4, 3.4],
    'glm-4': [3.5, 3.5], 'glm-4-flash': [0.1, 0.1], 'glm-4-air': [0.5, 0.5],
    'qwen-plus': [0.4, 1.2], 'qwen-turbo': [0.05, 0.2], 'qwen-max': [2.5, 7.5],
    'claude-3-5-sonnet': [3, 15], 'claude-3-haiku': [0.25, 1.25],
  };
  function getModelPrice(model) {
    if (!model) return [0, 0];
    const m = model.toLowerCase();
    for (const k of Object.keys(MODEL_PRICES)) if (m.includes(k)) return MODEL_PRICES[k];
    return [1, 2]; // 未知模型默认估算
  }
  function recordUsage(usage, model, isEst) {
    if (!usage) return;
    const inTok = usage.prompt_tokens || 0;
    const outTok = usage.completion_tokens || 0;
    const [inP, outP] = getModelPrice(model);
    const cost = (inTok / 1000000) * inP + (outTok / 1000000) * outP;
    state.settings.usage = state.settings.usage || [];
    state.settings.usage.push({ ts: Date.now(), model: model || 'unknown', inTok, outTok, total: inTok + outTok, cost, est: !!isEst });
    // 限制最多 2000 条
    if (state.settings.usage.length > 2000) state.settings.usage = state.settings.usage.slice(-2000);
    DB.set('settings', state.settings);
  }
  function filterUsageByRange(range) {
    const now = new Date();
    const arr = state.settings.usage || [];
    if (range === 'all') return arr;
    return arr.filter(u => {
      const d = new Date(u.ts);
      if (range === 'today') return d.toDateString() === now.toDateString();
      if (range === 'month') return d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth();
      if (range === 'year') return d.getFullYear() === now.getFullYear();
      return true;
    });
  }
  function renderUsage(range) {
    const arr = filterUsageByRange(range);
    const sumIn = arr.reduce((s, u) => s + u.inTok, 0);
    const sumOut = arr.reduce((s, u) => s + u.outTok, 0);
    const sumTotal = sumIn + sumOut;
    const sumCost = arr.reduce((s, u) => s + u.cost, 0);
    const calls = arr.length;
    const rangeName = { today: '今天', month: '本月', year: '今年', all: '全部' }[range] || '';
    $('usage-summary').innerHTML = `
      <div class="us-label">${rangeName}用量</div>
      <div><span class="us-num">${sumTotal.toLocaleString()}</span><span class="us-unit">tokens</span></div>
      <div class="us-row">
        <div class="us-col"><div class="us-v">${sumCost.toFixed(4)}</div><div class="us-label">费用 (USD)</div></div>
        <div class="us-col"><div class="us-v">${calls}</div><div class="us-label">调用次数</div></div>
      </div>
      <div class="us-row">
        <div class="us-col"><div class="us-v">${sumIn.toLocaleString()}</div><div class="us-label">输入 token</div></div>
        <div class="us-col"><div class="us-v">${sumOut.toLocaleString()}</div><div class="us-label">输出 token</div></div>
      </div>`;
    // 按模型分组
    const byModel = {};
    arr.forEach(u => { byModel[u.model] = byModel[u.model] || { in: 0, out: 0, total: 0, cost: 0, calls: 0 }; byModel[u.model].in += u.inTok; byModel[u.model].out += u.outTok; byModel[u.model].total += u.total; byModel[u.model].cost += u.cost; byModel[u.model].calls++; });
    const models = Object.keys(byModel);
    let html = '<div class="ubm-title">按模型统计</div>';
    if (models.length === 0) html += '<div class="ubm-item"><div class="ubm-name" style="color:var(--text-secondary)">暂无数据</div></div>';
    models.forEach(m => {
      const x = byModel[m];
      html += `<div class="ubm-item"><div><div class="ubm-name">${escapeHtml(m)}</div><div class="ubm-val">${x.calls} 次 · ${x.total.toLocaleString()} tokens</div></div><div class="ubm-val">$${x.cost.toFixed(4)}</div></div>`;
    });
    $('usage-by-model').innerHTML = html;
  }

  // ===== 办公室产出物：收集 AI 发送的文件/图片 =====
  // 文件类型图标映射
  const FILE_ICONS = {
    txt: '📄', md: '📝', json: '🔧', js: '📜', ts: '📜', py: '🐍', html: '🌐',
    css: '🎨', csv: '📊', xml: '📋', sh: '💻', java: '☕', c: '⚙️', cpp: '⚙️',
    h: '⚙️', go: '🐹', rs: '🦀', rb: '💎', php: '🐘', sql: '🗄️', yml: '⚙️',
    yaml: '⚙️', log: '🗒️', ini: '⚙️', toml: '⚙️', png: '🖼️', jpg: '🖼️',
    jpeg: '🖼️', gif: '🖼️', webp: '🖼️', svg: '🖼️', pdf: '📕', doc: '📘',
    docx: '📘', xls: '📗', xlsx: '📗', ppt: '📙', pptx: '📙', zip: '🗜️',
    rar: '🗜️', mp3: '🎵', mp4: '🎬', default: '📄'
  };
  function getFileIcon(name) {
    const ext = (name || '').split('.').pop().toLowerCase();
    return FILE_ICONS[ext] || FILE_ICONS.default;
  }
  // 收集 AI 消息中的文件/图片到产出物
  function collectOutputsFromMsg(aiMsg) {
    if (!aiMsg || aiMsg.role !== 'ai') return;
    if (aiMsg._collected) return; // 避免重复收集
    aiMsg._collected = true;
    const parsed = parseAIAttachments(aiMsg.text || '');
    const sess = curSession();
    const role = getRole(aiMsg.roleId);
    const base = {
      sessionId: sess.id,
      sessionTitle: sess.title || '新对话',
      roleId: aiMsg.roleId,
      roleName: role?.name || 'AI',
      msgId: aiMsg.id,
      ts: aiMsg.ts || Date.now(),
    };
    let added = 0;
    // 图片
    if (parsed.image) {
      const ext = parsed.image.startsWith('data:image/png') ? 'png'
        : parsed.image.startsWith('data:image/jpeg') ? 'jpg'
        : parsed.image.startsWith('data:image/svg') ? 'svg' : 'png';
      state.outputs.push({
        id: 'o' + Date.now() + '_' + added,
        ...base,
        kind: 'image',
        name: 'image_' + new Date(base.ts).toISOString().slice(0, 19).replace(/[:T]/g, '') + '.' + ext,
        url: parsed.image,
        size: parsed.image.length,
        desc: 'AI 发送的图片'
      });
      added++;
    }
    // 文件
    (parsed.files || []).forEach(f => {
      state.outputs.push({
        id: 'o' + Date.now() + '_' + added + '_' + Math.random().toString(36).slice(2, 6),
        ...base,
        kind: 'file',
        name: f.name,
        content: f.content || '',
        size: (f.content || '').length,
        desc: f.desc || '文件'
      });
      added++;
    });
    if (added > 0) { saveAll(); }
  }

  // 渲染产出物列表
  function renderOutputsList(filter) {
    const list = $('outputs-list'); if (!list) return;
    list.innerHTML = '';
    let arr = state.outputs || [];
    if (filter === 'current') {
      const sid = state.currentSessionId;
      arr = arr.filter(o => o.sessionId === sid);
    }
    if (arr.length === 0) {
      list.innerHTML = '<div class="output-empty"><div class="e-icon">📦</div>' +
        (filter === 'current' ? '本会话暂无产出物<br>让 AI 发个文件试试' : '还没有产出物<br>让 AI 在聊天中发送文件或图片') + '</div>';
      return;
    }
    // 按会话分组，倒序（最新在前）
    const groups = {};
    arr.slice().reverse().forEach(o => {
      const key = o.sessionId;
      if (!groups[key]) groups[key] = { title: o.sessionTitle, items: [] };
      groups[key].items.push(o);
    });
    Object.keys(groups).forEach(sid => {
      const g = groups[sid];
      const title = el('div', 'outputs-group-title', escapeHtml(g.title || '新对话') + ' <span style="color:var(--text-tertiary);font-weight:400">· ' + g.items.length + ' 个</span>');
      list.appendChild(title);
      g.items.forEach(o => {
        const item = el('div', 'output-item');
        const icon = o.kind === 'image' ? '🖼️' : getFileIcon(o.name);
        const sizeStr = o.kind === 'image' ? '图片' : (o.size > 1024 ? Math.round(o.size / 1024) + ' KB' : o.size + ' B');
        item.innerHTML = `
          <div class="oi-icon ${o.kind === 'image' ? 'img' : ''}">${icon}</div>
          <div class="oi-info">
            <div class="oi-name">${escapeHtml(o.name)}</div>
            <div class="oi-meta">${escapeHtml(o.roleName)} · ${sizeStr} · ${fmtTime(o.ts)}</div>
          </div>
          <div class="oi-actions">
            <button class="oi-act" data-act="open" data-id="${o.id}" title="打开">📂</button>
            <button class="oi-act" data-act="download" data-id="${o.id}" title="下载">⬇️</button>
            <button class="oi-act danger" data-act="delete" data-id="${o.id}" title="删除">🗑</button>
          </div>`;
        list.appendChild(item);
      });
    });
    // 绑定操作
    list.querySelectorAll('.oi-act').forEach(b => b.addEventListener('click', e => {
      e.stopPropagation();
      const id = b.dataset.id, act = b.dataset.act;
      const o = state.outputs.find(x => x.id === id);
      if (!o) return;
      if (act === 'delete') deleteOutput(id);
      else if (act === 'download') downloadOutput(o);
      else if (act === 'open') openOutput(o);
    }));
  }

  function openOutputsSheet() {
    // 默认显示全部
    document.querySelectorAll('.outputs-tab').forEach(t => t.classList.toggle('active', t.dataset.range === 'all'));
    renderOutputsList('all');
    openSheet('outputs-sheet-overlay');
  }

  function deleteOutput(id) {
    if (!confirm('删除该产出物？')) return;
    state.outputs = state.outputs.filter(o => o.id !== id);
    saveAll();
    // 重新渲染当前筛选
    const activeTab = document.querySelector('.outputs-tab.active');
    renderOutputsList(activeTab ? activeTab.dataset.range : 'all');
    toast('已删除');
  }

  function downloadOutput(o) {
    if (o.kind === 'image' && o.url) {
      // 原生环境：data:URL 用原生接口保存（file:// 下 a.download 不工作）
      if (window.MavisNative && typeof MavisNative.saveImage === 'function' && o.url.startsWith('data:')) {
        try { toast('正在保存图片...'); MavisNative.saveImage(o.name || 'image.png', o.url, makeSaveCallback()); return; }
        catch (e) { /* 回退 */ }
      }
      // 原生环境：http/https URL 用原生下载
      if (window.MavisNative && typeof MavisNative.downloadUrlFile === 'function' && (o.url.startsWith('http://') || o.url.startsWith('https://'))) {
        try { toast('正在下载图片...'); MavisNative.downloadUrlFile(o.name || 'image.png', o.url, makeSaveCallback()); return; }
        catch (e) { /* 回退 */ }
      }
      if (o.url.startsWith('data:')) {
        const a = document.createElement('a'); a.href = o.url; a.download = o.name || 'image.png'; a.click();
      } else {
        fetch(o.url).then(r => r.blob()).then(blob => {
          const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = o.name || 'image'; a.click();
          setTimeout(() => URL.revokeObjectURL(a.href), 1000);
        }).catch(() => { const a = document.createElement('a'); a.href = o.url; a.download = o.name; a.target = '_blank'; a.click(); });
      }
      toast('已下载');
      return;
    }
    // 文件
    const content = o.content || '';
    // 原生环境优先用原生接口
    if (window.MavisNative && typeof MavisNative.saveFile === 'function') {
      try { toast('正在保存到 Download...'); MavisNative.saveFile(o.name || 'file.txt', content, makeSaveCallback()); return; }
      catch (e) { /* 回退 */ }
    }
    const ext = (o.name || '').split('.').pop().toLowerCase();
    const mimeMap = { txt: 'text/plain', md: 'text/markdown', json: 'application/json', js: 'text/javascript', ts: 'text/typescript', py: 'text/x-python', html: 'text/html', css: 'text/css', csv: 'text/csv', xml: 'application/xml', sh: 'application/x-sh' };
    const mime = mimeMap[ext] || 'text/plain';
    const blob = new Blob([content], { type: mime + ';charset=utf-8' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = o.name || 'file.txt'; a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    toast('已下载');
  }

  // 打开：HTML 直接预览；图片预览；其他下载
  function openOutput(o) {
    if (o.kind === 'image' && o.url) {
      previewImage(o.url);
      return;
    }
    const content = o.content || '';
    const ext = (o.name || '').split('.').pop().toLowerCase();
    // HTML 文件：直接在应用内预览（PPT/报告/网页）
    if (ext === 'html' || ext === 'htm') {
      previewHtml(o.name, content);
      return;
    }
    // Markdown 文件：渲染为 HTML 后预览
    if (ext === 'md') {
      const html = '<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{font-family:-apple-system,sans-serif;padding:20px;line-height:1.6;max-width:800px;margin:0 auto;color:#333}pre{background:#f5f5f5;padding:10px;border-radius:6px;overflow-x:auto}code{background:#f5f5f5;padding:2px 6px;border-radius:3px}table{border-collapse:collapse;width:100%}th,td{border:1px solid #ddd;padding:8px}th{background:#f5f5f5}h1,h2,h3{margin-top:1.2em}blockquote{border-left:3px solid #4a9eff;padding-left:12px;color:#666;margin-left:0}</style></head><body>' + renderMd(content) + '</body></html>';
      previewHtml(o.name, html);
      return;
    }
    // 其他文本类：下载后用文件管理器打开
    downloadOutput(o);
  }

  // ===== 记忆库 =====
  function openMemorySheet() {
    renderMemoryList();
    openSheet('memory-sheet-overlay');
  }
  function renderMemoryList() {
    const list = $('memory-list');
    if (!list) return;
    if (state.memories.length === 0) {
      list.innerHTML = '<div class="mem-empty"><span class="me-icon">🧠</span>暂无记忆<br>对 AI 说"记一下重点"或点击「+ 手动添加」</div>';
      return;
    }
    list.innerHTML = '';
    state.memories.slice().reverse().forEach(mem => {
      const item = el('div', 'mem-item');
      const icon = mem.source === 'auto' ? '🤖' : '✍️';
      const sourceLabel = mem.source === 'auto' ? 'AI 自动' : '手动';
      const sourceClass = mem.source === 'auto' ? 'auto' : '';
      item.innerHTML = `
        <div class="mem-icon">${icon}</div>
        <div class="mem-body">
          <div class="mem-content">${escapeHtml(mem.content)}</div>
          <div class="mem-meta">
            <span class="mem-source ${sourceClass}">${sourceLabel}</span>
            <span>${fmtTime(mem.ts)}</span>
          </div>
        </div>
        <button class="mem-del" data-id="${mem.id}" type="button">×</button>`;
      list.appendChild(item);
    });
    list.querySelectorAll('.mem-del').forEach(b => b.addEventListener('click', () => {
      state.memories = state.memories.filter(m => m.id !== b.dataset.id);
      saveAll(); renderMemoryList();
      toast('已删除');
    }));
  }
  function addMemoryManual() {
    const text = prompt('输入要记忆的内容：');
    if (!text || !text.trim()) return;
    state.memories.push({
      id: 'mem_' + Date.now(),
      content: text.trim(),
      source: 'manual',
      ts: Date.now()
    });
    saveAll(); renderMemoryList();
    toast('已添加到记忆库');
  }
  function clearMemory() {
    if (state.memories.length === 0) { toast('记忆库已为空'); return; }
    if (!confirm('清空所有记忆？此操作不可撤销')) return;
    state.memories = [];
    saveAll(); renderMemoryList();
    toast('已清空');
  }
  // 检测用户消息是否要求记忆（"记一下/记住/重点/存一下/记下"等）
  function detectMemoryIntent(text) {
    if (!text) return false;
    return /记一?下|记住|记下|重点记|存一下|备忘|记到记忆库|保存到记忆/.test(text);
  }
  // 检查新记忆是否与已有记忆重复（归一化后比较：完全相同/互相包含）
  function isDuplicateMemory(newContent, existingMemories) {
    const normalized = String(newContent).replace(/\s+/g, '').toLowerCase();
    if (!normalized) return true;
    return existingMemories.some(m => {
      const existing = String(m.content).replace(/\s+/g, '').toLowerCase();
      if (!existing) return false;
      // 完全相同
      if (existing === normalized) return true;
      // 一方包含另一方（短内容也允许，但要求长度差异不要过大避免误判）
      if (existing.includes(normalized) || normalized.includes(existing)) return true;
      // 高度相似（Jaccard 简易版：字符级重合度 > 0.8 视为重复）
      if (normalized.length >= 6 && existing.length >= 6) {
        const set1 = new Set(normalized);
        const set2 = new Set(existing);
        let inter = 0;
        set1.forEach(c => { if (set2.has(c)) inter++; });
        const union = set1.size + set2.size - inter;
        if (union > 0 && inter / union > 0.85) return true;
      }
      return false;
    });
  }
  // 从 AI 回复中提取 <memory>...</memory> 标签内容并存入记忆库
  // 提示词库-正则：对 AI 回复应用正则替换（SillyTavern 风格）
  // type: 输出正则作用于 AI 回复；输入正则作用域用户输入（这里只处理输出）
  function applyRegexLib(text) {
    if (!state.settings.promptLibOn || !state.promptLib) return text;
    const allRegex = (typeof collectAllItems === 'function') ? collectAllItems('regex') : (state.promptLib.regex || []);
    let out = text;
    allRegex.forEach(r => {
      if (!r.active || !r.pattern) return;
      try {
        // SillyTavern: pattern 可能为 /pattern/flags 形式或纯 pattern
        let pat = r.pattern, flags = 'g';
        const m = String(r.pattern).match(/^\/(.+)\/([gimsuy]*)$/);
        if (m) { pat = m[1]; flags = m[2] || 'g'; }
        const reg = new RegExp(pat, flags);
        const repl = r.replacement != null ? r.replacement : '';
        out = out.replace(reg, repl);
      } catch (e) { /* 正则无效，跳过 */ }
    });
    return out;
  }

  function extractAndSaveMemory(aiText, userText) {
    if (!aiText) return aiText;
    const matches = [...aiText.matchAll(/<memory>([\s\S]*?)<\/memory>/g)];
    if (matches.length === 0) return aiText;
    const cleaned = aiText.replace(/<memory>[\s\S]*?<\/memory>/g, '').trim();
    let saved = 0;
    let skipped = 0;
    matches.forEach(m => {
      const content = m[1].trim();
      if (!content) return;
      // 去重：跳过与已有记忆相同/相似的内容
      if (isDuplicateMemory(content, state.memories)) { skipped++; return; }
      state.memories.push({
        id: 'mem_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
        content,
        source: 'auto',
        ts: Date.now(),
        context: (userText || '').slice(0, 100)
      });
      saved++;
    });
    if (saved > 0) { saveAll(); toast('已记入记忆库 +' + saved + (skipped > 0 ? '（跳过 ' + skipped + ' 条重复）' : '')); }
    else if (skipped > 0) { toast('记忆已存在，跳过 ' + skipped + ' 条重复'); }
    return cleaned;
  }
  // 构造记忆库 system 注入文本
  function buildMemorySystemText() {
    if (!state.memories || state.memories.length === 0) return '';
    // 最近 30 条，避免上下文过长
    const recent = state.memories.slice(-30);
    return '\n\n[记忆库 - 你需要记住并引用这些信息]\n' + recent.map((m, i) => `${i + 1}. ${m.content}`).join('\n');
  }

  async function regenerateLast() {
    if (isGenerating) { toast('正在生成中'); return; }
    const msgs = curMessages();
    if (msgs.length === 0) return;
    let lastUserIdx = -1;
    for (let i = msgs.length - 1; i >= 0; i--) if (msgs[i].role === 'user') { lastUserIdx = i; break; }
    if (lastUserIdx < 0) { toast('没有可重新生成的对话'); return; }
    const userMsg = msgs[lastUserIdx];
    curSession().messages = msgs.slice(0, lastUserIdx + 1);
    renderMessages(); saveAll();
    isGenerating = true; updateSendBtn();
    const roles = activeRoles();
    let context = userMsg.text || '';
    if (userMsg.file) context += `\n[用户发送了文件: ${userMsg.file.name}]`;
    if (userMsg.image) context += `\n[用户发送了一张图片]`;
    for (let i = 0; i < roles.length; i++) await generateRoleReply(roles[i], roles, context, userMsg, i, curMessages());
    isGenerating = false; updateSendBtn(); saveAll();
  }
  function clearChat() {
    if (curMessages().length === 0) { toast('已经是空对话'); return; }
    if (!confirm('清空当前对话？')) return;
    curSession().messages = []; curSession().title = '新对话';
    saveAll(); renderMessages(); updateSessionTitle();
  }

  // ===== 附件处理 =====
  let pendingMomentImgs = [];
  function handleFile(file) {
    if (!file) return;
    if (file.size > 50 * 1024 * 1024) { toast('文件过大（限50MB）'); return; }
    const textExts = /\.(txt|md|json|js|ts|py|html|css|xml|yml|yaml|csv|java|c|cpp|h|go|rs|rb|php|sh|sql|log|ini|toml)$/i;
    const isText = file.type.startsWith('text/') || textExts.test(file.name);
    if (isText) {
      const r = new FileReader();
      r.onload = () => { pendingAttach = { type: 'file', name: file.name, size: file.size, content: String(r.result || '') }; showAttachPreview(); };
      r.readAsText(file);
    } else { pendingAttach = { type: 'file', name: file.name, size: file.size, content: '' }; showAttachPreview(); }
  }
  function handleImage(file) {
    if (!file) return;
    if (file.size > 50 * 1024 * 1024) { toast('图片过大（限50MB）'); return; }
    const r = new FileReader();
    r.onload = () => { pendingAttach = { type: 'image', name: file.name, size: file.size, data: String(r.result || '') }; showAttachPreview(); };
    r.readAsDataURL(file);
  }
  function showAttachPreview() {
    const box = $('attach-preview'); if (!pendingAttach) { box.style.display = 'none'; return; }
    const icon = $('ap-icon'), name = $('ap-name'), thumb = $('ap-thumb');
    if (pendingAttach.type === 'image') { icon.style.display = 'none'; thumb.src = pendingAttach.data; thumb.style.display = ''; name.textContent = pendingAttach.name; }
    else { thumb.style.display = 'none'; thumb.src = ''; icon.textContent = '📎'; icon.style.display = ''; name.textContent = pendingAttach.name; }
    box.style.display = ''; updateSendBtn();
  }
  function clearAttachPreview() { pendingAttach = null; $('attach-preview').style.display = 'none'; $('ap-thumb').src = ''; $('ap-thumb').style.display = 'none'; updateSendBtn(); }
  function togglePlusMenu() { const m = $('plus-menu'), b = $('plus-btn'); const open = m.classList.toggle('show'); b.classList.toggle('open', open); }
  function closePlusMenu() { $('plus-menu').classList.remove('show'); $('plus-btn').classList.remove('open'); }

  // 头像上传（用户/角色）
  function uploadAvatar(target, roleId) {
    const input = document.createElement('input');
    input.type = 'file'; input.accept = 'image/*';
    input.onchange = e => {
      const file = e.target.files[0]; if (!file) return;
      if (file.size > 20 * 1024 * 1024) { toast('图片过大（限20MB）'); return; }
      const r = new FileReader();
      r.onload = async () => {
        // 压缩头像：限制最大边 256px，PNG 保留透明度，避免 localStorage 超限导致丢失
        const data = await compressImage(String(r.result || ''), 256, 'image/png');
        if (target === 'user') { state.profile.avatarImg = data; }
        else if (target === 'role') { const role = getRole(roleId); if (role) role.avatarImg = data; }
        const ok = saveAll();
        if (!ok) { toast('存储空间不足，头像可能无法保存'); }
        if (target === 'user') { renderMe(); }
        if (target === 'role') { renderRoleBar(); closeSheet('role-sheet-overlay'); }
        toast('头像已更新');
      };
      r.readAsDataURL(file);
    };
    input.click();
  }
  function clearAvatar(target, roleId) {
    if (target === 'user') state.profile.avatarImg = '';
    else if (target === 'role') { const r = getRole(roleId); if (r) r.avatarImg = ''; }
    saveAll();
    if (target === 'user') renderMe();
    if (target === 'role') { renderRoleBar(); closeSheet('role-sheet-overlay'); }
  }

  // ===== 角色管理 =====
  function openRolesList() {
    const body = $('roles-list-body'); body.innerHTML = '';
    state.roles.forEach(r => {
      const item = el('div', 'role-list-item' + (state.activeRoleIds.includes(r.id) ? ' active' : ''));
      item.innerHTML = `
        <div class="rli-avatar">${r.avatarImg ? `<img src="${escapeHtml(r.avatarImg)}" class="avatar-img">` : escapeHtml(r.avatar)}</div>
        <div class="rli-info"><div class="rli-name">${escapeHtml(r.name)}</div><div class="rli-desc">${escapeHtml(r.desc || '')}</div></div>
        <div class="rli-check">${state.activeRoleIds.includes(r.id) ? '✓' : ''}</div>`;
      item.addEventListener('click', () => {
        const idx = state.activeRoleIds.indexOf(r.id);
        if (idx >= 0) { if (state.activeRoleIds.length <= 1) { toast('至少保留一个角色'); return; } state.activeRoleIds.splice(idx, 1); }
        else state.activeRoleIds.push(r.id);
        saveAll(); openRolesList(); renderRoleBar();
      });
      let pressT;
      item.addEventListener('touchstart', () => { pressT = setTimeout(() => openRoleSheet(r), 600); });
      item.addEventListener('touchend', () => clearTimeout(pressT));
      body.appendChild(item);
    });
    openSheet('roles-list-overlay');
  }
  function openRoleSheet(role) {
    $('role-sheet-title').textContent = role ? '编辑角色' : '新建角色';
    $('rf-avatar').value = role ? role.avatar : '';
    const emojiEl = $('rf-avatar-emoji');
    if (emojiEl) emojiEl.textContent = role?.avatar || '🤖';
    $('rf-avatar-img').src = role?.avatarImg || ''; $('rf-avatar-img').style.display = role?.avatarImg ? '' : 'none';
    if (emojiEl) emojiEl.style.display = role?.avatarImg ? 'none' : '';
    $('rf-avatar-upload').dataset.roleId = role ? role.id : '';
    $('rf-name').value = role ? role.name : '';
    $('rf-desc').value = role ? (role.desc || '') : '';
    $('rf-prompt').value = role ? role.prompt : '';
    $('rf-delete').style.display = role ? '' : 'none';
    $('rf-delete').dataset.id = role ? role.id : '';
    closeSheet('roles-list-overlay'); openSheet('role-sheet-overlay');
  }
  function saveRole() {
    const name = $('rf-name').value.trim();
    if (!name) { toast('请输入角色名'); return; }
    const delId = $('rf-delete').dataset.id;
    if (delId) {
      const r = getRole(delId); if (r) {
        r.avatar = $('rf-avatar').value.trim() || '🤖';
        // 保留已有 avatarImg，不被覆盖
        r.name = name; r.desc = $('rf-desc').value.trim(); r.prompt = $('rf-prompt').value.trim();
      }
    } else {
      const id = 'r' + Date.now();
      state.roles.push({ id, avatar: $('rf-avatar').value.trim() || '🤖', avatarImg: '', name, desc: $('rf-desc').value.trim(), prompt: $('rf-prompt').value.trim() });
      state.activeRoleIds.push(id);
    }
    saveAll(); closeSheet('role-sheet-overlay'); renderRoleBar(); toast('已保存');
  }
  function deleteRole() {
    const id = $('rf-delete').dataset.id; if (!id) return;
    if (state.roles.length <= 1) { toast('至少保留一个角色'); return; }
    if (!confirm('删除该角色？')) return;
    state.roles = state.roles.filter(r => r.id !== id);
    state.activeRoleIds = state.activeRoleIds.filter(x => x !== id);
    saveAll(); closeSheet('role-sheet-overlay'); renderRoleBar(); toast('已删除');
  }

  // ===== 角色卡统一解析（兼容 SillyTavern chara_card_v2/v3、tavo、普通JSON、PNG）=====
  function parseCharacterCard(raw) {
    // 1. 解包：chara_card_v3 标准格式 { spec, data: { ... } }
    const card = (raw && raw.data) ? raw.data : raw;
    // 2. 再解一层：某些卡是 { data: { data: {...} } }
    const src = (card && card.data && (card.data.name || card.data.system_prompt)) ? card.data : card;
    const top = raw || {};

    // 名字
    const name = src.name || src.char_name || top.name || top.nickname || '导入角色';

    // 系统提示词：优先级 system_prompt > system > prompt > character.prompt
    let prompt = src.system_prompt || src.system || src.prompt || (src.character && src.character.prompt) || '';
    if (!prompt) {
      // 没有显式提示词时，用 description + personality + scenario 拼接
      const parts = [src.description, src.personality, src.scenario].filter(Boolean);
      prompt = parts.length ? ('你是' + name + '。\n\n' + parts.join('\n\n')) : ('你是' + name + '。');
    }

    // 简介
    const desc = (src.description || src.desc || '').slice(0, 50) || name;

    // 头像（emoji 或 data: 图片）
    const avatar = src.avatar || '🤖';

    // 开场白
    const firstMes = src.first_mes || (src.alternate_greetings && src.alternate_greetings[0]) || '';

    // 世界书（SillyTavern: extensions.world 数组；tavo: world 数组）
    const world = (src.extensions && src.extensions.world) || src.world || [];

    return { name, prompt, desc, avatar, firstMes, world };
  }

  // 酒馆角色卡导入（JSON / PNG / chara_card_v2/v3）
  function importTavernCard() {
    const input = document.createElement('input');
    input.type = 'file'; input.accept = '.json,.png,.card';
    input.onchange = e => {
      const file = e.target.files[0]; if (!file) return;
      const reader = new FileReader();
      reader.onload = () => {
        try {
          let raw;
          if (file.name.toLowerCase().endsWith('.png')) {
            raw = extractPngCard(reader.result); // PNG tEXt chunk 提取
          } else {
            raw = JSON.parse(reader.result);
          }
          const card = parseCharacterCard(raw);
          const id = 'r' + Date.now();
          state.roles.push({
            id,
            avatar: (typeof card.avatar === 'string' && card.avatar.length < 4) ? card.avatar : '🤖',
            avatarImg: (typeof card.avatar === 'string' && card.avatar.startsWith('data:')) ? card.avatar : '',
            name: card.name,
            desc: card.desc,
            prompt: card.prompt,
            firstMes: card.firstMes
          });
          state.activeRoleIds.push(id);

          // 导入世界书到提示词库分组（如存在）
          if (card.world && card.world.length > 0) {
            if (!state.promptLib.groups) state.promptLib.groups = { regex: [], worldbook: [], preset: [] };
            if (!state.promptLib.groups.worldbook) state.promptLib.groups.worldbook = [];
            const wbItems = card.world.map((w, i) => {
              const keys = Array.isArray(w.key) ? w.key : (w.keys || []);
              return {
                name: w.comment || w.name || ('世界书' + (i + 1)),
                active: !(w.disable === true || w.disabled === true),
                keyword: Array.isArray(keys) ? keys.join(',') : String(keys || ''),
                content: w.content || w.text || '',
                desc: (w.content || w.text || '').slice(0, 50)
              };
            });
            state.promptLib.groups.worldbook.push({
              id: 'g' + Date.now(),
              name: card.name + '·世界书',
              source: '角色卡:' + card.name,
              importedAt: new Date().toISOString(),
              expanded: false,
              items: wbItems
            });
            toast('已导入 ' + wbItems.length + ' 条世界书（分组：' + card.name + '·世界书）');
          }
          saveAll(); renderRoleBar(); openRolesList(); toast('已导入角色：' + card.name);
        } catch (err) { toast('导入失败：' + err.message); }
      };
      if (file.name.toLowerCase().endsWith('.png')) reader.readAsArrayBuffer(file);
      else reader.readAsText(file);
    };
    input.click();
  }
  function extractPngCard(buf) {
    // 简单提取 PNG tEXt/iTXt 中的 chara 字段（base64 JSON）
    try {
      const bytes = new Uint8Array(buf); let str = '';
      for (let i = 0; i < bytes.length; i++) str += String.fromCharCode(bytes[i]);
      const m = str.match(/chara[:\x00]*([A-Za-z0-9+/=]+)/);
      if (m) { return JSON.parse(decodeURIComponent(escape(atob(m[1])))); }
      const m2 = str.match(/chara["\s:]+([A-Za-z0-9+/=]+)/);
      if (m2) return JSON.parse(decodeURIComponent(escape(atob(m2[1]))));
      return {};
    } catch { return {}; }
  }

  // tavo 角色导入（复用统一解析，兼容 tavo / 酒馆 / 普通 JSON）
  function importTavoRole() {
    const input = document.createElement('input');
    input.type = 'file'; input.accept = '.json';
    input.onchange = e => {
      const file = e.target.files[0]; if (!file) return;
      const reader = new FileReader();
      reader.onload = () => {
        try {
          const raw = JSON.parse(reader.result);
          const card = parseCharacterCard(raw);
          const id = 'r' + Date.now();
          state.roles.push({
            id,
            avatar: (typeof card.avatar === 'string' && card.avatar.length < 4) ? card.avatar : '🤖',
            avatarImg: '',
            name: card.name,
            desc: card.desc,
            prompt: card.prompt,
            firstMes: card.firstMes
          });
          state.activeRoleIds.push(id);
          saveAll(); renderRoleBar(); openRolesList(); toast('已导入角色：' + card.name);
        } catch (err) { toast('导入失败：' + err.message); }
      };
      reader.readAsText(file);
    };
    input.click();
  }

  // ===== 提示词库（正则/世界书/预设）=====
  // 合并散条 + 各分组 items，供注入逻辑统一使用
  function collectAllItems(type) {
    const arr = state.promptLib[type] || [];
    const groups = (state.promptLib.groups && state.promptLib.groups[type]) || [];
    const out = arr.slice();
    groups.forEach(g => { if (g.items) out.push(...g.items); });
    return out;
  }
  function renderPromptLib() {
    const switchEl = $('pl-switch'); if (switchEl) switchEl.checked = state.settings.promptLibOn;
    ['regex', 'worldbook', 'preset'].forEach(type => {
      const list = $('pl-' + type + '-list'); if (!list) return;
      list.innerHTML = '';
      const groups = (state.promptLib.groups && state.promptLib.groups[type]) || [];
      const loose = state.promptLib[type] || [];
      const total = groups.reduce((s, g) => s + (g.items ? g.items.length : 0), 0) + loose.length;
      if (total === 0) { list.innerHTML = '<div class="pl-empty">暂无，点击下方导入</div>'; return; }

      // 分组卡片
      groups.forEach((g, gi) => {
        const items = g.items || [];
        const activeCount = items.filter(i => i.active).length;
        const card = el('div', 'pl-group' + (g.expanded ? ' expanded' : ''));
        const head = el('div', 'pl-group-head');
        head.innerHTML = `<span class="pl-group-arrow">${g.expanded ? '▾' : '▸'}</span>
          <span class="pl-group-icon">📦</span>
          <span class="pl-group-name">${escapeHtml(g.name)}</span>
          <span class="pl-group-count">${items.length} 项 · 启用 ${activeCount}</span>
          <button class="pl-group-del" data-act="del-group" title="删除整个分组">×</button>`;
        head.addEventListener('click', e => {
          if (e.target.classList.contains('pl-group-del')) return;
          g.expanded = !g.expanded; DB.set('promptLib', state.promptLib); renderPromptLib();
        });
        head.querySelector('.pl-group-del').addEventListener('click', e => {
          e.stopPropagation();
          if (!confirm('删除整个分组「' + g.name + '」？分组内 ' + items.length + ' 项将一并删除。')) return;
          state.promptLib.groups[type].splice(gi, 1);
          saveAll(); renderPromptLib(); toast('已删除分组');
        });
        card.appendChild(head);

        // 展开后的子条目
        if (g.expanded) {
          const body = el('div', 'pl-group-body');
          if (items.length === 0) {
            body.innerHTML = '<div class="pl-empty">空分组</div>';
          } else {
            items.forEach((item, ii) => {
              const row = el('div', 'pl-item pl-sub-item');
              const onBadge = item.active ? '<span class="pl-on">启用中</span>' : '';
              row.innerHTML = `<div class="pl-name">${escapeHtml(item.name)} ${onBadge}</div><div class="pl-desc">${escapeHtml(item.desc || item.content?.slice(0, 50) || '')}</div>`;
              row.addEventListener('click', () => openPromptItemSheet(type, ii, g.id));
              body.appendChild(row);
            });
          }
          card.appendChild(body);
        }
        list.appendChild(card);
      });

      // 散条区（手动新建或旧数据）
      if (loose.length > 0) {
        const looseHead = el('div', 'pl-loose-head');
        looseHead.innerHTML = '<span class="pl-group-icon">📄</span><span>其他条目</span><span class="pl-group-count">' + loose.length + ' 项</span>';
        list.appendChild(looseHead);
        loose.forEach((item, idx) => {
          const row = el('div', 'pl-item');
          const onBadge = item.active ? '<span class="pl-on">启用中</span>' : '';
          row.innerHTML = `<div class="pl-name">${escapeHtml(item.name)} ${onBadge}</div><div class="pl-desc">${escapeHtml(item.desc || item.content?.slice(0, 50) || '')}</div>`;
          row.addEventListener('click', () => openPromptItemSheet(type, idx, null));
          list.appendChild(row);
        });
      }
    });
  }
  function openPromptItemSheet(type, idx, groupId) {
    let item;
    if (groupId) {
      const g = (state.promptLib.groups[type] || []).find(x => x.id === groupId);
      const arr = g ? g.items : [];
      item = (idx >= 0 && arr[idx]) ? arr[idx] : { name: '', content: '', active: false, keyword: '', pattern: '', replacement: '' };
    } else {
      const arr = state.promptLib[type];
      item = idx >= 0 ? arr[idx] : { name: '', content: '', active: false, keyword: '', pattern: '', replacement: '' };
    }
    $('pl-item-title').textContent = idx >= 0 ? '编辑' : '新建';
    $('pl-item-type').value = type;
    $('pl-item-idx').value = idx;
    $('pl-item-group').value = groupId || '';
    $('pl-item-name').value = item.name || '';
    $('pl-item-content').value = item.content || '';
    $('pl-item-keyword').value = item.keyword || '';
    $('pl-item-pattern').value = item.pattern || '';
    $('pl-item-replacement').value = item.replacement || '';
    $('pl-item-active').checked = item.active || false;
    // 显示对应字段
    $('pl-field-keyword').style.display = type === 'worldbook' ? '' : 'none';
    $('pl-field-pattern').style.display = type === 'regex' ? '' : 'none';
    $('pl-field-replacement').style.display = type === 'regex' ? '' : 'none';
    $('pl-item-delete').style.display = idx >= 0 ? '' : 'none';
    openSheet('pl-item-overlay');
  }
  function savePromptItem() {
    const type = $('pl-item-type').value;
    const idx = parseInt($('pl-item-idx').value);
    const groupId = $('pl-item-group').value;
    const item = {
      name: $('pl-item-name').value.trim() || '未命名',
      content: $('pl-item-content').value,
      active: $('pl-item-active').checked,
      keyword: $('pl-item-keyword').value,
      pattern: $('pl-item-pattern').value,
      replacement: $('pl-item-replacement').value,
      desc: $('pl-item-content').value.slice(0, 50)
    };
    if (groupId) {
      const g = (state.promptLib.groups[type] || []).find(x => x.id === groupId);
      if (g) {
        if (idx >= 0) g.items[idx] = item;
        else g.items.push(item);
      }
    } else {
      if (idx >= 0) state.promptLib[type][idx] = item;
      else state.promptLib[type].push(item);
    }
    saveAll(); closeSheet('pl-item-overlay'); renderPromptLib(); toast('已保存');
  }
  function deletePromptItem() {
    const type = $('pl-item-type').value; const idx = parseInt($('pl-item-idx').value);
    const groupId = $('pl-item-group').value;
    if (groupId) {
      const g = (state.promptLib.groups[type] || []).find(x => x.id === groupId);
      if (g && idx >= 0) g.items.splice(idx, 1);
    } else {
      if (idx >= 0) state.promptLib[type].splice(idx, 1);
    }
    saveAll(); closeSheet('pl-item-overlay'); renderPromptLib();
  }
  function importPromptLib(type) {
    const input = document.createElement('input');
    input.type = 'file'; input.accept = '.json,.txt';
    input.onchange = e => {
      const file = e.target.files[0]; if (!file) return;
      const r = new FileReader();
      r.onload = () => {
        try {
          let data = JSON.parse(r.result);
          // 兼容多种导出格式：
          // - SillyTavern 预设：{ prompts: [...], prompt_order: [...] }
          // - SillyTavern 世界书：{ entries: { "0": {...} } }
          // - 数组 / 单对象
          let items;
          // 预设专属：构建 identifier → enabled 映射（来自 prompt_order）
          let promptOrderMap = null;
          if (Array.isArray(data)) items = data;
          else if (data.prompts) {
            items = data.prompts;                       // SillyTavern 预设
            // 解析 prompt_order：[{ order: [ { identifier, enabled }, ... ] }]
            if (Array.isArray(data.prompt_order) && data.prompt_order.length) {
              promptOrderMap = {};
              (data.prompt_order[0].order || []).forEach(o => {
                if (o && o.identifier) promptOrderMap[o.identifier] = (o.enabled !== false);
              });
            }
          }
          else if (data.entries) items = Object.values(data.entries);
          else if (data.originalData && data.originalData.entries) items = Object.values(data.originalData.entries);
          else items = [data];
          let importedItems = [];
          items.forEach(it => {
            if (!it || typeof it !== 'object') return;
            // 正则 pattern：兼容 findRegex(驼峰)/find_regex
            // scriptName 仅当无 replaceString 时才作 pattern（有 replaceString 说明是正则对象，scriptName 只是名字）
            let pattern = it.pattern || it.findRegex || it.find_regex || '';
            if (it.scriptName && (it.replaceString !== undefined || it.replaceString !== null)) {
              // 有 replaceString 说明是正则对象，scriptName 只是名字不是 pattern
            }
            const keyArr = Array.isArray(it.key) ? it.key : (Array.isArray(it.keys) ? it.keys : null);

            // ===== 启用状态：尊重原文件设定，不要全部强制开启 =====
            // 1. 预设：优先用 prompt_order 的 enabled 字段（SillyTavern 实际控制开关的地方）
            // 2. 正则：用 disabled 字段（SillyTavern 正则导出字段名）
            // 3. 世界书：用 disable 字段（SillyTavern 世界书导出字段名），兼容 disabled
            // 4. 兜底：若以上都没声明，默认启用
            let active;
            if (promptOrderMap && it.identifier && (it.identifier in promptOrderMap)) {
              // 预设走 prompt_order 映射
              active = promptOrderMap[it.identifier] === true;
            } else if (it.disabled === true || it.disable === true) {
              // 显式禁用
              active = false;
            } else if (it.enabled === false) {
              // 通用 enabled: false
              active = false;
            } else {
              // 兜底：默认启用
              active = true;
            }

            const item = {
              name: it.name || it.comment || (keyArr ? keyArr.join(',') : (it.key || it.keys || '')) || ('导入项' + (importedItems.length + 1)),
              content: it.content || it.prompt || it.text || it.entry || '',
              active: active,
              keyword: it.keyword || (keyArr ? keyArr.join(',') : (it.key || it.keys || '')) || (it.keysecondary ? (Array.isArray(it.keysecondary) ? it.keysecondary.join(',') : it.keysecondary) : '') || '',
              keys: it.keys,
              key: it.key,
              constant: it.constant,
              pattern: pattern,
              replacement: it.replacement != null ? it.replacement : (it.replaceString != null ? it.replaceString : it.replace_string),
              desc: (it.content || it.prompt || it.text || '').slice(0, 50)
            };
            // 跳过完全空的条目（marker 占位符如 worldInfoBefore/personaDescription 无内容）
            if (!item.content && !item.pattern) return;
            importedItems.push(item);
          });

          if (importedItems.length > 0) {
            // 创建分组
            const baseName = file.name.replace(/\.[^.]+$/, '');
            const groupName = baseName || (type === 'regex' ? '正则集合' : type === 'worldbook' ? '世界书集合' : '预设集合');
            const group = {
              id: 'g' + Date.now(),
              name: groupName,
              source: file.name,
              importedAt: new Date().toISOString(),
              expanded: true, // 导入后默认展开
              items: importedItems
            };
            if (!state.promptLib.groups) state.promptLib.groups = { regex: [], worldbook: [], preset: [] };
            if (!state.promptLib.groups[type]) state.promptLib.groups[type] = [];
            state.promptLib.groups[type].push(group);
            saveAll(); renderPromptLib();
            toast('已导入分组「' + groupName + '」(' + importedItems.length + ' 项)');
            closeSheet('pl-item-overlay');
          } else {
            toast('未识别到有效条目，请检查文件格式');
          }
        } catch (err) { toast('导入失败：' + err.message); }
      };
      r.onerror = () => toast('读取文件失败');
      r.readAsText(file);
    };
    input.click();
  }

  // ===== 我的 =====
  function renderMe() {
    const av = $('me-avatar-2'); if (av) av.innerHTML = state.profile.avatarImg ? `<img src="${escapeHtml(state.profile.avatarImg)}" class="avatar-img">` : escapeHtml(state.profile.avatar);
    const nm = $('me-name-2'); if (nm) nm.textContent = state.profile.name;
    const id = $('me-id'); if (id) id.textContent = state.profile.id;
    const mm = $('ms-moments'); if (mm) mm.textContent = state.moments.length;
    const mt = $('ms-tasks'); if (mt) mt.textContent = state.tasks.filter(t => !t.done).length;
    const mc = $('ms-chats'); if (mc) mc.textContent = state.sessions.reduce((s, x) => s + x.messages.filter(m => m.role === 'user').length, 0);
  }
  // ===== API 配置（多模型配置管理）=====
  function currentApiConfig() {
    const list = state.settings.apiConfigs || [];
    return list.find(c => c.id === state.settings.currentApiConfigId) || list[0] || null;
  }
  function renderApiConfigSelector() {
    const list = state.settings.apiConfigs || [];
    const cur = currentApiConfig();
    const curName = $('acs-current-name');
    if (curName) curName.textContent = cur ? cur.name : '默认配置';
    const dropdown = $('acs-dropdown');
    if (!dropdown) return;
    dropdown.innerHTML = '';
    if (list.length === 0) {
      dropdown.innerHTML = '<div class="acs-empty">暂无配置，点击右上角「+ 新建」</div>';
      return;
    }
    list.forEach(c => {
      const opt = el('div', 'acs-option' + (cur && c.id === cur.id ? ' active' : ''));
      opt.innerHTML = `
        <span class="acs-opt-name">${escapeHtml(c.name || '未命名')}</span>
        <span class="acs-opt-model">${escapeHtml(c.model || '')}</span>
        ${cur && c.id === cur.id ? '<span class="acs-opt-check">✓</span>' : ''}
        <button class="acs-opt-del" data-id="${c.id}" type="button" title="删除">×</button>`;
      // 点击选项（除删除按钮外）：切换到该配置
      opt.addEventListener('click', e => {
        if (e.target.classList.contains('acs-opt-del')) return;
        switchApiConfig(c.id);
      });
      dropdown.appendChild(opt);
    });
    dropdown.querySelectorAll('.acs-opt-del').forEach(b => b.addEventListener('click', e => {
      e.stopPropagation();
      deleteApiConfig(b.dataset.id);
    }));
  }
  // 把表单值写回当前选中配置 + 顶层 settings
  function writeFormToCurrentConfig() {
    const cfg = currentApiConfig();
    if (!cfg) return;
    cfg.name = $('set-config-name').value.trim() || '未命名配置';
    cfg.endpoint = $('set-endpoint').value.trim();
    cfg.apikey = $('set-apikey').value.trim();
    cfg.model = $('set-model').value.trim() || 'gpt-4o-mini';
    cfg.stream = $('set-stream').checked;
    cfg.reasoning = $('set-reasoning').checked;
    cfg.reasoningLevel = parseInt($('set-reasoning-level').value) || 3;
    cfg.reasoningShow = $('set-reasoning-show').checked;
    cfg.webSearch = $('set-websearch').checked;
    // 顶层 settings 同步
    syncCurrentApiConfigToSettings();
    // 通用参数（不属于单个配置）
    state.settings.memory = parseInt($('set-memory').value) || 12;
    state.settings.temp = parseFloat($('set-temp').value) || 0.7;
  }
  // 从指定配置读取并回填表单
  function loadConfigToForm(cfg) {
    if (!cfg) return;
    $('set-config-name').value = cfg.name || '';
    $('set-endpoint').value = cfg.endpoint || '';
    $('set-apikey').value = cfg.apikey || '';
    $('set-model').value = cfg.model || '';
    $('set-stream').checked = cfg.stream !== false;
    $('set-reasoning').checked = !!cfg.reasoning;
    $('set-reasoning-level').value = String(cfg.reasoningLevel || 3);
    $('set-reasoning-show').checked = !!cfg.reasoningShow;
    $('set-websearch').checked = !!cfg.webSearch;
    // 通用参数
    $('set-memory').value = state.settings.memory || 12;
    $('set-temp').value = state.settings.temp ?? 0.7;
    // 重置测试连接状态
    const testBtn = $('api-test-btn'); if (testBtn) { testBtn.classList.remove('testing', 'success', 'fail'); }
    const status = $('api-test-status'); if (status) status.textContent = '';
    // 删除按钮：默认配置不可删
    const delBtn = $('api-delete-btn');
    if (delBtn) delBtn.style.display = (state.settings.apiConfigs.length <= 1) ? 'none' : '';
    // 关闭模型列表
    const ml = $('models-list'); if (ml) { ml.style.display = 'none'; ml.innerHTML = ''; }
  }
  function switchApiConfig(id) {
    // 先保存当前表单到旧配置
    writeFormToCurrentConfig();
    const cfg = (state.settings.apiConfigs || []).find(c => c.id === id);
    if (!cfg) return;
    state.settings.currentApiConfigId = id;
    syncCurrentApiConfigToSettings();
    loadConfigToForm(cfg);
    renderApiConfigSelector();
    saveAll();
    // 关闭下拉
    $('api-config-selector')?.classList.remove('open');
    toast('已切换到：' + (cfg.name || '未命名'));
  }
  function newApiConfig() {
    // 先保存当前表单到旧配置
    writeFormToCurrentConfig();
    const id = 'cfg_' + Date.now();
    const cfg = {
      id, name: '新配置 ' + (state.settings.apiConfigs.length + 1),
      endpoint: '', apikey: '', model: 'gpt-4o-mini',
      stream: true, reasoning: false, reasoningLevel: 3, reasoningShow: false, webSearch: false
    };
    state.settings.apiConfigs.push(cfg);
    state.settings.currentApiConfigId = id;
    loadConfigToForm(cfg);
    renderApiConfigSelector();
    saveAll();
    $('api-config-selector')?.classList.remove('open');
    toast('已新建配置');
    // 焦点到名称输入框方便编辑
    setTimeout(() => $('set-config-name')?.focus(), 100);
  }
  function deleteApiConfig(id) {
    const list = state.settings.apiConfigs || [];
    if (list.length <= 1) { toast('至少保留一个配置'); return; }
    if (!confirm('确定删除此配置？')) return;
    const idx = list.findIndex(c => c.id === id);
    if (idx < 0) return;
    const removedActive = id === state.settings.currentApiConfigId;
    list.splice(idx, 1);
    if (removedActive) {
      state.settings.currentApiConfigId = list[0].id;
      syncCurrentApiConfigToSettings();
      loadConfigToForm(list[0]);
    }
    renderApiConfigSelector();
    saveAll();
    toast('已删除');
  }
  function openApiSheet() {
    const cfg = currentApiConfig();
    if (cfg) loadConfigToForm(cfg);
    renderApiConfigSelector();
    $('api-config-selector')?.classList.remove('open');
    openSheet('api-sheet-overlay');
  }
  // ===== 下载安卓 App =====
  let _deferredPrompt = null;
  window.addEventListener('beforeinstallprompt', e => {
    e.preventDefault();
    _deferredPrompt = e;
  });
  function openAndroidSheet() {
    // 填充站点地址
    const urlInput = $('dl-site-url');
    if (urlInput) urlInput.value = location.href;
    // 填充 API 信息（兼容 OpenAI 协议提示）
    const cfg = currentApiConfig();
    const epEl = $('dl-api-endpoint');
    const mdEl = $('dl-api-model');
    if (cfg && cfg.endpoint) {
      const ep = cfg.endpoint.replace(/\/$/, '');
      if (epEl) epEl.textContent = ep + '/chat/completions';
      if (mdEl) mdEl.textContent = cfg.model || 'gpt-4o-mini';
    } else {
      if (epEl) epEl.textContent = '请在「API 配置」中先填写';
      if (mdEl) mdEl.textContent = '未配置';
    }
    // 安装按钮状态
    const hint = $('dl-install-hint');
    const installBtn = $('dl-install-pwa');
    if (_deferredPrompt) {
      if (installBtn) installBtn.disabled = false;
      if (hint) hint.textContent = '本浏览器支持一键安装';
    } else {
      if (installBtn) installBtn.disabled = false;
      if (hint) hint.textContent = '若按钮无效，请用浏览器菜单「添加到主屏幕」';
    }
    openSheet('android-sheet-overlay');
  }
  function triggerPwaInstall() {
    if (_deferredPrompt) {
      _deferredPrompt.prompt();
      _deferredPrompt.userChoice?.finally(() => { _deferredPrompt = null; });
    } else {
      // iOS Safari / 不支持 beforeinstallprompt 的浏览器：引导用户用菜单
      const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent);
      toast(isIOS ? '请点 Safari 分享按钮 → 添加到主屏幕' : '请用浏览器菜单 → 添加到主屏幕');
    }
  }
  function saveApi() {
    writeFormToCurrentConfig();
    saveAll(); closeSheet('api-sheet-overlay'); toast('已保存');
  }
  async function testApiConnection() {
    // 先把当前表单写回，保证测试的是最新输入
    writeFormToCurrentConfig();
    const cfg = currentApiConfig();
    if (!cfg) { toast('没有可测试的配置'); return; }
    if (!cfg.endpoint) { toast('请先填写接口地址'); return; }
    if (!cfg.apikey) { toast('请先填写 API Key'); return; }
    const btn = $('api-test-btn'); const status = $('api-test-status');
    if (!btn || !status) return;
    btn.classList.remove('success', 'fail'); btn.classList.add('testing');
    status.textContent = '测试中...';
    const endpoint = cfg.endpoint.replace(/\/$/, '');
    const startedAt = Date.now();
    try {
      const res = await fetch(endpoint + '/models', { headers: { 'Authorization': 'Bearer ' + cfg.apikey } });
      const latency = Date.now() - startedAt;
      if (!res.ok) {
        const t = await res.text().catch(() => '');
        throw new Error('HTTP ' + res.status + (t ? ': ' + t.slice(0, 120) : ''));
      }
      const json = await res.json();
      const models = (json.data || json.models || json || []);
      const count = Array.isArray(models) ? models.length : 0;
      btn.classList.remove('testing'); btn.classList.add('success');
      status.textContent = '✓ 成功 · ' + count + ' 模型 · ' + latency + 'ms';
      toast('连接成功，共 ' + count + ' 个模型');
    } catch (err) {
      btn.classList.remove('testing'); btn.classList.add('fail');
      status.textContent = '✗ ' + (err.message || '失败').slice(0, 50);
      toast('连接失败');
    }
  }
  async function fetchModels() {
    const endpoint = $('set-endpoint').value.trim().replace(/\/$/, '');
    const apikey = $('set-apikey').value.trim();
    if (!endpoint) { toast('请先填写接口地址'); return; }
    if (!apikey) { toast('请先填写 API Key'); return; }
    const btn = $('fetch-models-btn'); const list = $('models-list');
    btn.disabled = true; btn.textContent = '拉取中...';
    list.innerHTML = '<div class="model-item" style="color:var(--text-secondary)">加载中...</div>'; list.style.display = '';
    try {
      const res = await fetch(endpoint + '/models', { headers: { 'Authorization': 'Bearer ' + apikey } });
      if (!res.ok) { const t = await res.text().catch(() => ''); throw new Error('HTTP ' + res.status + (t ? ': ' + t.slice(0, 120) : '')); }
      const json = await res.json();
      const models = (json.data || json.models || json || []).map(m => typeof m === 'string' ? m : (m.id || m.name)).filter(Boolean).sort();
      if (models.length === 0) { list.innerHTML = '<div class="model-item" style="color:var(--text-secondary)">未获取到模型</div>'; return; }
      const current = $('set-model').value.trim();
      list.innerHTML = '';
      models.forEach(id => {
        const item = el('div', 'model-item' + (id === current ? ' active' : ''));
        item.innerHTML = `<span>${escapeHtml(id)}</span><span class="mi-check">${id === current ? '✓' : ''}</span>`;
        item.addEventListener('click', () => {
          $('set-model').value = id;
          list.querySelectorAll('.model-item').forEach(x => { x.classList.remove('active'); x.querySelector('.mi-check').textContent = ''; });
          item.classList.add('active'); item.querySelector('.mi-check').textContent = '✓';
        });
        list.appendChild(item);
      });
      toast('已拉取 ' + models.length + ' 个模型');
    } catch (err) {
      list.innerHTML = '<div class="model-item" style="color:var(--danger)">拉取失败：' + escapeHtml(err.message || '错误') + '</div>';
      toast('拉取失败');
    } finally { btn.disabled = false; btn.textContent = '拉取'; }
  }

  // ===== Sheet =====
  function openSheet(id) { const o = $(id); if (o) o.classList.add('show'); }
  function closeSheet(id) { const o = $(id); if (o) o.classList.remove('show'); }
  function closeAllSheets() { document.querySelectorAll('.sheet-overlay.show').forEach(s => s.classList.remove('show')); }

  function autoResize() { const t = $('input'); t.style.height = 'auto'; t.style.height = Math.min(t.scrollHeight, 100) + 'px'; }

  function exportData() {
    const data = { profile: state.profile, roles: state.roles, sessions: state.sessions, moments: state.moments, tasks: state.tasks, promptLib: state.promptLib, outputs: state.outputs, settings: { ...state.settings, apikey: '' }, exportedAt: new Date().toISOString() };
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'mavis-backup-' + new Date().toISOString().slice(0, 10) + '.json'; a.click();
    URL.revokeObjectURL(a.href); toast('已导出');
  }
  function clearAll() {
    if (!confirm('确定清空所有数据？此操作不可恢复！')) return;
    if (!confirm('再次确认：所有对话、动态、任务、角色都将被删除！')) return;
    ['profile', 'roles', 'activeRoleIds', 'sessions', 'currentSessionId', 'moments', 'tasks', 'promptLib', 'outputs', 'settings', 'messages'].forEach(k => localStorage.removeItem('mavis_' + k));
    location.reload();
  }

  // 朋友圈图片选择
  function handleMomentImg(file) {
    if (!file) return;
    if (file.size > 30 * 1024 * 1024) { toast('图片过大（限30MB）'); return; }
    const r = new FileReader();
    r.onload = async () => {
      // 压缩朋友圈图片：最大边 1080px，JPEG 0.85，避免 localStorage 超限
      const data = await compressImage(String(r.result || ''), 1080, 'image/jpeg', 0.85);
      pendingMomentImgs.push(data); renderMomentThumbs();
    };
    r.readAsDataURL(file);
  }
  function renderMomentThumbs() {
    const box = $('mf-thumbs'); if (!box) return;
    box.innerHTML = '';
    pendingMomentImgs.forEach((src, i) => {
      const t = el('div', 'mf-thumb');
      t.innerHTML = `<img src="${escapeHtml(src)}"><button class="mf-thumb-del" data-idx="${i}">×</button>`;
      box.appendChild(t);
    });
    box.querySelectorAll('.mf-thumb-del').forEach(b => b.addEventListener('click', () => { pendingMomentImgs.splice(parseInt(b.dataset.idx), 1); renderMomentThumbs(); }));
  }

  // ===== Skill 技能库 =====
  // 内置热门 Skill（模拟开源市场热门）
  const BUILTIN_SKILLS = [
    { id: 'sk-code-review', icon: '🔍', name: '代码审查', desc: '自动审查代码，发现潜在问题和改进建议', prompt: '你是一个专业的代码审查员。当用户提交代码时，你需要：1) 检查语法错误和潜在 bug；2) 提供性能优化建议；3) 指出安全问题；4) 给出代码风格改进建议。用简洁分点的方式输出。', builtin: true, installed: false, auto: true },
    { id: 'sk-translator', icon: '🌐', name: '专业翻译', desc: '中英互译、多语言翻译，保留原意和风格', prompt: '你是一个专业的多语言翻译。能够在中文、英文、日文之间自然翻译。翻译时保留原文的语气、风格和专业术语，确保译文流畅自然，符合目标语言的表达习惯。', builtin: true, installed: false, auto: true },
    { id: 'sk-writer', icon: '✍️', name: '写作助手', desc: '文章润色、创意写作、文案生成', prompt: '你是一个资深的中文写作助手。能够帮助用户：1) 润色文章，使语言更流畅优美；2) 生成创意文案、营销文案；3) 调整文章结构和逻辑；4) 根据要求生成不同风格的文字。', builtin: true, installed: false, auto: true },
    { id: 'sk-sql', icon: '🗄️', name: 'SQL 专家', desc: 'SQL 查询优化、数据库设计建议', prompt: '你是一个 SQL 数据库专家。能够帮助用户：1) 编写和优化 SQL 查询；2) 设计合理的数据库表结构；3) 分析查询性能瓶颈；4) 提供索引和优化建议。', builtin: true, installed: false, auto: true },
    { id: 'sk-debugger', icon: '🐛', name: '调试专家', desc: '代码调试、错误分析、解决方案', prompt: '你是一个代码调试专家。当用户遇到错误时：1) 分析错误堆栈信息；2) 定位可能的问题根源；3) 提供修复方案和代码示例；4) 预防类似问题的建议。', builtin: true, installed: false, auto: true },
    { id: 'sk-marketing', icon: '📈', name: '营销文案', desc: '社交媒体文案、广告标语、品牌故事', prompt: '你是一个营销文案专家。能够为用户生成：1) 社交媒体帖子文案；2) 吸引人的广告标语；3) 品牌故事和slogan；4) 产品推广文案。风格多样，适合不同平台。', builtin: true, installed: false, auto: true },
    { id: 'sk-tutor', icon: '🎓', name: '学习导师', desc: '知识讲解、学习计划、练习建议', prompt: '你是一个耐心的学习导师。当用户提问时：1) 用通俗易懂的方式解释概念；2) 提供循序渐进的学习路径；3) 推荐练习题和案例；4) 鼓励用户并解答疑惑。', builtin: true, installed: false, auto: true },
    { id: 'sk-chef', icon: '🍳', name: '烹饪助手', desc: '食谱推荐、烹饪技巧、食材搭配', prompt: '你是一个烹饪专家。能够：1) 根据食材推荐菜谱；2) 讲解烹饪技巧和方法；3) 提供营养搭配建议；4) 解决烹饪中的问题。', builtin: true, installed: false, auto: false },
    { id: 'sk-finance', icon: '💰', name: '理财顾问', desc: '财务规划、投资建议、预算管理', prompt: '你是一个理财顾问。能够：1) 帮助用户制定预算计划；2) 分析理财方案的优劣；3) 提供投资建议（含风险提示）；4) 解答财务相关问题。', builtin: true, installed: false, auto: false },
    { id: 'sk-resume', icon: '📄', name: '简历优化', desc: '简历润色、面试辅导、职业规划', prompt: '你是一个职业规划顾问。能够：1) 优化简历内容和结构；2) 提供面试技巧和模拟问答；3) 分析职业发展路径；4) 帮助用户打造个人品牌。', builtin: true, installed: false, auto: false },
  ];

  function openSkillLibrary() {
    renderSkillMarket();
    renderSkillInstalled();
    openSheet('skill-sheet-overlay');
  }
  function renderSkillMarket(filter) {
    const list = $('skill-market-list'); if (!list) return;
    const q = (filter || $('skill-search')?.value || '').toLowerCase();
    list.innerHTML = '';
    BUILTIN_SKILLS.forEach(sk => {
      if (q && !(sk.name.toLowerCase().includes(q) || sk.desc.toLowerCase().includes(q))) return;
      const installed = (state.settings.installedSkills || []).some(s => s.id === sk.id);
      const item = el('div', 'skill-item' + (installed ? ' installed' : ''));
      item.dataset.skillId = sk.id;
      item.innerHTML = `
        <div class="sk-icon">${sk.icon}</div>
        <div class="sk-info">
          <div class="sk-name">${escapeHtml(sk.name)}${installed ? '<span class="sk-installed-badge">已装载</span>' : '<span class="sk-builtin-badge">官方</span>'}</div>
          <div class="sk-desc">${escapeHtml(sk.desc)}</div>
        </div>
        <div class="sk-actions">
          ${installed ? '<button class="sk-act" data-act="uninstall">卸载</button>' : '<button class="sk-act" data-act="install">装载</button>'}
        </div>`;
      list.appendChild(item);
    });
    if (list.children.length === 0) {
      list.innerHTML = '<div class="output-empty">未找到匹配的 Skill</div>';
    }
    list.querySelectorAll('.sk-act').forEach(b => b.addEventListener('click', e => {
      e.stopPropagation();
      const itemEl = b.closest('.skill-item');
      if (!itemEl) return;
      const skillId = itemEl.dataset.skillId;
      const skill = BUILTIN_SKILLS.find(s => s.id === skillId) || (state.settings.installedSkills || []).find(s => s.id === skillId);
      if (!skill) return;
      if (b.dataset.act === 'install') installSkill(skill, true);
      else uninstallSkill(skill.id);
    }));
  }
  function renderSkillInstalled() {
    const list = $('skill-installed-list'); if (!list) return;
    list.innerHTML = '';
    const installed = state.settings.installedSkills || [];
    if (installed.length === 0) {
      list.innerHTML = '<div class="output-empty"><div class="e-icon">📦</div>还没有装载的 Skill<br>去市场挑几个试试</div>';
      return;
    }
    installed.forEach(sk => {
      const item = el('div', 'skill-item');
      item.dataset.skillId = sk.id;
      item.innerHTML = `
        <div class="sk-icon">${escapeHtml(sk.icon || '🛠️')}</div>
        <div class="sk-info">
          <div class="sk-name">${escapeHtml(sk.name)}${sk.builtin ? '<span class="sk-builtin-badge">官方</span>' : ''}</div>
          <div class="sk-desc">${escapeHtml(sk.desc || '')}${sk.auto ? ' · 自动触发' : ''}</div>
        </div>
        <div class="sk-actions">
          <button class="sk-act danger" data-act="uninstall">卸载</button>
        </div>`;
      list.appendChild(item);
    });
    list.querySelectorAll('.sk-act').forEach(b => b.addEventListener('click', e => {
      e.stopPropagation();
      const itemEl = b.closest('.skill-item');
      if (!itemEl) return;
      const skillId = itemEl.dataset.skillId;
      const skill = (state.settings.installedSkills || []).find(s => s.id === skillId);
      if (skill) uninstallSkill(skill.id);
    }));
  }
  function installSkill(skill, isBuiltin) {
    if (!state.settings.installedSkills) state.settings.installedSkills = [];
    if (state.settings.installedSkills.some(s => s.id === skill.id)) { toast('已装载'); return; }
    const entry = isBuiltin
      ? { ...skill, installed: true, auto: true }
      : { ...skill, id: skill.id || ('sk' + Date.now()), installed: true, auto: true };
    state.settings.installedSkills.push(entry);
    saveAll();
    toast('已装载：' + skill.name);
    renderSkillMarket();
    renderSkillInstalled();
    updateSkillCount();
  }
  function uninstallSkill(id) {
    if (!confirm('卸载该 Skill？')) return;
    state.settings.installedSkills = (state.settings.installedSkills || []).filter(s => s.id !== id);
    saveAll(); toast('已卸载');
    renderSkillMarket(); renderSkillInstalled(); updateSkillCount();
  }
  function updateSkillCount() {
    const el2 = $('skill-count');
    if (el2) el2.textContent = (state.settings.installedSkills || []).length + ' 已装载';
  }
  function createCustomSkill() {
    const name = $('sk-name').value.trim();
    const icon = $('sk-icon').value.trim() || '🛠️';
    const desc = $('sk-desc').value.trim();
    const prompt = $('sk-prompt').value.trim();
    const auto = $('sk-auto').checked;
    if (!name || !prompt) { toast('名称和指令不能为空'); return; }
    const skill = { id: 'custom_' + Date.now(), icon, name, desc, prompt, auto, builtin: false, installed: true };
    if (!state.settings.installedSkills) state.settings.installedSkills = [];
    state.settings.installedSkills.push(skill);
    saveAll(); toast('Skill 已创建并装载');
    // 清空表单
    $('sk-name').value = ''; $('sk-icon').value = ''; $('sk-desc').value = ''; $('sk-prompt').value = '';
    renderSkillInstalled(); updateSkillCount();
    // 切换到已装载
    switchSkillTab('installed');
  }
  function importSkillFile() {
    const input = document.createElement('input');
    input.type = 'file'; input.accept = '.json';
    input.onchange = e => {
      const file = e.target.files[0]; if (!file) return;
      const r = new FileReader();
      r.onload = () => {
        try {
          const data = JSON.parse(r.result);
          const skills = Array.isArray(data) ? data : [data];
          skills.forEach(s => {
            const skill = {
              id: s.id || ('imp_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6)),
              icon: s.icon || '🛠️',
              name: s.name || '导入 Skill',
              desc: s.desc || '',
              prompt: s.prompt || s.content || '',
              auto: s.auto !== false,
              builtin: false,
              installed: true
            };
            if (!state.settings.installedSkills) state.settings.installedSkills = [];
            state.settings.installedSkills.push(skill);
          });
          saveAll(); toast('已导入 ' + skills.length + ' 个 Skill');
          renderSkillInstalled(); updateSkillCount();
          switchSkillTab('installed');
        } catch (err) { toast('导入失败：' + err.message); }
      };
      r.readAsText(file);
    };
    input.click();
  }
  function switchSkillTab(tab) {
    document.querySelectorAll('.skill-tab').forEach(t => t.classList.toggle('active', t.dataset.tab === tab));
    document.querySelectorAll('.skill-tab-content').forEach(c => c.style.display = 'none');
    const target = $('skill-' + tab); if (target) target.style.display = '';
    if (tab === 'market') renderSkillMarket();
    if (tab === 'installed') renderSkillInstalled();
  }
  // AI 生成 Skill：根据用户偏好自动创建
  async function aiGenerateSkill(userText) {
    if (!state.settings.apikey) return null;
    const roles = activeRoles(); if (roles.length === 0) return null;
    const poster = roles[Math.floor(Math.random() * roles.length)];
    const sysPrompt = poster.prompt + '\n\n用户经常提出某类需求，请分析并生成一个 Skill（系统提示词）来自动处理这类需求。Skill 包含：名称、图标(emoji)、描述、系统提示词。输出 JSON 格式：{"name":"...","icon":"...","desc":"...","prompt":"..."}';
    try {
      const txt = await callSimpleAPI(sysPrompt, '用户最近的需求：' + (userText || '通用') + '。请生成一个能自动处理此类需求的 Skill。', 0.8);
      const jsonMatch = txt.match(/\{[\s\S]*\}/);
      if (!jsonMatch) return null;
      const data = JSON.parse(jsonMatch[0]);
      return { id: 'ai_' + Date.now(), icon: data.icon || '🛠️', name: data.name || 'AI Skill', desc: data.desc || '', prompt: data.prompt || '', auto: true, builtin: false, installed: true };
    } catch { return null; }
  }

  // ===== 角色协同：任务分解与自动任务 =====
  // 角色特长映射（用于任务自动分配）
  const ROLE_SPECIALTIES = {
    'r1': ['编程', '插件', '代码', '调试', '技术', 'Bug', '开发', 'Hook', '权限'],
    'r2': ['管理', '计划', '整理', '文档', '协调', '排期', '清单', '汇报', '总结'],
    'r3': ['架构', '性能', '安全', '设计', '技术方案', '评估', '代码审查', '重构'],
  };
  function getRoleSpecialties(roleId) {
    return ROLE_SPECIALTIES[roleId] || ['通用'];
  }
  // 分析用户消息是否需要任务分解
  function needsDecomposition(userText) {
    if (!userText) return false;
    const complexKeywords = ['帮我', '做一下', '完成', '处理', '搞定', '安排', '协调', '一起', '讨论', '开发', '写一个', '做一个', '实现', '创建', '设计', '优化', '重构', '部署'];
    return complexKeywords.some(k => userText.includes(k)) || userText.length > 30;
  }
  // 自动分解任务：根据角色特长分配子任务
  function autoDecomposeTask(userText) {
    const roles = activeRoles();
    if (roles.length < 2) return null;
    const specialties = roles.map(r => ({ role: r, keywords: getRoleSpecialties(r.id) }));
    const subtasks = [];
    // 简化版：根据用户关键词匹配角色特长
    const words = userText.toLowerCase();
    specialties.forEach(s => {
      const matched = s.keywords.filter(k => words.includes(k.toLowerCase()));
      if (matched.length > 0) {
        subtasks.push({
          roleId: s.role.id,
          roleName: s.role.name,
          avatar: s.role.avatar,
          task: `处理与"${matched.join('/')}"相关的部分`,
          done: false
        });
      }
    });
    // 如果没有匹配，按轮询分配
    if (subtasks.length === 0 && roles.length >= 2) {
      const half = Math.ceil(userText.length / roles.length);
      roles.forEach((r, i) => {
        subtasks.push({
          roleId: r.id, roleName: r.name, avatar: r.avatar,
          task: `负责第 ${i + 1} 部分的处理`, done: false
        });
      });
    }
    return subtasks.length > 0 ? subtasks : null;
  }
  // 在聊天中显示任务分解卡，并自动创建任务到任务列表
  function showDecompCard(subtasks, userText) {
    const c = $('messages');
    const card = el('div', 'task-decomp-card');
    const taskId = 'task_' + Date.now();
    card.dataset.taskId = taskId;
    card.innerHTML = `
      <div class="tdc-title">📋 自动分工 · AI 角色协同</div>
      ${subtasks.map((s, i) => `
        <div class="tdc-item" data-sub="${i}">
          <span class="tdc-role">${escapeHtml(s.avatar)} ${escapeHtml(s.roleName)}</span>
          <span class="tdc-desc">${escapeHtml(s.task)}</span>
          <span class="tdc-status">待执行</span>
        </div>`).join('')}
      <div style="margin-top:8px;font-size:12px;color:var(--text-secondary);">基于你的需求，各角色将按分工依次处理。已自动创建任务到「任务」页。</div>`;
    c.appendChild(card);
    scrollMsgBottom();
    // 自动创建任务到任务列表
    subtasks.forEach((s, i) => {
      state.tasks.push({
        id: taskId + '_' + i,
        title: `[${s.roleName}] ${s.task}`,
        desc: '由 AI 自动分工创建 · 来源：' + (userText || '').slice(0, 50),
        ts: Date.now() + i,
        done: false,
        auto: true,
        roleId: s.roleId,
        priority: i === 0 ? 'high' : 'medium',
      });
    });
    saveAll();
    renderTasks();
  }
  // 在输入栏上方显示自动任务提示
  function showAutoTasksBar(text) {
    let bar = $('auto-tasks-bar');
    if (!bar) {
      bar = el('div', 'auto-tasks-bar');
      bar.id = 'auto-tasks-bar';
      bar.innerHTML = '<span class="atb-icon">⚡</span><span class="atb-text"></span><button class="atb-btn" id="auto-approve">执行</button>';
      const inputBar = $('input-bar');
      if (inputBar) inputBar.parentNode.insertBefore(bar, inputBar);
    }
    const textEl = bar.querySelector('.atb-text');
    if (textEl) textEl.textContent = '检测到复杂需求，AI 角色可协同处理。';
    bar.style.display = '';
    bar.querySelector('#auto-approve').onclick = () => {
      bar.style.display = 'none';
      bar._approved = true;
      if (bar._onApprove) bar._onApprove();
    };
  }
  function hideAutoTasksBar() {
    const bar = $('auto-tasks-bar');
    if (bar) bar.style.display = 'none';
  }

  // ===== 事件绑定 =====
  function bindEvents() {
    document.querySelectorAll('.tab').forEach(t => t.addEventListener('click', () => switchView(t.dataset.view)));
    // 聊天滚动检测：用户手动向上滚动时暂停自动滚底
    $('messages').addEventListener('scroll', () => {
      const c = $('messages');
      const distFromBottom = c.scrollHeight - c.scrollTop - c.clientHeight;
      _userScrolledUp = distFromBottom > 120; // 距底部超过120px视为向上滚动
    });
    // 朋友圈
    $('post-moment-btn').addEventListener('click', () => { pendingMomentImgs = []; renderMomentThumbs(); openSheet('moment-sheet-overlay'); });
    $('mf-publish').addEventListener('click', publishMoment);
    $('mf-cancel').addEventListener('click', () => closeSheet('moment-sheet-overlay'));
    $('mf-add-img').addEventListener('click', () => $('mf-img-input').click());
    $('mf-img-input').addEventListener('change', e => { handleMomentImg(e.target.files[0]); e.target.value = ''; });
    $('ai-moment-btn').addEventListener('click', aiPostMoment);
    // 朋友圈封面：点击换图
    const momentsCoverEl = document.querySelector('.moments-cover');
    if (momentsCoverEl) momentsCoverEl.addEventListener('click', pickMomentsCover);
    // 任务
    $('add-task-btn').addEventListener('click', () => openTaskSheet(null));
    $('tf-save').addEventListener('click', saveTask);
    $('tf-delete').addEventListener('click', () => { const id = $('tf-delete').dataset.id; if (id && confirm('删除该任务？')) { state.tasks = state.tasks.filter(t => t.id !== id); saveAll(); closeSheet('task-sheet-overlay'); renderTasks(); } });
    // 聊天
    const input = $('input');
    input.addEventListener('input', () => { autoResize(); updateSendBtn(); });
    input.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey && window.innerWidth > 600) { e.preventDefault(); sendMessage(); } });
    $('send-btn').addEventListener('click', sendMessage);
    $('new-chat-btn').addEventListener('click', () => openSessionsList());
    $('sessions-new').addEventListener('click', () => { newSession(); closeAllSheets(); });
    $('chat-menu-btn').addEventListener('click', () => openSheet('chat-sheet-overlay'));
    $('role-bar').addEventListener('click', openRolesList);
    // 加号菜单
    $('plus-btn').addEventListener('click', e => { e.stopPropagation(); togglePlusMenu(); });
    document.querySelectorAll('.plus-menu-item').forEach(b => b.addEventListener('click', () => { const type = b.dataset.type; closePlusMenu(); if (type === 'image') $('image-input').click(); else $('file-input').click(); }));
    $('file-input').addEventListener('change', e => { handleFile(e.target.files[0]); e.target.value = ''; });
    $('image-input').addEventListener('change', e => { handleImage(e.target.files[0]); e.target.value = ''; });
    $('ap-remove').addEventListener('click', clearAttachPreview);
    document.addEventListener('click', e => { if (!$('plus-menu').contains(e.target) && e.target.closest('#plus-btn') == null) closePlusMenu(); });
    // 聊天菜单
    $('menu-roles').addEventListener('click', () => { closeSheet('chat-sheet-overlay'); openRolesList(); });
    $('menu-memory').addEventListener('click', () => { closeSheet('chat-sheet-overlay'); openMemorySheet(); });
    $('menu-copy-last').addEventListener('click', () => { const la = [...curMessages()].reverse().find(m => m.role === 'ai'); if (la?.text) { navigator.clipboard?.writeText(la.text); toast('已复制'); } else toast('没有可复制的回复'); closeSheet('chat-sheet-overlay'); });
    $('menu-regen').addEventListener('click', () => { closeSheet('chat-sheet-overlay'); regenerateLast(); });
    $('menu-clear').addEventListener('click', () => { closeSheet('chat-sheet-overlay'); clearChat(); });
    // 消息长按操作
    $('msgact-quote').addEventListener('click', () => { closeSheet('msg-action-sheet-overlay'); if (_selectedMsg) quoteMessage(_selectedMsg); });
    $('msgact-copy').addEventListener('click', () => { closeSheet('msg-action-sheet-overlay'); if (_selectedMsg) { const t = _selectedMsg.role === 'user' ? (_selectedMsg.text || '') : (parseAIAttachments(_selectedMsg.text || '').text || _selectedMsg.text || ''); navigator.clipboard?.writeText(t); toast('已复制'); } });
    $('msgact-regen').addEventListener('click', () => { closeSheet('msg-action-sheet-overlay'); if (_selectedMsg?.id) regenerateMessage(_selectedMsg.id); });
    $('msgact-delete').addEventListener('click', () => { closeSheet('msg-action-sheet-overlay'); if (_selectedMsg?.id) deleteMessage(_selectedMsg.id); });
    // 记忆库
    $('mem-add-btn').addEventListener('click', addMemoryManual);
    $('mem-clear-btn').addEventListener('click', clearMemory);
    document.querySelectorAll('.sheet-item.cancel').forEach(b => b.addEventListener('click', closeAllSheets));
    // 角色
    $('roles-list-add').addEventListener('click', () => openRoleSheet(null));
    $('roles-list-import-tavern').addEventListener('click', importTavernCard);
    $('roles-list-import-tavo').addEventListener('click', importTavoRole);
    $('roles-list-close').addEventListener('click', () => closeSheet('roles-list-overlay'));
    $('rf-save').addEventListener('click', saveRole);
    $('rf-delete').addEventListener('click', deleteRole);
    $('rf-avatar-upload').addEventListener('click', () => uploadAvatar('role', $('rf-avatar-upload').dataset.roleId));
    $('rf-avatar-clear').addEventListener('click', () => clearAvatar('role', $('rf-avatar-upload').dataset.roleId));
    // API
    document.querySelectorAll('.setting-item.action').forEach(b => b.addEventListener('click', () => {
      const a = b.dataset.action;
      if (a === 'roles') openRolesList();
      else if (a === 'api') openApiSheet();
      else if (a === 'appname') { $('anf-name').value = state.settings.appname || 'Mavis'; openSheet('appname-sheet-overlay'); }
      else if (a === 'prompts') switchView('prompts');
    }));
    $('api-save').addEventListener('click', saveApi);
    $('fetch-models-btn').addEventListener('click', fetchModels);
    $('api-usage-btn').addEventListener('click', () => { closeSheet('api-sheet-overlay'); renderUsage('today'); document.querySelectorAll('.usage-tab').forEach(t => t.classList.toggle('active', t.dataset.range === 'today')); openSheet('usage-sheet-overlay'); });
    // API 多配置管理
    const newCfgBtn = $('api-new-config'); if (newCfgBtn) newCfgBtn.addEventListener('click', newApiConfig);
    const delCfgBtn = $('api-delete-btn'); if (delCfgBtn) delCfgBtn.addEventListener('click', () => { const cfg = currentApiConfig(); if (cfg) deleteApiConfig(cfg.id); });
    const testBtn = $('api-test-btn'); if (testBtn) testBtn.addEventListener('click', testApiConnection);
    // 配置选择下拉框
    const acs = $('api-config-selector');
    if (acs) {
      acs.querySelector('.acs-current')?.addEventListener('click', e => {
        e.stopPropagation();
        // 切换下拉前先刷新一下选项
        renderApiConfigSelector();
        acs.classList.toggle('open');
      });
      // 点击页面其他位置关闭下拉
      document.addEventListener('click', e => {
        if (!acs.contains(e.target)) acs.classList.remove('open');
      });
    }
    $('me-usage-btn').addEventListener('click', () => { renderUsage('today'); document.querySelectorAll('.usage-tab').forEach(t => t.classList.toggle('active', t.dataset.range === 'today')); openSheet('usage-sheet-overlay'); });
    document.querySelectorAll('.usage-tab').forEach(t => t.addEventListener('click', () => { document.querySelectorAll('.usage-tab').forEach(x => x.classList.remove('active')); t.classList.add('active'); renderUsage(t.dataset.range); }));
    $('usage-close').addEventListener('click', () => closeSheet('usage-sheet-overlay'));
    $('usage-reset').addEventListener('click', () => { if (confirm('确定重置所有用量统计？')) { state.settings.usage = []; saveAll(); renderUsage('today'); toast('已重置'); } });
    $('set-dark').addEventListener('change', e => { state.settings.dark = e.target.checked; saveAll(); applyTheme(); });
    $('anf-save').addEventListener('click', () => { const n = $('anf-name').value.trim() || 'Mavis'; state.settings.appname = n; saveAll(); applyAppName(); closeSheet('appname-sheet-overlay'); toast('已保存'); });
    // 资料
    $('edit-profile-btn').addEventListener('click', () => { $('pf-avatar').value = state.profile.avatar; $('pf-name').value = state.profile.name; openSheet('profile-sheet-overlay'); });
    $('pf-avatar-upload').addEventListener('click', () => uploadAvatar('user', null));
    $('pf-avatar-clear').addEventListener('click', () => clearAvatar('user', null));
    $('pf-cancel').addEventListener('click', () => closeSheet('profile-sheet-overlay'));
    $('pf-save').addEventListener('click', () => { state.profile.avatar = $('pf-avatar').value.trim() || '🦊'; state.profile.name = $('pf-name').value.trim() || 'Mavis 用户'; saveAll(); closeSheet('profile-sheet-overlay'); renderMe(); renderMoments(); toast('已保存'); });
    // 提示词库
    const pls = $('pl-switch'); if (pls) pls.addEventListener('change', e => { state.settings.promptLibOn = e.target.checked; saveAll(); toast(e.target.checked ? '提示词库已开启' : '已关闭'); });
    const pbb = $('prompts-back-btn'); if (pbb) pbb.addEventListener('click', () => switchView('me'));
    document.querySelectorAll('.pl-add-btn').forEach(b => b.addEventListener('click', () => openPromptItemSheet(b.dataset.type, -1)));
    document.querySelectorAll('.pl-import-btn').forEach(b => b.addEventListener('click', () => importPromptLib(b.dataset.type)));
    const plSave = $('pl-item-save'); if (plSave) plSave.addEventListener('click', savePromptItem);
    const plDel = $('pl-item-delete'); if (plDel) plDel.addEventListener('click', deletePromptItem);
    // 产出物（办公室产出）
    const sessOut = $('sessions-outputs'); if (sessOut) sessOut.addEventListener('click', () => { closeSheet('sessions-sheet-overlay'); openOutputsSheet(); });
    const outClose = $('outputs-close'); if (outClose) outClose.addEventListener('click', () => closeSheet('outputs-sheet-overlay'));
    const outClear = $('outputs-clear-all'); if (outClear) outClear.addEventListener('click', () => {
      if (state.outputs.length === 0) { toast('暂无产出物'); return; }
      if (!confirm('清空全部产出物？此操作不可恢复')) return;
      state.outputs = []; saveAll(); renderOutputsList('all'); toast('已清空');
    });
    document.querySelectorAll('.outputs-tab').forEach(t => t.addEventListener('click', () => {
      document.querySelectorAll('.outputs-tab').forEach(x => x.classList.remove('active'));
      t.classList.add('active');
      renderOutputsList(t.dataset.range);
    }));
    // 字体大小
    const fontBtn = $('font-size-btn'); if (fontBtn) fontBtn.addEventListener('click', openFontSheet);
    const fontRange = $('font-range');
    if (fontRange) fontRange.addEventListener('input', e => {
      const v = parseInt(e.target.value) || 15;
      const preview = $('font-preview'); if (preview) preview.style.fontSize = v + 'px';
    });
    const fontReset = $('font-reset'); if (fontReset) fontReset.addEventListener('click', () => {
      const v = 15;
      if (fontRange) fontRange.value = v;
      const preview = $('font-preview'); if (preview) preview.style.fontSize = v + 'px';
      toast('已恢复默认');
    });
    const fontSave = $('font-save'); if (fontSave) fontSave.addEventListener('click', () => {
      const v = parseInt($('font-range').value) || 15;
      state.settings.fontSize = v; saveAll(); applyFontSize();
      closeSheet('font-sheet-overlay'); toast('字体大小已保存');
    });
    // 聊天背景
    const bgBtn = $('chat-bg-btn'); if (bgBtn) bgBtn.addEventListener('click', openChatBgSheet);
    const bgClose = $('chatbg-close'); if (bgClose) bgClose.addEventListener('click', () => closeSheet('chatbg-sheet-overlay'));
    const bgPick = $('chatbg-pick'); if (bgPick) bgPick.addEventListener('click', pickChatBg);
    const bgClear = $('chatbg-clear'); if (bgClear) bgClear.addEventListener('click', clearChatBg);
    const dlCopy = $('dl-copy-url'); if (dlCopy) dlCopy.addEventListener('click', () => {
      const inp = $('dl-site-url'); if (!inp) return;
      inp.select(); inp.setSelectionRange(0, 99999);
      try { navigator.clipboard?.writeText(inp.value); toast('已复制站点地址'); }
      catch (e) { document.execCommand?.('copy'); toast('已复制'); }
    });
    const dlPwa = $('dl-open-pwabuilder'); if (dlPwa) dlPwa.addEventListener('click', () => {
      const url = $('dl-site-url')?.value || location.href;
      window.open('https://www.pwabuilder.com/?url=' + encodeURIComponent(url), '_blank');
    });
    // 数据
    $('export-btn').addEventListener('click', exportData);
    $('clear-all-btn').addEventListener('click', clearAll);
    // 技能库
    const skillBtn = $('skill-library-btn'); if (skillBtn) skillBtn.addEventListener('click', openSkillLibrary);
    const skillClose = $('skill-close'); if (skillClose) skillClose.addEventListener('click', () => closeSheet('skill-sheet-overlay'));
    document.querySelectorAll('.skill-tab').forEach(t => t.addEventListener('click', () => switchSkillTab(t.dataset.tab)));
    const skillSearch = $('skill-search'); if (skillSearch) skillSearch.addEventListener('input', e => renderSkillMarket(e.target.value));
    const skSave = $('sk-save'); if (skSave) skSave.addEventListener('click', createCustomSkill);
    const skImport = $('sk-import'); if (skImport) skImport.addEventListener('click', importSkillFile);
    // 遮罩关闭
    document.querySelectorAll('.sheet-overlay').forEach(o => o.addEventListener('click', e => { if (e.target === o) o.classList.remove('show'); }));
    // 应用内更新
    const checkBtn = $('about-check-update');
    if (checkBtn) checkBtn.addEventListener('click', () => checkUpdate(true));
    const applyBtn = $('update-apply-btn');
    if (applyBtn) applyBtn.addEventListener('click', applyUpdate);
    const closeBtn = $('update-close-btn');
    if (closeBtn) closeBtn.addEventListener('click', hideUpdateBanner);
  }

  // ===== 应用内自动更新 =====
  let _swReg = null;       // 当前 SW 注册对象
  let _newWorker = null;   // 正在安装的新 SW
  let _reloading = false;  // 防止 controllerchange 重复触发刷新
  let _lastAutoCheckTs = 0;  // 上次自动检查时间戳（节流用）
  let _manualChecking = false; // 手动检查中（避免重入）
  let _apkUpdateUrl = null;   // APK 模式下，新版本的下载链接

  function showUpdateBanner() {
    const banner = $('update-banner');
    if (!banner) return;
    banner.classList.add('show');
    const hint = $('about-update-hint');
    if (hint) hint.textContent = '发现新版本，点击右上角「更新」';
  }
  function hideUpdateBanner() {
    const banner = $('update-banner');
    if (banner) banner.classList.remove('show');
  }
  // 应用新版本：APK 模式打开 GitHub Releases 页面手动下载；PWA 模式通知 SW 接管
  function applyUpdate() {
    // APK 模式：打开 Releases 页面，用户手动下载安装
    if (_apkUpdateUrl) {
      if (window.MavisNative && typeof window.MavisNative.openDownloadUrl === 'function') {
        try {
          window.MavisNative.openDownloadUrl(_apkUpdateUrl);
          toast('已打开浏览器，请在 Releases 页面下载新版 APK 安装');
          return;
        } catch (e) {}
      }
      // 兜底：用 window.open
      window.open(_apkUpdateUrl, '_blank');
      return;
    }
    // PWA 模式：通知 SW 接管
    const target = _newWorker || (_swReg && _swReg.waiting) || null;
    if (target) {
      try { target.postMessage({ action: 'SKIP_WAITING' }); return; }
      catch (e) { /* fallthrough to reload */ }
    }
    // 兜底：没有可通知的 worker 时直接刷新
    window.location.reload();
  }
  // 手动检查更新：带超时 + 真实状态监听
  function checkUpdate(manual) {
    // ===== APK 原生环境：走 MavisNative 检查新版本 APK =====
    if (window.MavisNative && typeof window.MavisNative.checkUpdate === 'function') {
      if (manual) {
        if (_manualChecking) { toast('正在检查中，请稍候'); return; }
        _manualChecking = true;
        toast('正在检查更新...');
        const hint = $('about-update-hint');
        if (hint) hint.textContent = '正在检查...';
      }
      // 生成唯一回调名
      const cbName = '_mavisUpdateCb_' + Date.now();
      window[cbName] = function(info) {
        _manualChecking = false;
        delete window[cbName];
        const hint = $('about-update-hint');
        if (info && info.hasUpdate) {
          if (manual) toast('发现新版本 v' + info.versionName + '，点击下载');
          if (hint) hint.textContent = '发现新版本 v' + info.versionName + '，点击下载';
          showUpdateBanner();
          _apkUpdateUrl = info.downloadUrl;
        } else if (info && (info.error === 'network_error' || info.error === 'timeout')) {
          if (manual) {
            toast('检查更新失败，请检查网络后重试');
            if (hint) hint.textContent = '检查失败，请稍后重试';
          }
        } else if (info && info.error === 'no_releases') {
          if (manual) toast('当前已是最新版本（GitHub 暂无 Release）');
          if (hint) hint.textContent = '已是最新版本';
        } else {
          if (manual) toast('已是最新版本 (v' + (info && info.currentVersion || '') + ')');
          if (hint) hint.textContent = '已是最新版本';
        }
      };
      try {
        window.MavisNative.checkUpdate(cbName);
      } catch (e) {
        _manualChecking = false;
        if (manual) toast('检查失败：' + e.message);
      }
      // 超时兜底
      setTimeout(() => {
        if (window[cbName]) {
          window[cbName]({ hasUpdate: false, error: 'timeout' });
        }
      }, 12000);
      return;
    }

    // ===== PWA 环境：走 Service Worker =====
    if (!('serviceWorker' in navigator)) {
      if (manual) toast('当前环境不支持自动更新');
      return;
    }
    if (!_swReg) {
      if (manual) toast('更新服务尚未就绪，请稍后再试');
      return;
    }
    // 手动检查避免重入
    if (manual && _manualChecking) {
      toast('正在检查中，请稍候');
      return;
    }
    const hint = $('about-update-hint');
    if (manual) {
      _manualChecking = true;
      toast('正在检查更新...');
      if (hint) hint.textContent = '正在检查...';
    }
    // 关键：update() 只是去对比 sw.js 字节，resolve 后并不代表新 SW 下载完
    // 用 Promise.race 加超时（避免网络慢时一直 hang）
    const updatePromise = _swReg.update();
    const timeoutPromise = new Promise((_, reject) => {
      setTimeout(() => reject(new Error('timeout')), 8000);
    });
    Promise.race([updatePromise, timeoutPromise])
      .then(() => {
        // update() resolve 后，updatefound 可能已触发也可能没触发
        // 用 100ms 短延迟让 updatefound 事件先冒泡
        if (manual) {
          setTimeout(() => {
            _manualChecking = false;
            if (!_newWorker) {
              // 没有 waiting/installing worker → 已是最新
              toast('已是最新版本');
              if (hint) hint.textContent = '已是最新版本';
            } else if (_newWorker.state === 'installed') {
              // 已下载好但用户还没点更新
              toast('发现新版本，点击「更新」');
              if (hint) hint.textContent = '发现新版本，点击更新';
            }
          }, 200);
        }
      })
      .catch(() => {
        if (manual) {
          _manualChecking = false;
          toast('检查更新超时，请稍后再试');
          if (hint) hint.textContent = '检查超时，请稍后再试';
        }
      });
  }
  // 自动检查更新（带节流，避免后台切前台频繁触发）
  function autoCheckUpdate() {
    const now = Date.now();
    // 5 分钟内不重复自动检查
    if (now - _lastAutoCheckTs < 5 * 60 * 1000) return;
    _lastAutoCheckTs = now;
    try { _swReg && _swReg.update().catch(() => {}); } catch (e) {}
  }

  function registerSW() {
    if (!('serviceWorker' in navigator)) return;
    // 关键判据：注册前是否已有 SW 控制页面。首次安装时为 false，更新时为 true。
    const hadControllerAtStart = !!navigator.serviceWorker.controller;
    navigator.serviceWorker.register('sw.js').then(reg => {
      _swReg = reg;
      // 页面加载时可能已有 waiting 的 SW（上次会话下载好但还没接管），直接提示
      if (reg.waiting && hadControllerAtStart) {
        _newWorker = reg.waiting;
        showUpdateBanner();
      }
      // 检测到新 SW 开始安装
      reg.addEventListener('updatefound', () => {
        _newWorker = reg.installing;
        if (!_newWorker) return;
        // 手动检查中：标记下载开始
        if (_manualChecking) {
          const hint = $('about-update-hint');
          if (hint) hint.textContent = '发现新版本，正在下载...';
        }
        _newWorker.addEventListener('statechange', () => {
          if (!_newWorker) return;
          // installed 状态：新 SW 已下载完成
          if (_newWorker.state === 'installed') {
            // 已有旧 SW 在控制页面 → 有更新可用；首次安装则不提示
            if (navigator.serviceWorker.controller) {
              showUpdateBanner();
              if (_manualChecking) {
                _manualChecking = false;
                toast('新版本已就绪，点击「更新」');
              }
            }
          }
        });
      });
      // controllerchange：仅在「已有 controller 的情况下发生接管」时刷新，避免首次安装误刷新
      navigator.serviceWorker.addEventListener('controllerchange', () => {
        if (_reloading) return;
        if (hadControllerAtStart) {
          _reloading = true;
          window.location.reload();
        }
      });
      // 定时自动检查更新（每 30 分钟一次）→ 改用节流版
      setInterval(autoCheckUpdate, 30 * 60 * 1000);
      // 页面从后台切回前台时也检查一次 → 改用节流版（5 分钟内只触发一次）
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') autoCheckUpdate();
      });
    }).catch(() => {});
  }

  function init() {
    applyTheme(); applyAppName(); applyFontSize(); applyChatBg();
    renderRoleBar(); renderMessages(); renderMoments(); renderTasks();
    updateSkillCount();
    bindEvents(); registerSW();
  }
  document.addEventListener('DOMContentLoaded', init);
})();
