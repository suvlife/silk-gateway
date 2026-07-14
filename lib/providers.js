/**
 * SilkGateway - Provider 注册表
 * KV 驱动的 provider 配置,替代硬编码
 *
 * KV key 格式: provider:<providerId>
 * KV value: { id, name, baseUrl, authType, apiKeyEnv, format, models, priority, active, capabilities }
 */

import { getCapabilitiesForModel } from './shared.js';

// ============================================================
// 默认 provider 配置 (KV 无数据时降级使用)
// ============================================================

export const DEFAULT_PROVIDERS = {
  volcengine: {
    id: 'volcengine',
    name: '火山引擎',
    baseUrl: 'https://ark.cn-beijing.volces.com/api/plan/v3',
    authType: 'bearer',
    apiKeyEnv: 'VOLCENGINE_API_KEY',
    format: 'openai',
    priority: 1,
    active: true,
    models: {
      'doubao-seed-2.0-pro': { input: 0.11, output: 0.43 },
      'ark-code-latest': { input: 0.11, output: 0.43 },
      'glm-5.1': { input: 0.14, output: 0.28 },
    },
  },
  deepseek: {
    id: 'deepseek',
    name: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com/v1',
    authType: 'bearer',
    apiKeyEnv: 'DEEPSEEK_API_KEY',
    format: 'openai',
    priority: 2,
    active: true,
    models: {
      'deepseek-chat': { input: 0.14, output: 0.28 },
      'deepseek-reasoner': { input: 0.55, output: 2.19 },
      'deepseek-v4-pro': { input: 0.55, output: 2.19 },
      'deepseek-v4-flash': { input: 0.14, output: 0.28 },
    },
  },
  kimi: {
    id: 'kimi',
    name: 'Kimi (Moonshot)',
    baseUrl: 'https://api.moonshot.cn/v1',
    authType: 'bearer',
    apiKeyEnv: 'KIMI_API_KEY',
    format: 'openai',
    priority: 3,
    active: true,
    models: {
      'kimi-k2.6': { input: 0.14, output: 0.42 },
      'moonshot-v1-128k': { input: 0.14, output: 0.42 },
    },
  },
  mimo: {
    id: 'mimo',
    name: '小米 MiMo',
    baseUrl: 'https://api.xiaomimimo.com/v1',
    authType: 'bearer',
    apiKeyEnv: 'MIMO_API_KEY',
    format: 'openai',
    priority: 4,
    active: true,
    models: {
      'mimo-v2.5': { input: 0.10, output: 0.30 },
      'mimo-v2.5-pro': { input: 0.10, output: 0.30 },
    },
  },
  openai: {
    id: 'openai',
    name: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    authType: 'bearer',
    apiKeyEnv: 'OPENAI_API_KEY',
    format: 'openai',
    priority: 99,
    active: true,
    models: {},
  },
};

// 默认价格表 (KV 无数据时降级使用,与 worker.js CONFIG.pricing 对齐)
export const DEFAULT_PRICING = {
  'deepseek-chat': { input: 0.14, output: 0.28, provider: 'deepseek' },
  'deepseek-reasoner': { input: 0.55, output: 2.19, provider: 'deepseek' },
  'deepseek-v4-pro': { input: 0.55, output: 2.19, provider: 'deepseek' },
  'deepseek-v4-flash': { input: 0.14, output: 0.28, provider: 'deepseek' },
  'doubao-seed-2.0-pro': { input: 0.11, output: 0.43, provider: 'volcengine' },
  'ark-code-latest': { input: 0.11, output: 0.43, provider: 'volcengine' },
  'kimi-k2.6': { input: 0.14, output: 0.42, provider: 'kimi' },
  'moonshot-v1-128k': { input: 0.14, output: 0.42, provider: 'kimi' },
  'mimo-v2.5': { input: 0.10, output: 0.30, provider: 'mimo' },
  'mimo-v2.5-pro': { input: 0.10, output: 0.30, provider: 'mimo' },
  'glm-5.1': { input: 0.14, output: 0.28, provider: 'volcengine' },
  default: { input: 0.14, output: 0.28, provider: 'volcengine' },
};

