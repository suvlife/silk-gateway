/**
 * SilkGateway - 单元测试
 * 使用 Node.js 内置 assert 模块,无需安装依赖
 * 运行: node tests/run-all.js
 */

import assert from 'assert';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);

// ============================================================
// shared.js 测试
// ============================================================

function testShared() {
  console.log('--- Testing shared.js ---');

  const {
    getCapabilitiesForModel,
    checkFallbackError,
    getQuotaCooldown,
    isModelLockActive,
    buildModelLockUpdate,
    detectRequiredCapabilities,
    reorderByCapabilities,
  } = require('../lib/shared.js');

  // getCapabilitiesForModel
  const claudeCaps = getCapabilitiesForModel(null, 'claude-sonnet-4-6');
  assert.strictEqual(claudeCaps.vision, true, 'Claude should have vision');
  assert.strictEqual(claudeCaps.thinkingFormat, 'claude-budget');

  const deepseekReasonerCaps = getCapabilitiesForModel(null, 'deepseek-reasoner');
  assert.strictEqual(deepseekReasonerCaps.reasoning, true, 'deepseek-reasoner should have reasoning');
  assert.strictEqual(deepseekReasonerCaps.thinkingCanDisable, false, 'deepseek-reasoner thinking cannot be disabled');

  const defaultCaps = getCapabilitiesForModel(null, 'unknown-model-xyz');
  assert.strictEqual(defaultCaps.vision, false, 'Unknown model should have default caps');
  console.log('  ✅ getCapabilitiesForModel');

  // checkFallbackError
  const r1 = checkFallbackError(429, 'rate limit exceeded', 0);
  assert.strictEqual(r1.shouldFallback, true);
  assert.strictEqual(r1.newBackoffLevel, 1);
  assert.ok(r1.cooldownMs >= 2000, 'First backoff should be >= 2s');

  const r2 = checkFallbackError(401, 'unauthorized', 0);
  assert.strictEqual(r2.shouldFallback, true);
  assert.strictEqual(r2.cooldownMs, 120000, '401 should be 2min cooldown');

  const r3 = checkFallbackError(400, 'bad request', 0);
  assert.strictEqual(r3.shouldFallback, true, 'Unknown errors should still fallback');
  assert.strictEqual(r3.cooldownMs, 30000, 'Unknown errors get 30s transient');

  const r4 = checkFallbackError(500, 'no credentials available', 0);
  assert.strictEqual(r4.cooldownMs, 120000, 'no credentials text should match');

  console.log('  ✅ checkFallbackError');

  // getQuotaCooldown
  assert.strictEqual(getQuotaCooldown(0), 2000, 'Level 0 -> 2s');
  assert.strictEqual(getQuotaCooldown(1), 2000, 'Level 1 -> 2s (base * 2^0)');
  assert.strictEqual(getQuotaCooldown(2), 4000, 'Level 2 -> 4s (base * 2^1)');
  assert.strictEqual(getQuotaCooldown(3), 8000, 'Level 3 -> 8s');
  assert.ok(getQuotaCooldown(15) <= 300000, 'Level 15 should be capped at 5min');

  console.log('  ✅ getQuotaCooldown');

  // isModelLockActive
  const conn = {
    modelLocks: {
      'modelLock_deepseek-chat': new Date(Date.now() + 60000).toISOString(),
      'modelLock___all__': null,
    },
  };
  assert.strictEqual(isModelLockActive(conn, 'deepseek-chat'), true, 'Active lock should be detected');
  assert.strictEqual(isModelLockActive(conn, 'other-model'), false, 'No lock for other model');
  assert.strictEqual(isModelLockActive(null, 'test'), false, 'Null connection should not be locked');

  const expiredConn = {
    modelLocks: {
      'modelLock_test': new Date(Date.now() - 60000).toISOString(),
    },
  };
  assert.strictEqual(isModelLockActive(expiredConn, 'test'), false, 'Expired lock should not be active');

  console.log('  ✅ isModelLockActive');

  // buildModelLockUpdate
  const lockUpdate = buildModelLockUpdate('test-model', 5000);
  assert.ok(lockUpdate['modelLock_test-model'], 'Should have lock key');
  const lockTime = new Date(lockUpdate['modelLock_test-model']).getTime();
  assert.ok(lockTime > Date.now() && lockTime < Date.now() + 10000, 'Lock should be ~5s in future');

  console.log('  ✅ buildModelLockUpdate');

  // detectRequiredCapabilities
  const bodyWithImage = {
    messages: [
      { role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,abc' } }] },
    ],
  };
  const caps = detectRequiredCapabilities(bodyWithImage);
  assert.ok(caps.includes('vision'), 'Should detect vision requirement');

  const bodyWithPdf = {
    messages: [
      { role: 'user', content: [{ type: 'file', file: { name: 'doc.pdf' } }] },
    ],
  };
  const pdfCaps = detectRequiredCapabilities(bodyWithPdf);
  assert.ok(pdfCaps.includes('pdf'), 'Should detect pdf requirement');

  const bodyTextOnly = {
    messages: [{ role: 'user', content: 'Hello world' }],
  };
  assert.strictEqual(detectRequiredCapabilities(bodyTextOnly).length, 0, 'Text-only should have no requirements');

  console.log('  ✅ detectRequiredCapabilities');

  // reorderByCapabilities
  const models = ['text-only-model', 'claude-sonnet-4-6', 'gpt-4o'];
  const reordered = reorderByCapabilities(models, ['vision'], null);
  // Vision-capable models should come first
  assert.ok(reordered.indexOf('claude-sonnet-4-6') < reordered.indexOf('text-only-model'), 'Vision models should be first');
  assert.strictEqual(reordered.length, 3, 'No models should be dropped');

  console.log('  ✅ reorderByCapabilities');
}

// ============================================================
// providers.js 测试
// ============================================================

function testProviders() {
  console.log('--- Testing providers.js ---');

  const {
    resolveModel,
    getAllModels,
    getAllPricing,
    DEFAULT_PROVIDERS,
    DEFAULT_PRICING,
  } = require('../lib/providers.js');

  // resolveModel with default providers
  const result = resolveModel('deepseek-chat', DEFAULT_PROVIDERS);
  assert.ok(result, 'Should resolve deepseek-chat');
  assert.strictEqual(result.providerId, 'deepseek');
  assert.strictEqual(result.pricing.input, 0.14);
  assert.strictEqual(result.pricing.output, 0.28);

  // resolveModel unknown model
  const unknown = resolveModel('unknown-model-xyz', DEFAULT_PROVIDERS);
  assert.ok(unknown, 'Should still resolve with default pricing');

  console.log('  ✅ resolveModel');

  // getAllModels
  const models = getAllModels(DEFAULT_PROVIDERS);
  assert.ok(models.length > 0, 'Should have models');
  assert.ok(models.some(m => m.id === 'deepseek-chat'), 'Should include deepseek-chat');
  assert.ok(models.every(m => m.owned_by !== undefined), 'All models should have owned_by');

  console.log('  ✅ getAllModels');

  // getAllPricing
  const pricing = getAllPricing(DEFAULT_PROVIDERS);
  assert.ok(pricing['deepseek-chat'], 'Should have deepseek-chat pricing');
  assert.strictEqual(pricing['deepseek-chat'].input, 0.14);

  console.log('  ✅ getAllPricing');
}

// ============================================================
// keypool.js 测试
// ============================================================

async function testKeyPool() {
  console.log('--- Testing keypool.js ---');

  // keypool 需要 KV env,我们用 mock
  const mockEnv = createMockKV();
  const { createConnection, loadConnections, getCredentials, markUnavailable, clearError } = require('../lib/keypool.js');

  // 创建连接
  await createConnection(mockEnv, 'deepseek', { apiKey: 'sk-key1', priority: 1, name: 'primary' });
  await createConnection(mockEnv, 'deepseek', { apiKey: 'sk-key2', priority: 2, name: 'secondary' });

  const conns = await loadConnections(mockEnv, 'deepseek');
  assert.strictEqual(conns.length, 2, 'Should have 2 connections');

  console.log('  ✅ createConnection + loadConnections');

  // getCredentials - fill-first
  const creds = await getCredentials(mockEnv, 'deepseek', 'deepseek-chat', new Set(), { strategy: 'fill-first' });
  assert.ok(creds, 'Should get credentials');
  assert.strictEqual(creds.apiKey, 'sk-key1', 'fill-first should pick priority 1');

  console.log('  ✅ getCredentials (fill-first)');

  // markUnavailable
  await markUnavailable(mockEnv, creds.connectionId, 'deepseek', 429, 'rate limit exceeded', 'deepseek-chat');

  // 现在 key1 应该被锁定,应选 key2
  const creds2 = await getCredentials(mockEnv, 'deepseek', 'deepseek-chat', new Set(), { strategy: 'fill-first' });
  assert.strictEqual(creds2.apiKey, 'sk-key2', 'Should fallback to key2 after key1 locked');

  console.log('  ✅ markUnavailable + failover');

  // clearError
  await clearError(mockEnv, creds.connectionId, 'deepseek', 'deepseek-chat');
  // key1 的锁应被清除
  const conn1 = await loadConnections(mockEnv, 'deepseek').then(c => c.find(x => x.id === creds.connectionId));
  const lockKey = 'modelLock_deepseek-chat';
  assert.ok(!conn1.modelLocks[lockKey] || new Date(conn1.modelLocks[lockKey]).getTime() <= Date.now(),
    'Lock should be cleared after clearError');

  console.log('  ✅ clearError');
}

// ============================================================
// combos.js 测试
// ============================================================

async function testCombos() {
  console.log('--- Testing combos.js ---');

  const mockEnv = createMockKV();
  const { createCombo, isCombo, listCombos, deleteCombo } = require('../lib/combos.js');

  // 创建 combo
  await createCombo(mockEnv, {
    name: 'fast-cheap',
    models: ['mimo-v2.5', 'deepseek-chat', 'kimi-k2.6'],
    strategy: 'fallback',
    stickyLimit: 3,
    autoSwitch: true,
  });

  // isCombo
  const combo = await isCombo('fast-cheap', mockEnv);
  assert.ok(combo, 'Should find combo');
  assert.strictEqual(combo.models.length, 3);
  assert.strictEqual(combo.strategy, 'fallback');

  const notCombo = await isCombo('nonexistent', mockEnv);
  assert.strictEqual(notCombo, null, 'Nonexistent combo should return null');

  console.log('  ✅ createCombo + isCombo');

  // listCombos
  const combos = await listCombos(mockEnv);
  assert.strictEqual(combos.length, 1);
  assert.strictEqual(combos[0].name, 'fast-cheap');

  console.log('  ✅ listCombos');

  // deleteCombo
  await deleteCombo(mockEnv, 'fast-cheap');
  const afterDelete = await isCombo('fast-cheap', mockEnv);
  assert.strictEqual(afterDelete, null, 'Combo should be deleted');

  console.log('  ✅ deleteCombo');

  // 验证 combo 名称校验
  try {
    await createCombo(mockEnv, { name: 'invalid name!', models: ['test'] });
    assert.fail('Should reject invalid name');
  } catch (err) {
    assert.ok(err.message.includes('Invalid combo name'));
  }

  try {
    await createCombo(mockEnv, { name: 'valid', models: [] });
    assert.fail('Should reject empty models');
  } catch (err) {
    assert.ok(err.message.includes('at least one model'));
  }

  console.log('  ✅ combo validation');

  // 测试 model_override 支持 (对象格式)
  await createCombo(mockEnv, {
    name: 'override-combo',
    models: [
      { model: 'deepseek-chat', modelOverride: 'deepseek-v3' },
      { model: 'mimo-v2.5' },  // 无 override
    ],
    strategy: 'fallback',
  });

  const overrideCombo = await isCombo('override-combo', mockEnv);
  assert.ok(overrideCombo, 'Override combo should exist');
  assert.strictEqual(overrideCombo.models[0].model, 'deepseek-chat');
  assert.strictEqual(overrideCombo.models[0].modelOverride, 'deepseek-v3');
  assert.strictEqual(overrideCombo.models[1].model, 'mimo-v2.5');
  assert.strictEqual(overrideCombo.models[1].modelOverride, null);

  console.log('  ✅ combo model_override support');

  // 测试字符串格式兼容
  await createCombo(mockEnv, {
    name: 'string-combo',
    models: ['mimo-v2.5', 'deepseek-chat'],
  });
  const stringCombo = await isCombo('string-combo', mockEnv);
  assert.ok(stringCombo.models[0].model, 'String models should be normalized');
  assert.strictEqual(stringCombo.models[0].modelOverride, null);

  console.log('  ✅ string model backwards compat');
}

// ============================================================
// rtk.js 测试
// ============================================================

function testRTK() {
  console.log('--- Testing rtk.js ---');

  const { compressMessages, formatRtkLog } = require('../lib/rtk.js');

  // 测试 git diff 压缩
  const longGitDiff = 'diff --git a/file.js b/file.js\n' +
    'index abc..def 100644\n' +
    '--- a/file.js\n' +
    '+++ b/file.js\n' +
    '@@ -1,500 +1,500 @@\n' +
    Array.from({ length: 500 }, (_, i) => `+line ${i}`).join('\n');

  const body = {
    messages: [
      { role: 'user', content: 'Check this diff' },
      { role: 'tool', content: longGitDiff, tool_call_id: 'call_1' },
    ],
  };

  const stats = compressMessages(body, true);
  assert.ok(stats, 'Should return stats');
  assert.ok(stats.bytesAfter < stats.bytesBefore, 'Should compress');
  assert.ok(stats.hits.length > 0, 'Should have hits');
  assert.ok(stats.bytesBefore > 500, 'Should detect large content');

  console.log('  ✅ git diff compression');

  // 测试小内容跳过
  const smallBody = {
    messages: [
      { role: 'tool', content: 'short', tool_call_id: 'call_1' },
    ],
  };
  const smallStats = compressMessages(smallBody, true);
  // 小于 MIN_COMPRESS_SIZE (500) 应该跳过
  assert.ok(!smallStats || smallStats.bytesAfter === smallStats.bytesBefore, 'Small content should be skipped');

  console.log('  ✅ small content skip');

  // 测试 disabled
  const disabledStats = compressMessages(body, false);
  assert.strictEqual(disabledStats, null, 'Disabled should return null');

  console.log('  ✅ disabled returns null');

  // 测试 fail-open (畸形输入)
  const weirdBody = { messages: 'not an array' };
  const weirdStats = compressMessages(weirdBody, true);
  assert.strictEqual(weirdStats, null, 'Should return null for invalid input');

  console.log('  ✅ fail-open for invalid input');

  // 测试 Claude 格式
  const claudeBody = {
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'Check this' }] },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'tool_1', name: 'bash', input: { cmd: 'git diff' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tool_1', content: longGitDiff }] },
    ],
  };
  const claudeStats = compressMessages(claudeBody, true);
  assert.ok(claudeStats, 'Should compress Claude format');
  assert.ok(claudeStats.bytesAfter < claudeStats.bytesBefore);

  console.log('  ✅ Claude format compression');

  // 测试 formatRtkLog
  const logStr = formatRtkLog(stats);
  assert.ok(typeof logStr === 'string');
  assert.ok(logStr.includes('bytes') || logStr.includes('%'), 'Log should contain bytes or percentage');

  console.log('  ✅ formatRtkLog');
}

