/**
 * SilkGateway - Shared utilities
 * 错误处理、能力查询、常量定义
 * 供 providers.js / keypool.js / combos.js 共用
 */

// ============================================================
// 能力查询 (简化版,移植自 9router capabilities.js)
// ============================================================

const DEFAULT_CAPABILITIES = {
  vision: false,
  pdf: false,
  audioInput: false,
  videoInput: false,
  search: false,
  tools: true,
  reasoning: false,
  thinkingFormat: 'openai',
  thinkingCanDisable: true,
  maxOutput: 8192,
  contextWindow: 128000,
};

// 按模型名模式匹配能力
const PATTERN_CAPABILITIES = [
  {
    pattern: /^(claude-3|claude-opus|claude-sonnet|claude-haiku|cc\/)/i,
    caps: { vision: true, pdf: true, tools: true, reasoning: true, thinkingFormat: 'claude-budget', maxOutput: 8192, contextWindow: 200000 },
  },
  {
    pattern: /^(gpt-4o|gpt-4-turbo|gpt-5|cx\/|gh\/)/i,
    caps: { vision: true, pdf: true, tools: true, reasoning: true, maxOutput: 16384, contextWindow: 128000 },
  },
  {
    pattern: /^(gemini|vertex\/)/i,
    caps: { vision: true, pdf: true, audioInput: true, tools: true, reasoning: true, thinkingFormat: 'gemini-level', maxOutput: 8192, contextWindow: 1000000 },
  },
  {
    pattern: /^(deepseek-reasoner|deepseek-r1|deepseek-v4-pro)/i,
    caps: { reasoning: true, thinkingCanDisable: false, thinkingFormat: 'deepseek', maxOutput: 8192 },
  },
  {
    pattern: /^(deepseek-chat|deepseek-v4-flash)/i,
    caps: { tools: true, maxOutput: 8192 },
  },
  {
    pattern: /^(kimi|moonshot)/i,
    caps: { tools: true, maxOutput: 8192, contextWindow: 128000 },
  },
  {
    pattern: /^(mimo|xiaomi)/i,
    caps: { tools: true, maxOutput: 8192 },
  },
  {
    pattern: /^(glm|chatglm)/i,
    caps: { tools: true, reasoning: true, thinkingFormat: 'zai', maxOutput: 8192 },
  },
  {
    pattern: /^(qwen|qwen3)/i,
    caps: { tools: true, reasoning: true, thinkingFormat: 'qwen', maxOutput: 8192 },
  },
  {
    pattern: /^(minimax)/i,
    caps: { tools: true, reasoning: true, thinkingFormat: 'minimax', maxOutput: 8192 },
  },
];

/**
 * 查询模型能力
 * @param {string} providerId - provider ID (可为 null)
 * @param {string} model - 模型名
 * @returns {object} 能力对象
 */
export function getCapabilitiesForModel(providerId, model) {
  if (!model) return { ...DEFAULT_CAPABILITIES };

  // 先尝试精确匹配 provider 自带的能力
  // (provider 配置中的 capabilities 字段优先)

  // 按模式匹配
  for (const entry of PATTERN_CAPABILITIES) {
    if (entry.pattern.test(model)) {
      return { ...DEFAULT_CAPABILITIES, ...entry.caps };
    }
  }

  return { ...DEFAULT_CAPABILITIES };
}

// ============================================================
// 错误处理 (移植自 9router errorConfig.js + accountFallback.js)
// ============================================================

// 冷却时间常量
export const COOLDOWN = {
  short: 5 * 1000,        // 5 秒
  long: 2 * 60 * 1000,    // 2 分钟
  transient: 30 * 1000,   // 30 秒(未匹配的默认)
  max: 30 * 60 * 1000,    // 30 分钟(上限)
};

// 指数退避配置
export const BACKOFF_CONFIG = {
  base: 2000,              // 2 秒
  max: 5 * 60 * 1000,     // 5 分钟
  maxLevel: 15,
};

