/**
 * SilkGateway - AI Tokens Global Relay
 * Cloudflare Workers 中转服务
 * 支持流式转发 (SSE) / 非流式转发 / 按用量计费
 * 
 * 部署：wrangler deploy
 */

// ============================================================
// 配置
// ============================================================

const CONFIG = {
  providers: {
    volcengine: {
      baseUrl: 'https://ark.cn-beijing.volces.com/api/plan/v3',
      apiKey: '',
    },
    deepseek: {
      baseUrl: 'https://api.deepseek.com/v1',
      apiKey: '',
    },
    kimi: {
      baseUrl: 'https://api.moonshot.cn/v1',
      apiKey: '',
    },
    mimo: {
      baseUrl: 'https://api.xiaomimimo.com/v1',
      apiKey: '',
    },
    openai: {
      baseUrl: 'https://api.openai.com/v1',
      apiKey: '',
    },
  },

  defaultProvider: 'volcengine',

  // 限流配置（每分钟）
  rateLimit: {
    free: 10,
    pro: 200,
    enterprise: 2000,
  },

  // 价格配置（每百万 token，美元）
  pricing: {
    // DeepSeek
    'deepseek-chat':       { input: 0.14,  output: 0.28, provider: 'deepseek' },
    'deepseek-reasoner':   { input: 0.55,  output: 2.19, provider: 'deepseek' },
    'deepseek-v4-pro':     { input: 0.55,  output: 2.19, provider: 'deepseek' },
    'deepseek-v4-flash':   { input: 0.14,  output: 0.28, provider: 'deepseek' },
    // 火山引擎
    'doubao-seed-2.0-pro': { input: 0.11,  output: 0.43, provider: 'volcengine' },
    'ark-code-latest':     { input: 0.11,  output: 0.43, provider: 'volcengine' },
    // Kimi
    'kimi-k2.6':           { input: 0.14,  output: 0.42, provider: 'kimi' },
    'moonshot-v1-128k':    { input: 0.14,  output: 0.42, provider: 'kimi' },
    // 小米 MiMo
    'mimo-v2.5':           { input: 0.10,  output: 0.30, provider: 'mimo' },
    'mimo-v2.5-pro':       { input: 0.10,  output: 0.30, provider: 'mimo' },
    // GLM
    'glm-5.1':             { input: 0.14,  output: 0.28, provider: 'volcengine' },
    // 默认
    'default':             { input: 0.14,  output: 0.28, provider: 'volcengine' },
  },

  // 会员折扣
  tierDiscount: { free: 0, pro: 0.1, enterprise: 0.2 },

  // 免费额度（每月 token）
  freeQuota: { free: 100_000, pro: 1_000_000, enterprise: 10_000_000 },
};

// ============================================================
// 工具函数
// ============================================================

function generateId() {
  return 'chatcmpl-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Api-Key',
    'Access-Control-Max-Age': '86400',
  };
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders() },
  });
}

// ============================================================
// API Key 鉴权
// ============================================================

function extractApiKey(request) {
  const authHeader = request.headers.get('Authorization');
  if (authHeader?.startsWith('Bearer ')) return authHeader.slice(7);
  const xApiKey = request.headers.get('X-Api-Key');
  if (xApiKey) return xApiKey;
  return new URL(request.url).searchParams.get('api_key');
}

async function authenticate(request, env) {
  const apiKey = extractApiKey(request);
  if (!apiKey) return { error: 'Missing API key', status: 401 };

  const keyInfo = await env.API_KEYS.get(apiKey, { type: 'json' });
  if (!keyInfo) return { error: 'Invalid API key', status: 401 };
  if (!keyInfo.active) return { error: 'API key is disabled', status: 403 };

  return { keyInfo, apiKey };
}

// ============================================================
// 限流
// ============================================================

async function checkRateLimit(apiKey, tier, env) {
  const now = Date.now();
  const windowMs = 60 * 1000;
  const limit = CONFIG.rateLimit[tier] || CONFIG.rateLimit.free;

  const key = `ratelimit:${apiKey}`;
  const data = await env.RATE_LIMIT_KV.get(key, { type: 'json' });
  let requests = data ? data.filter(ts => now - ts < windowMs) : [];

  if (requests.length >= limit) {
    return { allowed: false, limit, remaining: 0, resetAt: Math.ceil((requests[0] + windowMs) / 1000) };
  }

  requests.push(now);
  await env.RATE_LIMIT_KV.put(key, JSON.stringify(requests), { expirationTtl: 120 });

  return { allowed: true, limit, remaining: limit - requests.length, resetAt: Math.ceil((now + windowMs) / 1000) };
}