// ============================================================
// KV 加载
// ============================================================

/**
 * 从 KV 加载所有 provider 配置
 * 如果 KV 无数据,降级使用 DEFAULT_PROVIDERS
 * @param {object} env - Workers env
 * @returns {Promise<object>} providerId -> providerConfig 映射
 */
export async function loadProviders(env) {
  try {
    const list = await env.API_KEYS.list({ prefix: 'provider:' });
    if (!list.keys || list.keys.length === 0) {
      // KV 无数据,降级使用默认配置
      return { ...DEFAULT_PROVIDERS };
    }

    const providers = {};
    for (const key of list.keys) {
      const providerId = key.name.slice('provider:'.length);
      const data = await env.API_KEYS.get(key.name, { type: 'json' });
      if (data && data.active !== false) {
        providers[providerId] = data;
      }
    }

    // 如果加载到数据则返回,否则降级
    return Object.keys(providers).length > 0 ? providers : { ...DEFAULT_PROVIDERS };
  } catch (err) {
    console.error('loadProviders error:', err);
    return { ...DEFAULT_PROVIDERS };
  }
}

// ============================================================
// 模型路由
// ============================================================

/**
 * 给定模型名,解析出 provider 和价格信息
 * @param {string} modelName - 模型名 (如 "deepseek-chat")
 * @param {object} providers - loadProviders() 返回的映射
 * @returns {{ providerId: string, providerConfig: object, pricing: {input, output} } | null}
 */
export function resolveModel(modelName, providers) {
  if (!modelName || !providers) return null;

  // 遍历所有 provider 查找包含该模型的，按 priority 升序（数字小=优先）
  const sortedProviders = Object.entries(providers).sort(
    ([, a], [, b]) => (a.priority || 99) - (b.priority || 99)
  );
  for (const [providerId, providerConfig] of sortedProviders) {
    if (!providerConfig.active) continue;
    if (providerConfig.models && providerConfig.models[modelName]) {
      const modelPricing = providerConfig.models[modelName];
      return {
        providerId,
        providerConfig,
        pricing: {
          input: modelPricing.input,
          output: modelPricing.output,
        },
      };
    }
  }

  // 未找到精确匹配,尝试用默认价格表
  const defaultPricing = DEFAULT_PRICING[modelName] || DEFAULT_PRICING.default;
  const providerId = defaultPricing.provider;
  const providerConfig = providers[providerId];

  if (providerConfig) {
    return {
      providerId,
      providerConfig,
      pricing: { input: defaultPricing.input, output: defaultPricing.output },
    };
  }

  // 最后降级:用第一个可用 provider
  const firstProvider = Object.values(providers).find(p => p.active);
  if (firstProvider) {
    return {
      providerId: firstProvider.id,
      providerConfig: firstProvider,
      pricing: { input: defaultPricing.input, output: defaultPricing.output },
    };
  }

  return null;
}

/**
 * 获取所有模型列表 (供 /v1/models 端点)
 * @param {object} providers - loadProviders() 返回的映射
 * @returns {Array<{id, object, owned_by}>}
 */
export function getAllModels(providers) {
  const models = [];
  const seen = new Set();

  for (const [providerId, providerConfig] of Object.entries(providers)) {
    if (!providerConfig.active || !providerConfig.models) continue;
    for (const modelId of Object.keys(providerConfig.models)) {
      if (seen.has(modelId)) continue;
      seen.add(modelId);
      models.push({
        id: modelId,
        object: 'model',
        owned_by: providerId,
      });
    }
  }

  // 追加默认价格表中的模型(如果不在 provider 配置中)
  for (const [modelId, pricing] of Object.entries(DEFAULT_PRICING)) {
    if (modelId === 'default' || seen.has(modelId)) continue;
    seen.add(modelId);
    models.push({
      id: modelId,
      object: 'model',
      owned_by: pricing.provider,
    });
  }

  return models;
}

