/**
 * SilkGateway - AI Tokens Global Relay
 * Cloudflare Workers 中转服务
 * 支持流式转发 (SSE) / 非流式转发 / 按用量计费
 * 支持多账号 Key 池 / Combo 路由 / 格式互转 / RTK 压缩
 *
 * 部署：wrangler deploy
 */

// ============================================================
// 模块导入
// ============================================================

import { loadProviders, resolveModel, getAllModels, getAllPricing, getUpstreamKey, DEFAULT_PROVIDERS, DEFAULT_PRICING, saveProvider, deleteProvider, listAllProviders, testProvider } from './lib/providers.js';
import { getCredentials, markUnavailable, clearError, loadConnections, loadConnection, createConnection, deleteConnection, listAllConnections, saveConnection } from './lib/keypool.js';
import { isCombo, listCombos, createCombo, updateCombo, deleteCombo, handleComboChat } from './lib/combos.js';
import { detectFormat, translateRequest, translateResponseChunk, initState } from './lib/translator.js';
import { compressMessages, formatRtkLog } from './lib/rtk.js';
import { checkFallbackError } from './lib/shared.js';
import { hashPassword, verifyPassword, validatePassword, signJWT, verifyJWT, generateToken, generateApiKey } from './lib/auth.js';
import { sendVerificationEmail, sendWelcomeEmail, sendPasswordResetEmail, sendPasswordChangedNotification } from './lib/email.js';

// ============================================================
// 配置 (保留作为降级默认值,实际运行时从 KV 加载)
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
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Api-Key, X-Admin-Secret, X-RTK',
    'Access-Control-Max-Age': '86400',
  };
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders() },
  });
}

function htmlResponse(html, status = 200) {
  return new Response(html, {
    status,
    headers: { 'Content-Type': 'text/html; charset=utf-8', ...corsHeaders() },
  });
}

