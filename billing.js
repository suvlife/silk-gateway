/**
 * SilkGateway Billing System
 * 按 token 用量计费
 * 
 * 当前使用模拟数据，后续接入 Stripe 时只需替换 chargeUser 函数
 */

// ============================================================
// 价格配置（每百万 token 价格，单位：美元）
// ============================================================

const PRICING = {
  // 模型定价
  models: {
    'deepseek-chat':         { input: 0.14,  output: 0.28 },
    'deepseek-reasoner':     { input: 0.55,  output: 2.19 },
    'doubao-seed-2.0-pro':   { input: 0.11,  output: 0.43 },
    'ark-code-latest':       { input: 0.11,  output: 0.43 },
    'glm-5.1':               { input: 0.14,  output: 0.28 },
    'kimi-k2.6':             { input: 0.14,  output: 0.42 },
    'qwen3.6-plus':          { input: 0.14,  output: 0.42 },
    'minimax-m2.7':          { input: 0.14,  output: 0.42 },
    // 默认价格
    'default':               { input: 0.14,  output: 0.28 },
  },
  
  // 会员折扣
  tierDiscount: {
    free: 0,        // 无折扣
    pro: 0.1,       // 9折
    enterprise: 0.2, // 8折
  },
  
  // 免费额度（每月 token 数）
  freeQuota: {
    free: 100_000,        // 10万 token/月
    pro: 1_000_000,       // 100万 token/月
    enterprise: 10_000_000, // 1000万 token/月
  },
};

// ============================================================
// 用量记录（KV 存储）
// ============================================================

/**
 * 记录用量
 */
async function recordUsage(env, apiKey, model, usage) {
  const now = new Date();
  const monthKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  const dayKey = now.toISOString().slice(0, 10);
  
  const promptTokens = usage.prompt_tokens || 0;
  const completionTokens = usage.completion_tokens || 0;
  const totalTokens = promptTokens + completionTokens;
  
  // 计算费用
  const pricing = PRICING.models[model] || PRICING.models['default'];
  const cost = (promptTokens * pricing.input + completionTokens * pricing.output) / 1_000_000;
  
  // 月度用量
  const monthKeyFull = `usage:${apiKey}:${monthKey}`;
  const monthData = await env.USAGE_LOG.get(monthKeyFull, { type: 'json' }) || {
    month: monthKey,
    requests: 0,
    promptTokens: 0,
    completionTokens: 0,
    totalCost: 0,
    models: {},
  };
  
  monthData.requests += 1;
  monthData.promptTokens += promptTokens;
  monthData.completionTokens += completionTokens;
  monthData.totalCost += cost;
  
  if (!monthData.models[model]) {
    monthData.models[model] = { requests: 0, tokens: 0, cost: 0 };
  }
  monthData.models[model].requests += 1;
  monthData.models[model].tokens += totalTokens;
  monthData.models[model].cost += cost;
  
  await env.USAGE_LOG.put(monthKeyFull, JSON.stringify(monthData), { expirationTtl: 86400 * 90 });
  
  // 每日用量（用于统计）
  const dayKeyFull = `usage:${apiKey}:${dayKey}`;
  const dayData = await env.USAGE_LOG.get(dayKeyFull, { type: 'json' }) || {
    date: dayKey,
    requests: 0,
    tokens: 0,
    cost: 0,
  };
  
  dayData.requests += 1;
  dayData.tokens += totalTokens;
  dayData.cost += cost;
  
  await env.USAGE_LOG.put(dayKeyFull, JSON.stringify(dayData), { expirationTtl: 86400 * 7 });
  
  // 扣减余额
  await deductBalance(env, apiKey, cost);
  
  return {
    tokens: totalTokens,
    cost,
    model,
  };
}

// ============================================================
// 余额管理
// ============================================================

/**
 * 获取用户余额
 */
async function getBalance(env, apiKey) {
  const data = await env.API_KEYS.get(apiKey, { type: 'json' });
  return data?.balance || 0;
}

/**
 * 扣减余额
 */
async function deductBalance(env, apiKey, amount) {
  const data = await env.API_KEYS.get(apiKey, { type: 'json' });
  if (!data) return;
  
  // Pro 用户有免费额度
  const tier = data.tier || 'free';
  const monthKey = new Date().toISOString().slice(0, 7);
  const monthUsageKey = `usage:${apiKey}:${monthKey}`;
  const monthUsage = await env.USAGE_LOG.get(monthUsageKey, { type: 'json' });
  
  const freeQuota = PRICING.freeQuota[tier] || PRICING.freeQuota.free;
  const usedTokens = (monthUsage?.promptTokens || 0) + (monthUsage?.completionTokens || 0);
  
  // 在免费额度内不扣费
  if (usedTokens <= freeQuota) {
    return { balance: data.balance || 0, charged: 0 };
  }
  
  // 应用会员折扣
  const discount = PRICING.tierDiscount[tier] || 0;
  const finalAmount = amount * (1 - discount);
  
  // 扣减余额
  data.balance = Math.max(0, (data.balance || 0) - finalAmount);
  await env.API_KEYS.put(apiKey, JSON.stringify(data));
  
  return { balance: data.balance, charged: finalAmount };
}

/**
 * 充值余额（模拟 Stripe 支付）
 */
async function addBalance(env, apiKey, amount) {
  const data = await env.API_KEYS.get(apiKey, { type: 'json' });
  if (!data) throw new Error('Invalid API key');
  
  data.balance = (data.balance || 0) + amount;
  await env.API_KEYS.put(apiKey, JSON.stringify(data));
  
  return { balance: data.balance };
}

// ============================================================
// 账单查询
// ============================================================

/**
 * 获取月度账单
 */
async function getMonthlyBill(env, apiKey, month) {
  const monthKey = month || new Date().toISOString().slice(0, 7);
  const key = `usage:${apiKey}:${monthKey}`;
  const data = await env.USAGE_LOG.get(key, { type: 'json' });
  
  if (!data) {
    return {
      month: monthKey,
      requests: 0,
      promptTokens: 0,
      completionTokens: 0,
      totalCost: 0,
      models: {},
    };
  }
  
  return data;
}

/**
 * 获取用量历史
 */
async function getUsageHistory(env, apiKey, days = 30) {
  const history = [];
  const now = new Date();
  
  for (let i = 0; i < days; i++) {
    const date = new Date(now);
    date.setDate(date.getDate() - i);
    const dayKey = date.toISOString().slice(0, 10);
    const key = `usage:${apiKey}:${dayKey}`;
    const data = await env.USAGE_LOG.get(key, { type: 'json' });
    
    if (data) {
      history.push(data);
    }
  }
  
  return history;
}

// ============================================================
// 价格查询
// ============================================================

function getPricing() {
  return {
    models: Object.entries(PRICING.models)
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
  };
}

// ============================================================
// 导出
// ============================================================

export {
  PRICING,
  recordUsage,
  getBalance,
  deductBalance,
  addBalance,
  getMonthlyBill,
  getUsageHistory,
  getPricing,
};