/**
 * 构建价格表 (供 /v1/pricing 端点)
 */
export function getAllPricing(providers) {
  const pricing = {};

  for (const [providerId, providerConfig] of Object.entries(providers)) {
    if (!providerConfig.models) continue;
    for (const [modelId, modelPricing] of Object.entries(providerConfig.models)) {
      if (!pricing[modelId]) {
        pricing[modelId] = {
          input: modelPricing.input,
          output: modelPricing.output,
          provider: providerId,
        };
      }
    }
  }

  // 合并默认价格表
  for (const [modelId, modelPricing] of Object.entries(DEFAULT_PRICING)) {
    if (modelId === 'default') continue;
    if (!pricing[modelId]) {
      pricing[modelId] = modelPricing;
    }
  }

  return pricing;
}

/**
 * 获取 provider 的上游 API Key
 * 优先从 connection 的 apiKey 读取(用于 keypool),其次从 env secret 读取
 * @param {object} providerConfig - provider 配置
 * @param {string} apiKey - 来自 keypool 的 key (可选)
 * @param {object} env - Workers env
 * @returns {string} API key
 */
export function getUpstreamKey(providerConfig, apiKey, env) {
  if (apiKey) return apiKey;
  if (providerConfig.apiKey) return providerConfig.apiKey;
  if (providerConfig.apiKeyEnv && env[providerConfig.apiKeyEnv]) {
    return env[providerConfig.apiKeyEnv];
  }
  return '';
}

/**
 * 获取模型能力(结合 provider 配置)
 */
export function getModelCapabilities(modelName, providers) {
  if (providers) {
    for (const p of Object.values(providers)) {
      if (p.models && p.models[modelName]) {
        const modelConfig = p.models[modelName];
        if (modelConfig.capabilities) {
          return getCapabilitiesForModel(p.id, modelName, modelConfig.capabilities);
        }
        if (p.capabilities) {
          return getCapabilitiesForModel(p.id, modelName, p.capabilities);
        }
      }
    }
  }
  return getCapabilitiesForModel(null, modelName);
}

// ============================================================
// Provider 管理 (管理员 API)
// ============================================================

/**
 * 保存 provider 配置到 KV
 */
export async function saveProvider(env, providerConfig) {
  const key = `provider:${providerConfig.id}`;
  await env.API_KEYS.put(key, JSON.stringify(providerConfig));
  return providerConfig;
}

/**
 * 删除 provider
 */
export async function deleteProvider(env, providerId) {
  await env.API_KEYS.delete(`provider:${providerId}`);
}

/**
 * 列出所有 provider (含 inactive)
 */
export async function listAllProviders(env) {
  const list = await env.API_KEYS.list({ prefix: 'provider:' });
  const providers = [];
  for (const key of list.keys) {
    const data = await env.API_KEYS.get(key.name, { type: 'json' });
    if (data) providers.push(data);
  }
  return providers;
}

/**
 * 测试 provider 连通性
 */
export async function testProvider(providerConfig, env) {
  try {
    const upstreamKey = getUpstreamKey(providerConfig, null, env);
    if (!upstreamKey) {
      return { ok: false, error: 'No API key configured' };
    }

    const url = `${providerConfig.baseUrl}/models`;
    const headers = { 'Content-Type': 'application/json' };
    if (providerConfig.authType === 'x-api-key') {
      headers['x-api-key'] = upstreamKey;
    } else {
      headers['Authorization'] = `Bearer ${upstreamKey}`;
    }

    const res = await fetch(url, { method: 'GET', headers });
    if (res.ok) {
      const data = await res.json();
      const modelCount = data.data ? data.data.length : 0;
      return { ok: true, models: modelCount };
    }
    return { ok: false, error: `HTTP ${res.status}`, status: res.status };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}