function verifyResultPage(type, title, message, apiKey) {
  const color = type === 'success' ? '#4ade80' : type === 'error' ? '#f87171' : '#c9a84c';
  const apiKeySection = apiKey ? `
    <div style="background:#16161f;border:1px solid rgba(255,255,255,0.1);border-radius:8px;padding:16px;margin:24px 0">
      <p style="color:#8b8b9a;font-size:13px;margin:0 0 8px">Your API Key (save it now, shown only once):</p>
      <code style="color:${BRAND_COLOR || '#c9a84c'};font-size:14px;word-break:break-all">${apiKey}</code>
    </div>` : '';
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${title}</title></head>
<body style="margin:0;padding:0;background:#0a0a0f;font-family:sans-serif">
<div style="max-width:480px;margin:0 auto;padding:60px 24px;text-align:center">
  <div style="font-size:48px;margin-bottom:24px">${type === 'success' ? '✅' : type === 'error' ? '❌' : 'ℹ️'}</div>
  <h1 style="color:${color};font-size:24px;margin:0 0 16px">${title}</h1>
  <p style="color:#8b8b9a;font-size:15px;line-height:1.6">${message}</p>
  ${apiKeySection}
  <div style="margin-top:32px">
    <a href="/dashboard/" style="display:inline-block;padding:12px 32px;background:#c9a84c;color:#0a0a0f;text-decoration:none;font-weight:600;border-radius:8px">Go to Dashboard</a>
  </div>
</div>
</body></html>`;
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
// JWT 鉴权 (Dashboard 登录会话)
// ============================================================

async function authenticateJWT(request, env) {
  const authHeader = request.headers.get('Authorization');
  if (!authHeader?.startsWith('Bearer ')) return { error: 'Missing token', status: 401 };

  const token = authHeader.slice(7);
  // JWT 格式: header.payload.signature (3 段),API Key 格式: sk-xxx (1 段)
  if (token.split('.').length !== 3) return { error: 'Invalid token format', status: 401 };

  const payload = await verifyJWT(token, env.JWT_SECRET);
  if (!payload) return { error: 'Invalid or expired token', status: 401 };

  // 检查 JWT 黑名单 (登出)
  if (payload.jti) {
    const blacklisted = await env.API_KEYS.get(`jwt:blacklist:${payload.jti}`);
    if (blacklisted) return { error: 'Token revoked', status: 401 };
  }

  return { payload, token };
}

/**
 * 混合认证: 优先 JWT,降级 API Key
 */
async function authenticateAny(request, env) {
  // 先尝试 JWT
  const jwtResult = await authenticateJWT(request, env);
  if (!jwtResult.error) {
    // JWT 认证成功,加载用户数据
    const userData = await env.API_KEYS.get(`user:${jwtResult.payload.email}`, { type: 'json' });
    if (userData) {
      return { user: userData, authType: 'jwt', payload: jwtResult.payload };
    }
  }

  // 降级 API Key
  const apiKeyResult = await authenticate(request, env);
  if (!apiKeyResult.error) {
    const userData = await env.API_KEYS.get(`user:${apiKeyResult.keyInfo.userId}`, { type: 'json' });
    return { user: userData, keyInfo: apiKeyResult.keyInfo, apiKey: apiKeyResult.apiKey, authType: 'apikey' };
  }

  return { error: 'Authentication required', status: 401 };
}

// ============================================================
// 限流
// ============================================================

async function checkRateLimit(apiKey, tier, env) {
  const now = Date.now();
  const windowMs = 60 * 1000;
  const limit = CONFIG.rateLimit[tier] || CONFIG.rateLimit.free;

  // 固定窗口计数器：key 含分钟级时间戳，避免存储无界时间戳数组
  const windowStart = Math.floor(now / windowMs) * windowMs;
  const key = `ratelimit:${apiKey}:${windowStart}`;
  const count = parseInt(await env.RATE_LIMIT_KV.get(key) || '0', 10);

  if (count >= limit) {
    return { allowed: false, limit, remaining: 0, resetAt: Math.ceil((windowStart + windowMs) / 1000) };
  }

  await env.RATE_LIMIT_KV.put(key, String(count + 1), { expirationTtl: 120 });

  return { allowed: true, limit, remaining: limit - count - 1, resetAt: Math.ceil((windowStart + windowMs) / 1000) };
}

// ============================================================
// 管理员鉴权
// ============================================================

function authenticateAdmin(request, env) {
  const adminSecret = env.ADMIN_SECRET;
  // 未配置 ADMIN_SECRET 时拒绝访问，避免默认放行
  if (!adminSecret) return { error: 'Admin access not configured', status: 503 };
  const provided = request.headers.get('X-Admin-Secret') || new URL(request.url).searchParams.get('admin_secret');
  if (!provided || provided !== adminSecret) return { error: 'Unauthorized', status: 401 };
  return { ok: true };
}

// ============================================================
// 计费系统
// ============================================================

/**
 * 获取模型价格:优先 KV 自定义价格 -> provider 配置 -> 硬编码默认
 */
async function getPricingForModel(env, model, providers) {
  // 1. KV 自定义价格
  try {
    const customPricing = await env.API_KEYS.get(`pricing:${model}`, { type: 'json' });
    if (customPricing && customPricing.input !== undefined) {
      return { input: customPricing.input, output: customPricing.output };
    }
  } catch {}

  // 2. Provider 配置中的模型价格
  if (providers) {
    for (const p of Object.values(providers)) {
      if (p.models && p.models[model]) {
        return { input: p.models[model].input, output: p.models[model].output };
      }
    }
  }

  // 3. 硬编码默认价格
  const defaultPricing = CONFIG.pricing[model] || CONFIG.pricing['default'];
  return { input: defaultPricing.input, output: defaultPricing.output };
}

/**
 * 设置模型自定义价格 (管理员)
 */
async function setPricing(env, model, input, output) {
  const pricing = { input, output, updatedAt: new Date().toISOString() };
  await env.API_KEYS.put(`pricing:${model}`, JSON.stringify(pricing));
  return pricing;
}

/**
 * 删除模型自定义价格 (重置为默认)
 */
async function deletePricing(env, model) {
  await env.API_KEYS.delete(`pricing:${model}`);
}

/**
 * 获取所有价格 (合并 KV 自定义 + provider 配置 + 默认)
 */
async function getAllPricingWithOverrides(env, providers) {
  const result = {};

  // 默认价格
  for (const [model, pricing] of Object.entries(CONFIG.pricing)) {
    if (model === 'default') continue;
    result[model] = { input: pricing.input, output: pricing.output, source: 'default' };
  }

  // Provider 配置价格
  if (providers) {
    for (const [providerId, p] of Object.entries(providers)) {
      if (!p.models) continue;
      for (const [model, pricing] of Object.entries(p.models)) {
        result[model] = { input: pricing.input, output: pricing.output, source: `provider:${providerId}` };
      }
    }
  }

  // KV 自定义价格 (最高优先级)
  try {
    const list = await env.API_KEYS.list({ prefix: 'pricing:' });
    for (const key of list.keys) {
      const model = key.name.slice('pricing:'.length);
      const data = await env.API_KEYS.get(key.name, { type: 'json' });
      if (data) {
        result[model] = { input: data.input, output: data.output, source: 'custom', updatedAt: data.updatedAt };
      }
    }
  } catch {}

  return result;
}

async function recordUsage(env, apiKey, model, usage, requestId, metadata = {}) {
  const now = new Date();
  const monthKey = now.toISOString().slice(0, 7);
  const dayKey = now.toISOString().slice(0, 10);

  const promptTokens = usage.prompt_tokens || 0;
  const completionTokens = usage.completion_tokens || 0;
  const totalTokens = promptTokens + completionTokens;

  // 提取 cache tokens (Claude/OpenAI prompt caching)
  const cacheReadTokens = usage.cache_read_tokens
    || usage.prompt_tokens_details?.cached_tokens
    || usage.cache_read_input_tokens
    || 0;
  const cacheWriteTokens = usage.cache_write_tokens
    || usage.cache_creation_input_tokens
    || 0;

  // 价格查找:KV 自定义 -> provider 配置 -> 硬编码默认
  const pricing = await getPricingForModel(env, model, metadata.providers);
  // cache read 通常有折扣 (Claude: 10% 价格), 这里简化为全价
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

  // 通过 request_id 精确回填本条请求的 token 信息，避免并发串号
  if (requestId) {
    try {
      await env.DB.prepare(`
        UPDATE request_logs
        SET api_key = ?, model = ?, prompt_tokens = ?, completion_tokens = ?,
            cache_read_tokens = ?, cache_write_tokens = ?, cost = ?,
            combo_name = ?, provider_id = ?
        WHERE request_id = ?
      `).bind(
        apiKey, model, promptTokens, completionTokens,
        cacheReadTokens, cacheWriteTokens, cost,
        metadata.comboName || null, metadata.providerId || null,
        requestId
      ).run();
    } catch (err) {
      console.error('D1 update error:', err);
    }
  }

  // 扣减余额 + 写入交易流水
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

      // 写入消费交易流水
      try {
        await env.DB.prepare(`
          INSERT INTO transactions (timestamp, api_key, type, amount, balance_after, model, prompt_tokens, completion_tokens, description, request_id)
          VALUES (?, ?, 'consumption', ?, ?, ?, ?, ?, ?, ?)
        `).bind(
          now.toISOString(), apiKey, -finalCost, keyInfo.balance,
          model, promptTokens, completionTokens,
          `Token usage: ${totalTokens} tokens (${model})`, requestId
        ).run();
      } catch (err) {
        console.error('Transaction log error:', err);
      }
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

  // 写入充值交易流水
  try {
    await env.DB.prepare(`
      INSERT INTO transactions (timestamp, api_key, type, amount, balance_after, description)
      VALUES (?, ?, 'topup', ?, ?, ?)
    `).bind(
      new Date().toISOString(), apiKey, amount, data.balance,
      `Balance top-up: $${amount}`
    ).run();
  } catch (err) {
    console.error('Topup transaction log error:', err);
  }

  return { balance: data.balance };
}

// ============================================================
// 单模型上游调用 (含 keypool failover)
// ============================================================

// ============================================================
// 上游请求构建
// ============================================================

/**
 * 根据 provider 配置构建上游请求头
 * 支持不同 authType: bearer (OpenAI/DeepSeek) vs x-api-key (Anthropic)
 */
function buildUpstreamHeaders(providerConfig, upstreamKey) {
  const headers = { 'Content-Type': 'application/json' };
  const authType = providerConfig.authType || 'bearer';

  if (authType === 'x-api-key') {
    headers['x-api-key'] = upstreamKey;
    headers['anthropic-version'] = '2023-06-01';
  } else {
    headers['Authorization'] = `Bearer ${upstreamKey}`;
  }

  // 合并 provider 自定义 headers (如 User-Agent 绕过 WAF)
  if (providerConfig.headers && typeof providerConfig.headers === 'object') {
    Object.assign(headers, providerConfig.headers);
  }

  return headers;
}

/**
 * 构建上游请求体,确保流式时包含 stream_options 以获取真实 usage
 */
function buildUpstreamBody(body, isStream) {
  const upstreamBody = { ...body };
  if (isStream) {
    upstreamBody.stream = true;
    // 确保 OpenAI 兼容 provider 在流末尾返回 usage
    upstreamBody.stream_options = { include_usage: true };
  } else {
    upstreamBody.stream = false;
  }
  return upstreamBody;
}

/**
 * 尝试用指定 provider 和模型调用上游,自动处理 keypool failover
 * @returns {Promise<{ ok: boolean, response: Response, status: number, error: string, resetsAtMs: number }>}
 */
async function executeWithKeyPool(env, ctx, requestId, userApiKey, providerConfig, providerId, model, body, isStream, sourceFormat, metadata = {}) {
  const excludeConnIds = new Set();
  let lastError = null;
  let lastStatus = 503;

  // 将 providerId 合入 metadata 供 recordUsage 使用
  const usageMetadata = { ...metadata, providerId };

  while (true) {
    // 从 keypool 获取凭据
    const creds = await getCredentials(env, providerId, model, excludeConnIds, {
      strategy: 'fill-first',
      stickyLimit: 3,
    });

    if (!creds) {
      return { ok: false, status: 503, error: 'No active credentials for provider: ' + providerId };
    }

    if (creds.allRateLimited) {
      const resetsAtMs = creds.retryAfter ? Date.now() + creds.retryAfter * 1000 : null;
      return {
        ok: false,
        status: 503,
        error: creds.lastError || 'All connections rate limited',
        resetsAtMs,
      };
    }

    const upstreamKey = getUpstreamKey(providerConfig, creds.apiKey, env);
    if (!upstreamKey) {
      excludeConnIds.add(creds.connectionId);
      lastError = 'Missing API key for provider: ' + providerId;
      lastStatus = 500;
      continue;
    }

    // 调用上游
    const result = isStream
      ? await handleStreaming(env, ctx, requestId, userApiKey, providerConfig, upstreamKey, body, model, sourceFormat, usageMetadata)
      : await handleNonStreaming(env, ctx, requestId, userApiKey, providerConfig, upstreamKey, body, model, sourceFormat, usageMetadata);

    if (result.ok) {
      // 成功:清除该连接的错误状态
      await clearError(env, creds.connectionId, providerId, model);
      return result;
    }

    // 失败:标记连接不可用
    const markResult = await markUnavailable(env, creds.connectionId, providerId, result.status, result.error, model, result.resetsAtMs);

    if (!markResult.shouldFallback) {
      // 不可 fallback 的错误,直接返回
      return result;
    }

    // 排除该连接,继续尝试下一个
    excludeConnIds.add(creds.connectionId);
    lastError = result.error;
    lastStatus = result.status;

    // 继续循环尝试下一个账号
  }
}

// ============================================================
// 流式转发
// ============================================================

async function handleStreaming(env, ctx, requestId, userApiKey, providerConfig, upstreamKey, body, model, sourceFormat, metadata = {}) {
  const upstreamResponse = await fetch(`${providerConfig.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: buildUpstreamHeaders(providerConfig, upstreamKey),
    body: JSON.stringify(buildUpstreamBody(body, true)),
  });

  if (!upstreamResponse.ok) {
    const errorText = await upstreamResponse.text();
    return { ok: false, status: upstreamResponse.status, error: errorText };
  }

  const targetFormat = providerConfig.format || 'openai';
  const needTranslate = sourceFormat && sourceFormat !== targetFormat && sourceFormat !== 'openai';

  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  const encoder = new TextEncoder();

  let upstreamUsage = null;
  let completionText = '';
  let translateState = null;

  if (needTranslate) {
    translateState = initState(model);
  }

  const pump = async () => {
    const reader = upstreamResponse.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        // 如果需要翻译,解析每个 SSE chunk 并翻译
        if (needTranslate) {
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() || '';

          for (const line of lines) {
            if (line.startsWith('data: ') && !line.includes('[DONE]')) {
              try {
                const data = JSON.parse(line.slice(6));
                if (data.usage) upstreamUsage = data.usage;
                if (data.choices?.[0]?.delta?.content) {
                  completionText += data.choices[0].delta.content;
                }
                // 翻译 chunk 到目标格式
                const translated = translateResponseChunk('openai', sourceFormat, data, translateState);
                if (translated && translated.length > 0) {
                  for (const chunk of translated) {
                    await writer.write(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
                  }
                }
              } catch {}
            } else if (line.startsWith('data: [DONE]')) {
              await writer.write(encoder.encode('data: [DONE]\n\n'));
            }
          }
        } else {
          // 不需要翻译,直接透传
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
                  upstreamUsage = data.usage;
                }
              } catch {}
            }
          }
        }
      }
    } catch (err) {
      console.error('Stream error:', err);
    } finally {
      if (!needTranslate) {
        await writer.write(encoder.encode('data: [DONE]\n\n'));
      }
      await writer.close();

      // 流结束后记录用量
      const usage = upstreamUsage || {
        prompt_tokens: body.messages ? body.messages.reduce((sum, m) => sum + Math.ceil((m.content?.length || 0) / 4), 0) : 0,
        completion_tokens: Math.ceil(completionText.length / 4),
      };

      ctx.waitUntil(recordUsage(env, userApiKey, model || 'default', usage, requestId, metadata));
    }
  };

  pump();

  return {
    ok: true,
    response: new Response(readable, {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive', ...corsHeaders() },
    }),
  };
}

