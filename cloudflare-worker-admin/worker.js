/**
 * 凡耘手记留言板 · 管理员控制台
 * Cloudflare Worker · 部署在 admin.fanren.tech
 * 
 * 功能概述：
 * - 管理员登录验证（使用 PBKDF2 哈希保护密码）
 * - 查看所有留言（待审核/已通过/已拒绝）
 * - 一键通过/拒绝/删除留言（Ajax 异步操作）
 * - 支持按状态筛选
 * 
 * 页面路由：
 *   /           → 登录页（未登录）或控制台主页（已登录）
 *   /login      → 处理登录表单提交
 *   /logout     → 退出登录
 *   /health     → 健康检查
 *   /api/*      → API 接口（需验证登录状态）
 * 
 * 依赖：
 * - 复用 fanren-guestbook-api Worker 的 KV 命名空间
 */

// =============================================
// 辅助函数
// =============================================

/**
 * HTML 特殊字符转义
 * 防止 XSS 攻击
 * 
 * @param {string} s - 原始字符串
 * @returns {string} 转义后的字符串
 */
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({
    '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
  }[c]));
}

/**
 * 验证 Token
 * 
 * @param {string} inputToken - 输入的 Token
 * @param {string} expectedToken - 期望的 Token
 * @returns {Promise<boolean>} 是否匹配
 */
async function verifyToken(inputToken, expectedToken) {
  if (!inputToken) return false;
  return inputToken === expectedToken;
}

/**
 * 使用 PBKDF2-SHA256 验证密码
 * 密码在存储时已经过哈希处理
 * 
 * @param {string} inputPassword - 输入的密码
 * @param {string} expectedHash - 期望的哈希值
 * @param {string} salt - 盐值
 * @returns {Promise<boolean>} 是否匹配
 */
async function verifyPassword(inputPassword, expectedHash, salt) {
  if (!inputPassword) return false;
  
  // 使用 Web Crypto API 计算 PBKDF2 哈希
  const enc = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    enc.encode(inputPassword),
    'PBKDF2',
    false,
    ['deriveBits']
  );
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: enc.encode(salt), iterations: 100000, hash: 'SHA-256' },
    keyMaterial,
    256
  );
  // 转换为十六进制字符串
  const computedHex = Array.from(new Uint8Array(bits))
    .map(b => b.toString(16).padStart(2, '0')).join('');
  return computedHex === expectedHash;
}

/**
 * 检查请求是否已登录
 * 从 Cookie 中读取 admin_token 并验证
 * 
 * @param {Request} request - HTTP 请求
 * @param {Object} env - 环境变量
 * @returns {Promise<boolean>} 是否已登录
 */
async function isAuthed(request, env) {
  const cookie = request.headers.get('Cookie') || '';
  const m = cookie.match(/admin_token=([^;]+)/);
  if (!m) return false;
  return await verifyToken(decodeURIComponent(m[1]), env.ADMIN_TOKEN);
}

// =============================================
// 页面模板
// =============================================

/**
 * 登录页面 HTML
 * 
 * @param {string} error - 错误信息（可选）
 * @returns {string} HTML 字符串
 */
function loginHtml(error) {
  return `<!DOCTYPE html><html lang="zh-CN"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=5">
<title>登录 · 留言板管理 · fanren.tech</title>
<style>
  /* 登录页样式：简洁居中卡片 */
  :root { --bg: #f5f3ee; --card-bg: #fdfcf8; --text: #3a3528; --text-light: #7c6f57; --accent: #7c6f57; --paper: #e8e4dc; --danger: #c46a5a; --success: #7ba05b; }
  * { box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, "LXGW WenKai", sans-serif; background: var(--bg); color: var(--text); margin: 0; padding: 40px 20px; min-height: 100vh; display: flex; align-items: center; justify-content: center; }
  .card { background: var(--card-bg); border: 1px solid var(--paper); border-radius: 16px; padding: 40px 32px; max-width: 420px; width: 100%; box-shadow: 2px 2px 0 var(--paper); }
  h1 { margin: 0 0 8px; font-size: 22px; color: var(--text); }
  p.sub { color: var(--text-light); font-size: 14px; margin: 0 0 24px; }
  input { width: 100%; padding: 14px 16px; border: 1px solid var(--paper); border-radius: 10px; font-size: 15px; background: var(--bg); color: var(--text); font-family: inherit; transition: border-color 0.2s; }
  input:focus { outline: none; border-color: var(--accent); }
  button { width: 100%; margin-top: 16px; padding: 14px; background: var(--accent); color: white; border: none; border-radius: 10px; font-size: 15px; font-weight: 500; cursor: pointer; transition: all 0.2s; }
  button:hover { background: #5a4f3a; transform: translateY(-1px); }
  .error { background: #fbeae5; color: var(--danger); padding: 12px 16px; border-radius: 8px; font-size: 14px; margin-bottom: 16px; border: 1px solid #e8c4b8; }
  .hint { color: var(--text-light); font-size: 12px; margin-top: 16px; text-align: center; }
</style>
</head><body>
<div class="card">
  <h1>🌿 留言板管理</h1>
  <p class="sub">输入您的管理员 Token 登录</p>
  ${error ? `<div class="error">${escapeHtml(error)}</div>` : ''}
  <form method="POST" action="/login">
    <input type="password" name="password" placeholder="管理员密码" autofocus required>
    <button type="submit">登录</button>
  </form>
  <p class="hint">* 仅您本人可访问，cookie 7 天有效</p>
</div>
</body></html>`;
}

