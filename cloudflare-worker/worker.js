/**
 * 凡耘手记留言板 API 后端（v2 · C1 方案）
 * Cloudflare Worker · 部署在 api.fanren.tech
 * 
 * 功能概述：
 * - 存储访客留言到 Cloudflare KV（键值对存储）
 * - 审核流程：访客提交 → state=pending → 管理员审核通过/拒绝
 * - 审核通知：通过邮件发送给站长（需配置邮件服务）
 * 
 * API 端点：
 *   GET  /api/guestbook                    → 读取已审核通过的留言（公开）
 *   POST /api/guestbook                    → 提交新留言（写入 KV + 发邮件通知）
 *   GET  /api/admin/list?token=xxx         → 查看所有待审核留言（管理员专用）
 *   GET  /api/admin/approve?id=xxx&token=xxx → 审核通过
 *   GET  /api/admin/reject?id=xxx&token=xxx  → 审核拒绝
 *   GET  /__debug                          → 调试信息（生产环境可删除）
 * 
 * KV 存储结构：
 *   msg:{id}            → 留言详情（JSON）
 *   msg-index           → 所有留言 ID 数组（最近 200 条，用于快速遍历）
 * 
 * 环境变量（Cloudflare Worker Bindings）：
 *   ADMIN_TOKEN         (secret_text) - 管理员审核口令（防止审核链接被滥用）
 *   ADMIN_EMAIL         (plain_text)  - 站长接收审核通知的邮箱
 *   ALLOWED_ORIGIN      (plain_text)  - 允许的来源域名，例如 "https://fanren.tech"
 *   MAIL_FROM           (plain_text)  - 发件人地址，例如 "noreply@fanren.tech"
 *   SITE_URL            (plain_text)  - 网站 URL，例如 "https://fanren.tech"
 *   MAIL_API_KEY        (secret_text) - SendGrid 等邮件服务的 API Key（可选）
 */

// =============================================
// 辅助函数
// =============================================

/**
 * 生成 CORS 响应头
 * 允许跨域访问（用于前端 AJAX 调用）
 * 
 * @param {string|null} origin - 请求来源域名
 * @returns {Object} CORS 响应头对象
 */
function corsHeaders(origin) {
  return {
    'Access-Control-Allow-Origin': origin || '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',  // 预检请求缓存 24 小时
  };
}

/**
 * 构造 JSON 响应
 * 
 * @param {any} data - 响应数据
 * @param {number} status - HTTP 状态码
 * @param {string|null} origin - 请求来源
 * @returns {Response} HTTP 响应对象
 */
function jsonResponse(data, status = 200, origin) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      ...corsHeaders(origin),
    },
  });
}

/**
 * 检查请求来源是否被允许
 * 
 * @param {string|null} origin - 请求来源域名
 * @param {Object} env - 环境变量
 * @returns {boolean} 是否允许
 */
function isOriginAllowed(origin, env) {
  if (!origin) return true;  // 无来源（服务端请求）直接放行
  // 允许 fanren.tech 域名及其子域名
  if (/^https?:\/\/([a-z0-9-]+\.)?fanren\.tech(:\d+)?$/i.test(origin)) return true;
  // 允许本地开发（localhost 和 127.0.0.1）
  if (/^https?:\/\/localhost(:\d+)?$/i.test(origin)) return true;
  if (/^https?:\/\/127\.0\.0\.1(:\d+)?$/i.test(origin)) return true;
  return false;
}

/**
 * 生成短 ID
 * 格式：时间戳的 36 进制 + 4 位随机字符
 * 例如：m1abc2def
 * 
 * @returns {string} 唯一 ID
 */
function makeId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

/**
 * 发送邮件通知
 * 支持 SendGrid 风格的 API
 * 
 * @param {Object} env - 环境变量
 * @param {string} to - 收件人邮箱
 * @param {string} subject - 邮件主题
 * @param {string} text - 纯文本内容
 * @param {string} html - HTML 内容（可选）
 * @returns {Promise<Object>} 发送结果
 */