// 错误规则 (文本优先,然后状态码)
export const ERROR_RULES = [
  // 文本规则 (大小写不敏感子串匹配)
  { text: 'no credentials', cooldownMs: COOLDOWN.long },
  { text: 'request not allowed', cooldownMs: COOLDOWN.short },
  { text: 'improperly formed request', cooldownMs: COOLDOWN.long },
  { text: 'rate limit', backoff: true },
  { text: 'too many requests', backoff: true },
  { text: 'quota exceeded', backoff: true },
  { text: 'capacity', backoff: true },
  { text: 'overloaded', backoff: true },
  // 状态码规则
  { status: 401, cooldownMs: COOLDOWN.long },
  { status: 402, cooldownMs: COOLDOWN.long },
  { status: 403, cooldownMs: COOLDOWN.long },
  { status: 404, cooldownMs: COOLDOWN.long },
  { status: 429, backoff: true },
];

/**
 * 检查错误是否应该触发 fallback
 * @param {number} status - HTTP 状态码
 * @param {string} errorText - 错误文本
 * @param {number} backoffLevel - 当前退避级别
 * @returns {{ shouldFallback: boolean, cooldownMs: number, newBackoffLevel: number }}
 */
export function checkFallbackError(status, errorText, backoffLevel = 0) {
  const lowerText = (errorText || '').toLowerCase();

  for (const rule of ERROR_RULES) {
    let matched = false;

    if (rule.text && lowerText.includes(rule.text)) {
      matched = true;
    } else if (rule.status === status) {
      matched = true;
    }

    if (matched) {
      if (rule.backoff) {
        const cooldownMs = getQuotaCooldown(backoffLevel);
        return {
          shouldFallback: true,
          cooldownMs,
          newBackoffLevel: Math.min(backoffLevel + 1, BACKOFF_CONFIG.maxLevel),
        };
      }
      return {
        shouldFallback: true,
        cooldownMs: rule.cooldownMs,
        newBackoffLevel: 0,
      };
    }
  }

  // 默认:未知错误也触发 fallback,30 秒瞬态冷却
  return {
    shouldFallback: true,
    cooldownMs: COOLDOWN.transient,
    newBackoffLevel: 0,
  };
}

/**
 * 计算指数退避冷却时间
 */
export function getQuotaCooldown(backoffLevel) {
  const level = Math.max(0, backoffLevel - 1);
  const cooldown = BACKOFF_CONFIG.base * Math.pow(2, level);
  return Math.min(cooldown, BACKOFF_CONFIG.max);
}

// ============================================================
// 模型锁 (移植自 9router accountFallback.js)
// ============================================================

export const MODEL_LOCK_PREFIX = 'modelLock_';
export const MODEL_LOCK_ALL = '__all__';

export function getModelLockKey(model) {
  return MODEL_LOCK_PREFIX + (model || MODEL_LOCK_ALL);
}

/**
 * 检查连接是否被锁定(针对特定模型)
 */
export function isModelLockActive(connection, model) {
  if (!connection || !connection.modelLocks) return false;
  const now = Date.now();
  const specificKey = getModelLockKey(model);
  const allKey = getModelLockKey(null);

  const specificLock = connection.modelLocks[specificKey];
  const allLock = connection.modelLocks[allKey];

  if (specificLock && new Date(specificLock).getTime() > now) return true;
  if (allLock && new Date(allLock).getTime() > now) return true;

  return false;
}

/**
 * 获取连接上最早的锁到期时间
 */
export function getEarliestModelLockUntil(connection) {
  if (!connection || !connection.modelLocks) return null;
  const now = Date.now();
  let earliest = null;

  for (const [key, val] of Object.entries(connection.modelLocks)) {
    if (!val) continue;
    if (!key.startsWith(MODEL_LOCK_PREFIX)) continue;
    const expiry = new Date(val).getTime();
    if (expiry > now && (earliest === null || expiry < earliest)) {
      earliest = expiry;
    }
  }

  return earliest;
}

/**
 * 构建模型锁更新对象
 */
export function buildModelLockUpdate(model, cooldownMs) {
  const key = getModelLockKey(model);
  const expiry = new Date(Date.now() + cooldownMs).toISOString();
  return { [key]: expiry };
}

/**
 * 构建清除模型锁的更新对象(清除所有过期锁)
 */