// ============================================================
// 计费系统
// ============================================================

async function recordUsage(env, apiKey, model, usage) {
  const now = new Date();
  const monthKey = now.toISOString().slice(0, 7);
  const dayKey = now.toISOString().slice(0, 10);

  const promptTokens = usage.prompt_tokens || 0;
  const completionTokens = usage.completion_tokens || 0;
  const totalTokens = promptTokens + completionTokens;

  const pricing = CONFIG.pricing[model] || CONFIG.pricing['default'];
  const cost = (promptTokens * pricing.input + completionTokens * pricing.output) / 1_000_000;

  // 月度统计 (KV)
  const monthData = await env.USAGE_LOG.get(`usage:${apiKey}:${monthKey}`, { type: 'json' }) || {
    month: monthKey, requests: 0, promptTokens: 0, completionTokens: 0, totalCost: 0, models: {},
  };
  monthData.requests += 1;
  monthData.promptTokens += promptTokens;
  monthData.completionTokens += completionTokens;
  monthData.totalCost += cost;
  if (!monthData.models[model]) monthData.models[model] = { requests: 0, tokens: 0, cost: 0 };
  monthData.models[model].requests += 1;
  monthData.models[model].tokens += totalTokens;
  monthData.models[model].cost += cost;
  await env.USAGE_LOG.put(`usage:${apiKey}:${monthKey}`, JSON.stringify(monthData), { expirationTtl: 86400 * 90 });

  // 每日统计 (KV)
  const dayData = await env.USAGE_LOG.get(`usage:${apiKey}:${dayKey}`, { type: 'json' }) || {
    date: dayKey, requests: 0, tokens: 0, cost: 0,
  };
  dayData.requests += 1;
  dayData.tokens += totalTokens;
  dayData.cost += cost;
  await env.USAGE_LOG.put(`usage:${apiKey}:${dayKey}`, JSON.stringify(dayData), { expirationTtl: 86400 * 7 });

  // 更新 D1 数据库中最近一条记录的 token 信息
  try {
    await env.DB.prepare(`
      UPDATE request_logs 
      SET api_key = ?, model = ?, prompt_tokens = ?, completion_tokens = ?, cost = ?
      WHERE id = (SELECT id FROM request_logs ORDER BY id DESC LIMIT 1)
    `).bind(apiKey, model, promptTokens, completionTokens, cost).run();
  } catch (err) {
    console.error('D1 update error:', err);
  }

  // 扣减余额
  const keyInfo = await env.API_KEYS.get(apiKey, { type: 'json' });
  if (keyInfo) {
    const tier = keyInfo.tier || 'free';
    const usedTokens = monthData.promptTokens + monthData.completionTokens;
    const freeQuota = CONFIG.freeQuota[tier] || CONFIG.freeQuota.free;

    if (usedTokens > freeQuota) {
      const discount = CONFIG.tierDiscount[tier] || 0;
      const finalCost = cost * (1 - discount);
      keyInfo.balance = Math.max(0, (keyInfo.balance || 0) - finalCost);
      await env.API_KEYS.put(apiKey, JSON.stringify(keyInfo));
    }
  }

  return { tokens: totalTokens, cost, model };
}

async function getBalance(env, apiKey) {
  const data = await env.API_KEYS.get(apiKey, { type: 'json' });
  return data?.balance || 0;
}

async function addBalance(env, apiKey, amount) {
  const data = await env.API_KEYS.get(apiKey, { type: 'json' });
  if (!data) throw new Error('Invalid API key');
  data.balance = (data.balance || 0) + amount;
  await env.API_KEYS.put(apiKey, JSON.stringify(data));
  return { balance: data.balance };
}

// ============================================================
// 流式转发
// ============================================================

