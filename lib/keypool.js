/**
 * SilkGateway - 多账号 Key 池 + Failover
 *
 * 一个 provider 可配多个 API Key (connections),
 * 按优先级(fill-first)或轮询(round-robin)策略选择,
 * 失败时自动锁定 + 指数退避 + 切换到下一个账号。
 *
 * KV key: conn:<providerId>:<connId>
 * KV value: { id, provider, apiKey, priority, active, consecutiveUseCount,
 *             lastUsedAt, backoffLevel, lastError, lastErrorAt, modelLocks }
 */

import {
  checkFallbackError,
  isModelLockActive,
  getEarliestModelLockUntil,
  buildModelLockUpdate,
  buildClearModelLocksUpdate,
  COOLDOWN,
  generateConnId,
} from './shared.js';

// ============================================================
// 获取凭据
// ============================================================

/**
 * 获取一个可用的上游凭据
 * @param {object} env - Workers env
 * @param {string} providerId - provider ID
 * @param {string} model - 模型名 (用于按模型级锁定)
 * @param {Set} excludeConnIds - 排除的连接 ID 集合 (已失败的)
 * @param {object} options - { strategy: "fill-first"|"round-robin", stickyLimit: number }
 * @returns {Promise<object>} { apiKey, connectionId, connection } 或 { allRateLimited, retryAfter } 或 null
 */
export async function getCredentials(env, providerId, model, excludeConnIds = new Set(), options = {}) {
  const strategy = options.strategy || 'fill-first';
  const stickyLimit = options.stickyLimit || 3;

  // 从 KV 加载该 provider 的所有连接
  const connections = await loadConnections(env, providerId);

  if (connections.length === 0) {
    return null; // 无连接
  }

  // 过滤:active + 未被排除 + 未被锁定
  const now = Date.now();
  const available = connections.filter(c =>
    c.active !== false &&
    !excludeConnIds.has(c.id) &&
    !isModelLockActive(c, model)
  );

  if (available.length === 0) {
    // 全部被锁定或排除,计算最早到期时间
    let earliestExpiry = null;
    for (const c of connections) {
      if (c.active === false || excludeConnIds.has(c.id)) continue;
      const expiry = getEarliestModelLockUntil(c);
      if (expiry && (earliestExpiry === null || expiry < earliestExpiry)) {
        earliestExpiry = expiry;
      }
    }

    if (earliestExpiry) {
      const retryAfterSec = Math.ceil((earliestExpiry - now) / 1000);
      return {
        allRateLimited: true,
        retryAfter: retryAfterSec,
        retryAfterHuman: formatRetryAfter(retryAfterSec),
        lastError: connections[0]?.lastError || 'All connections rate limited',
      };
    }

    // 有连接但全部被排除(非锁定),返回上次错误
    return {
      allRateLimited: false,
      noCredentials: true,
      lastError: connections[0]?.lastError || 'No active credentials',
    };
  }

  // 选择连接
  let selected;
  if (strategy === 'round-robin') {
    selected = selectRoundRobin(available, stickyLimit);
  } else {
    selected = selectFillFirst(available);
  }

  // 更新使用计数和时间
  selected.consecutiveUseCount = (selected.consecutiveUseCount || 0) + 1;
  selected.lastUsedAt = new Date().toISOString();
  await saveConnection(env, selected);

  return {
    apiKey: selected.apiKey,
    connectionId: selected.id,
    connection: selected,
  };
}

/**
 * fill-first 策略:按 priority 排序取第一个
 */
function selectFillFirst(connections) {
  return [...connections].sort((a, b) => {
    const pa = a.priority || 100;
    const pb = b.priority || 100;
    if (pa !== pb) return pa - pb;
    // 同优先级按最近使用时间排序(久未用的优先)
    const ta = a.lastUsedAt ? new Date(a.lastUsedAt).getTime() : 0;
    const tb = b.lastUsedAt ? new Date(b.lastUsedAt).getTime() : 0;
    return ta - tb;
  })[0];
}

/**
 * round-robin 策略(粘性):如果当前连接的 consecutiveUseCount < stickyLimit 则复用,
 * 否则选最久未用的
 */
function selectRoundRobin(connections, stickyLimit) {
  // 按最近使用时间排序(最近使用的在前)
  const sorted = [...connections].sort((a, b) => {
    const ta = a.lastUsedAt ? new Date(a.lastUsedAt).getTime() : 0;
    const tb = b.lastUsedAt ? new Date(b.lastUsedAt).getTime() : 0;
    return tb - ta; // 最近的在前
  });

  const current = sorted[0];
  if (current && (current.consecutiveUseCount || 0) < stickyLimit) {
    return current; // 复用当前连接
  }

  // 选最久未用的
  return [...connections].sort((a, b) => {
    const ta = a.lastUsedAt ? new Date(a.lastUsedAt).getTime() : 0;
    const tb = b.lastUsedAt ? new Date(b.lastUsedAt).getTime() : 0;
    return ta - tb; // 最久的在前
  })[0];
}