async function sendMail(env, to, subject, text, html) {
  const apiKey = env.MAIL_API_KEY;
  const from = env.MAIL_FROM || 'noreply@fanren.tech';
  
  if (!apiKey) {
    // 没配邮件 API：把通知写到 KV，管理员可在后台查看
    await env.GUESTBOOK_KV.put('pending-notification', JSON.stringify({
      to, subject, text, html, sent_at: new Date().toISOString(),
    }));
    return { ok: false, reason: 'no MAIL_API_KEY, notification saved to KV' };
  }
  
  // 使用 SendGrid API 发送邮件
  const r = await fetch('https://api.sendgrid.com/v3/mail/send', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      personalizations: [{ to: [{ email: to }] }],
      from: { email: from, name: '凡耘手记 · 留言板' },
      subject,
      content: [
        { type: 'text/plain', value: text },
        ...(html ? [{ type: 'text/html', value: html }] : []),
      ],
    }),
  });
  return { ok: r.ok, status: r.status };
}

// =============================================
// KV 数据操作
// =============================================

/**
 * 获取留言 ID 列表（索引）
 * 
 * @param {Object} env - 环境变量
 * @returns {Promise<string[]>} 留言 ID 数组
 */
async function getIndex(env) {
  const raw = await env.GUESTBOOK_KV.get('msg-index');
  if (!raw) return [];
  try { return JSON.parse(raw); } catch { return []; }
}

/**
 * 保存留言 ID 列表（索引）
 * 最多保留最近 200 条
 * 
 * @param {Object} env - 环境变量
 * @param {string[]} ids - 留言 ID 数组
 */
async function saveIndex(env, ids) {
  const trimmed = ids.slice(0, 200);
  await env.GUESTBOOK_KV.put('msg-index', JSON.stringify(trimmed));
}

// =============================================
// API 处理器
// =============================================

/**
 * 获取已审核通过的留言列表（公开接口）
 * 
 * @param {Object} env - 环境变量
 * @param {string|null} origin - 请求来源
 * @returns {Promise<Response>} HTTP 响应
 */
async function handleGetApproved(env, origin) {
  const ids = await getIndex(env);
  const results = [];
  
  // 遍历索引，获取每条留言详情
  for (const id of ids) {
    const raw = await env.GUESTBOOK_KV.get(`msg:${id}`);
    if (!raw) continue;
    try {
      const msg = JSON.parse(raw);
      // 只返回审核通过的留言
      if (msg.state === 'approved') results.push(msg);
    } catch {}
  }
  
  return jsonResponse({ ok: true, count: results.length, comments: results }, 200, origin);
}

/**
 * 处理新留言提交
 * 
 * @param {Object} env - 环境变量
 * @param {string|null} origin - 请求来源
 * @param {Request} request - HTTP 请求
 * @returns {Promise<Response>} HTTP 响应
 */