async function handleStreaming(request, body, provider, apiKey, env, ctx) {
  const providerConfig = CONFIG.providers[provider];
  if (!providerConfig) return jsonResponse({ error: `Unknown provider: ${provider}` }, 400);

  const upstreamKey = providerConfig.apiKey || env[`${provider.toUpperCase()}_API_KEY`];
  if (!upstreamKey) return jsonResponse({ error: `Missing API key for provider: ${provider}` }, 500);

  const upstreamResponse = await fetch(`${providerConfig.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${upstreamKey}` },
    body: JSON.stringify({ ...body, stream: true }),
  });

  if (!upstreamResponse.ok) {
    const errorText = await upstreamResponse.text();
    return jsonResponse({ error: `Upstream API error: ${upstreamResponse.status}` }, upstreamResponse.status);
  }

  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  const encoder = new TextEncoder();

  let totalTokens = 0;
  let completionText = '';

  const pump = async () => {
    const reader = upstreamResponse.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        await writer.write(value);

        // 解析 SSE 数据用于计费
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (line.startsWith('data: ') && !line.includes('[DONE]')) {
            try {
              const data = JSON.parse(line.slice(6));
              if (data.choices?.[0]?.delta?.content) {
                completionText += data.choices[0].delta.content;
              }
              if (data.usage) {
                totalTokens = data.usage.total_tokens || 0;
              }
            } catch {}
          }
        }
      }
    } catch (err) {
      console.error('Stream error:', err);
    } finally {
      await writer.write(encoder.encode('data: [DONE]\n\n'));
      await writer.close();

      // 流结束后记录用量
      const promptTokens = body.messages.reduce((sum, m) => sum + Math.ceil((m.content?.length || 0) / 4), 0);
      const completionTokens = Math.ceil(completionText.length / 4);

      ctx.waitUntil(recordUsage(env, apiKey, body.model || 'default', {
        prompt_tokens: promptTokens,
        completion_tokens: completionTokens,
      }));
    }
  };

  pump();

  return new Response(readable, {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive', ...corsHeaders() },
  });
}

// ============================================================
// 非流式转发
// ============================================================

async function handleNonStreaming(request, body, provider, apiKey, env, ctx) {
  const providerConfig = CONFIG.providers[provider];
  if (!providerConfig) return jsonResponse({ error: `Unknown provider: ${provider}` }, 400);

  const upstreamKey = providerConfig.apiKey || env[`${provider.toUpperCase()}_API_KEY`];
  if (!upstreamKey) return jsonResponse({ error: `Missing API key for provider: ${provider}` }, 500);

  const upstreamResponse = await fetch(`${providerConfig.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${upstreamKey}` },
    body: JSON.stringify({ ...body, stream: false }),
  });

  if (!upstreamResponse.ok) {
    return jsonResponse({ error: `Upstream API error: ${upstreamResponse.status}` }, upstreamResponse.status);
  }

  const data = await upstreamResponse.json();

  // 记录用量
  if (data.usage) {
    ctx.waitUntil(recordUsage(env, apiKey, body.model || 'default', data.usage));
  }

  return jsonResponse(data);
}

// ============================================================
// 路由处理
// ============================================================

