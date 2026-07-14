/**
 * SilkGateway - 模型 Combo / Fallback 链
 *
 * 用户定义 combo (如 fast-cheap = [mimo-v2.5, deepseek-chat, kimi-k2.6]),
 * 请求时按 fallback (顺序尝试) 或 round-robin (轮询) 策略自动切换模型。
 * 支持按模型能力自动重排 (有图片 -> 优先 vision 模型)。
 *
 * KV key: combo:<name>
 * KV value: { id, name, models, strategy, stickyLimit, autoSwitch, createdAt }
 *
 * 轮询状态 KV key: rr:<comboName>
 * 轮询状态 KV value: { index, consecutiveUseCount }
 */

import {
  detectRequiredCapabilities,
  reorderByCapabilities,
  checkFallbackError,
  sleep,
} from './shared.js';

// ============================================================
// Combo 查询
// ============================================================

const COMBO_PREFIX = 'combo:';
const RR_PREFIX = 'rr:';

/**
 * 检查模型名是否是一个 combo
 * @returns {Promise<object|null>} combo 定义或 null
 */
export async function isCombo(modelStr, env) {
  if (!modelStr || modelStr.includes('/')) return null;
  try {
    const combo = await env.API_KEYS.get(`${COMBO_PREFIX}${modelStr}`, { type: 'json' });
    return combo || null;
  } catch {
    return null;
  }
}

/**
 * 列出所有 combo (公开端点)
 */
export async function listCombos(env) {
  const list = await env.API_KEYS.list({ prefix: COMBO_PREFIX });
  const combos = [];
  for (const key of list.keys) {
    const data = await env.API_KEYS.get(key.name, { type: 'json' });
    if (data) {
      // 归一化 models 格式用于展示
      const normalized = normalizeComboModels(data.models);
      combos.push({
        name: data.name,
        models: normalized.map(m => m.modelOverride ? `${m.model}->${m.modelOverride}` : m.model),
        strategy: data.strategy,
        description: data.description || '',
      });
    }
  }
  return combos;
}

// ============================================================
// Combo 管理
// ============================================================

export async function createCombo(env, { name, models, strategy = 'fallback', stickyLimit = 3, autoSwitch = true, description = '' }) {
  if (!name || !/^[a-zA-Z0-9_.\-]+$/.test(name)) {
    throw new Error('Invalid combo name (use letters, numbers, _ . -)');
  }
  if (!Array.isArray(models) || models.length === 0) {
    throw new Error('Combo must have at least one model');
  }

  // models 支持两种格式:
  // 1. 简单字符串: ["mimo-v2.5", "deepseek-chat"]
  // 2. 对象格式 (支持 model_override): [{ model: "deepseek-chat", modelOverride: "deepseek-v3" }]
  // modelOverride 用于给 provider 发送不同的模型名,但计费仍用 model 字段
  const normalizedModels = models.map(m => {
    if (typeof m === 'string') return { model: m, modelOverride: null };
    if (m && typeof m === 'object' && m.model) return { model: m.model, modelOverride: m.modelOverride || m.model_override || null };
    throw new Error('Invalid model entry in combo: ' + JSON.stringify(m));
  });

  const combo = {
    id: `combo_${Date.now().toString(36)}`,
    name,
    models: normalizedModels,
    strategy,
    stickyLimit,
    autoSwitch,
    description,
    createdAt: new Date().toISOString(),
  };

  await env.API_KEYS.put(`${COMBO_PREFIX}${name}`, JSON.stringify(combo));
  return combo;
}

export async function updateCombo(env, name, updates) {
  const existing = await env.API_KEYS.get(`${COMBO_PREFIX}${name}`, { type: 'json' });
  if (!existing) throw new Error(`Combo not found: ${name}`);

  const updated = { ...existing, ...updates, updatedAt: new Date().toISOString() };
  await env.API_KEYS.put(`${COMBO_PREFIX}${name}`, JSON.stringify(updated));
  return updated;
}

export async function deleteCombo(env, name) {
  await env.API_KEYS.delete(`${COMBO_PREFIX}${name}`);
  await env.API_KEYS.delete(`${RR_PREFIX}${name}`); // 清除轮询状态
}

// ============================================================
// 轮询状态管理
// ============================================================

