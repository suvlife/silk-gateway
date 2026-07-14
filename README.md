# SilkGateway

AI Tokens Global Relay — 基于 Cloudflare Workers 的智能 AI API 网关

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Cloudflare Workers](https://img.shields.io/badge/Cloudflare-Workers-F38020?logo=cloudflare&logoColor=white)](https://workers.cloudflare.com/)

## 简介

SilkGateway 是一个基于 Cloudflare Workers 的 AI API 中转网关，为全球开发者提供对中国大模型（DeepSeek、火山引擎、小米 MiMo、Kimi 等）的高速访问。

核心能力：多模型路由、自动 Failover、Combo 组合切换、OpenAI/Claude 格式互转、RTK Token 压缩、精确计费、完整认证体系。

## 功能特性

### API 中转
- **流式 SSE 转发** — 实时 token 流，兼容 OpenAI 格式
- **全球边缘节点** — Cloudflare 300+ 节点就近接入，延迟 <100ms
- **多格式互转** — OpenAI ↔ Claude 双向格式转换，Claude SDK / Claude Code 用户通过 `/v1/messages` 直接接入
- **RTK Token Saver** — 自动压缩 tool_result（git diff、grep、ls 等），节省 20-40% 输入 token

### 智能路由
- **Provider 注册表** — KV 驱动，动态添加模型供应方无需改代码
- **多账号 Key 池** — 多个 API Key 自动轮询/优先级/failover，指数退避，按模型级锁定
- **模型 Combo** — 定义模型组合，自动 fallback / round-robin 切换，按能力自动路由（有图片 → 优先 vision 模型）
- **model_override** — Combo 中每个位置可指定不同的上游模型名

### 认证体系
- **邮箱+密码注册** — PBKDF2 密码哈希（100k 迭代），邮箱验证后才激活
- **JWT 登录** — 邮箱+密码登录，24h JWT 会话，安全登出（黑名单）
- **密码管理** — 找回密码、重置密码，密码强度校验
- **邮件通知** — 注册验证、欢迎邮件（含 API Key）、密码重置通知（Resend API）
- **API Key 管理** — 登录后在 Dashboard 查看/重置 API Key，旧 Key 立即失效

### 计费与统计
- **按量计费** — Token 级别精确计费，支持 cache token 跟踪
- **多维度统计** — 按 key × 小时 × 模型 的多维度时间序列（hour/day/week/month 粒度）
- **价格管理** — 管理后台动态设置模型价格，无需改代码
- **账单系统** — 充值/消费流水记录，月度账单汇总
- **限流保护** — 按用户等级分级限流

### 管理后台
- **监控面板** — 请求日志、状态码分布、国家统计、延迟分析
- **Provider 管理** — 增删改查上游供应方，测试连通性
- **Connection 管理** — Key 池状态（活跃/锁定/退避），增删改查
- **Combo 管理** — 创建/编辑/删除模型组合
- **Analytics** — 全局 Token/Cost 趋势，按 Key/模型/Combo 分析
- **Pricing** — 模型价格行内编辑
- **Transactions** — 全局交易流水，CSV 导出

## 架构

```
用户请求 (/v1/chat/completions 或 /v1/messages)
    ↓
鉴权 (JWT / API Key) → 限流 → 余额检查
    ↓
RTK 压缩 (compressMessages)           ← Token Saver
    ↓
格式检测 (detectFormat)               ← 格式互转
Claude? → 翻译为 OpenAI (translateRequest)
    ↓
Combo 检测 (isCombo)                  ← 智能路由
是 combo? → handleComboChat 遍历模型
    ↓
Provider 解析 (resolveModel)           ← Provider 注册表
    ↓
Key 池选择 (getCredentials)            ← 多账号 Key 池
    ↓
executeWithKeyPool 循环:
  选 Key → 调上游 → 成功? clearError : markUnavailable → 下一个 Key
    ↓
响应翻译 (translateResponseChunk)      ← 格式互转
    ↓
计费 (recordUsage) → 写入 D1 + KV → 返回
```

**存储分工：**
- **KV** — 用户数据、Provider 配置、Connection、Combo、价格、限流、用量统计、Token 状态
- **D1 (SQLite)** — 请求日志、交易流水、统计分析

## 目录结构

```
silk-gateway/
├── worker.js              # Workers 主代码 (API 中转/鉴权/计费/路由/认证)
├── lib/
│   ├── providers.js       # Provider 注册表 (KV 驱动)
│   ├── keypool.js         # 多账号 Key 池 + Failover
│   ├── combos.js          # 模型 Combo / Fallback 链
│   ├── translator.js      # OpenAI ↔ Claude 格式互转
│   ├── rtk.js             # RTK Token Saver (tool_result 压缩)
│   ├── auth.js            # 密码哈希 (PBKDF2) + JWT + Token 生成
│   ├── email.js           # Resend API 邮件发送
│   └── shared.js          # 共享工具 (错误处理/能力查询/常量)
├── index.html             # 官网落地页
├── register/
│   └── index.html         # 用户注册页 (邮箱+密码+验证)
├── dashboard/
│   └── index.html         # 用户 Dashboard (JWT登录/图表/账单/RTK)
├── reset-password/
│   └── index.html         # 密码重置页
├── docs/
│   └── index.html         # API 文档
├── admin/
│   └── index.html         # 管理面板 (7个tab: 监控/Provider/Connection/Combo/Analytics/Pricing/Transactions)
├── tests/
│   └── run-all.js         # 单元测试 (8套件 46用例)
├── manage-keys.js         # API Key 管理工具 (CLI)
├── package.json           # 项目配置
├── wrangler.toml          # Cloudflare Workers 配置
└── README.md
```

## 快速开始

### 1. 安装 Wrangler CLI

```bash
npm install -g wrangler
wrangler login
```

### 2. 创建存储资源

```bash
# KV 命名空间
wrangler kv namespace create API_KEYS
wrangler kv namespace create RATE_LIMIT_KV
wrangler kv namespace create USAGE_LOG

# D1 数据库
wrangler d1 create silk-gateway-logs
```

将输出的 ID 填入 `wrangler.toml`。

### 3. 创建数据库表

```bash
wrangler d1 execute silk-gateway-logs --remote --command "
CREATE TABLE IF NOT EXISTS request_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  request_id TEXT,
  timestamp TEXT NOT NULL,
  method TEXT NOT NULL,
  path TEXT NOT NULL,
  status INTEGER NOT NULL,
  duration INTEGER NOT NULL,
  user_agent TEXT,
  country TEXT,
  ip TEXT,
  api_key TEXT,
  model TEXT,
  prompt_tokens INTEGER DEFAULT 0,
  completion_tokens INTEGER DEFAULT 0,
  cache_read_tokens INTEGER DEFAULT 0,
  cache_write_tokens INTEGER DEFAULT 0,
  cost REAL DEFAULT 0,
  combo_name TEXT,
  provider_id TEXT,
  error_message TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_request_id ON request_logs(request_id);
CREATE INDEX IF NOT EXISTS idx_timestamp ON request_logs(timestamp);
CREATE INDEX IF NOT EXISTS idx_country ON request_logs(country);
CREATE INDEX IF NOT EXISTS idx_path ON request_logs(path);
CREATE INDEX IF NOT EXISTS idx_combo ON request_logs(combo_name);
CREATE INDEX IF NOT EXISTS idx_provider ON request_logs(provider_id);
CREATE INDEX IF NOT EXISTS idx_apikey_ts ON request_logs(api_key, timestamp);
CREATE INDEX IF NOT EXISTS idx_model_ts ON request_logs(model, timestamp);

CREATE TABLE IF NOT EXISTS transactions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp TEXT NOT NULL,
  api_key TEXT NOT NULL,
  type TEXT NOT NULL,
  amount REAL NOT NULL,
  balance_after REAL,
  model TEXT,
  prompt_tokens INTEGER DEFAULT 0,
  completion_tokens INTEGER DEFAULT 0,
  description TEXT,
  request_id TEXT
);
CREATE INDEX IF NOT EXISTS idx_txn_apikey ON transactions(api_key, timestamp);
CREATE INDEX IF NOT EXISTS idx_txn_type ON transactions(type, timestamp);
"
```

### 4. 设置密钥

```bash
# 上游 Provider API Keys
wrangler secret put VOLCENGINE_API_KEY
wrangler secret put DEEPSEEK_API_KEY
wrangler secret put KIMI_API_KEY
wrangler secret put MIMO_API_KEY

# 管理员密钥（充值、监控、管理端点鉴权，必填）
wrangler secret put ADMIN_SECRET

# JWT 签名密钥（用户登录会话，必填）
wrangler secret put JWT_SECRET

# Resend 邮件 API（注册验证、密码重置邮件）
wrangler secret put RESEND_API_KEY

# 可选：自定义发件人地址（默认 onboarding@resend.dev）
# wrangler secret put MAIL_FROM
```

### 5. 部署

```bash
# 部署 Workers
wrangler deploy

# 部署静态页面 (官网/注册/Dashboard/文档/管理面板)
wrangler pages deploy . --project-name=silk-gateway-site
```

### 6. 绑定自定义域名

在 Cloudflare Dashboard 中：
- 添加 `api.silkgateway.ai` 指向 Workers
- 添加 `silkgateway.ai` 指向 Pages

### 升级迁移（从旧版本）

如果从旧版本升级，需添加新的数据库列：

```bash
wrangler d1 execute silk-gateway-logs --remote --command "ALTER TABLE request_logs ADD COLUMN cache_read_tokens INTEGER DEFAULT 0"
wrangler d1 execute silk-gateway-logs --remote --command "ALTER TABLE request_logs ADD COLUMN cache_write_tokens INTEGER DEFAULT 0"
wrangler d1 execute silk-gateway-logs --remote --command "ALTER TABLE request_logs ADD COLUMN combo_name TEXT"
wrangler d1 execute silk-gateway-logs --remote --command "ALTER TABLE request_logs ADD COLUMN provider_id TEXT"
wrangler d1 execute silk-gateway-logs --remote --command "CREATE INDEX IF NOT EXISTS idx_apikey_ts ON request_logs(api_key, timestamp)"
wrangler d1 execute silk-gateway-logs --remote --command "CREATE INDEX IF NOT EXISTS idx_model_ts ON request_logs(model, timestamp)"
```

## API 端点

### AI 代理

| 端点 | 方法 | 说明 |
|------|------|------|
| `/v1/chat/completions` | POST | 聊天补全 (OpenAI 格式，支持流式) |
| `/v1/messages` | POST | 聊天补全 (Claude 格式，自动转换为 OpenAI) |
| `/v1/models` | GET | 模型列表 |
| `/v1/pricing` | GET | 价格查询 |
| `/v1/combos` | GET | Combo 列表（公开） |

### 认证

| 端点 | 方法 | 说明 |
|------|------|------|
| `/api/register` | POST | 用户注册（邮箱+密码，发验证邮件） |
| `/api/verify-email` | GET | 邮箱验证（token 验证，生成 API Key） |
| `/api/resend-verification` | POST | 重新发送验证邮件 |
| `/api/login` | POST | 登录（邮箱+密码 → JWT） |
| `/api/logout` | POST | 登出（JWT 黑名单） |
| `/api/forgot-password` | POST | 忘记密码（发重置邮件） |
| `/api/reset-password` | POST | 重置密码（token + 新密码） |
| `/api/reset-api-key` | POST | 重置 API Key（需 JWT） |
| `/api/user` | GET | 用户信息（支持 JWT 和 API Key 双模式） |

### 计费与统计

| 端点 | 方法 | 说明 |
|------|------|------|
| `/v1/balance` | GET | 余额查询 |
| `/v1/usage` | GET | 月度用量 |
| `/v1/usage/daily` | GET | 每日用量统计 |
| `/v1/usage/hourly` | GET | 每小时用量统计 |
| `/v1/usage/timeseries` | GET | 多维度时间序列（hour/day/week/month × model/provider/combo） |
| `/v1/usage/aggregate` | GET | 按维度用量聚合（管理员） |
| `/v1/billing` | GET | 账单详情 |
| `/v1/billing/statement` | GET | 月度账单汇总 |
| `/v1/transactions` | GET | 用户交易流水 |
| `/v1/topup` | POST | 充值（管理员） |

### 管理端点（需 X-Admin-Secret）

| 端点 | 方法 | 说明 |
|------|------|------|
| `/v1/stats` | GET | 系统统计 |
| `/v1/logs` | GET | 请求日志 |
| `/v1/admin/providers` | GET/POST | Provider 管理 |
| `/v1/admin/providers/:id` | DELETE | 删除 Provider |
| `/v1/admin/providers/:id/test` | POST | 测试 Provider 连通性 |
| `/v1/admin/connections` | GET/POST | Connection / Key Pool 管理 |
| `/v1/admin/connections/:provider/:id` | PUT/DELETE | 更新/删除 Connection |
| `/v1/admin/combos` | POST | 创建 Combo |
| `/v1/admin/combos/:name` | PUT/DELETE | 更新/删除 Combo |
| `/v1/admin/pricing` | GET | 获取所有模型价格 |
| `/v1/admin/pricing/:model` | PUT/DELETE | 设置/重置模型价格 |
| `/v1/admin/usage/timeseries` | GET | 管理员级时间序列 |
| `/v1/admin/transactions` | GET | 全局交易流水 |

## 使用示例

### 注册与登录

```bash
# 注册（会发送验证邮件）
curl -X POST https://api.silkgateway.ai/api/register \
  -H "Content-Type: application/json" \
  -d '{"email":"user@example.com","firstName":"John","lastName":"Doe","password":"SecurePass123"}'

# 登录（获取 JWT）
curl -X POST https://api.silkgateway.ai/api/login \
  -H "Content-Type: application/json" \
  -d '{"email":"user@example.com","password":"SecurePass123"}'
# → { "token": "eyJ...", "user": { "email": "...", "tier": "free" } }
```

### 流式调用（OpenAI 格式）

```bash
curl https://api.silkgateway.ai/v1/chat/completions \
  -H "Authorization: Bearer sk-your-key" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "deepseek-chat",
    "messages": [{"role": "user", "content": "Hello!"}],
    "stream": true
  }'
```

### Claude 格式调用（自动转换）

```bash
# Claude SDK / Claude Code 用户直接使用 /v1/messages
curl https://api.silkgateway.ai/v1/messages \
  -H "x-api-key: sk-your-key" \
  -H "Content-Type: application/json" \
  -H "anthropic-version: 2023-06-01" \
  -d '{
    "model": "deepseek-chat",
    "max_tokens": 1024,
    "messages": [{"role": "user", "content": "Hello!"}]
  }'
```

### 使用 Combo（模型组合自动切换）

```bash
# 使用 combo 名作为 model，自动 fallback/round-robin
curl https://api.silkgateway.ai/v1/chat/completions \
  -H "Authorization: Bearer sk-your-key" \
  -H "Content-Type: application/json" \
  -d '{"model": "fast-cheap", "messages": [{"role": "user", "content": "Hello!"}]}'
```

### RTK Token Saver

RTK 默认启用，自动压缩 tool_result 内容，节省 20-40% 输入 token。

```bash
# 单次请求关闭 RTK
curl https://api.silkgateway.ai/v1/chat/completions \
  -H "Authorization: Bearer sk-your-key" \
  -H "X-RTK: off" \
  -H "Content-Type: application/json" \
  -d '{"model":"deepseek-chat","messages":[...]}'

# 响应头包含压缩统计
# X-RTK-Saved: 1234bytes(15%)
```

### 管理端点示例

```bash
# 添加 Provider
curl -X POST https://api.silkgateway.ai/v1/admin/providers \
  -H "X-Admin-Secret: your-admin-secret" \
  -H "Content-Type: application/json" \
  -d '{"id":"deepseek","name":"DeepSeek","baseUrl":"https://api.deepseek.com/v1","authType":"bearer","apiKeyEnv":"DEEPSEEK_API_KEY","format":"openai","priority":1,"active":true,"models":{"deepseek-chat":{"input":0.14,"output":0.28}}}'

# 添加 API Key 到 Key Pool
curl -X POST https://api.silkgateway.ai/v1/admin/connections \
  -H "X-Admin-Secret: your-admin-secret" \
  -H "Content-Type: application/json" \
  -d '{"provider":"deepseek","apiKey":"sk-xxx","priority":1,"name":"primary"}'

# 创建 Combo
curl -X POST https://api.silkgateway.ai/v1/admin/combos \
  -H "X-Admin-Secret: your-admin-secret" \
  -H "Content-Type: application/json" \
  -d '{"name":"fast-cheap","models":["mimo-v2.5","deepseek-chat","kimi-k2.6"],"strategy":"fallback","autoSwitch":true}'

# 创建 Combo（带 model_override）
curl -X POST https://api.silkgateway.ai/v1/admin/combos \
  -H "X-Admin-Secret: your-admin-secret" \
  -H "Content-Type: application/json" \
  -d '{"name":"smart-cluster","models":[{"model":"deepseek-chat","modelOverride":"deepseek-v3"},{"model":"mimo-v2.5"}],"strategy":"round-robin","stickyLimit":3}'

# 设置模型价格
curl -X PUT https://api.silkgateway.ai/v1/admin/pricing/deepseek-chat \
  -H "X-Admin-Secret: your-admin-secret" \
  -H "Content-Type: application/json" \
  -d '{"input":0.14,"output":0.28}'
```

## 支持模型

| 模型 | Provider | 输入价格 | 输出价格 |
|------|----------|----------|----------|
| deepseek-chat | DeepSeek | $0.14/M | $0.28/M |
| deepseek-reasoner | DeepSeek | $0.55/M | $2.19/M |
| deepseek-v4-pro | DeepSeek | $0.55/M | $2.19/M |
| deepseek-v4-flash | DeepSeek | $0.14/M | $0.28/M |
| doubao-seed-2.0-pro | 火山引擎 | $0.11/M | $0.43/M |
| ark-code-latest | 火山引擎 | $0.11/M | $0.43/M |
| kimi-k2.6 | Kimi | $0.14/M | $0.42/M |
| moonshot-v1-128k | Kimi | $0.14/M | $0.42/M |
| mimo-v2.5 | 小米 MiMo | $0.10/M | $0.30/M |
| mimo-v2.5-pro | 小米 MiMo | $0.10/M | $0.30/M |
| glm-5.1 | 智谱 | $0.14/M | $0.28/M |

可通过管理后台动态添加更多 Provider 和模型。

## 用户等级

| 等级 | 月费 | 免费额度 | 限流 | 折扣 |
|------|------|----------|------|------|
| Free | $0 | 100K tokens | 10/min | 0% |
| Pro | $29 | 1M tokens | 200/min | 10% |
| Enterprise | 自定义 | 10M tokens | 2000/min | 20% |

## 页面

| 页面 | 地址 | 说明 |
|------|------|------|
| 官网 | `https://silkgateway.ai` | 落地页 |
| 注册 | `https://silkgateway.ai/register/` | 用户注册（邮箱+密码+验证） |
| Dashboard | `https://silkgateway.ai/dashboard/` | 用户面板（JWT登录/图表/账单/RTK） |
| 密码重置 | `https://silkgateway.ai/reset-password/` | 密码重置页 |
| 文档 | `https://silkgateway.ai/docs/` | API 文档 |
| 管理面板 | `https://silkgateway.ai/admin/` | 系统管理（7个tab） |

## 高级功能

### Provider 注册表

Provider 配置存储在 KV 中（key 前缀 `provider:`），支持动态添加无需改代码。KV 无数据时自动降级使用内置默认配置。支持 `bearer` 和 `x-api-key` 两种认证方式。

### 多账号 Key 池

每个 Provider 可配置多个 API Key（Connection），支持 fill-first（优先级）和 round-robin（轮询）策略。Key 失败时自动锁定 + 指数退避（2s→4s→8s... 上限 5min）+ 切换到下一个 Key。支持按模型级锁定。

### 模型 Combo

定义模型组合（如 `fast-cheap = [mimo-v2.5, deepseek-chat, kimi-k2.6]`），请求时自动按 fallback 或 round-robin 策略切换。支持 `model_override`（每个位置可指定不同上游模型名）。按模型能力自动重排（有图片请求优先路由到 vision 模型）。

### 格式互转

支持 OpenAI ↔ Claude 双向格式转换。Claude SDK / Claude Code 用户通过 `/v1/messages` 端点接入，后端自动转换为 OpenAI 格式调用上游，响应再转回 Claude 格式。流式 SSE 逐 chunk 翻译。

### RTK Token Saver

转发前自动检测并压缩 `tool_result` 内容（git diff、grep、ls、build output 等 12 种过滤器），节省 20-40% 输入 token。Fail-open 设计，出错不阻断请求。通过 `X-RTK: off` 请求头可单次关闭。

### 认证体系

- **注册**：邮箱+密码（PBKDF2 哈希），邮箱验证后才生成 API Key
- **登录**：邮箱+密码 → JWT（HS256，24h），支持登出黑名单
- **密码管理**：找回密码（邮箱重置链接，1h TTL）、重置密码
- **API Key**：登录后在 Dashboard 查看/重置，旧 Key 立即失效
- **双模式认证**：JWT（Dashboard 操作）和 API Key（API 调用）分离

### 精确计费与统计

- 按 key × 小时 × 模型 的多维度时间序列统计
- 支持 hour/day/week/month 粒度
- Cache token（cache_read / cache_write）跟踪
- 充值/消费流水记录，月度账单汇总
- 管理后台动态价格管理（KV 存储，优先级：自定义 > Provider 配置 > 默认）

## 环境变量

| 变量名 | 说明 |
|--------|------|
| `VOLCENGINE_API_KEY` | 火山引擎 API Key |
| `DEEPSEEK_API_KEY` | DeepSeek API Key |
| `KIMI_API_KEY` | Kimi API Key |
| `MIMO_API_KEY` | 小米 MiMo API Key |
| `OPENAI_API_KEY` | OpenAI API Key（可选） |
| `ADMIN_SECRET` | 管理员密钥（管理端点鉴权，必填） |
| `JWT_SECRET` | JWT 签名密钥（用户登录会话，必填） |
| `RESEND_API_KEY` | Resend 邮件 API key（注册验证、密码重置） |
| `MAIL_FROM` | 可选：发件人地址（默认 onboarding@resend.dev） |

## 测试

```bash
# 运行全部单元测试（8 套件 46 用例）
npm test

# 测试覆盖：
# - shared.js: 能力查询、错误规则、指数退避、模型锁、能力检测
# - providers.js: 模型路由、价格表、KV 降级兼容
# - keypool.js: fill-first 选择、轮询、failover、锁定/解锁
# - combos.js: 创建/删除、model_override、字符串兼容、校验
# - rtk.js: git diff 压缩、小内容跳过、fail-open、Claude 格式
# - translator.js: 格式检测、Claude↔OpenAI 双向转换
# - pricing.js: KV 价格优先级、设置/删除/列表
# - auth.js: 密码哈希/验证、JWT 签发/验证/防篡改、token 生成
```

## D1 日志查询

```bash
# 今日请求数
wrangler d1 execute silk-gateway-logs --remote \
  --command "SELECT COUNT(*) as count FROM request_logs WHERE timestamp >= '2026-07-14'"

# 按模型统计 Token 消耗
wrangler d1 execute silk-gateway-logs --remote \
  --command "SELECT model, SUM(prompt_tokens) as input, SUM(completion_tokens) as output FROM request_logs WHERE model IS NOT NULL GROUP BY model"

# 按 Combo 统计使用量
wrangler d1 execute silk-gateway-logs --remote \
  --command "SELECT combo_name, COUNT(*) as requests, SUM(cost) as cost FROM request_logs WHERE combo_name IS NOT NULL GROUP BY combo_name"

# 查询交易流水
wrangler d1 execute silk-gateway-logs --remote \
  --command "SELECT * FROM transactions ORDER BY timestamp DESC LIMIT 20"
```

## License

MIT

## 联系方式

- 官网: https://silkgateway.ai
- 文档: https://silkgateway.ai/docs/
- 邮箱: support@silkgateway.ai
- GitHub: https://github.com/suvlife/silk-gateway