async function handleSubmit(env, origin, request) {
  // 来源检查
  if (!isOriginAllowed(origin, env)) {
    return jsonResponse({ error: '来源不被允许', origin }, 403, origin);
  }
  
  // 解析请求体
  let payload;
  try { payload = await request.json(); }
  catch (e) { return jsonResponse({ error: '请求体不是合法 JSON', detail: e.message }, 400, origin); }

  const { name, email, content, category } = payload || {};
  
  // 验证留言内容
  if (!content || typeof content !== 'string' || content.trim().length < 5) {
    return jsonResponse({ error: '留言内容至少 5 个字' }, 400, origin);
  }
  if (content.length > 1000) {
    return jsonResponse({ error: '留言内容不超过 1000 字' }, 400, origin);
  }
  
  // 验证邮箱格式
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return jsonResponse({ error: '邮箱格式不正确' }, 400, origin);
  }
  
  // 验证昵称长度
  if (name && name.length > 50) {
    return jsonResponse({ error: '昵称不超过 50 字' }, 400, origin);
  }

  // 生成留言 ID
  const id = makeId();
  
  // 构造留言对象
  const msg = {
    id,
    name: (name || '匿名访客').replace(/[\r\n]/g, ' '),
    email: (email || '').replace(/[\r\n]/g, ' '),
    content: content.trim(),
    category: category || 'general',
    state: 'pending',  // 默认为待审核状态
    created_at: new Date().toISOString(),
    ip: request.headers.get('CF-Connecting-IP') || 'unknown',  // 获取访客 IP
  };

  // 写入 KV 存储
  await env.GUESTBOOK_KV.put(`msg:${id}`, JSON.stringify(msg));
  const ids = await getIndex(env);
  ids.unshift(id);  // 新留言插入到数组头部
  await saveIndex(env, ids);

  // 构造审核链接，发送邮件通知站长
  const siteUrl = env.SITE_URL || 'https://fanren.tech';
  const approveUrl = `${siteUrl}/api/admin/approve?id=${id}&token=${env.ADMIN_TOKEN}`;
  const rejectUrl = `${siteUrl}/api/admin/reject?id=${id}&token=${env.ADMIN_TOKEN}`;
  
  const mailText = `程老师，您有一条新留言待审核：

昵称: ${msg.name}
${msg.email ? '邮箱: ' + msg.email : ''}
板块: ${msg.category}
时间: ${msg.created_at}
IP: ${msg.ip}

内容：
${msg.content}

✓ 通过: ${approveUrl}
✗ 拒绝: ${rejectUrl}

—— fanren.tech 留言板
`;

  // 发送通知邮件
  let mailStatus = { ok: false };
  if (env.ADMIN_EMAIL) {
    mailStatus = await sendMail(env, env.ADMIN_EMAIL, `💬 新留言待审核 from ${msg.name}`, mailText);
  }

  return jsonResponse({
    ok: true,
    id,
    state: 'pending',
    mail: mailStatus,
    message: '留言已提交，等待审核。审核通过后将在网站显示。',
  }, 201, origin);
}

/**
 * 验证管理员 Token
 * 
 * @param {URL} url - 请求 URL
 * @param {Object} env - 环境变量
 * @returns {boolean} 是否验证通过
 */
function checkAdminToken(url, env) {
  return url.searchParams.get('token') === env.ADMIN_TOKEN;
}

/**
 * 获取所有留言列表（管理员接口）
 * 
 * @param {Object} env - 环境变量
 * @param {string|null} origin - 请求来源
 * @param {URL} url - 请求 URL
 * @returns {Promise<Response>} HTTP 响应
 */
async function handleAdminList(env, origin, url) {
  if (!checkAdminToken(url, env)) {
    return jsonResponse({ error: '无效的 admin token' }, 403, origin);
  }
  
  const ids = await getIndex(env);
  const results = [];
  
  for (const id of ids) {
    const raw = await env.GUESTBOOK_KV.get(`msg:${id}`);
    if (!raw) continue;
    try {
      const msg = JSON.parse(raw);
      results.push({
        id: msg.id,
        name: msg.name,
        email: msg.email,
        content: msg.content,
        category: msg.category,
        state: msg.state,
        created_at: msg.created_at,
      });
    } catch {}
  }
  
  return jsonResponse({ ok: true, count: results.length, items: results }, 200, origin);
}

/**
 * 处理审核操作（通过/拒绝）
 * 
 * @param {Object} env - 环境变量
 * @param {string|null} origin - 请求来源
 * @param {URL} url - 请求 URL
 * @param {string} action - 操作类型（approve/reject）
 * @returns {Promise<Response>} HTTP 响应
 */
