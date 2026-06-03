/**
 * fanren.tech 留言板 API
 * Cloudflare Worker · 部署在 api.fanren.tech
 *
 * Endpoints:
 *   GET  /api/guestbook       -> 读取留言列表
 *   POST /api/guestbook       -> 创建新留言（创建 GitHub Issue）
 *
 * 环境变量（bindings）:
 *   GITHUB_TOKEN   (secret_text) - GitHub PAT
 *   GITHUB_REPO    (plain_text)  - 仓库，格式 "owner/repo"
 *   ALLOWED_ORIGIN (plain_text)  - 允许的来源，例如 "https://fanren.tech"
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
  const allowed = (env.ALLOWED_ORIGIN || 'https://fanren.tech').split(',').map(s => s.trim());
  if (!origin) return false;
  return allowed.some(a => origin === a || origin.startsWith(a.replace(/\/$/, '')));
}

async function handleGetComments(env, origin) {
  const url = `https://api.github.com/repos/${env.GITHUB_REPO}/issues?labels=guestbook&state=open&per_page=50&sort=created&direction=desc`;
  const r = await fetch(url, {
    headers: {
      'Authorization': `Bearer ${env.GITHUB_TOKEN}`,
      'Accept': 'application/vnd.github+json',
      'User-Agent': 'fanren-tech-guestbook-worker',
    },
  });
  if (!r.ok) {
    const err = await r.text();
    return jsonResponse({ error: 'GitHub API 读取失败', status: r.status, detail: err.slice(0, 500) }, r.status, origin);
  }
  const issues = await r.json();
  const comments = issues.filter(i => !i.pull_request).map(i => ({
    id: i.id,
    number: i.number,
    title: i.title,
    body: i.body,
    created_at: i.created_at,
    html_url: i.html_url,
  }));
  return jsonResponse({ ok: true, count: comments.length, comments }, 200, origin);
}

async function handlePostComment(env, origin, request) {
  if (!isOriginAllowed(origin, env)) {
    return jsonResponse({ error: '来源不被允许', origin, allowed: env.ALLOWED_ORIGIN }, 403, origin);
  }
  let payload;
  try {
    payload = await request.json();
  } catch (e) {
    return jsonResponse({ error: '请求体不是合法 JSON', detail: e.message }, 400, origin);
  }
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

  const safeName = (name || '匿名访客').replace(/[\r\n]/g, ' ');
  const safeEmail = (email || '').replace(/[\r\n]/g, ' ');
  const safeCategory = category || 'general';
  const body = `**昵称:** ${safeName}
**邮箱:** ${safeEmail}
**板块:** ${safeCategory}

---
${content.trim()}`;

  const url = `https://api.github.com/repos/${env.GITHUB_REPO}/issues`;
  let r;
  try {
    r = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${env.GITHUB_TOKEN}`,
        'Accept': 'application/vnd.github+json',
        'Content-Type': 'application/json',
        'User-Agent': 'fanren-tech-guestbook-worker',
      },
      body: JSON.stringify({
        title: `💬 留言 from ${safeName}`,
        body,
        labels: ['guestbook'],
      }),
    });
  } catch (e) {
    return jsonResponse({ error: '调用 GitHub API 异常', detail: e.message }, 502, origin);
  }

  if (!r.ok) {
    const err = await r.text();
    return jsonResponse({ error: '创建留言失败', status: r.status, detail: err.slice(0, 800) }, r.status, origin);
  }
  const issue = await r.json();
  return jsonResponse({
    ok: true,
    issue_number: issue.number,
    html_url: issue.html_url,
  }, 201, origin);
}

export default {
  async fetch(request, env, ctx) {
    const origin = request.headers.get('Origin');
    const url = new URL(request.url);
    const path = url.pathname;

    // 调试：把 env 关键值返回（生产可去掉）
    if (path === '/__debug') {
      return jsonResponse({
        env_keys: Object.keys(env || {}),
        github_repo: env?.GITHUB_REPO,
        allowed_origin: env?.ALLOWED_ORIGIN,
        has_token: !!env?.GITHUB_TOKEN,
      }, 200, origin);
    }

    // CORS 预检
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }

    // 健康检查
    if (path === '/' || path === '/health') {
      return new Response('OK', { status: 200, headers: corsHeaders(origin) });
    }

    if (path === '/api/guestbook') {
      if (request.method === 'GET') {
        return await handleGetComments(env, origin);
      }
      if (request.method === 'POST') {
        return await handlePostComment(env, origin, request);
      }
      return jsonResponse({ error: 'Method not allowed' }, 405, origin);
    }

    return jsonResponse({ error: 'Not found', path }, 404, origin);
  },
};
