#!/usr/bin/env node

/**
 * API Key 管理工具
 * 
 * 用法：
 *   node manage-keys.js create <userId> [tier] [provider]
 *   node manage-keys.js list
 *   node manage-keys.js disable <key>
 *   node manage-keys.js enable <key>
 *   node manage-keys.js delete <key>
 * 
 * 示例：
 *   node manage-keys.js create user123 pro volcengine
 *   node manage-keys.js disable sk-abc123
 */

const { execSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');

const KV_BINDING = 'API_KEYS';

function runWrangler(args) {
  try {
    const result = execSync(`wrangler ${args}`, { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] });
    return result.trim();
  } catch (err) {
    console.error(`Error: ${err.stderr || err.message}`);
    process.exit(1);
  }
}

function generateApiKey() {
  const random = crypto.randomBytes(24).toString('hex');
  return `sk-${random}`;
}

function createKey(userId, tier = 'free', provider = 'volcengine') {
  const key = generateApiKey();
  const keyInfo = {
    userId,
    tier,
    provider,
    active: true,
    createdAt: new Date().toISOString(),
  };

  const value = JSON.stringify(keyInfo).replace(/"/g, '\\"');
  runWrangler(`kv key put --binding=${KV_BINDING} "${key}" "${value}"`);

  console.log('\n✅ API Key created successfully!\n');
  console.log(`  Key:      ${key}`);
  console.log(`  User:     ${userId}`);
  console.log(`  Tier:     ${tier}`);
  console.log(`  Provider: ${provider}`);
  console.log(`\n  保存好此 Key，后续无法再次查看！\n`);
}

function updateKey(key, updates) {
  // 先读取现有数据
  const existing = runWrangler(`kv key get --binding=${KV_BINDING} "${key}"`);
  if (!existing) {
    console.error('Key not found');
    process.exit(1);
  }

  const keyInfo = JSON.parse(existing);
  const updated = { ...keyInfo, ...updates };

  const value = JSON.stringify(updated).replace(/"/g, '\\"');
  runWrangler(`kv key put --binding=${KV_BINDING} "${key}" "${value}"`);

  console.log(`✅ Key ${key.slice(0, 12)}... updated`);
}

// CLI
const [,, command, ...args] = process.argv;

switch (command) {
  case 'create': {
    const [userId, tier, provider] = args;
    if (!userId) {
      console.error('用法: node manage-keys.js create <userId> [tier] [provider]');
      process.exit(1);
    }
    createKey(userId, tier, provider);
    break;
  }

  case 'disable': {
    const [key] = args;
    if (!key) {
      console.error('用法: node manage-keys.js disable <key>');
      process.exit(1);
    }
    updateKey(key, { active: false });
    break;
  }

  case 'enable': {
    const [key] = args;
    if (!key) {
      console.error('用法: node manage-keys.js enable <key>');
      process.exit(1);
    }
    updateKey(key, { active: true });
    break;
  }

  case 'info': {
    const [key] = args;
    if (!key) {
      console.error('用法: node manage-keys.js info <key>');
      process.exit(1);
    }
    const data = runWrangler(`kv key get --binding=${KV_BINDING} "${key}"`);
    console.log(JSON.parse(data));
    break;
  }

  default:
    console.log(`
SilkGateway API Key Manager

用法：
  node manage-keys.js create <userId> [tier] [provider]  创建新 Key
  node manage-keys.js disable <key>                      禁用 Key
  node manage-keys.js enable <key>                       启用 Key
  node manage-keys.js info <key>                         查看 Key 信息

示例：
  node manage-keys.js create user123 pro volcengine
  node manage-keys.js disable sk-abc123def456
    `);
}