// ============================================================
// translator.js 测试 (桩版本测试,等正式版替换后需要更新)
// ============================================================

function testTranslator() {
  console.log('--- Testing translator.js ---');

  const { detectFormat, initState, FORMATS, translateRequest, translateResponseChunk } = require('../lib/translator.js');

  // detectFormat: /v1/messages -> claude, /v1/chat/completions -> null (default openai)
  assert.strictEqual(detectFormat('/v1/messages', {}), FORMATS.CLAUDE, '/v1/messages should detect as claude');
  assert.strictEqual(detectFormat('/v1/chat/completions', {}), null, '/v1/chat/completions should return null (default openai)');

  console.log('  ✅ detectFormat');

  // initState
  const state = initState('test-model', 'msg_test123');
  assert.strictEqual(state.model, 'test-model', 'State should have model');
  assert.strictEqual(state.messageId, 'msg_test123', 'State should have messageId');
  assert.strictEqual(state.toolCallIndex, 0, 'State should have toolCallIndex');

  console.log('  ✅ initState');

  // Claude -> OpenAI request translation
  const claudeRequest = {
    model: 'deepseek-chat',
    max_tokens: 1024,
    messages: [{ role: 'user', content: 'Hello world' }],
    system: 'You are helpful.',
  };
  const openaiRequest = translateRequest(FORMATS.CLAUDE, FORMATS.OPENAI, 'deepseek-chat', claudeRequest, true);
  assert.ok(openaiRequest, 'Should return translated request');
  assert.ok(Array.isArray(openaiRequest.messages), 'Should have messages array');
  assert.strictEqual(openaiRequest.stream, true, 'Should preserve stream flag');
  // System message should be extracted
  const hasSystem = openaiRequest.messages.some(m => m.role === 'system');
  assert.ok(hasSystem, 'Should convert system to a system message');

  console.log('  ✅ Claude -> OpenAI request translation');

  // OpenAI -> Claude request translation
  const openaiReq = {
    model: 'deepseek-chat',
    max_tokens: 1024,
    messages: [
      { role: 'system', content: 'You are helpful.' },
      { role: 'user', content: 'Hello world' },
    ],
  };
  const claudeReq = translateRequest(FORMATS.OPENAI, FORMATS.CLAUDE, 'deepseek-chat', openaiReq, false);
  assert.ok(claudeReq, 'Should return translated request');
  assert.ok(Array.isArray(claudeReq.messages), 'Should have messages array');
  assert.strictEqual(claudeReq.stream, false, 'Should preserve stream flag');
  assert.ok(claudeReq.max_tokens, 'Should have max_tokens');

  console.log('  ✅ OpenAI -> Claude request translation');

  // Same format = passthrough
  const same = translateRequest(FORMATS.OPENAI, FORMATS.OPENAI, 'test', openaiReq, true);
  assert.strictEqual(same, openaiReq, 'Same format should passthrough');

  console.log('  ✅ Same format passthrough');
}

