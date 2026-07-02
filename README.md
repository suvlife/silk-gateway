# SilkGateway

AI Tokens Global Relay - 中国大模型 Token 出海中转站

## 简介

SilkGateway 是一个基于 Cloudflare Workers 的 AI API 中转服务，为全球开发者提供对中国大模型（DeepSeek、火山引擎、小米 MiMo 等）的高速访问。

## 功能特性

- **流式 SSE 转发** - 实时 token 流，兼容 OpenAI 格式
- **全球边缘节点** - Cloudflare 300+ 节点就近接入
- **多模型支持** - DeepSeek、火山引擎、小米 MiMo 等 9+ 模型
- **用户注册系统** - 自助注册获取 API Key
- **按用量计费** - Token 级别精确计费
- **限流保护** - 按用户等级分级限流
- **实时监控** - 请求日志、状态码分布、国家统计

## 架构

```
用户请求
    ↓
Cloudflare 边缘节点 (全球 300+)
    ↓
Workers API 中转 (鉴权/限流/路由)
    ↓
中国大模型 API (DeepSeek/Volcengine/MiMo)
    ↓
D1 数据库 (日志/统计) + KV (用户数据/限流)
```

## 目录结构

```
silk-gateway/
├── worker.js          # Workers 主代码 (API 中转/鉴权/计费/监控)
├── index.html         # 官网落地页
├── register/
│   └── index.html     # 用户注册页
├── dashboard/
│   └── index.html     # 用户 Dashboard
├── docs/
│   └── index.html     # API 文档
├── admin/
│   └── index.html     # 监控面板
├── billing.js         # 计费逻辑
├── manage-keys.js     # API Key 管理工具
├── wrangler.toml      # Cloudflare Workers 配置
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
wrangler kv namespace create LOGS

# D1 数据库 (日志)
wrangler d1 create silk-gateway-logs
```

将输出的 ID 填入 `wrangler.toml`。

### 3. 创建数据库表

```bash
wrangler d1 execute silk-gateway-logs --remote --command "
CREATE TABLE IF NOT EXISTS request_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
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
  cost REAL DEFAULT 0,
  error_message TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_timestamp ON request_logs(timestamp);
CREATE INDEX IF NOT EXISTS idx_country ON request_logs(country);
CREATE INDEX IF NOT EXISTS idx_path ON request_logs(path);
"
```

### 4. 设置 API Key

```bash
wrangler secret put VOLCENGINE_API_KEY
wrangler secret put DEEPSEEK_API_KEY
wrangler secret put KIMI_API_KEY
wrangler secret put MIMO_API_KEY
```

### 5. 部署

```bash
# 部署 Workers
wrangler deploy

# 部署静态页面 (官网/注册/Dashboard/文档/监控)
wrangler pages deploy . --project-name=silk-gateway-site
```

### 6. 绑定自定义域名

在 Cloudflare Dashboard 中：
- 添加 `api.silkgateway.ai` 指向 Workers
- 添加 `silkgateway.ai` 指向 Pages

## API 端点

| 端点 | 方法 | 说明 |
|------|------|------|
| `/v1/chat/completions` | POST | 聊天补全 (支持流式) |
| `/v1/models` | GET | 模型列表 |
| `/v1/pricing` | GET | 价格查询 |
| `/v1/balance` | GET | 余额查询 |
| `/v1/usage` | GET | 用量查询 |
| `/v1/billing` | GET | 账单详情 |
| `/v1/topup` | POST | 充值 |
| `/v1/stats` | GET | 系统统计 |
| `/v1/logs` | GET | 请求日志 |
| `/api/register` | POST | 用户注册 |
| `/api/user` | GET | 用户信息 |

## 使用示例

```bash
# 流式调用
curl https://api.silkgateway.ai/v1/chat/completions \
  -H "Authorization: Bearer sk-your-key" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "deepseek-chat",
    "messages": [{"role": "user", "content": "Hello!"}],
    "stream": true
  }'

# 查询余额
curl https://api.silkgateway.ai/v1/balance \
  -H "Authorization: Bearer sk-your-key"
```

## 支持模型

| 模型 | Provider | 输入价格 | 输出价格 |
|------|----------|----------|----------|
| deepseek-chat | DeepSeek | $0.14/M | $0.28/M |
| deepseek-v4-pro | DeepSeek | $0.55/M | $2.19/M |
| deepseek-reasoner | DeepSeek | $0.55/M | $2.19/M |
| ark-code-latest | 火山引擎 | $0.11/M | $0.43/M |
| doubao-seed-2.0-pro | 火山引擎 | $0.11/M | $0.43/M |
| mimo-v2.5 | 小米 MiMo | $0.10/M | $0.30/M |
| mimo-v2.5-pro | 小米 MiMo | $0.10/M | $0.30/M |

## 用户等级

| 等级 | 月费 | 免费额度 | 限流 | 折扣 |
|------|------|----------|------|------|
| Free | $0 | 100K tokens | 10/min | 0% |
| Pro | $29 | 1M tokens | 200/min | 10% |
| Enterprise | 自定义 | 10M tokens | 2000/min | 20% |

## 监控

访问 `/admin/` 查看：
- 实时请求数和错误率
- 状态码分布
- 国家来源统计
- 请求日志

### D1 日志查询

```bash
# 今日请求数
wrangler d1 execute silk-gateway-logs --remote \
  --command "SELECT COUNT(*) as count FROM request_logs WHERE timestamp >= '2026-07-02'"

# 按国家统计
wrangler d1 execute silk-gateway-logs --remote \
  --command "SELECT country, COUNT(*) as count FROM request_logs GROUP BY country ORDER BY count DESC"

# 查询慢请求 (>1秒)
wrangler d1 execute silk-gateway-logs --remote \
  --command "SELECT * FROM request_logs WHERE duration > 1000 ORDER BY duration DESC LIMIT 10"

# 按模型统计 Token 消耗
wrangler d1 execute silk-gateway-logs --remote \
  --command "SELECT model, SUM(prompt_tokens) as input, SUM(completion_tokens) as output FROM request_logs WHERE model IS NOT NULL GROUP BY model"
```

## 环境变量

| 变量名 | 说明 |
|--------|------|
| `VOLCENGINE_API_KEY` | 火山引擎 API Key |
| `DEEPSEEK_API_KEY` | DeepSeek API Key |
| `KIMI_API_KEY` | Kimi API Key |
| `MIMO_API_KEY` | 小米 MiMo API Key |

## License

MIT

## 联系方式

- 官网: https://silkgateway.ai
- 文档: https://silkgateway.ai/docs/
- 邮箱: support@silkgateway.ai