// =============================================
// KV 数据操作
// =============================================

/**
 * 获取留言 ID 列表（索引）
 */
async function getIndex(env) {
  const raw = await env.GUESTBOOK_KV.get('msg-index');
  if (!raw) return [];
  try { return JSON.parse(raw); } catch { return []; }
}

/**
 * 加载所有留言
 */
async function loadAllMessages(env) {
  const ids = await getIndex(env);
  const results = [];
  for (const id of ids) {
    const raw = await env.GUESTBOOK_KV.get(`msg:${id}`);
    if (!raw) continue;
    try {
      const msg = JSON.parse(raw);
      results.push(msg);
    } catch {}
  }
  return results;
}

/**
 * 管理控制台页面 HTML
 * 
 * @param {Array} messages - 留言列表
 * @param {string} filter - 当前筛选条件
 * @returns {string} HTML 字符串
 */
function consoleHtml(messages, filter) {
  // 按状态分组统计
  const groups = { pending: [], approved: [], rejected: [] };
  for (const m of messages) {
    if (groups[m.state]) groups[m.state].push(m);
  }

  /**
   * 渲染单个留言卡片
   */
  const renderCard = (m) => {
    const date = new Date(m.created_at).toLocaleString('zh-CN', { hour12: false });
    const reviewDate = m.reviewed_at ? new Date(m.reviewed_at).toLocaleString('zh-CN', { hour12: false }) : '';
    // 状态徽章
    const stateBadge = {
      pending: '<span class="badge pending">⏳ 待审核</span>',
      approved: '<span class="badge approved">✓ 已通过</span>',
      rejected: '<span class="badge rejected">✗ 已拒绝</span>',
    }[m.state] || '';
    
    return `
    <div class="msg-card" data-state="${m.state}">
      <div class="msg-header">
        <div class="msg-meta">
          <strong>👤 ${escapeHtml(m.name)}</strong>
          ${m.email ? `<span class="email">📧 ${escapeHtml(m.email)}</span>` : ''}
          <span class="time">${date}</span>
        </div>
        ${stateBadge}
      </div>
      <div class="msg-content">${escapeHtml(m.content).replace(/\n/g, '<br>')}</div>
      ${m.ip && m.ip !== 'unknown' ? `<div class="msg-ip">IP: ${escapeHtml(m.ip)}</div>` : ''}
      ${reviewDate ? `<div class="msg-review">审核时间: ${reviewDate}</div>` : ''}
      <div class="msg-actions">
        ${m.state === 'pending' ? `
          <button class="btn-approve" data-id="${m.id}">✓ 通过</button>
          <button class="btn-reject" data-id="${m.id}">✗ 拒绝</button>
        ` : ''}
        ${m.state !== 'pending' ? `
          <button class="btn-pending" data-id="${m.id}">↩ 改回待审</button>
        ` : ''}
        <button class="btn-delete" data-id="${m.id}">🗑 删除</button>
      </div>
    </div>`;
  };

  return `<!DOCTYPE html><html lang="zh-CN"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=5">
<title>留言板管理 · fanren.tech</title>
<style>
  /* 控制台样式 */
  :root { --bg: #f5f3ee; --card-bg: #fdfcf8; --text: #3a3528; --text-light: #7c6f57; --accent: #7c6f57; --paper: #e8e4dc; --danger: #c46a5a; --success: #7ba05b; --warning: #c19a3e; }
  * { box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, "LXGW WenKai", sans-serif; background: var(--bg); color: var(--text); margin: 0; padding: 0; line-height: 1.6; }
  
  /* 页头 */
  .header { background: var(--card-bg); border-bottom: 1px solid var(--paper); padding: 16px 20px; position: sticky; top: 0; z-index: 10; box-shadow: 0 1px 3px rgba(0,0,0,0.03); }
  .header-inner { max-width: 800px; margin: 0 auto; display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 12px; }
  h1 { font-size: 20px; margin: 0; }
  .header-right { display: flex; gap: 12px; align-items: center; }
  .logout { color: var(--text-light); text-decoration: none; font-size: 13px; padding: 6px 12px; border-radius: 6px; transition: background 0.2s; }
  .logout:hover { background: var(--bg); }
  
  /* 主容器 */
  .container { max-width: 800px; margin: 0 auto; padding: 20px; }
  
  /* 统计卡片 */
  .stats { display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px; margin-bottom: 24px; }
  .stat { background: var(--card-bg); border: 1px solid var(--paper); border-radius: 10px; padding: 16px; text-align: center; cursor: pointer; transition: all 0.2s; }
  .stat:hover { transform: translateY(-1px); }
  .stat .num { font-size: 28px; font-weight: 700; }
  .stat .label { font-size: 12px; color: var(--text-light); margin-top: 4px; }
  .stat.pending .num { color: var(--warning); }
  .stat.approved .num { color: var(--success); }
  .stat.rejected .num { color: var(--danger); }
  .stat.active { border-color: var(--accent); border-width: 2px; padding: 15px; }
  
  /* 筛选栏 */
  .filter-bar { display: flex; gap: 8px; margin-bottom: 16px; flex-wrap: wrap; }
  .filter-btn { background: var(--card-bg); border: 1px solid var(--paper); padding: 8px 16px; border-radius: 8px; cursor: pointer; font-size: 13px; color: var(--text-light); font-family: inherit; }
  .filter-btn.active { background: var(--accent); color: white; border-color: var(--accent); }
  
  /* 留言卡片 */
  .msg-card { background: var(--card-bg); border: 1px solid var(--paper); border-radius: 12px; padding: 18px 20px; margin-bottom: 12px; transition: all 0.2s; }
  .msg-card:hover { box-shadow: 1px 1px 0 var(--paper); }
  .msg-header { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 10px; flex-wrap: wrap; gap: 8px; }
  .msg-meta { font-size: 14px; display: flex; flex-wrap: wrap; gap: 10px; align-items: center; }
  .msg-meta .email { color: var(--text-light); font-size: 12px; }
  .msg-meta .time { color: var(--text-light); font-size: 12px; }
  
  /* 状态徽章 */
  .badge { padding: 3px 10px; border-radius: 6px; font-size: 11px; font-weight: 500; }
  .badge.pending { background: #fdf0d8; color: var(--warning); }
  .badge.approved { background: #e8f0d8; color: var(--success); }
  .badge.rejected { background: #fbeae5; color: var(--danger); }
  
  .msg-content { font-size: 14.5px; line-height: 1.7; margin: 10px 0; white-space: pre-wrap; word-break: break-word; }
  .msg-ip, .msg-review { font-size: 11px; color: var(--text-light); margin-top: 6px; }
  
  /* 操作按钮 */
  .msg-actions { display: flex; gap: 8px; margin-top: 12px; flex-wrap: wrap; }
  .msg-actions button { padding: 6px 14px; border-radius: 6px; border: 1px solid var(--paper); background: var(--bg); cursor: pointer; font-size: 13px; font-family: inherit; transition: all 0.2s; }
  .btn-approve { color: var(--success); border-color: var(--success) !important; }
  .btn-approve:hover { background: var(--success); color: white; }
  .btn-reject { color: var(--danger); border-color: var(--danger) !important; }
  .btn-reject:hover { background: var(--danger); color: white; }
  .btn-pending { color: var(--warning); }
  .btn-pending:hover { background: var(--warning); color: white; }
  .btn-delete:hover { background: #999; color: white; }
  
  /* 空状态 */
  .empty { text-align: center; padding: 60px 20px; color: var(--text-light); }
  .empty .icon { font-size: 48px; margin-bottom: 12px; }
  
  /* 提示框 */
  .toast { position: fixed; bottom: 24px; left: 50%; transform: translateX(-50%); background: var(--text); color: white; padding: 12px 24px; border-radius: 8px; font-size: 14px; opacity: 0; transition: opacity 0.3s; z-index: 100; }
  .toast.show { opacity: 1; }
  .toast.success { background: var(--success); }
  .toast.error { background: var(--danger); }
  
  /* 返回链接 */
  .back-link { display: inline-block; margin-bottom: 12px; color: var(--text-light); text-decoration: none; font-size: 13px; }
  .back-link:hover { color: var(--accent); }
  
  /* 移动端适配 */
  @media (max-width: 600px) { .stats { grid-template-columns: repeat(3, 1fr); gap: 8px; } .stat { padding: 12px 8px; } .stat .num { font-size: 22px; } }
</style>
</head><body>
<div class="header">
  <div class="header-inner">
    <h1>🌿 留言板管理</h1>
    <div class="header-right">
      <a href="https://fanren.tech/guestbook" target="_blank" class="logout">前台 ↗</a>
      <a href="/logout" class="logout">退出</a>
    </div>
  </div>
</div>
<div class="container">
  <a href="https://fanren.tech" class="back-link">← 返回 fanren.tech</a>
  
  <!-- 统计卡片 -->
  <div class="stats">
    <div class="stat pending" data-filter="pending">
      <div class="num">${groups.pending.length}</div>
      <div class="label">⏳ 待审核</div>
    </div>
    <div class="stat approved" data-filter="approved">
      <div class="num">${groups.approved.length}</div>
      <div class="label">✓ 已通过</div>
    </div>
    <div class="stat rejected" data-filter="rejected">
      <div class="num">${groups.rejected.length}</div>
      <div class="label">✗ 已拒绝</div>
    </div>
  </div>
  
  <!-- 筛选栏 -->
  <div class="filter-bar">
    <button class="filter-btn ${filter==='all'?'active':''}" data-filter="all">全部 (${messages.length})</button>
    <button class="filter-btn ${filter==='pending'?'active':''}" data-filter="pending">待审核 (${groups.pending.length})</button>
    <button class="filter-btn ${filter==='approved'?'active':''}" data-filter="approved">已通过 (${groups.approved.length})</button>
    <button class="filter-btn ${filter==='rejected'?'active':''}" data-filter="rejected">已拒绝 (${groups.rejected.length})</button>
  </div>
  
  <!-- 留言列表 -->
  <div id="messages">
    ${messages.length === 0 ? `<div class="empty"><div class="icon">🌱</div><p>还没有留言</p></div>` : ''}
    ${messages.map(renderCard).join('')}
  </div>
</div>

<!-- 提示框 -->
<div id="toast" class="toast"></div>

<!-- 前端脚本 -->
<script>
  let currentFilter = '${filter}';

  /**
   * 显示提示框
   */
  function showToast(msg, type) {
    const t = document.getElementById('toast');
    t.textContent = msg;
    t.className = 'toast show ' + (type || '');
    setTimeout(() => t.className = 'toast', 2500);
  }

  /**
   * 调用 API 执行操作
   */
  async function api(action, id) {
    try {
      const r = await fetch('/api/' + action + '?id=' + encodeURIComponent(id), { method: 'POST' });
      const data = await r.json();
      if (data.ok) {
        showToast(data.message || '操作成功', 'success');
        setTimeout(() => location.reload(), 600);
      } else {
        showToast(data.error || '操作失败', 'error');
      }
    } catch (e) {
      showToast('网络错误: ' + e.message, 'error');
    }
  }

  /**
   * 事件委托：处理按钮点击
   */
  document.addEventListener('click', (e) => {
    if (e.target.classList.contains('btn-approve')) api('approve', e.target.dataset.id);
    else if (e.target.classList.contains('btn-reject')) api('reject', e.target.dataset.id);
    else if (e.target.classList.contains('btn-pending')) api('pending', e.target.dataset.id);
    else if (e.target.classList.contains('btn-delete')) {
      if (confirm('确定要删除这条留言吗？此操作不可恢复。')) api('delete', e.target.dataset.id);
    }
    else if (e.target.classList.contains('filter-btn')) {
      const f = e.target.dataset.filter;
      const url = new URL(location.href);
      url.searchParams.set('filter', f);
      location.href = url.toString();
    }
    else if (e.target.closest('.stat')) {
      const f = e.target.closest('.stat').dataset.filter;
      const url = new URL(location.href);
      url.searchParams.set('filter', f);
      location.href = url.toString();
    }
  });

  /**
   * 客户端筛选（初始加载时）
   */
  const url = new URL(location.href);
  const initialFilter = url.searchParams.get('filter') || 'all';
  if (initialFilter !== 'all') {
    document.querySelectorAll('.msg-card').forEach(card => {
      if (card.dataset.state !== initialFilter) card.style.display = 'none';
    });
  }
</script>
</body></html>`;
}