async function handleRequest(request, env, ctx) {
  const url = new URL(request.url);
  const path = url.pathname;

  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders() });
  }

  // 健康检查
  if (path === '/health') {
    return jsonResponse({ status: 'ok', service: 'SilkGateway', version: '1.1.0' });
  }

  // API 首页
  if (path === '/' || path === '/docs') {
    return jsonResponse({
      service: 'SilkGateway',
      description: 'AI Tokens Global Relay',
      endpoints: {
        chat: 'POST /v1/chat/completions',
        models: 'GET /v1/models',
        usage: 'GET /v1/usage',
        balance: 'GET /v1/balance',
        billing: 'GET /v1/billing',
        pricing: 'GET /v1/pricing',
        topup: 'POST /v1/topup',
      },
    });
  }

  // 模型列表
  if (path === '/v1/models' && request.method === 'GET') {
    return jsonResponse({
      object: 'list',
      data: Object.keys(CONFIG.pricing).filter(m => m !== 'default').map(id => ({
        id, object: 'model', owned_by: id.split('-')[0],
      })),
    });
  }

  // 价格查询
  if (path === '/v1/pricing' && request.method === 'GET') {
    return jsonResponse({
      models: Object.entries(CONFIG.pricing)
        .filter(([k]) => k !== 'default')
        .map(([name, price]) => ({
          name,
          input: `$${price.input}/M tokens`,
          output: `$${price.output}/M tokens`,
        })),
      tiers: [
        { name: 'Free', price: '$0/mo', quota: '100K tokens/mo', discount: '0%' },
        { name: 'Pro', price: '$29/mo', quota: '1M tokens/mo', discount: '10%' },
        { name: 'Enterprise', price: 'Custom', quota: '10M tokens/mo', discount: '20%' },
      ],
    });
  }

  // 余额查询
  if (path === '/v1/balance' && request.method === 'GET') {
    const auth = await authenticate(request, env);
    if (auth.error) return jsonResponse({ error: auth.error }, auth.status);
    const balance = await getBalance(env, auth.apiKey);
    return jsonResponse({ balance, currency: 'USD' });
  }

  // 充值（模拟）
  if (path === '/v1/topup' && request.method === 'POST') {
    const auth = await authenticate(request, env);
    if (auth.error) return jsonResponse({ error: auth.error }, auth.status);

    let body;
    try { body = await request.json(); } catch { return jsonResponse({ error: 'Invalid JSON' }, 400); }

    if (!body.amount || body.amount <= 0) {
      return jsonResponse({ error: 'Invalid amount' }, 400);
    }

    const result = await addBalance(env, auth.apiKey, body.amount);
    return jsonResponse({ success: true, ...result });
  }

  // 用量查询
  if (path === '/v1/usage' && request.method === 'GET') {
    const auth = await authenticate(request, env);
    if (auth.error) return jsonResponse({ error: auth.error }, auth.status);

    const month = url.searchParams.get('month') || new Date().toISOString().slice(0, 7);
    const data = await env.USAGE_LOG.get(`usage:${auth.apiKey}:${month}`, { type: 'json' }) || {
      month, requests: 0, promptTokens: 0, completionTokens: 0, totalCost: 0, models: {},
    };

    return jsonResponse(data);
  }

  // 月度账单
  if (path === '/v1/billing' && request.method === 'GET') {
    const auth = await authenticate(request, env);
    if (auth.error) return jsonResponse({ error: auth.error }, auth.status);

    const month = url.searchParams.get('month') || new Date().toISOString().slice(0, 7);
    const usage = await env.USAGE_LOG.get(`usage:${auth.apiKey}:${month}`, { type: 'json' }) || {
      month, requests: 0, promptTokens: 0, completionTokens: 0, totalCost: 0, models: {},
    };

    const balance = await getBalance(env, auth.apiKey);
    const tier = auth.keyInfo.tier || 'free';
    const freeQuota = CONFIG.freeQuota[tier] || CONFIG.freeQuota.free;
    const discount = CONFIG.tierDiscount[tier] || 0;

    return jsonResponse({
      month,
      tier,
      usage: {
        requests: usage.requests,
        promptTokens: usage.promptTokens,
        completionTokens: usage.completionTokens,
        totalTokens: usage.promptTokens + usage.completionTokens,
      },
      costs: {
        subtotal: usage.totalCost,
        discount: usage.totalCost * discount,
        total: usage.totalCost * (1 - discount),
      },
      quota: {
        free: freeQuota,
        used: usage.promptTokens + usage.completionTokens,
        remaining: Math.max(0, freeQuota - usage.promptTokens - usage.completionTokens),
      },
      balance,
      models: usage.models,
    });
  }

  // 用户注册
  if (path === '/api/register' && request.method === 'POST') {
    let body;
    try { body = await request.json(); } catch { return jsonResponse({ error: 'Invalid JSON' }, 400); }

    // 验证必填字段
    if (!body.email || !body.firstName || !body.lastName) {
      return jsonResponse({ error: 'Missing required fields: email, firstName, lastName' }, 400);
    }

    // 验证邮箱格式
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(body.email)) {
      return jsonResponse({ error: 'Invalid email format' }, 400);
    }

    // 检查邮箱是否已注册
    const existingUserKey = `user:${body.email}`;
    const existingUser = await env.API_KEYS.get(existingUserKey, { type: 'json' });
    if (existingUser) {
      return jsonResponse({ error: 'Email already registered', apiKey: existingUser.apiKey }, 409);
    }

    // 生成 API Key
    const randomBytes = new Uint8Array(24);
    crypto.getRandomValues(randomBytes);
    const apiKey = 'sk-' + Array.from(randomBytes, b => b.toString(16).padStart(2, '0')).join('');

    // 创建用户数据
    const tier = body.tier || 'free';
    const balance = tier === 'free' ? 0 : tier === 'pro' ? 0 : 0; // 需要充值才能使用

    const userData = {
      apiKey,
      email: body.email,
      firstName: body.firstName,
      lastName: body.lastName,
      company: body.company || '',
      useCase: body.useCase || '',
      tier,
      balance,
      active: true,
      createdAt: new Date().toISOString(),
    };

    // 保存用户数据
    await env.API_KEYS.put(existingUserKey, JSON.stringify(userData));

    // 保存 API Key -> 用户数据映射
    await env.API_KEYS.put(apiKey, JSON.stringify({
      userId: body.email,
      tier,
      provider: CONFIG.defaultProvider,
      active: true,
      balance,
      createdAt: userData.createdAt,
    }));

    // 返回 API Key
    return jsonResponse({
      success: true,
      apiKey,
      tier,
      message: 'Account created successfully',
    }, 201);
  }

  // 用户信息查询
  if (path === '/api/user' && request.method === 'GET') {
    const auth = await authenticate(request, env);
    if (auth.error) return jsonResponse({ error: auth.error }, auth.status);

    const userKey = `user:${auth.keyInfo.userId || ''}`;
    const userData = await env.API_KEYS.get(userKey, { type: 'json' });

    if (!userData) {
      return jsonResponse({ email: 'unknown', tier: auth.keyInfo.tier });
    }

    return jsonResponse({
      email: userData.email,
      firstName: userData.firstName,
      lastName: userData.lastName,
      company: userData.company,
      tier: userData.tier,
      balance: auth.keyInfo.balance || 0,
      createdAt: userData.createdAt,
    });
  }

  // Chat Completions
  if (path === '/v1/chat/completions' && request.method === 'POST') {
    const startTime = Date.now();

    // 鉴权
    const auth = await authenticate(request, env);
    if (auth.error) return jsonResponse({ error: auth.error }, auth.status);

    // 余额检查
    const balance = await getBalance(env, auth.apiKey);
    if (balance <= 0 && auth.keyInfo.tier !== 'free') {
      return jsonResponse({ error: 'Insufficient balance', balance: 0 }, 402);
    }

    // 限流
    const rateLimit = await checkRateLimit(auth.apiKey, auth.keyInfo.tier, env);
    if (!rateLimit.allowed) {
      return jsonResponse({ error: 'Rate limit exceeded', limit: rateLimit.limit, reset_at: rateLimit.resetAt }, 429);
    }

    // 解析请求
    let body;
    try { body = await request.json(); } catch { return jsonResponse({ error: 'Invalid JSON body' }, 400); }

    if (!body.messages || !Array.isArray(body.messages)) {
      return jsonResponse({ error: 'Missing or invalid messages array' }, 400);
    }

    // 从 model 的 pricing 配置中推断 provider
    const modelPricing = CONFIG.pricing[body.model] || CONFIG.pricing['default'];
    const provider = body._provider || modelPricing.provider || auth.keyInfo.provider || CONFIG.defaultProvider;
    const isStream = body.stream !== false;

    const cleanBody = { ...body };
    delete cleanBody._provider;

    // 转发
    const response = isStream
      ? await handleStreaming(request, cleanBody, provider, auth.apiKey, env, ctx)
      : await handleNonStreaming(request, cleanBody, provider, auth.apiKey, env, ctx);

    // 添加响应头
    const responseHeaders = new Headers(response.headers);
    responseHeaders.set('X-RateLimit-Limit', rateLimit.limit);
    responseHeaders.set('X-RateLimit-Remaining', rateLimit.remaining);
    responseHeaders.set('X-RateLimit-Reset', rateLimit.resetAt);
    responseHeaders.set('X-Request-Id', generateId());

    return new Response(response.body, { status: response.status, headers: responseHeaders });
  }

  // 监控端点
  if (path === '/v1/logs' && request.method === 'GET') {
    const type = url.searchParams.get('type') || 'all';
    const limit = parseInt(url.searchParams.get('limit') || '50');
    const logs = await getLogs(env, type, limit);
    return jsonResponse({ logs, count: logs.length });
  }

  if (path === '/v1/stats' && request.method === 'GET') {
    const stats = await getStats(env);
    return jsonResponse(stats);
  }

  // 用户每日用量统计
  if (path === '/v1/usage/daily' && request.method === 'GET') {
    const auth = await authenticate(request, env);
    if (auth.error) return jsonResponse({ error: auth.error }, auth.status);

    const days = parseInt(url.searchParams.get('days') || '7');
    const dailyUsage = await getDailyUsage(env, auth.apiKey, days);
    return jsonResponse(dailyUsage);
  }

  // 用户每小时用量统计
  if (path === '/v1/usage/hourly' && request.method === 'GET') {
    const auth = await authenticate(request, env);
    if (auth.error) return jsonResponse({ error: auth.error }, auth.status);

    const hourlyUsage = await getHourlyUsage(env, auth.apiKey);
    return jsonResponse(hourlyUsage);
  }

  return jsonResponse({ error: 'Not found', path }, 404);
}