export function buildClearModelLocksUpdate(connection, model) {
  const updates = {};
  if (!connection || !connection.modelLocks) return updates;

  const now = Date.now();
  const specificKey = getModelLockKey(model);
  const allKey = getModelLockKey(null);

  for (const [key, val] of Object.entries(connection.modelLocks)) {
    if (!key.startsWith(MODEL_LOCK_PREFIX)) continue;
    // 清除目标模型的锁、全局锁、以及所有已过期的锁
    if (key === specificKey || key === allKey) {
      updates[key] = null;
    } else if (val) {
      const expiry = new Date(val).getTime();
      if (expiry <= now) {
        updates[key] = null;
      }
    }
  }

  return updates;
}

// ============================================================
// 能力检测 (用于 combo 自动路由)
// ============================================================

const HARD_CAPS = new Set(['vision', 'pdf', 'audioInput', 'videoInput']);

/**
 * 检测请求需要的能力(扫描最后一条用户消息)
 */
export function detectRequiredCapabilities(body) {
  const required = new Set();
  const items = body.messages || body.input || body.contents || [];
  if (!Array.isArray(items)) return [];

  // 找最后一条用户消息
  let trailingItems = [];
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i];
    const role = item.role || (item.type === 'message' ? 'user' : '');
    trailingItems.unshift(item);
    if (role === 'assistant' || role === 'model') break;
  }

  // 扫描内容中的媒体类型
  for (const item of trailingItems) {
    const content = item.content;
    if (typeof content === 'string') continue;
    if (!Array.isArray(content)) continue;

    for (const block of content) {
      // OpenAI image_url
      if (block.type === 'image_url' || block.type === 'input_image' || block.type === 'image') {
        required.add('vision');
      }
      // Claude image
      if (block.type === 'image' || (block.source && block.source.type === 'base64')) {
        required.add('vision');
      }
      // Gemini inlineData
      if (block.inlineData) {
        const mime = block.inlineData.mimeType || '';
        if (mime.startsWith('image/')) required.add('vision');
        if (mime === 'application/pdf') required.add('pdf');
        if (mime.startsWith('audio/')) required.add('audioInput');
        if (mime.startsWith('video/')) required.add('videoInput');
      }
      // OpenAI file / Claude document
      if (block.type === 'file' || block.type === 'document' || block.type === 'input_file') {
        required.add('pdf');
      }
    }
  }

  return [...required];
}

/**
 * 按能力重排模型列表(稳定排序,不丢弃模型)
 * 满足所有硬需求的排最前,满足部分排中间,其余排最后
 */
export function reorderByCapabilities(models, required, providers) {
  if (!required || required.length === 0) return models;

  const hardRequired = required.filter(r => HARD_CAPS.has(r));

  const tiers = [[], [], []]; // tier 0: 满足全部硬需求, tier 1: 满足部分, tier 2: 其余

  for (const modelStr of models) {
    const caps = getModelCapabilities(modelStr, providers);
    const satisfied = hardRequired.filter(r => caps[r]);
    const allHardSatisfied = satisfied.length === hardRequired.length;
    const someSatisfied = satisfied.length > 0;

    if (allHardSatisfied) {
      tiers[0].push(modelStr);
    } else if (someSatisfied) {
      tiers[1].push(modelStr);
    } else {
      tiers[2].push(modelStr);
    }
  }

  return [...tiers[0], ...tiers[1], ...tiers[2]];
}

/**
 * 获取模型能力(结合 provider 配置和模式匹配)
 */
function getModelCapabilities(modelStr, providers) {
  // 如果 providers 中有该模型的配置,使用它
  if (providers) {
    for (const p of Object.values(providers)) {
      if (p.models && p.models[modelStr] && p.models[modelStr].capabilities) {
        return { ...DEFAULT_CAPABILITIES, ...p.models[modelStr].capabilities };
      }
      // 也检查 provider 级能力
      if (p.capabilities) {
        return { ...DEFAULT_CAPABILITIES, ...p.capabilities };
      }
    }
  }
  // 回退到模式匹配
  return getCapabilitiesForModel(null, modelStr);
}

// ============================================================
// 通用工具
// ============================================================

export function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export function generateId() {
  return 'chatcmpl-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

export function generateConnId() {
  return 'conn_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}