// =============================================
// 主入口
// =============================================

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;
    const cookie = request.headers.get('Cookie') || '';

    // =============================================
    // 登录处理
    // =============================================
    if (path === '/login' && request.method === 'POST') {
      const formData = await request.formData();
      const password = formData.get('password');
      
      // 验证密码
      if (await verifyPassword(password, env.ADMIN_PASSWORD_HASH, env.ADMIN_PASSWORD_SALT)) {
        // 密码正确，设置 Cookie 并重定向到控制台
        return new Response(null, {
          status: 302,
          headers: {
            'Location': '/',
            'Set-Cookie': `admin_token=${encodeURIComponent(env.ADMIN_TOKEN)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${7*24*3600}`,
          },
        });
      }
      // 密码错误，显示错误信息
      return new Response(loginHtml('密码不正确，请重试'), { status: 401, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
    }

    // =============================================
    // 退出登录
    // =============================================
    if (path === '/logout') {
      return new Response(null, {
        status: 302,
        headers: { 'Location': '/login', 'Set-Cookie': 'admin_token=; Path=/; HttpOnly; Max-Age=0' },
      });
    }

    // =============================================
    // 健康检查
    // =============================================
    if (path === '/health') {
      return new Response('OK', { status: 200 });
    }

    // =============================================
    // API 路由
    // =============================================
    if (path.startsWith('/api/')) {
      // 验证登录状态
      if (!await isAuthed(request, env)) {
        return new Response(JSON.stringify({ ok: false, error: '未授权' }), {
          status: 401, headers: { 'Content-Type': 'application/json' },
        });
      }
      
      const action = path.slice(5);  // 提取操作类型
      const id = url.searchParams.get('id');
      if (!id) return new Response(JSON.stringify({ ok: false, error: '缺少 id' }), { status: 400, headers: { 'Content-Type': 'application/json' } });

      const raw = await env.GUESTBOOK_KV.get(`msg:${id}`);
      if (!raw) return new Response(JSON.stringify({ ok: false, error: '留言不存在' }), { status: 404, headers: { 'Content-Type': 'application/json' } });
      const msg = JSON.parse(raw);

      // 删除操作
      if (action === 'delete') {
        await env.GUESTBOOK_KV.delete(`msg:${id}`);
        // 从索引中移除
        const ids = await getIndex(env);
        const filtered = ids.filter(x => x !== id);
        await env.GUESTBOOK_KV.put('msg-index', JSON.stringify(filtered));
        return new Response(JSON.stringify({ ok: true, message: '已删除' }), { headers: { 'Content-Type': 'application/json' } });
      }

      // 更新状态（approve/reject/pending）
      const stateMap = { approve: 'approved', reject: 'rejected', pending: 'pending' };
      msg.state = stateMap[action] || msg.state;
      msg.reviewed_at = new Date().toISOString();
      await env.GUESTBOOK_KV.put(`msg:${id}`, JSON.stringify(msg));

      const messages = { approve: '已通过', reject: '已拒绝', pending: '已改回待审' };
      return new Response(JSON.stringify({ ok: true, message: messages[action] || '已更新' }), { headers: { 'Content-Type': 'application/json' } });
    }

    // =============================================
    // 页面路由
    // =============================================
    if (!await isAuthed(request, env)) {
      // 未登录，显示登录页
      if (path === '/') {
        return new Response(loginHtml(), { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
      }
      return new Response(loginHtml(), { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
    }

    // 已登录，显示控制台
    if (path === '/') {
      const filter = url.searchParams.get('filter') || 'all';
      const messages = await loadAllMessages(env);
      return new Response(consoleHtml(messages, filter), {
        status: 200,
        headers: { 'Content-Type': 'text/html; charset=utf-8' },
      });
    }

    return new Response('Not found', { status: 404 });
  },
};