// ============================================================
// 标记不可用 (失败时)
// ============================================================

/**
 * 标记连接不可用,设置模型锁和退避
 * @returns {Promise<{ shouldFallback: boolean, cooldownMs: number }>}
 */
export async function markUnavailable(env, connectionId, providerId, status, errorText, model, resetsAtMs = null) {
  const connection = await loadConnection(env, providerId, connectionId);
  if (!connection) return { shouldFallback: false, cooldownMs: 0 };

  const backoffLevel = connection.backoffLevel || 0;
  let shouldFallback, cooldownMs, newBackoffLevel;

  // 精确的重置时间覆盖(如上游返回 resets_at)
  if (resetsAtMs && resetsAtMs > Date.now()) {
    cooldownMs = Math.min(resetsAtMs - Date.now(), COOLDOWN.max);
    newBackoffLevel = 0;
    shouldFallback = true;
  } else {
    const result = checkFallbackError(status, errorText, backoffLevel);
    shouldFallback = result.shouldFallback;
    cooldownMs = result.cooldownMs;
    newBackoffLevel = result.newBackoffLevel;
  }

  if (!shouldFallback) {
    return { shouldFallback: false, cooldownMs: 0 };
  }

  // 更新连接:加模型锁 + 退避级别 + 错误信息
  const lockUpdate = buildModelLockUpdate(model, cooldownMs);
  if (!connection.modelLocks) connection.modelLocks = {};
  Object.assign(connection.modelLocks, lockUpdate);

  connection.backoffLevel = newBackoffLevel;
  connection.lastError = (errorText || '').slice(0, 200);
  connection.lastErrorAt = new Date().toISOString();

  await saveConnection(env, connection);

  return { shouldFallback, cooldownMs };
}

// ============================================================
// 清除错误 (成功时)
// ============================================================

/**
 * 成功时清除该模型的锁
 */
export async function clearError(env, connectionId, providerId, model) {
  const connection = await loadConnection(env, providerId, connectionId);
  if (!connection) return;

  const clearUpdate = buildClearModelLocksUpdate(connection, model);
  if (!connection.modelLocks) connection.modelLocks = {};
  Object.assign(connection.modelLocks, clearUpdate);

  // 检查是否还有活跃的锁
  const hasActiveLock = Object.entries(connection.modelLocks).some(([key, val]) => {
    if (!key.startsWith('modelLock_') || !val) return false;
    return new Date(val).getTime() > Date.now();
  });

  if (!hasActiveLock) {
    connection.backoffLevel = 0;
    connection.lastError = null;
  }

  await saveConnection(env, connection);
}

// ============================================================
// KV 持久化
// ============================================================

const CONN_PREFIX = 'conn:';

/**
 * 加载一个 provider 的所有连接
 */
export async function loadConnections(env, providerId) {
  const prefix = `${CONN_PREFIX}${providerId}:`;
  const list = await env.API_KEYS.list({ prefix });
  const connections = [];

  for (const key of list.keys) {
    const data = await env.API_KEYS.get(key.name, { type: 'json' });
    if (data) connections.push(data);
  }

  return connections;
}

/**
 * 加载单个连接
 */
export async function loadConnection(env, providerId, connId) {
  const key = `${CONN_PREFIX}${providerId}:${connId}`;
  return await env.API_KEYS.get(key, { type: 'json' });
}

/**
 * 保存连接
 */
export async function saveConnection(env, connection) {
  const key = `${CONN_PREFIX}${connection.provider}:${connection.id}`;
  await env.API_KEYS.put(key, JSON.stringify(connection));
}

/**
 * 删除连接
 */
export async function deleteConnection(env, providerId, connId) {
  const key = `${CONN_PREFIX}${providerId}:${connId}`;
  await env.API_KEYS.delete(key);
}

/**
 * 创建新连接
 */
export async function createConnection(env, providerId, { apiKey, priority = 100, name = '' }) {
  const connId = generateConnId();
  const connection = {
    id: connId,
    provider: providerId,
    apiKey,
    name,
    priority,
    active: true,
    consecutiveUseCount: 0,
    lastUsedAt: null,
    backoffLevel: 0,
    lastError: null,
    lastErrorAt: null,
    modelLocks: {},
    createdAt: new Date().toISOString(),
  };

  await saveConnection(env, connection);
  return connection;
}

/**
 * 列出所有 provider 的所有连接 (管理面板用)
 */
export async function listAllConnections(env) {
  const list = await env.API_KEYS.list({ prefix: CONN_PREFIX });
  const connections = [];
  for (const key of list.keys) {
    const data = await env.API_KEYS.get(key.name, { type: 'json' });
    if (data) {
      // 脱敏:不返回完整 apiKey
      connections.push({
        ...data,
        apiKey: data.apiKey ? data.apiKey.slice(0, 8) + '...' : '',
      });
    }
  }
  return connections;
}

// ============================================================
// 工具
// ============================================================

function formatRetryAfter(seconds) {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.ceil(seconds / 60)}m`;
  return `${Math.ceil(seconds / 3600)}h`;
}