// ============================================================
// Worker 入口
// ============================================================

export default {
  async fetch(request, env, ctx) {
    const startTime = Date.now();
    try {
      const response = await handleRequest(request, env, ctx);
      // 记录请求日志
      ctx.waitUntil(logRequest(env, request, response, startTime));
      return response;
    } catch (err) {
      console.error('Unhandled error:', err);
      const errorResponse = jsonResponse({ error: 'Internal server error' }, 500);
      ctx.waitUntil(logRequest(env, request, errorResponse, startTime));
      return errorResponse;
    }
  },
};

// ============================================================
// 监控和日志 (D1 版本)
// ============================================================

async function logRequest(env, request, response, startTime) {
  const duration = Date.now() - startTime;
  const url = new URL(request.url);
  
  try {
    await env.DB.prepare(`
      INSERT INTO request_logs (timestamp, method, path, status, duration, user_agent, country, ip)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      new Date().toISOString(),
      request.method,
      url.pathname,
      response.status,
      duration,
      request.headers.get('User-Agent')?.slice(0, 100) || '',
      request.headers.get('CF-IPCountry') || '',
      request.headers.get('CF-Connecting-IP') || ''
    ).run();
  } catch (err) {
    console.error('D1 log error:', err);
  }
}

async function getLogs(env, type = 'all', limit = 50) {
  let query = 'SELECT * FROM request_logs';
  if (type === 'error') {
    query += ' WHERE status >= 400';
  }
  query += ' ORDER BY timestamp DESC LIMIT ?';
  
  const { results } = await env.DB.prepare(query).bind(limit).all();
  return results || [];
}

async function getStats(env) {
  const today = new Date().toISOString().slice(0, 10);
  
  // 今日总请求数
  const { count: totalRequests } = await env.DB.prepare(
    'SELECT COUNT(*) as count FROM request_logs WHERE timestamp >= ?'
  ).bind(today + 'T00:00:00').first();
  
  // 今日错误数
  const { count: totalErrors } = await env.DB.prepare(
    'SELECT COUNT(*) as count FROM request_logs WHERE timestamp >= ? AND status >= 400'
  ).bind(today + 'T00:00:00').first();
  
  // 平均延迟
  const { avg_duration } = await env.DB.prepare(
    'SELECT AVG(duration) as avg_duration FROM request_logs WHERE timestamp >= ?'
  ).bind(today + 'T00:00:00').first();
  
  // Top 路径
  const { results: topPaths } = await env.DB.prepare(`
    SELECT path, COUNT(*) as count, SUM(CASE WHEN status >= 400 THEN 1 ELSE 0 END) as errors
    FROM request_logs WHERE timestamp >= ?
    GROUP BY path ORDER BY count DESC LIMIT 10
  `).bind(today + 'T00:00:00').all();
  
  // 状态码分布
  const { results: statusRows } = await env.DB.prepare(`
    SELECT 
      CASE 
        WHEN status BETWEEN 200 AND 299 THEN '2xx'
        WHEN status BETWEEN 300 AND 399 THEN '3xx'
        WHEN status BETWEEN 400 AND 499 THEN '4xx'
        WHEN status BETWEEN 500 AND 599 THEN '5xx'
        ELSE 'other'
      END as code_group,
      COUNT(*) as count
    FROM request_logs WHERE timestamp >= ?
    GROUP BY code_group
  `).bind(today + 'T00:00:00').all();
  
  const statusCodes = {};
  (statusRows || []).forEach(r => { statusCodes[r.code_group] = r.count; });
  
  // 国家统计
  const { results: countryRows } = await env.DB.prepare(`
    SELECT country, COUNT(*) as count
    FROM request_logs WHERE timestamp >= ?
    GROUP BY country ORDER BY count DESC LIMIT 10
  `).bind(today + 'T00:00:00').all();
  
  return {
    date: today,
    totalRequests: totalRequests || 0,
    totalErrors: totalErrors || 0,
    errorRate: totalRequests > 0 ? ((totalErrors / totalRequests) * 100).toFixed(2) + '%' : '0%',
    avgDuration: Math.round(avg_duration || 0) + 'ms',
    topPaths: (topPaths || []).map(p => ({ path: p.path, count: p.count, errors: p.errors })),
    statusCodes,
    countryStats: (countryRows || []).map(c => ({ country: c.country || 'Unknown', count: c.count })),
  };
}

async function getDailyUsage(env, apiKey, days = 7) {
  const now = new Date();
  const dailyData = [];
  
  for (let i = days - 1; i >= 0; i--) {
    const date = new Date(now);
    date.setDate(date.getDate() - i);
    const dateStr = date.toISOString().slice(0, 10);
    const nextDate = new Date(date);
    nextDate.setDate(nextDate.getDate() + 1);
    const nextDateStr = nextDate.toISOString().slice(0, 10);
    
    const { count: requests } = await env.DB.prepare(
      'SELECT COUNT(*) as count FROM request_logs WHERE timestamp >= ? AND timestamp < ?'
    ).bind(dateStr + 'T00:00:00', nextDateStr + 'T00:00:00').first();
    
    const { total_tokens } = await env.DB.prepare(
      'SELECT COALESCE(SUM(prompt_tokens + completion_tokens), 0) as total_tokens FROM request_logs WHERE timestamp >= ? AND timestamp < ?'
    ).bind(dateStr + 'T00:00:00', nextDateStr + 'T00:00:00').first();
    
    dailyData.push({
      date: dateStr,
      day: date.toLocaleDateString('en', { weekday: 'short' }),
      requests: requests || 0,
      tokens: total_tokens || 0,
    });
  }
  
  // 获取模型分布
  const startDate = new Date(now);
  startDate.setDate(startDate.getDate() - days);
  const { results: modelRows } = await env.DB.prepare(`
    SELECT 
      CASE 
        WHEN path LIKE '%chat%' THEN 'chat'
        WHEN path LIKE '%models%' THEN 'models'
        WHEN path LIKE '%balance%' THEN 'account'
        WHEN path LIKE '%billing%' THEN 'account'
        WHEN path LIKE '%usage%' THEN 'account'
        ELSE 'other'
      END as category,
      COUNT(*) as count
    FROM request_logs 
    WHERE timestamp >= ?
    GROUP BY category
  `).bind(startDate.toISOString().slice(0, 10) + 'T00:00:00').all();
  
  return {
    period: `${days} days`,
    daily: dailyData,
    categories: (modelRows || []).map(r => ({ category: r.category, count: r.count })),
    totalRequests: dailyData.reduce((sum, d) => sum + d.requests, 0),
    totalTokens: dailyData.reduce((sum, d) => sum + d.tokens, 0),
  };
}

async function getHourlyUsage(env, apiKey) {
  const now = new Date();
  const today = now.toISOString().slice(0, 10);
  const hourlyData = [];
  
  for (let hour = 0; hour < 24; hour++) {
    const hourStr = hour.toString().padStart(2, '0');
    const nextHourStr = (hour + 1).toString().padStart(2, '0');
    
    let query, params;
    if (hour < 23) {
      query = 'SELECT COUNT(*) as count FROM request_logs WHERE timestamp >= ? AND timestamp < ?';
      params = [`${today}T${hourStr}:00:00`, `${today}T${nextHourStr}:00:00`];
    } else {
      query = 'SELECT COUNT(*) as count FROM request_logs WHERE timestamp >= ?';
      params = [`${today}T${hourStr}:00:00`];
    }
    
    const { count: requests } = await env.DB.prepare(query).bind(...params).first();
    
    hourlyData.push({
      hour: hour,
      label: `${hourStr}:00`,
      requests: requests || 0,
    });
  }
  
  return {
    date: today,
    hourly: hourlyData,
    peakHour: hourlyData.reduce((max, h) => h.requests > max.requests ? h : max, hourlyData[0]),
  };
}
