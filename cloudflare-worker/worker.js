/**
 * fanren.tech 留言板 API（v2 · C1 方案）
 * Cloudflare Worker · 部署在 api.fanren.tech
 *
 * 数据存储: Cloudflare KV（不再依赖 GitHub Issues）
 * 审核流程: 访客提交 → state=pending → 邮件通知程老师 → 点链接审核
 *
 * Endpoints:
 *   GET  /api/guestbook                    -> 读取已审核留言（公开）
 *   POST /api/guestbook                    -> 提交留言（写 KV + 发邮件）
 *   GET  /api/admin/list?token=xxx         -> 看所有待审核（您专用）
 *   GET  /api/admin/approve?id=xxx&token=xxx -> 审核通过
 *   GET  /api/admin/reject?id=xxx&token=xxx  -> 审核拒绝
 *   GET  /__debug                         -> 调试（生产可删）
 *
 * KV key 格式:
 *   msg:{id}            -> 留言 JSON 详情
 *   msg-index           -> 所有留言 id 数组（最近 200 条）
 *
 * 环境变量（bindings）:
 *   ADMIN_TOKEN  (secret_text) - 您的审核口令（防别人乱点审核链接）
 *   ADMIN_EMAIL  (plain_text)  - 您接收审核通知的邮箱
 *   ALLOWED_ORIGIN (plain_text) - 允许的来源，例如 "https://fanren.tech"
 *   MAIL_FROM     (plain_text)  - 发件人，例如 "noreply@fanren.tech"
 *   SITE_URL      (plain_text)  - 网站 URL，例如 "https://fanren.tech"
 *   MAIL_DKIM_DOMAIN/DKIM_SELECTOR/PRIVATE_KEY (Email Workers 用)
 */

function corsHeaders(origin) {
  return {
    'Access-Control-Allow-Origin': origin || '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
  };
}

function jsonResponse(data, status = 200, origin) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      ...corsHeaders(origin),
    },
  });
}

function isOriginAllowed(origin, env) {
  if (!origin) return true;
  if (/^https?:\/\/([a-z0-9-]+\.)?fanren\.tech(:\d+)?$/i.test(origin)) return true;
  if (/^https?:\/\/localhost(:\d+)?$/i.test(origin)) return true;
  if (/^https?:\/\/127\.0\.0\.1(:\d+)?$/i.test(origin)) return true;
  return false;
}

function makeId() {
  // 简短 ID：时间戳 + 4 位随机
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

async function sendMail(env, to, subject, text, html) {
  // 用 Email Workers 发送（绑定域名后即可用）
  // 没配 DKIM 的话，先 fallback 到 fetch 一个简单的 webhook
  // 这里先实现 SendGrid 风格的 API key 方式（如果没配就跳过发送，登录控制台）
  const apiKey = env.MAIL_API_KEY;
  const from = env.MAIL_FROM || 'noreply@fanren.tech';
  if (!apiKey) {
    // 没配邮件 API：把通知写到 KV 一个特殊 key 里，前台 admin list 顺带显示
    await env.GUESTBOOK_KV.put('pending-notification', JSON.stringify({
      to, subject, text, html, sent_at: new Date().toISOString(),
    }));
    return { ok: false, reason: 'no MAIL_API_KEY, notification saved to KV' };
  }
  // SendGrid 风格
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

async function getIndex(env) {
  const raw = await env.GUESTBOOK_KV.get('msg-index');
  if (!raw) return [];
  try { return JSON.parse(raw); } catch { return []; }
}

async function saveIndex(env, ids) {
  // 只保留最近 200 条
  const trimmed = ids.slice(0, 200);
  await env.GUESTBOOK_KV.put('msg-index', JSON.stringify(trimmed));
}

async function handleGetApproved(env, origin) {
  const ids = await getIndex(env);
  const results = [];
  for (const id of ids) {
    const raw = await env.GUESTBOOK_KV.get(`msg:${id}`);
    if (!raw) continue;
    try {
      const msg = JSON.parse(raw);
      if (msg.state === 'approved') results.push(msg);
    } catch {}
  }
  return jsonResponse({ ok: true, count: results.length, comments: results }, 200, origin);
}

async function handleSubmit(env, origin, request) {
  if (!isOriginAllowed(origin, env)) {
    return jsonResponse({ error: '来源不被允许', origin }, 403, origin);
  }
  let payload;
  try { payload = await request.json(); }
  catch (e) { return jsonResponse({ error: '请求体不是合法 JSON', detail: e.message }, 400, origin); }

  const { name, email, content, category } = payload || {};
  if (!content || typeof content !== 'string' || content.trim().length < 5) {
    return jsonResponse({ error: '留言内容至少 5 个字' }, 400, origin);
  }
  if (content.length > 1000) {
    return jsonResponse({ error: '留言内容不超过 1000 字' }, 400, origin);
  }
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return jsonResponse({ error: '邮箱格式不正确' }, 400, origin);
  }
  if (name && name.length > 50) {
    return jsonResponse({ error: '昵称不超过 50 字' }, 400, origin);
  }

  const id = makeId();
  const msg = {
    id,
    name: (name || '匿名访客').replace(/[\r\n]/g, ' '),
    email: (email || '').replace(/[\r\n]/g, ' '),
    content: content.trim(),
    category: category || 'general',
    state: 'pending',
    created_at: new Date().toISOString(),
    ip: request.headers.get('CF-Connecting-IP') || 'unknown',
  };

  // 写 KV
  await env.GUESTBOOK_KV.put(`msg:${id}`, JSON.stringify(msg));
  const ids = await getIndex(env);
  ids.unshift(id);
  await saveIndex(env, ids);

  // 发邮件通知程老师
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

function checkAdminToken(url, env) {
  return url.searchParams.get('token') === env.ADMIN_TOKEN;
}

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

async function handleAdminAction(env, origin, url, action) {
  if (!checkAdminToken(url, env)) {
    return jsonResponse({ error: '无效的 admin token' }, 403, origin);
  }
  const id = url.searchParams.get('id');
  if (!id) return jsonResponse({ error: '缺少 id 参数' }, 400, origin);

  const raw = await env.GUESTBOOK_KV.get(`msg:${id}`);
  if (!raw) return jsonResponse({ error: '留言不存在' }, 404, origin);
  const msg = JSON.parse(raw);

  msg.state = action === 'approve' ? 'approved' : 'rejected';
  msg.reviewed_at = new Date().toISOString();
  await env.GUESTBOOK_KV.put(`msg:${id}`, JSON.stringify(msg));

  // 同时返回 HTML（点邮件链接时直接显示结果）
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

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({
    '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
  }[c]));
}

export default {
  async fetch(request, env, ctx) {
    const origin = request.headers.get('Origin');
    const url = new URL(request.url);
    const path = url.pathname;

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }
    if (path === '/' || path === '/health') {
      return new Response('OK', { status: 200, headers: corsHeaders(origin) });
    }
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

    if (path === '/api/guestbook') {
      if (request.method === 'GET') return await handleGetApproved(env, origin);
      if (request.method === 'POST') return await handleSubmit(env, origin, request);
      return jsonResponse({ error: 'Method not allowed' }, 405, origin);
    }
    if (path === '/api/admin/list') {
      return await handleAdminList(env, origin, url);
    }
    if (path === '/api/admin/approve') {
      return await handleAdminAction(env, origin, url, 'approve');
    }
    if (path === '/api/admin/reject') {
      return await handleAdminAction(env, origin, url, 'reject');
    }

    return jsonResponse({ error: 'Not found', path }, 404, origin);
  },
};