async function getRotatedModels(env, models, comboName, stickyLimit) {
  // models 现在是 [{ model, modelOverride }] 格式
  if (models.length <= 1) return models;

  const limit = stickyLimit || 1;
  const rrKey = `${RR_PREFIX}${comboName}`;
  let state = await env.API_KEYS.get(rrKey, { type: 'json' });
  if (!state) state = { index: 0, consecutiveUseCount: 0 };

  const currentIndex = state.index % models.length;

  // 构建旋转后的数组:从 currentIndex 开始
  const rotated = [
    ...models.slice(currentIndex),
    ...models.slice(0, currentIndex),
  ];

  // 更新计数
  state.consecutiveUseCount = (state.consecutiveUseCount || 0) + 1;
  if (state.consecutiveUseCount >= limit) {
    state.index = (currentIndex + 1) % models.length;
    state.consecutiveUseCount = 0;
  }

  await env.API_KEYS.put(rrKey, JSON.stringify(state));

  return rotated;
}

// ============================================================
// Combo 聊天处理
// ============================================================

/**
 * 将 combo.models 归一化为 [{ model, modelOverride }] 格式
 * 兼容旧的字符串数组格式
 */
function normalizeComboModels(models) {
  return models.map(m => {
    if (typeof m === 'string') return { model: m, modelOverride: null };
    if (m && typeof m === 'object' && m.model) {
      return { model: m.model, modelOverride: m.modelOverride || m.model_override || null };
    }
    return { model: String(m), modelOverride: null };
  });
}

/**
 * 处理 combo 请求:按策略遍历模型,直到成功或全部失败
 * @param {object} env
 * @param {object} body - 请求体
 * @param {object} combo - combo 定义
 * @param {function} executeSingleModel - async (model, modelOverride) => { ok, response, status, error, resetsAtMs }
 * @returns {Promise<object>} { response, status, error, rtkStats }
 */
export async function handleComboChat(env, body, combo, executeSingleModel) {
  const { strategy, stickyLimit, autoSwitch, name } = combo;
  // models 现在是 [{ model, modelOverride }] 格式,兼容旧的字符串数组
  let models = normalizeComboModels(combo.models);

  // 1. 旋转模型 (round-robin 时)
  if (strategy === 'round-robin') {
    models = await getRotatedModels(env, models, name, stickyLimit);
  }

  // 2. 按能力重排 (autoSwitch 时)
  if (autoSwitch !== false) {
    const required = detectRequiredCapabilities(body);
    if (required.length > 0) {
      const modelNames = models.map(m => m.model);
      const reordered = reorderByCapabilities(modelNames, required, null);
      // 用重排后的顺序重建 models 数组
      models = reordered.map(name => models.find(m => m.model === name)).filter(Boolean);
    }
  }

  // 3. 遍历模型
  let lastError = null;
  let lastStatus = 503;
  let earliestRetryAfter = null;

  for (let i = 0; i < models.length; i++) {
    const { model, modelOverride } = models[i];
    const result = await executeSingleModel(model, modelOverride);

    if (result.ok) {
      return result; // 成功,返回
    }

    // 失败:检查是否应该 fallback
    lastError = result.error || 'Unknown error';
    lastStatus = result.status || 503;

    if (result.resetsAtMs) {
      const retryMs = result.resetsAtMs;
      if (earliestRetryAfter === null || retryMs < earliestRetryAfter) {
        earliestRetryAfter = retryMs;
      }
    }

    const fallbackCheck = checkFallbackError(result.status, result.error, 0);

    if (!fallbackCheck.shouldFallback) {
      // 不可 fallback 的错误(如 400),直接返回
      return result;
    }

    // 瞬态 5xx 微冷却:短暂等待后尝试下一个
    if (fallbackCheck.cooldownMs > 0 && fallbackCheck.cooldownMs <= 5000) {
      await sleep(fallbackCheck.cooldownMs);
    }

    // 继续下一个模型
  }

  // 4. 全部失败
  const errorMsg = lastError || 'All models failed';
  const status = errorMsg.includes('no credentials') || errorMsg.includes('No active') ? 503 : lastStatus;

  const errorBody = {
    error: {
      type: 'upstream_error',
      message: `All models in combo "${name}" failed. Last error: ${errorMsg}`,
    },
  };

  if (earliestRetryAfter) {
    const retryAfterSec = Math.ceil((earliestRetryAfter - Date.now()) / 1000);
    errorBody.error.retry_after = retryAfterSec;
  }

  return {
    ok: false,
    status,
    error: errorMsg,
    response: new Response(JSON.stringify(errorBody), {
      status,
      headers: { 'Content-Type': 'application/json' },
    }),
  };
}

// ============================================================
// 导出
// ============================================================

export { COMBO_PREFIX, RR_PREFIX };