// ============================================================
// 非流式转发
// ============================================================

async function handleNonStreaming(env, ctx, requestId, userApiKey, providerConfig, upstreamKey, body, model, sourceFormat, metadata = {}) {
  const upstreamResponse = await fetch(`${providerConfig.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: buildUpstreamHeaders(providerConfig, upstreamKey),
    body: JSON.stringify(buildUpstreamBody(body, false)),
  });

  if (!upstreamResponse.ok) {
    const errorText = await upstreamResponse.text();
    return { ok: false, status: upstreamResponse.status, error: errorText };
  }

  let data = await upstreamResponse.json();

  // 格式翻译 (OpenAI -> Claude 等)
  const targetFormat = providerConfig.format || 'openai';
  if (sourceFormat && sourceFormat !== targetFormat && sourceFormat !== 'openai') {
    try {
      // 对非流式响应,把完整 JSON 当作一个 chunk 翻译
      const state = initState(model);
      const translated = translateResponseChunk('openai', sourceFormat, data, state);
      if (translated && translated.length > 0) {
        // 取最后一个 chunk 作为最终结果(通常包含完整内容)
        data = translated[translated.length - 1];
      }
    } catch (err) {
      console.error('Response translation error:', err);
    }
  }

  // 记录用量
  if (data.usage) {
    ctx.waitUntil(recordUsage(env, userApiKey, model || 'default', data.usage, requestId, metadata));
  }

  return { ok: true, response: jsonResponse(data) };
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
    const providers = await loadProviders(env);
    const models = getAllModels(providers);
    return jsonResponse({ object: 'list', data: models });
  }

  // 价格查询
  if (path === '/v1/pricing' && request.method === 'GET') {
    const providers = await loadProviders(env);
    const pricing = getAllPricing(providers);
    return jsonResponse({
      models: Object.entries(pricing).map(([name, price]) => ({
        name,
        input: `$${price.input}/M tokens`,
        output: `$${price.output}/M tokens`,
        provider: price.provider,
      })),
      tiers: [
        { name: 'Free', price: '$0/mo', quota: '100K tokens/mo', discount: '0%' },
        { name: 'Pro', price: '$29/mo', quota: '1M tokens/mo', discount: '10%' },
        { name: 'Enterprise', price: 'Custom', quota: '10M tokens/mo', discount: '20%' },
      ],
    });
  }

  // Combo 列表 (公开)
  if (path === '/v1/combos' && request.method === 'GET') {
    const combos = await listCombos(env);
    return jsonResponse({ combos });
  }

  // 余额查询
  if (path === '/v1/balance' && request.method === 'GET') {
    const auth = await authenticate(request, env);
    if (auth.error) return jsonResponse({ error: auth.error }, auth.status);
    const balance = await getBalance(env, auth.apiKey);
    return jsonResponse({ balance, currency: 'USD' });
  }

  // 充值（需管理员鉴权；接入 Stripe webhook 后在此校验支付凭证）
  if (path === '/v1/topup' && request.method === 'POST') {
    const admin = authenticateAdmin(request, env);
    if (admin.error) return jsonResponse({ error: admin.error }, admin.status);

    let body;
    try { body = await request.json(); } catch { return jsonResponse({ error: 'Invalid JSON' }, 400); }

    const amount = Number(body.amount);
    if (!Number.isFinite(amount) || amount <= 0) {
      return jsonResponse({ error: 'Invalid amount' }, 400);
    }
    // 金额上限，防止误操作或滥用
    const MAX_TOPUP = 1000;
    if (amount > MAX_TOPUP) {
      return jsonResponse({ error: `Amount exceeds maximum (${MAX_TOPUP})` }, 400);
    }

    // 支持管理员给任意 apiKey 充值；若未指定则报错（不再用调用方身份充值）
    const targetKey = body.api_key;
    if (!targetKey) {
      return jsonResponse({ error: 'Missing api_key to top up' }, 400);
    }

    const result = await addBalance(env, targetKey, amount);
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

  // 用户注册 (含密码 + 邮箱验证)
  if (path === '/api/register' && request.method === 'POST') {
    let body;
    try { body = await request.json(); } catch { return jsonResponse({ error: 'Invalid JSON' }, 400); }

    // 验证必填字段
    if (!body.email || !body.firstName || !body.lastName) {
      return jsonResponse({ error: 'Missing required fields: email, firstName, lastName' }, 400);
    }
    if (!body.password) {
      return jsonResponse({ error: 'Password is required' }, 400);
    }

    // 验证邮箱格式
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(body.email)) {
      return jsonResponse({ error: 'Invalid email format' }, 400);
    }

    // 验证密码强度
    const passwordCheck = validatePassword(body.password);
    if (!passwordCheck.valid) {
      return jsonResponse({ error: passwordCheck.error }, 400);
    }

    // 检查邮箱是否已注册 (安全:不泄露 apiKey)
    const existingUserKey = `user:${body.email}`;
    const existingUser = await env.API_KEYS.get(existingUserKey, { type: 'json' });
    if (existingUser) {
      return jsonResponse({ error: 'Email already registered. Please log in or use forgot password.' }, 409);
    }

    // 哈希密码
    const { hash: passwordHash, salt: passwordSalt } = await hashPassword(body.password);

    // 创建用户数据 (未验证状态,暂不生成 API Key)
    const tier = body.tier || 'free';
    const userData = {
      email: body.email,
      firstName: body.firstName,
      lastName: body.lastName,
      company: body.company || '',
      useCase: body.useCase || '',
      tier,
      balance: 0,
      active: true,
      passwordHash,
      passwordSalt,
      emailVerified: false,
      apiKey: null,
      createdAt: new Date().toISOString(),
    };

    // 保存用户数据
    await env.API_KEYS.put(existingUserKey, JSON.stringify(userData));

    // 生成邮箱验证 token (TTL 24h)
    const verifyToken = generateToken(32);
    const baseUrl = new URL(request.url).origin;
    const verifyUrl = `${baseUrl}/api/verify-email?token=${verifyToken}`;
    await env.API_KEYS.put(`verifytoken:${verifyToken}`, JSON.stringify({
      email: body.email,
      expires: Date.now() + 24 * 60 * 60 * 1000,
    }), { expirationTtl: 86400 });

    // 发送验证邮件
    await sendVerificationEmail(env, body.email, verifyUrl);

    return jsonResponse({
      success: true,
      message: 'Account created! Please check your email to verify your account and get your API key.',
      email: body.email,
    }, 201);
  }

  // 邮箱验证
  if (path === '/api/verify-email' && request.method === 'GET') {
    const token = url.searchParams.get('token');
    if (!token) return jsonResponse({ error: 'Missing verification token' }, 400);

    // 读取 token
    const tokenData = await env.API_KEYS.get(`verifytoken:${token}`, { type: 'json' });
    if (!tokenData) {
      return htmlResponse(verifyResultPage('error', 'Invalid or expired verification link', 'The link may have already been used or expired. Please request a new one.'));
    }

    // 检查过期
    if (tokenData.expires < Date.now()) {
      await env.API_KEYS.delete(`verifytoken:${token}`);
      return htmlResponse(verifyResultPage('error', 'Verification link expired', 'Please request a new verification email.'));
    }

    // 加载用户
    const userKey = `user:${tokenData.email}`;
    const userData = await env.API_KEYS.get(userKey, { type: 'json' });
    if (!userData) {
      return htmlResponse(verifyResultPage('error', 'Account not found', 'User account no longer exists.'));
    }

    if (userData.emailVerified) {
      await env.API_KEYS.delete(`verifytoken:${token}`);
      return htmlResponse(verifyResultPage('info', 'Already verified', 'Your email is already verified.'));
    }

    // 验证成功:生成 API Key,标记已验证
    const apiKey = generateApiKey();
    userData.emailVerified = true;
    userData.apiKey = apiKey;
    await env.API_KEYS.put(userKey, JSON.stringify(userData));

    // 保存 API Key -> 用户映射
    await env.API_KEYS.put(apiKey, JSON.stringify({
      userId: userData.email,
      tier: userData.tier,
      provider: CONFIG.defaultProvider,
      active: true,
      balance: userData.balance,
      createdAt: userData.createdAt,
    }));

    // 删除 token (一次性)
    await env.API_KEYS.delete(`verifytoken:${token}`);

    // 发送欢迎邮件
    await sendWelcomeEmail(env, userData.email, apiKey, userData.firstName);

    // 返回成功页面 (含 API Key,提示仅此一次)
    return htmlResponse(verifyResultPage('success', 'Email Verified!', 'Your account is now active. Your API key has been sent to your email.', apiKey));
  }

  // 重新发送验证邮件
  if (path === '/api/resend-verification' && request.method === 'POST') {
    let body;
    try { body = await request.json(); } catch { return jsonResponse({ error: 'Invalid JSON' }, 400); }
    if (!body.email) return jsonResponse({ error: 'Email is required' }, 400);

    const userKey = `user:${body.email}`;
    const userData = await env.API_KEYS.get(userKey, { type: 'json' });

    // 不泄露邮箱是否存在
    if (!userData) {
      return jsonResponse({ success: true, message: 'If the email exists and is unverified, a new verification link has been sent.' });
    }

    if (userData.emailVerified) {
      return jsonResponse({ error: 'Email is already verified' }, 400);
    }

    // 防滥用:检查上次发送时间 (1 分钟限制)
    const lastSentKey = `verifylastsent:${body.email}`;
    const lastSent = await env.API_KEYS.get(lastSentKey);
    if (lastSent) {
      return jsonResponse({ error: 'Please wait 1 minute before requesting another email' }, 429);
    }

    // 生成新 token
    const verifyToken = generateToken(32);
    const baseUrl = new URL(request.url).origin;
    const verifyUrl = `${baseUrl}/api/verify-email?token=${verifyToken}`;
    await env.API_KEYS.put(`verifytoken:${verifyToken}`, JSON.stringify({
      email: body.email,
      expires: Date.now() + 24 * 60 * 60 * 1000,
    }), { expirationTtl: 86400 });

    // 记录发送时间 (1 分钟 TTL)
    await env.API_KEYS.put(lastSentKey, '1', { expirationTtl: 60 });

    await sendVerificationEmail(env, body.email, verifyUrl);

    return jsonResponse({ success: true, message: 'Verification email sent. Please check your inbox.' });
  }

  // 登录 (邮箱 + 密码 -> JWT)
  if (path === '/api/login' && request.method === 'POST') {
    let body;
    try { body = await request.json(); } catch { return jsonResponse({ error: 'Invalid JSON' }, 400); }

    if (!body.email || !body.password) {
      return jsonResponse({ error: 'Email and password are required' }, 400);
    }

    const userKey = `user:${body.email}`;
    const userData = await env.API_KEYS.get(userKey, { type: 'json' });
    if (!userData) {
      return jsonResponse({ error: 'Invalid email or password' }, 401);
    }

    // 验证密码
    if (!userData.passwordHash || !userData.passwordSalt) {
      return jsonResponse({ error: 'Account not set up for password login. Please reset your password.' }, 401);
    }

    const passwordValid = await verifyPassword(body.password, userData.passwordHash, userData.passwordSalt);
    if (!passwordValid) {
      return jsonResponse({ error: 'Invalid email or password' }, 401);
    }

    // 检查邮箱验证
    if (!userData.emailVerified) {
      return jsonResponse({ error: 'Email not verified. Please check your inbox or resend verification.', needsVerification: true }, 403);
    }

    // 签发 JWT
    const token = await signJWT({
      email: userData.email,
      tier: userData.tier,
    }, env.JWT_SECRET || 'default-jwt-secret-change-me');

    return jsonResponse({
      success: true,
      token,
      user: {
        email: userData.email,
        firstName: userData.firstName,
        lastName: userData.lastName,
        tier: userData.tier,
        balance: userData.balance || 0,
      },
    });
  }

  // 登出 (JWT 黑名单)
  if (path === '/api/logout' && request.method === 'POST') {
    const authHeader = request.headers.get('Authorization');
    if (authHeader?.startsWith('Bearer ')) {
      const token = authHeader.slice(7);
      const payload = await verifyJWT(token, env.JWT_SECRET || 'default-jwt-secret-change-me');
      if (payload && payload.jti && payload.exp) {
        const ttl = payload.exp - Math.floor(Date.now() / 1000);
        if (ttl > 0) {
          await env.API_KEYS.put(`jwt:blacklist:${payload.jti}`, '1', { expirationTtl: ttl });
        }
      }
    }
    return jsonResponse({ success: true, message: 'Logged out' });
  }

  // 忘记密码
  if (path === '/api/forgot-password' && request.method === 'POST') {
    let body;
    try { body = await request.json(); } catch { return jsonResponse({ error: 'Invalid JSON' }, 400); }
    if (!body.email) return jsonResponse({ error: 'Email is required' }, 400);

    // 不泄露邮箱是否存在 (始终返回相同消息)
    const genericResponse = jsonResponse({
      success: true,
      message: 'If the email is registered, a password reset link has been sent.',
    });

    const userKey = `user:${body.email}`;
    const userData = await env.API_KEYS.get(userKey, { type: 'json' });
    if (!userData) return genericResponse;

    // 防滥用:1 分钟限制
    const lastSentKey = `resetlastsent:${body.email}`;
    const lastSent = await env.API_KEYS.get(lastSentKey);
    if (lastSent) {
      return jsonResponse({ error: 'Please wait 1 minute before requesting another reset email' }, 429);
    }

    // 生成重置 token (TTL 1h)
    const resetToken = generateToken(32);
    const baseUrl = new URL(request.url).origin;
    const resetUrl = `${baseUrl}/reset-password/?token=${resetToken}`;
    await env.API_KEYS.put(`resettoken:${resetToken}`, JSON.stringify({
      email: body.email,
      expires: Date.now() + 60 * 60 * 1000,
    }), { expirationTtl: 3600 });

    await env.API_KEYS.put(lastSentKey, '1', { expirationTtl: 60 });

    await sendPasswordResetEmail(env, body.email, resetUrl);

    return genericResponse;
  }

  // 重置密码
  if (path === '/api/reset-password' && request.method === 'POST') {
    let body;
    try { body = await request.json(); } catch { return jsonResponse({ error: 'Invalid JSON' }, 400); }

    if (!body.token || !body.newPassword) {
      return jsonResponse({ error: 'Token and new password are required' }, 400);
    }

    // 验证密码强度
    const passwordCheck = validatePassword(body.newPassword);
    if (!passwordCheck.valid) {
      return jsonResponse({ error: passwordCheck.error }, 400);
    }

    // 读取 reset token
    const tokenData = await env.API_KEYS.get(`resettoken:${body.token}`, { type: 'json' });
    if (!tokenData) {
      return jsonResponse({ error: 'Invalid or expired reset token' }, 400);
    }

    if (tokenData.expires < Date.now()) {
      await env.API_KEYS.delete(`resettoken:${body.token}`);
      return jsonResponse({ error: 'Reset token expired' }, 400);
    }

    // 更新密码
    const userKey = `user:${tokenData.email}`;
    const userData = await env.API_KEYS.get(userKey, { type: 'json' });
    if (!userData) {
      return jsonResponse({ error: 'Account not found' }, 400);
    }

    const { hash: passwordHash, salt: passwordSalt } = await hashPassword(body.newPassword);
    userData.passwordHash = passwordHash;
    userData.passwordSalt = passwordSalt;
    await env.API_KEYS.put(userKey, JSON.stringify(userData));

    // 删除 token (一次性)
    await env.API_KEYS.delete(`resettoken:${body.token}`);

    // 发送通知邮件
    await sendPasswordChangedNotification(env, tokenData.email);

    return jsonResponse({ success: true, message: 'Password reset successfully. Please log in with your new password.' });
  }

  // 重置 API Key (需 JWT 认证)
  if (path === '/api/reset-api-key' && request.method === 'POST') {
    const authResult = await authenticateJWT(request, env);
    if (authResult.error) return jsonResponse({ error: authResult.error }, authResult.status);

    const userKey = `user:${authResult.payload.email}`;
    const userData = await env.API_KEYS.get(userKey, { type: 'json' });
    if (!userData) return jsonResponse({ error: 'Account not found' }, 404);

    // 删除旧 API Key
    if (userData.apiKey) {
      await env.API_KEYS.delete(userData.apiKey);
    }

    // 生成新 API Key
    const newApiKey = generateApiKey();
    userData.apiKey = newApiKey;
    await env.API_KEYS.put(userKey, JSON.stringify(userData));

    // 保存新 API Key -> 用户映射
    await env.API_KEYS.put(newApiKey, JSON.stringify({
      userId: userData.email,
      tier: userData.tier,
      provider: CONFIG.defaultProvider,
      active: true,
      balance: userData.balance || 0,
      createdAt: userData.createdAt,
    }));

    return jsonResponse({ success: true, apiKey: newApiKey, message: 'API key reset. The old key is no longer valid.' });
  }

  // 用户信息查询 (支持 JWT 和 API Key 双模式)
  if (path === '/api/user' && request.method === 'GET') {
    const authResult = await authenticateAny(request, env);
    if (authResult.error) return jsonResponse({ error: authResult.error }, authResult.status || 401);

    // JWT 模式:返回完整信息(含 apiKey)
    if (authResult.authType === 'jwt' && authResult.user) {
      const u = authResult.user;
      return jsonResponse({
        email: u.email,
        firstName: u.firstName,
        lastName: u.lastName,
        company: u.company,
        tier: u.tier,
        balance: u.balance || 0,
        createdAt: u.createdAt,
        apiKey: u.apiKey || null,
        emailVerified: u.emailVerified || false,
      });
    }

    // API Key 模式:返回基本信息(不含 apiKey)
    const auth = { keyInfo: authResult.keyInfo, apiKey: authResult.apiKey };
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

  // Chat Completions (OpenAI 格式) 和 Messages (Claude 格式)
  if ((path === '/v1/chat/completions' || path === '/v1/messages') && request.method === 'POST') {
    const startTime = Date.now();
    const requestId = generateId();

    // 鉴权
    const auth = await authenticate(request, env);
    if (auth.error) return jsonResponse({ error: auth.error }, auth.status);

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

    // 余额/额度检查
    const tier = auth.keyInfo.tier || 'free';
    if (tier !== 'free') {
      const balance = await getBalance(env, auth.apiKey);
      if (balance <= 0) {
        return jsonResponse({ error: 'Insufficient balance', balance: 0 }, 402);
      }
    } else {
      const monthKey = new Date().toISOString().slice(0, 7);
      const monthUsage = await env.USAGE_LOG.get(`usage:${auth.apiKey}:${monthKey}`, { type: 'json' });
      const usedTokens = (monthUsage?.promptTokens || 0) + (monthUsage?.completionTokens || 0);
      const freeQuota = CONFIG.freeQuota.free;
      if (usedTokens >= freeQuota) {
        return jsonResponse({ error: 'Free quota exceeded', quota: freeQuota, used: usedTokens }, 402);
      }
    }

    // 检测请求格式 (OpenAI / Claude)
    const sourceFormat = detectFormat(path, body);
    const isStream = body.stream !== false;

    // 加载 providers
    const providers = await loadProviders(env);

    // 获取请求模型名
    const requestedModel = body.model || 'default';

    // 检查是否是 combo
    const combo = await isCombo(requestedModel, env);

    // RTK 压缩 (在翻译之前,直接压缩原始 body)
    const rtkEnabled = auth.keyInfo.rtkEnabled !== false && request.headers.get('X-RTK') !== 'off';
    let rtkStats = null;
    try {
      rtkStats = compressMessages(body, rtkEnabled);
    } catch (err) {
      console.error('RTK error:', err);
    }

    // 清理内部字段
    const cleanBody = { ...body };
    delete cleanBody._provider;

    // 格式翻译:如果 sourceFormat 是 claude,翻译为 openai 格式给上游
    let upstreamBody = cleanBody;
    if (sourceFormat === 'claude') {
      try {
        upstreamBody = translateRequest('claude', 'openai', requestedModel, cleanBody, isStream);
        // 翻译后可能改变 model 字段,确保保留
        if (!upstreamBody.model) upstreamBody.model = requestedModel;
      } catch (err) {
        console.error('Request translation error:', err);
        // 翻译失败则用原始 body
      }
    }

    let response;
    let actualModel = requestedModel;

    if (combo) {
      // Combo 路由:遍历模型列表
      const result = await handleComboChat(env, upstreamBody, combo, async (model, modelOverride) => {
        const modelResolved = resolveModel(model, providers);
        if (!modelResolved) {
          return { ok: false, status: 404, error: `Unknown model: ${model}` };
        }

        // 如果有 modelOverride,用 override 名调上游,但计费仍用原始 model 名
        const modelBody = { ...upstreamBody, model: modelOverride || model };
        const result = await executeWithKeyPool(
          env, ctx, requestId, auth.apiKey,
          modelResolved.providerConfig, modelResolved.providerId,
          model, modelBody, isStream, sourceFormat,
          { comboName: combo.name, providers }
        );

        if (result.ok) {
          return { ok: true, response: result.response };
        }
        return { ok: false, status: result.status, error: result.error, resetsAtMs: result.resetsAtMs };
      });

      response = result.response || jsonResponse({ error: result.error || 'All models failed' }, result.status || 503);
      // combo.models 可能是对象数组或字符串数组,取第一个模型名
      const firstModel = typeof combo.models[0] === 'string' ? combo.models[0] : (combo.models[0]?.model || 'combo');
      actualModel = firstModel;
    } else {
      // 单模型路由
      const modelResolved = resolveModel(requestedModel, providers);
      if (!modelResolved) {
        return jsonResponse({ error: `Unknown model: ${requestedModel}` }, 400);
      }

      const result = await executeWithKeyPool(
        env, ctx, requestId, auth.apiKey,
        modelResolved.providerConfig, modelResolved.providerId,
        requestedModel, upstreamBody, isStream, sourceFormat,
        { providers }
      );

      if (!result.ok) {
        const errorStatus = result.status || 502;
        return jsonResponse({ error: result.error || 'Upstream error', status: errorStatus }, errorStatus);
      }

      response = result.response;
    }

    // 添加响应头
    const responseHeaders = new Headers(response.headers);
    responseHeaders.set('X-RateLimit-Limit', String(rateLimit.limit));
    responseHeaders.set('X-RateLimit-Remaining', String(rateLimit.remaining));
    responseHeaders.set('X-RateLimit-Reset', String(rateLimit.resetAt));
    responseHeaders.set('X-Request-Id', requestId);

    // RTK 压缩统计
    if (rtkStats) {
      responseHeaders.set('X-RTK-Saved', formatRtkLog(rtkStats));
    }

    return new Response(response.body, { status: response.status, headers: responseHeaders });
  }

  // ============================================================
  // 管理端点:Provider 管理
  // ============================================================

  if (path === '/v1/admin/providers' && request.method === 'GET') {
    const admin = authenticateAdmin(request, env);
    if (admin.error) return jsonResponse({ error: admin.error }, admin.status);
    const providers = await listAllProviders(env);
    return jsonResponse({ providers });
  }

  if (path === '/v1/admin/providers' && request.method === 'POST') {
    const admin = authenticateAdmin(request, env);
    if (admin.error) return jsonResponse({ error: admin.error }, admin.status);
    let body;
    try { body = await request.json(); } catch { return jsonResponse({ error: 'Invalid JSON' }, 400); }
    if (!body.id || !body.baseUrl) return jsonResponse({ error: 'Missing id or baseUrl' }, 400);
    const provider = await saveProvider(env, body);
    return jsonResponse({ success: true, provider });
  }

  if (path.startsWith('/v1/admin/providers/') && request.method === 'DELETE') {
    const admin = authenticateAdmin(request, env);
    if (admin.error) return jsonResponse({ error: admin.error }, admin.status);
    const providerId = path.slice('/v1/admin/providers/'.length);
    await deleteProvider(env, providerId);
    return jsonResponse({ success: true });
  }

  if (path.match(/^\/v1\/admin\/providers\/[^/]+\/test$/) && request.method === 'POST') {
    const admin = authenticateAdmin(request, env);
    if (admin.error) return jsonResponse({ error: admin.error }, admin.status);
    const providerId = path.split('/')[4];
    const providers = await listAllProviders(env);
    const providerConfig = providers.find(p => p.id === providerId);
    if (!providerConfig) return jsonResponse({ error: 'Provider not found' }, 404);
    const result = await testProvider(providerConfig, env);
    return jsonResponse(result);
  }

  // ============================================================
  // 管理端点:Connection (Key Pool) 管理
  // ============================================================

  if (path === '/v1/admin/connections' && request.method === 'GET') {
    const admin = authenticateAdmin(request, env);
    if (admin.error) return jsonResponse({ error: admin.error }, admin.status);
    const connections = await listAllConnections(env);
    return jsonResponse({ connections });
  }

  if (path === '/v1/admin/connections' && request.method === 'POST') {
    const admin = authenticateAdmin(request, env);
    if (admin.error) return jsonResponse({ error: admin.error }, admin.status);
    let body;
    try { body = await request.json(); } catch { return jsonResponse({ error: 'Invalid JSON' }, 400); }
    if (!body.provider || !body.apiKey) return jsonResponse({ error: 'Missing provider or apiKey' }, 400);
    const conn = await createConnection(env, body.provider, {
      apiKey: body.apiKey,
      priority: body.priority || 100,
      name: body.name || '',
    });
    return jsonResponse({ success: true, connection: { ...conn, apiKey: conn.apiKey.slice(0, 8) + '...' } }, 201);
  }

  if (path.startsWith('/v1/admin/connections/') && request.method === 'PUT') {
    const admin = authenticateAdmin(request, env);
    if (admin.error) return jsonResponse({ error: admin.error }, admin.status);
    const parts = path.slice('/v1/admin/connections/'.length).split('/');
    const providerId = parts[0];
    const connId = parts[1];
    let body;
    try { body = await request.json(); } catch { return jsonResponse({ error: 'Invalid JSON' }, 400); }
    const conn = await loadConnection(env, providerId, connId);
    if (!conn) return jsonResponse({ error: 'Connection not found' }, 404);
    if (body.active !== undefined) conn.active = body.active;
    if (body.priority !== undefined) conn.priority = body.priority;
    if (body.name !== undefined) conn.name = body.name;
    if (body.apiKey) conn.apiKey = body.apiKey;
    await saveConnection(env, conn);
    return jsonResponse({ success: true, connection: { ...conn, apiKey: conn.apiKey.slice(0, 8) + '...' } });
  }

  if (path.startsWith('/v1/admin/connections/') && request.method === 'DELETE') {
    const admin = authenticateAdmin(request, env);
    if (admin.error) return jsonResponse({ error: admin.error }, admin.status);
    const parts = path.slice('/v1/admin/connections/'.length).split('/');
    const providerId = parts[0];
    const connId = parts[1];
    await deleteConnection(env, providerId, connId);
    return jsonResponse({ success: true });
  }

  // ============================================================
  // 管理端点:Combo 管理
  // ============================================================

  if (path === '/v1/admin/combos' && request.method === 'POST') {
    const admin = authenticateAdmin(request, env);
    if (admin.error) return jsonResponse({ error: admin.error }, admin.status);
    let body;
    try { body = await request.json(); } catch { return jsonResponse({ error: 'Invalid JSON' }, 400); }
    try {
      const combo = await createCombo(env, body);
      return jsonResponse({ success: true, combo }, 201);
    } catch (err) {
      return jsonResponse({ error: err.message }, 400);
    }
  }

  if (path.startsWith('/v1/admin/combos/') && request.method === 'PUT') {
    const admin = authenticateAdmin(request, env);
    if (admin.error) return jsonResponse({ error: admin.error }, admin.status);
    const name = path.slice('/v1/admin/combos/'.length);
    let body;
    try { body = await request.json(); } catch { return jsonResponse({ error: 'Invalid JSON' }, 400); }
    try {
      const combo = await updateCombo(env, name, body);
      return jsonResponse({ success: true, combo });
    } catch (err) {
      return jsonResponse({ error: err.message }, 404);
    }
  }

  if (path.startsWith('/v1/admin/combos/') && request.method === 'DELETE') {
    const admin = authenticateAdmin(request, env);
    if (admin.error) return jsonResponse({ error: admin.error }, admin.status);
    const name = path.slice('/v1/admin/combos/'.length);
    await deleteCombo(env, name);
    return jsonResponse({ success: true });
  }

  // 监控端点（需管理员鉴权）
  if (path === '/v1/logs' && request.method === 'GET') {
    const admin = authenticateAdmin(request, env);
    if (admin.error) return jsonResponse({ error: admin.error }, admin.status);
    const type = url.searchParams.get('type') || 'all';
    const limit = parseInt(url.searchParams.get('limit') || '50');
    const logs = await getLogs(env, type, limit);
    return jsonResponse({ logs, count: logs.length });
  }

  if (path === '/v1/stats' && request.method === 'GET') {
    const admin = authenticateAdmin(request, env);
    if (admin.error) return jsonResponse({ error: admin.error }, admin.status);
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

  // 按维度用量查询 (管理员:按 combo/provider/day 聚合)
  if (path === '/v1/usage/aggregate' && request.method === 'GET') {
    const admin = authenticateAdmin(request, env);
    if (admin.error) return jsonResponse({ error: admin.error }, admin.status);

    const groupBy = url.searchParams.get('group_by') || 'combo'; // combo | provider | day
    const days = parseInt(url.searchParams.get('days') || '30');
    const sinceDate = new Date();
    sinceDate.setDate(sinceDate.getDate() - days);
    const sinceStr = sinceDate.toISOString().slice(0, 10) + 'T00:00:00';

    let groupExpr, extraSelect = '';
    switch (groupBy) {
      case 'provider':
        groupExpr = 'COALESCE(provider_id, "unknown")';
        break;
      case 'day':
        groupExpr = 'substr(timestamp, 1, 10)';
        extraSelect = 'substr(timestamp, 1, 10) as period,';
        break;
      case 'combo':
      default:
        groupExpr = 'COALESCE(combo_name, model)';
        break;
    }

    try {
      const { results } = await env.DB.prepare(`
        SELECT ${extraSelect}
               ${groupExpr} as ${groupBy},
               COUNT(*) as request_count,
               SUM(prompt_tokens) as total_input_tokens,
               SUM(completion_tokens) as total_output_tokens,
               SUM(COALESCE(cache_read_tokens, 0)) as total_cache_read,
               SUM(COALESCE(cache_write_tokens, 0)) as total_cache_write,
               SUM(prompt_tokens + completion_tokens) as total_tokens,
               SUM(cost) as total_cost,
               SUM(CASE WHEN status >= 200 AND status < 300 THEN 1 ELSE 0 END) as success_count,
               SUM(CASE WHEN status >= 400 THEN 1 ELSE 0 END) as error_count
        FROM request_logs
        WHERE timestamp >= ?
        GROUP BY ${groupExpr}
        ORDER BY total_tokens DESC
      `).bind(sinceStr).all();

      return jsonResponse({
        group_by: groupBy,
        days,
        since: sinceStr,
        rows: results || [],
      });
    } catch (err) {
      console.error('Aggregate query error:', err);
      return jsonResponse({ error: 'Query failed (database columns may need migration)' }, 500);
    }
  }

  // ============================================================
  // 多维度时间序列统计
  // ============================================================

  // 用户级 timeseries (查自己的)
  if (path === '/v1/usage/timeseries' && request.method === 'GET') {
    const auth = await authenticate(request, env);
    if (auth.error) return jsonResponse({ error: auth.error }, auth.status);

    const result = await getTimeseries(env, {
      granularity: url.searchParams.get('granularity') || 'day',
      period: url.searchParams.get('period') || 'week',
      from: url.searchParams.get('from'),
      to: url.searchParams.get('to'),
      groupBy: url.searchParams.get('group_by') || 'none',
      apiKey: auth.apiKey,
      isAdmin: false,
    });
    return jsonResponse(result);
  }

  // 管理员级 timeseries (查全局或指定 key)
  if (path === '/v1/admin/usage/timeseries' && request.method === 'GET') {
    const admin = authenticateAdmin(request, env);
    if (admin.error) return jsonResponse({ error: admin.error }, admin.status);

    const result = await getTimeseries(env, {
      granularity: url.searchParams.get('granularity') || 'day',
      period: url.searchParams.get('period') || 'week',
      from: url.searchParams.get('from'),
      to: url.searchParams.get('to'),
      groupBy: url.searchParams.get('group_by') || 'none',
      apiKey: url.searchParams.get('api_key') || null,
      isAdmin: true,
    });
    return jsonResponse(result);
  }

  // ============================================================
  // 价格管理 (管理员)
  // ============================================================

  if (path === '/v1/admin/pricing' && request.method === 'GET') {
    const admin = authenticateAdmin(request, env);
    if (admin.error) return jsonResponse({ error: admin.error }, admin.status);
    const providers = await loadProviders(env);
    const pricing = await getAllPricingWithOverrides(env, providers);
    return jsonResponse({ pricing });
  }

  if (path.startsWith('/v1/admin/pricing/') && request.method === 'PUT') {
    const admin = authenticateAdmin(request, env);
    if (admin.error) return jsonResponse({ error: admin.error }, admin.status);
    const modelName = decodeURIComponent(path.slice('/v1/admin/pricing/'.length));
    let body;
    try { body = await request.json(); } catch { return jsonResponse({ error: 'Invalid JSON' }, 400); }
    if (typeof body.input !== 'number' || typeof body.output !== 'number') {
      return jsonResponse({ error: 'Missing input/output price' }, 400);
    }
    const result = await setPricing(env, modelName, body.input, body.output);
    return jsonResponse({ success: true, model: modelName, pricing: result });
  }

  if (path.startsWith('/v1/admin/pricing/') && request.method === 'DELETE') {
    const admin = authenticateAdmin(request, env);
    if (admin.error) return jsonResponse({ error: admin.error }, admin.status);
    const modelName = decodeURIComponent(path.slice('/v1/admin/pricing/'.length));
    await deletePricing(env, modelName);
    return jsonResponse({ success: true, model: modelName, message: 'Reset to default' });
  }

  // ============================================================
  // 交易流水与账单
  // ============================================================

  // 用户查询自己的交易流水
  if (path === '/v1/transactions' && request.method === 'GET') {
    const auth = await authenticate(request, env);
    if (auth.error) return jsonResponse({ error: auth.error }, auth.status);
    const transactions = await getTransactions(env, auth.apiKey, {
      type: url.searchParams.get('type') || 'all',
      days: parseInt(url.searchParams.get('days') || '30'),
      isAdmin: false,
    });
    return jsonResponse({ transactions, count: transactions.length });
  }

  // 管理员查询交易流水 (可指定 key)
  if (path === '/v1/admin/transactions' && request.method === 'GET') {
    const admin = authenticateAdmin(request, env);
    if (admin.error) return jsonResponse({ error: admin.error }, admin.status);
    const transactions = await getTransactions(env, null, {
      type: url.searchParams.get('type') || 'all',
      days: parseInt(url.searchParams.get('days') || '30'),
      isAdmin: true,
      targetKey: url.searchParams.get('api_key'),
    });
    return jsonResponse({ transactions, count: transactions.length });
  }

  // 账单汇总
  if (path === '/v1/billing/statement' && request.method === 'GET') {
    const auth = await authenticate(request, env);
    if (auth.error) return jsonResponse({ error: auth.error }, auth.status);
    const statement = await getBillingStatement(env, auth.apiKey, url.searchParams.get('month'));
    return jsonResponse(statement);
  }

  return jsonResponse({ error: 'Not found', path }, 404);
}

// ============================================================
// Worker 入口
// ============================================================

export default {
  async fetch(request, env, ctx) {
    const startTime = Date.now();
    const requestId = generateId();
    try {
      const response = await handleRequest(request, env, ctx, requestId);
      // 记录请求日志
      ctx.waitUntil(logRequest(env, request, response, startTime, requestId));
      return response;
    } catch (err) {
      console.error('Unhandled error:', err);
      const errorResponse = jsonResponse({ error: 'Internal server error' }, 500);
      ctx.waitUntil(logRequest(env, request, errorResponse, startTime, requestId));
      return errorResponse;
    }
  },
};

// ============================================================
// 监控和日志 (D1 版本)
// ============================================================

async function logRequest(env, request, response, startTime, requestId) {
  const duration = Date.now() - startTime;
  const url = new URL(request.url);

  try {
    await env.DB.prepare(`
      INSERT INTO request_logs (request_id, timestamp, method, path, status, duration, user_agent, country, ip)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      requestId,
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
  const startDate = new Date(now);
  startDate.setDate(startDate.getDate() - (days - 1));
  const startStr = startDate.toISOString().slice(0, 10) + 'T00:00:00';

  // 按日期分组,加 apiKey 过滤 + token/cost 维度
  const { results: dailyRows } = await env.DB.prepare(`
    SELECT
      substr(timestamp, 1, 10) as date,
      COUNT(*) as requests,
      COALESCE(SUM(prompt_tokens), 0) as input_tokens,
      COALESCE(SUM(completion_tokens), 0) as output_tokens,
      COALESCE(SUM(prompt_tokens + completion_tokens), 0) as tokens,
      COALESCE(SUM(cost), 0) as cost
    FROM request_logs
    WHERE timestamp >= ? AND api_key = ?
    GROUP BY substr(timestamp, 1, 10)
  `).bind(startStr, apiKey).all();

  const dailyMap = {};
  for (const row of (dailyRows || [])) {
    dailyMap[row.date] = {
      requests: row.requests,
      tokens: row.tokens,
      input_tokens: row.input_tokens,
      output_tokens: row.output_tokens,
      cost: row.cost,
    };
  }

  const dailyData = [];
  for (let i = days - 1; i >= 0; i--) {
    const date = new Date(now);
    date.setDate(date.getDate() - i);
    const dateStr = date.toISOString().slice(0, 10);
    const entry = dailyMap[dateStr] || { requests: 0, tokens: 0, input_tokens: 0, output_tokens: 0, cost: 0 };
    dailyData.push({
      date: dateStr,
      day: date.toLocaleDateString('en', { weekday: 'short' }),
      requests: entry.requests,
      tokens: entry.tokens,
      inputTokens: entry.input_tokens,
      outputTokens: entry.output_tokens,
      cost: entry.cost,
    });
  }

  // 按模型分布
  const { results: modelRows } = await env.DB.prepare(`
    SELECT
      COALESCE(model, 'unknown') as model,
      COUNT(*) as count,
      COALESCE(SUM(prompt_tokens + completion_tokens), 0) as tokens,
      COALESCE(SUM(cost), 0) as cost
    FROM request_logs
    WHERE timestamp >= ? AND api_key = ?
    GROUP BY model
  `).bind(startStr, apiKey).all();

  return {
    period: `${days} days`,
    daily: dailyData,
    models: (modelRows || []).map(r => ({ model: r.model, count: r.count, tokens: r.tokens, cost: r.cost })),
    totalRequests: dailyData.reduce((sum, d) => sum + d.requests, 0),
    totalTokens: dailyData.reduce((sum, d) => sum + d.tokens, 0),
    totalCost: dailyData.reduce((sum, d) => sum + d.cost, 0),
  };
}

async function getHourlyUsage(env, apiKey) {
  const now = new Date();
  const today = now.toISOString().slice(0, 10);
  const startStr = today + 'T00:00:00';

  // 按小时分组,加 apiKey 过滤 + token 维度
  const { results: hourRows } = await env.DB.prepare(`
    SELECT
      CAST(substr(timestamp, 12, 2) AS INTEGER) as hour,
      COUNT(*) as requests,
      COALESCE(SUM(prompt_tokens + completion_tokens), 0) as tokens,
      COALESCE(SUM(cost), 0) as cost
    FROM request_logs
    WHERE timestamp >= ? AND api_key = ?
    GROUP BY substr(timestamp, 12, 2)
  `).bind(startStr, apiKey).all();

  const hourMap = {};
  for (const row of (hourRows || [])) {
    hourMap[row.hour] = { requests: row.requests, tokens: row.tokens, cost: row.cost };
  }

  const hourlyData = [];
  for (let hour = 0; hour < 24; hour++) {
    const hourStr = hour.toString().padStart(2, '0');
    const entry = hourMap[hour] || { requests: 0, tokens: 0, cost: 0 };
    hourlyData.push({
      hour,
      label: `${hourStr}:00`,
      requests: entry.requests,
      tokens: entry.tokens,
      cost: entry.cost,
    });
  }

  return {
    date: today,
    hourly: hourlyData,
    peakHour: hourlyData.reduce((max, h) => h.requests > max.requests ? h : max, hourlyData[0]),
  };
}

// ============================================================
// 多维度时间序列统计 (核心:支持 hour/day/week/month × model/provider/combo 分组)
// ============================================================

async function getTimeseries(env, params) {
  const { granularity, period, from, to, groupBy, apiKey, isAdmin } = params;

  // 计算时间范围
  const now = new Date();
  let fromStr, toStr;
  if (period === 'today') {
    fromStr = now.toISOString().slice(0, 10) + 'T00:00:00';
    toStr = now.toISOString().slice(0, 10) + 'T23:59:59';
  } else if (period === 'week') {
    const weekAgo = new Date(now);
    weekAgo.setDate(weekAgo.getDate() - 7);
    fromStr = weekAgo.toISOString();
    toStr = now.toISOString();
  } else if (period === 'month') {
    fromStr = now.toISOString().slice(0, 7) + '-01T00:00:00';
    toStr = now.toISOString();
  } else if (from && to) {
    fromStr = from;
    toStr = to;
  } else {
    // 默认今天
    fromStr = now.toISOString().slice(0, 10) + 'T00:00:00';
    toStr = now.toISOString();
  }

  // 时间分组表达式
  let timeExpr;
  switch (granularity) {
    case 'hour': timeExpr = `substr(timestamp, 1, 13) || ':00:00'`; break;
    case 'day': timeExpr = `substr(timestamp, 1, 10)`; break;
    case 'week': timeExpr = `strftime('%Y-W%W', timestamp)`; break;
    case 'month': timeExpr = `substr(timestamp, 1, 7)`; break;
    default: timeExpr = `substr(timestamp, 1, 10)`;
  }

  // 分组字段
  let groupField = null;
  switch (groupBy) {
    case 'model': groupField = 'COALESCE(model, "unknown")'; break;
    case 'provider': groupField = 'COALESCE(provider_id, "unknown")'; break;
    case 'combo': groupField = 'COALESCE(combo_name, model, "unknown")'; break;
  }

  // 权限:非管理员只能查自己
  const whereClause = isAdmin && apiKey ? 'timestamp >= ? AND timestamp <= ? AND api_key = ?'
    : isAdmin ? 'timestamp >= ? AND timestamp <= ?'
    : 'timestamp >= ? AND timestamp <= ? AND api_key = ?';
  const bindParams = isAdmin && !apiKey ? [fromStr, toStr] : [fromStr, toStr, apiKey || ''];

  // 汇总统计
  const { results: summaryRows } = await env.DB.prepare(`
    SELECT
      COUNT(*) as total_requests,
      COALESCE(SUM(prompt_tokens), 0) as total_input_tokens,
      COALESCE(SUM(completion_tokens), 0) as total_output_tokens,
      COALESCE(SUM(cache_read_tokens), 0) as total_cache_read,
      COALESCE(SUM(cache_write_tokens), 0) as total_cache_write,
      COALESCE(SUM(prompt_tokens + completion_tokens), 0) as total_tokens,
      COALESCE(SUM(cost), 0) as total_cost,
      SUM(CASE WHEN status >= 200 AND status < 300 THEN 1 ELSE 0 END) as success_count,
      SUM(CASE WHEN status >= 400 THEN 1 ELSE 0 END) as error_count
    FROM request_logs
    WHERE ${whereClause}
  `).bind(...bindParams).all();

  const summary = (summaryRows || [{}])[0] || {};

  // 时间序列(无分组)
  if (!groupField) {
    const { results: seriesRows } = await env.DB.prepare(`
      SELECT
        ${timeExpr} as time_key,
        COUNT(*) as requests,
        COALESCE(SUM(prompt_tokens), 0) as input_tokens,
        COALESCE(SUM(completion_tokens), 0) as output_tokens,
        COALESCE(SUM(cache_read_tokens), 0) as cache_read_tokens,
        COALESCE(SUM(cache_write_tokens), 0) as cache_write_tokens,
        COALESCE(SUM(prompt_tokens + completion_tokens), 0) as total_tokens,
        COALESCE(SUM(cost), 0) as cost
      FROM request_logs
      WHERE ${whereClause}
      GROUP BY time_key
      ORDER BY time_key
    `).bind(...bindParams).all();

    return {
      granularity, period,
      from: fromStr, to: toStr,
      summary: {
        total_requests: summary.total_requests || 0,
        total_input_tokens: summary.total_input_tokens || 0,
        total_output_tokens: summary.total_output_tokens || 0,
        total_cache_read_tokens: summary.total_cache_read || 0,
        total_cache_write_tokens: summary.total_cache_write || 0,
        total_tokens: summary.total_tokens || 0,
        total_cost: summary.total_cost || 0,
        success_count: summary.success_count || 0,
        error_count: summary.error_count || 0,
      },
      series: (seriesRows || []).map(r => ({
        label: formatTimeLabel(r.time_key, granularity),
        timestamp: r.time_key,
        requests: r.requests,
        input_tokens: r.input_tokens,
        output_tokens: r.output_tokens,
        cache_read_tokens: r.cache_read_tokens,
        cache_write_tokens: r.cache_write_tokens,
        total_tokens: r.total_tokens,
        cost: r.cost,
      })),
    };
  }

  // 时间序列(带分组):双重分组查询
  const { results: groupedRows } = await env.DB.prepare(`
    SELECT
      ${timeExpr} as time_key,
      ${groupField} as group_name,
      COUNT(*) as requests,
      COALESCE(SUM(prompt_tokens + completion_tokens), 0) as total_tokens,
      COALESCE(SUM(cost), 0) as cost
    FROM request_logs
    WHERE ${whereClause}
    GROUP BY time_key, group_name
    ORDER BY time_key, total_tokens DESC
  `).bind(...bindParams).all();

  // 合并为 series,每个时间点包含 groups
  const timeMap = new Map();
  for (const row of (groupedRows || [])) {
    if (!timeMap.has(row.time_key)) {
      timeMap.set(row.time_key, {
        label: formatTimeLabel(row.time_key, granularity),
        timestamp: row.time_key,
        requests: 0, input_tokens: 0, output_tokens: 0,
        cache_read_tokens: 0, cache_write_tokens: 0,
        total_tokens: 0, cost: 0,
        groups: {},
      });
    }
    const entry = timeMap.get(row.time_key);
    entry.requests += row.requests;
    entry.total_tokens += row.total_tokens;
    entry.cost += row.cost;
    entry.groups[row.group_name] = {
      requests: row.requests,
      tokens: row.total_tokens,
      cost: row.cost,
    };
  }

  return {
    granularity, period,
    from: fromStr, to: toStr,
    summary: {
      total_requests: summary.total_requests || 0,
      total_input_tokens: summary.total_input_tokens || 0,
      total_output_tokens: summary.total_output_tokens || 0,
      total_cache_read_tokens: summary.total_cache_read || 0,
      total_cache_write_tokens: summary.total_cache_write || 0,
      total_tokens: summary.total_tokens || 0,
      total_cost: summary.total_cost || 0,
      success_count: summary.success_count || 0,
      error_count: summary.error_count || 0,
    },
    series: [...timeMap.values()],
  };
}

function formatTimeLabel(timeKey, granularity) {
  switch (granularity) {
    case 'hour': return timeKey.slice(11, 16);       // "14:30"
    case 'day': return timeKey.slice(5);              // "07-14"
    case 'week': return timeKey;                       // "2026-W28"
    case 'month': return timeKey;                      // "2026-07"
    default: return timeKey;
  }
}

// ============================================================
// 交易流水查询
// ============================================================

async function getTransactions(env, apiKey, params = {}) {
  const { type = 'all', days = 30, isAdmin = false, targetKey = null } = params;
  const now = new Date();
  const since = new Date(now);
  since.setDate(since.getDate() - days);
  const sinceStr = since.toISOString();

  let whereClause, bindParams;
  if (isAdmin && targetKey) {
    whereClause = 'timestamp >= ? AND api_key = ?';
    bindParams = [sinceStr, targetKey];
  } else if (isAdmin) {
    whereClause = 'timestamp >= ?';
    bindParams = [sinceStr];
  } else {
    whereClause = 'timestamp >= ? AND api_key = ?';
    bindParams = [sinceStr, apiKey];
  }

  if (type !== 'all') {
    whereClause += ' AND type = ?';
    bindParams.push(type);
  }

  const { results } = await env.DB.prepare(`
    SELECT id, timestamp, api_key, type, amount, balance_after,
           model, prompt_tokens, completion_tokens, description, request_id
    FROM transactions
    WHERE ${whereClause}
    ORDER BY timestamp DESC
    LIMIT 500
  `).bind(...bindParams).all();

  return results || [];
}

async function getBillingStatement(env, apiKey, month) {
  const monthKey = month || new Date().toISOString().slice(0, 7);
  const fromStr = monthKey + '-01T00:00:00';
  const nextMonth = new Date(monthKey + '-01T00:00:00');
  nextMonth.setMonth(nextMonth.getMonth() + 1);
  const toStr = nextMonth.toISOString();

  // 充值记录
  const { results: topups } = await env.DB.prepare(`
    SELECT timestamp, amount, description
    FROM transactions
    WHERE api_key = ? AND type = 'topup' AND timestamp >= ? AND timestamp < ?
    ORDER BY timestamp
  `).bind(apiKey, fromStr, toStr).all();

  // 消费汇总
  const { results: consumption } = await env.DB.prepare(`
    SELECT
      COALESCE(model, 'unknown') as model,
      COUNT(*) as requests,
      COALESCE(SUM(prompt_tokens), 0) as input_tokens,
      COALESCE(SUM(completion_tokens), 0) as output_tokens,
      COALESCE(SUM(ABS(amount)), 0) as total_cost
    FROM transactions
    WHERE api_key = ? AND type = 'consumption' AND timestamp >= ? AND timestamp < ?
    GROUP BY model
    ORDER BY total_cost DESC
  `).bind(apiKey, fromStr, toStr).all();

  const totalConsumption = (consumption || []).reduce((sum, c) => sum + c.total_cost, 0);
  const totalTopup = (topups || []).reduce((sum, t) => sum + t.amount, 0);
  const currentBalance = await getBalance(env, apiKey);

  return {
    period: monthKey,
    opening_balance: currentBalance - totalTopup + totalConsumption,
    closing_balance: currentBalance,
    topups: topups || [],
    consumption: {
      total_cost: totalConsumption,
      by_model: (consumption || []).map(c => ({
        model: c.model,
        requests: c.requests,
        input_tokens: c.input_tokens,
        output_tokens: c.output_tokens,
        cost: c.total_cost,
      })),
    },
    transactions_count: (topups || []).length + (consumption || []).reduce((s, c) => s + c.requests, 0),
  };
}