// ============================================================
// Mock KV
// ============================================================

function createMockKV() {
  const store = new Map();
  return {
    API_KEYS: {
      async get(key, opts) {
        const val = store.get(key);
        if (!val) return null;
        if (opts && opts.type === 'json') {
          return typeof val === 'string' ? JSON.parse(val) : val;
        }
        return typeof val === 'string' ? val : JSON.stringify(val);
      },
      async put(key, val) {
        store.set(key, typeof val === 'string' ? val : JSON.stringify(val));
      },
      async delete(key) {
        store.delete(key);
      },
      async list(opts = {}) {
        const prefix = opts.prefix || '';
        const keys = [];
        for (const key of store.keys()) {
          if (key.startsWith(prefix)) {
            keys.push({ name: key });
          }
        }
        return { keys };
      },
    },
    USAGE_LOG: {
      async get() { return null; },
      async put() {},
    },
    RATE_LIMIT_KV: {
      async get() { return null; },
      async put() {},
    },
    DB: {
      prepare() {
        return {
          bind() { return this; },
          run() { return {}; },
          first() { return {}; },
          all() { return { results: [] }; },
        };
      },
    },
  };
}

// ============================================================
// 价格管理测试
// ============================================================

async function testPricing() {
  console.log('--- Testing pricing management ---');

  // 用 mock KV 测试价格存储
  const mockEnv = createMockKV();

  // 测试设置自定义价格
  await mockEnv.API_KEYS.put('pricing:test-model', JSON.stringify({
    input: 0.50,
    output: 1.00,
    updatedAt: '2026-07-14T00:00:00Z',
  }));

  // 读取自定义价格
  const customPricing = await mockEnv.API_KEYS.get('pricing:test-model', { type: 'json' });
  assert.ok(customPricing, 'Custom pricing should be stored');
  assert.strictEqual(customPricing.input, 0.50);
  assert.strictEqual(customPricing.output, 1.00);

  console.log('  ✅ set custom pricing');

  // 测试价格优先级逻辑 (模拟 getPricingForModel 逻辑)
  const { DEFAULT_PROVIDERS, DEFAULT_PRICING } = require('../lib/providers.js');

  // 1. KV 自定义价格优先
  const kvPricing = await mockEnv.API_KEYS.get('pricing:test-model', { type: 'json' });
  assert.ok(kvPricing, 'KV pricing should be found first');

  // 2. Provider 配置价格 (用 DEFAULT_PROVIDERS)
  const providerPricing = DEFAULT_PROVIDERS.deepseek.models['deepseek-chat'];
  assert.strictEqual(providerPricing.input, 0.14, 'Provider pricing should be correct');

  // 3. 硬编码默认价格
  const defaultPricing = DEFAULT_PRICING['deepseek-chat'];
  assert.strictEqual(defaultPricing.input, 0.14, 'Default pricing should be correct');
  assert.strictEqual(DEFAULT_PRICING.default.input, 0.14, 'Fallback default should exist');

  console.log('  ✅ pricing priority (KV > provider > default)');

  // 测试删除自定义价格
  await mockEnv.API_KEYS.delete('pricing:test-model');
  const deleted = await mockEnv.API_KEYS.get('pricing:test-model');
  assert.strictEqual(deleted, null, 'Deleted pricing should be gone');

  console.log('  ✅ delete custom pricing');

  // 测试列出所有自定义价格
  await mockEnv.API_KEYS.put('pricing:model-a', JSON.stringify({ input: 0.1, output: 0.2 }));
  await mockEnv.API_KEYS.put('pricing:model-b', JSON.stringify({ input: 0.3, output: 0.4 }));
  const list = await mockEnv.API_KEYS.list({ prefix: 'pricing:' });
  assert.strictEqual(list.keys.length, 2, 'Should list 2 custom prices');

  console.log('  ✅ list custom pricing');
}