async function handleAdminAction(env, origin, url, action) {
  if (!checkAdminToken(url, env)) {
    return jsonResponse({ error: '无效的 admin token' }, 403, origin);
  }
  
  const id = url.searchParams.get('id');
  if (!id) return jsonResponse({ error: '缺少 id 参数' }, 400, origin);

  const raw = await env.GUESTBOOK_KV.get(`msg:${id}`);
  if (!raw) return jsonResponse({ error: '留言不存在' }, 404, origin);
  
  const msg = JSON.parse(raw);

  // 更新留言状态
  msg.state = action === 'approve' ? 'approved' : 'rejected';
  msg.reviewed_at = new Date().toISOString();
  await env.GUESTBOOK_KV.put(`msg:${id}`, JSON.stringify(msg));

  // 返回 HTML 页面（点击邮件链接时直接显示结果）
  const html = `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><title>审核结果</title>
<style>body{font-family:-apple-system,sans-serif;max-width:560px;margin:60px auto;padding:20px;text-align:center;color:#3a3528;background:#f5f3ee}
.card{background:#fff;border-radius:12px;padding:32px;box-shadow:0 4px 16px rgba(0,0,0,0.06)}
h1{color:${action==='approve'?'#7ba05b':'#c46a5a'}}
pre{background:#f5f3ee;padding:16px;border-radius:8px;text-align:left;white-space:pre-wrap;word-break:break-word}
a{color:#7c6f57;display:inline-block;margin-top:20px;text-decoration:none;border-bottom:1px solid #d8d2c4}
</style></head><body><div class="card">
<h1>${action==='approve'?'✅ 留言已通过':'✗ 留言已拒绝'}</h1>
<p>访客：<strong>${escapeHtml(msg.name)}</strong></p>
<pre>${escapeHtml(msg.content)}</pre>
<a href="${env.SITE_URL || 'https://fanren.tech'}/guestbook">← 返回留言板</a>
</div></body></html>`;

  return new Response(html, {
    status: 200,
    headers: { 'Content-Type': 'text/html; charset=utf-8', ...corsHeaders(origin) },
  });
}

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

// =============================================
// 主入口
// =============================================

/**
 * Cloudflare Worker 入口函数
 * 处理所有传入的 HTTP 请求
 * 
 * @param {Request} request - HTTP 请求
 * @param {Object} env - 环境变量（Cloudflare Bindings）
 * @param {Object} ctx - 上下文（用于异步操作）
 * @returns {Promise<Response>} HTTP 响应
 */
export default {
  async fetch(request, env, ctx) {
    const origin = request.headers.get('Origin');
    const url = new URL(request.url);
    const path = url.pathname;

    // 处理 OPTIONS 预检请求（CORS）
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }
    
    // 健康检查
    if (path === '/' || path === '/health') {
      return new Response('OK', { status: 200, headers: corsHeaders(origin) });
    }
    
    // 调试接口（生产环境可删除）
    if (path === '/__debug') {
      return jsonResponse({
        env_keys: Object.keys(env || {}),
        admin_email: env?.ADMIN_EMAIL,
        has_admin_token: !!env?.ADMIN_TOKEN,
        has_mail_api_key: !!env?.MAIL_API_KEY,
        site_url: env?.SITE_URL,
        mail_from: env?.MAIL_FROM,
        allowed_origin: env?.ALLOWED_ORIGIN,
        kv_id: env?.GUESTBOOK_KV?.id,
      }, 200, origin);
    }

    // 公开 API：获取已审核留言 / 提交新留言
    if (path === '/api/guestbook') {
      if (request.method === 'GET') return await handleGetApproved(env, origin);
      if (request.method === 'POST') return await handleSubmit(env, origin, request);
      return jsonResponse({ error: 'Method not allowed' }, 405, origin);
    }
    
    // 管理员 API：查看待审核列表
    if (path === '/api/admin/list') {
      return await handleAdminList(env, origin, url);
    }
    
    // 管理员 API：审核通过
    if (path === '/api/admin/approve') {
      return await handleAdminAction(env, origin, url, 'approve');
    }
    
    // 管理员 API：审核拒绝
    if (path === '/api/admin/reject') {
      return await handleAdminAction(env, origin, url, 'reject');
    }

    // 404：未匹配的路径
    return jsonResponse({ error: 'Not found', path }, 404, origin);
  },
};