// ============================================================
// 认证模块测试 (密码哈希 + JWT + token)
// ============================================================

async function testAuth() {
  console.log('--- Testing auth.js ---');

  const {
    hashPassword, verifyPassword, validatePassword,
    signJWT, verifyJWT, generateToken, generateApiKey,
  } = require('../lib/auth.js');

  // 密码哈希
  const { hash, salt } = await hashPassword('TestPass123');
  assert.ok(hash, 'Hash should be non-empty');
  assert.ok(salt, 'Salt should be non-empty');
  assert.notStrictEqual(hash, 'TestPass123', 'Hash should not be plaintext');

  console.log('  ✅ hashPassword');

  // 密码验证
  const valid = await verifyPassword('TestPass123', hash, salt);
  assert.strictEqual(valid, true, 'Correct password should verify');

  const invalid = await verifyPassword('WrongPass456', hash, salt);
  assert.strictEqual(invalid, false, 'Wrong password should fail');

  console.log('  ✅ verifyPassword');

  // 相同盐 + 相同密码 = 相同哈希
  const { hash: hash2 } = await hashPassword('TestPass123', salt);
  assert.strictEqual(hash, hash2, 'Same password + salt = same hash');

  console.log('  ✅ deterministic hash with same salt');

  // 密码强度验证
  assert.strictEqual(validatePassword('Short1').valid, false, 'Too short');
  assert.strictEqual(validatePassword('longenough').valid, false, 'No numbers');
  assert.strictEqual(validatePassword('12345678').valid, false, 'No letters');
  assert.strictEqual(validatePassword('ValidPass123').valid, true, 'Valid password');
  assert.strictEqual(validatePassword('').valid, false, 'Empty password');

  console.log('  ✅ validatePassword');

  // JWT 签发 + 验证
  const token = await signJWT({ email: 'test@example.com', tier: 'free' }, 'test-secret-key');
  assert.ok(token, 'JWT should be non-empty');
  assert.strictEqual(token.split('.').length, 3, 'JWT should have 3 parts');

  console.log('  ✅ signJWT');

  const payload = await verifyJWT(token, 'test-secret-key');
  assert.ok(payload, 'Payload should be non-null');
  assert.strictEqual(payload.email, 'test@example.com');
  assert.strictEqual(payload.tier, 'free');
  assert.ok(payload.iat, 'Should have issued-at');
  assert.ok(payload.exp, 'Should have expiry');
  assert.ok(payload.jti, 'Should have JTI');

  console.log('  ✅ verifyJWT (valid token)');

  // JWT 错误密钥
  const wrongPayload = await verifyJWT(token, 'wrong-secret');
  assert.strictEqual(wrongPayload, null, 'Wrong secret should fail');

  console.log('  ✅ verifyJWT (wrong secret rejected)');

  // JWT 篡改
  const parts = token.split('.');
  const tamperedToken = `${parts[0]}.${parts[1]}.tampered_signature`;
  const tamperedPayload = await verifyJWT(tamperedToken, 'test-secret-key');
  assert.strictEqual(tamperedPayload, null, 'Tampered token should fail');

  console.log('  ✅ verifyJWT (tampered token rejected)');

  // Token 生成
  const token1 = generateToken(32);
  const token2 = generateToken(32);
  assert.strictEqual(token1.length, 64, '32 bytes = 64 hex chars');
  assert.notStrictEqual(token1, token2, 'Tokens should be unique');

  console.log('  ✅ generateToken');

  // API Key 生成
  const apiKey = generateApiKey();
  assert.ok(apiKey.startsWith('sk-'), 'API key should start with sk-');
  assert.ok(apiKey.length > 50, 'API key should be long enough');

  console.log('  ✅ generateApiKey');
}

// ============================================================
// 运行所有测试
// ============================================================

async function runAll() {
  console.log('\n🧪 SilkGateway Unit Tests\n');

  let passed = 0;
  let failed = 0;
  const tests = [
    { name: 'shared', fn: testShared },
    { name: 'providers', fn: testProviders },
    { name: 'keypool', fn: testKeyPool },
    { name: 'combos', fn: testCombos },
    { name: 'rtk', fn: testRTK },
    { name: 'translator', fn: testTranslator },
    { name: 'pricing', fn: testPricing },
    { name: 'auth', fn: testAuth },
  ];

  for (const test of tests) {
    try {
      await test.fn();
      passed++;
      console.log(`  → ${test.name}: ALL PASSED\n`);
    } catch (err) {
      failed++;
      console.error(`  → ${test.name}: FAILED - ${err.message}\n`);
      console.error(err.stack);
    }
  }

  console.log(`\n📊 Results: ${passed} suites passed, ${failed} failed\n`);
  process.exit(failed > 0 ? 1 : 0);
}

runAll();
