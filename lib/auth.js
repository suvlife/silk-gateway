/**
 * SilkGateway - 认证工具模块
 * 密码哈希 (PBKDF2-SHA256) + JWT (HS256) + Token 生成
 * 纯 Web Crypto API,无外部依赖,Cloudflare Workers 原生兼容
 */

// ============================================================
// 密码哈希 (PBKDF2-SHA256, 100000 轮迭代)
// ============================================================

const PBKDF2_ITERATIONS = 100000;
const SALT_LENGTH = 16; // bytes
const HASH_LENGTH = 32; // bytes

/**
 * 哈希密码
 * @param {string} password - 明文密码
 * @param {string} [saltBase64] - 可选盐 (base64),不传则随机生成
 * @returns {Promise<{ hash: string, salt: string }>} base64 编码的哈希和盐
 */
export async function hashPassword(password, saltBase64) {
  let salt;
  if (saltBase64) {
    salt = base64ToBuffer(saltBase64);
  } else {
    salt = crypto.getRandomValues(new Uint8Array(SALT_LENGTH));
  }

  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(password),
    'PBKDF2',
    false,
    ['deriveBits']
  );

  const hashBuffer = await crypto.subtle.deriveBits(
    {
      name: 'PBKDF2',
      salt,
      iterations: PBKDF2_ITERATIONS,
      hash: 'SHA-256',
    },
    keyMaterial,
    HASH_LENGTH * 8
  );

  return {
    hash: bufferToBase64(hashBuffer),
    salt: bufferToBase64(salt),
  };
}

/**
 * 验证密码
 * @param {string} password - 明文密码
 * @param {string} hashBase64 - 存储的哈希 (base64)
 * @param {string} saltBase64 - 存储的盐 (base64)
 * @returns {Promise<boolean>}
 */
export async function verifyPassword(password, hashBase64, saltBase64) {
  const { hash } = await hashPassword(password, saltBase64);
  return hash === hashBase64;
}

/**
 * 验证密码强度
 * @param {string} password
 * @returns {{ valid: boolean, error?: string }}
 */
export function validatePassword(password) {
  if (!password || password.length < 8) {
    return { valid: false, error: 'Password must be at least 8 characters' };
  }
  if (!/[a-zA-Z]/.test(password)) {
    return { valid: false, error: 'Password must contain at least one letter' };
  }
  if (!/[0-9]/.test(password)) {
    return { valid: false, error: 'Password must contain at least one number' };
  }
  return { valid: true };
}

// ============================================================
// JWT (HS256, 24h 过期)
// ============================================================

const JWT_EXPIRY_SECONDS = 24 * 60 * 60; // 24 hours

/**
 * 签发 JWT
 * @param {object} payload - JWT payload (会自动加 iat, exp, jti)
 * @param {string} secret - 签名密钥
 * @returns {Promise<string>} JWT token
 */
export async function signJWT(payload, secret) {
  const header = { alg: 'HS256', typ: 'JWT' };
  const now = Math.floor(Date.now() / 1000);
  const jti = generateToken(16);

  const fullPayload = {
    ...payload,
    iat: now,
    exp: now + JWT_EXPIRY_SECONDS,
    jti,
  };

  const encodedHeader = base64UrlEncode(JSON.stringify(header));
  const encodedPayload = base64UrlEncode(JSON.stringify(fullPayload));
  const data = `${encodedHeader}.${encodedPayload}`;

  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );

  const signature = await crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(data)
  );

  const encodedSignature = bufferToBase64Url(signature);
  return `${data}.${encodedSignature}`;
}

/**
 * 验证 JWT
 * @param {string} token - JWT token
 * @param {string} secret - 签名密钥
 * @returns {Promise<object|null>} payload 或 null (无效/过期)
 */
export async function verifyJWT(token, secret) {
  const parts = token.split('.');
  if (parts.length !== 3) return null;

  const [encodedHeader, encodedPayload, encodedSignature] = parts;
  const data = `${encodedHeader}.${encodedPayload}`;

  // 验证签名
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['verify']
  );

  const signatureBuffer = base64UrlToBuffer(encodedSignature);
  const valid = await crypto.subtle.verify(
    'HMAC',
    key,
    signatureBuffer,
    new TextEncoder().encode(data)
  );

  if (!valid) return null;

  // 解析 payload
  let payload;
  try {
    payload = JSON.parse(base64UrlDecode(encodedPayload));
  } catch {
    return null;
  }

  // 检查过期
  const now = Math.floor(Date.now() / 1000);
  if (payload.exp && payload.exp < now) return null;

  return payload;
}

// ============================================================
// Token 生成
// ============================================================

/**
 * 生成随机 token (hex)
 * @param {number} bytes - 字节数
 * @returns {string} hex string
 */
export function generateToken(bytes = 32) {
  const randomBytes = crypto.getRandomValues(new Uint8Array(bytes));
  return Array.from(randomBytes, b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * 生成 API Key
 * @returns {string} sk-xxx 格式
 */
export function generateApiKey() {
  const randomBytes = new Uint8Array(24);
  crypto.getRandomValues(randomBytes);
  return 'sk-' + Array.from(randomBytes, b => b.toString(16).padStart(2, '0')).join('');
}

// ============================================================
// Base64 / Base64Url 工具
// ============================================================

function bufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function base64ToBuffer(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function bufferToBase64Url(buffer) {
  return bufferToBase64(buffer)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function base64UrlToBuffer(str) {
  const base64 = str.replace(/-/g, '+').replace(/_/g, '/');
  const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
  return base64ToBuffer(padded);
}

function base64UrlEncode(str) {
  return bufferToBase64Url(new TextEncoder().encode(str));
}

function base64UrlDecode(str) {
  return new TextDecoder().decode(base64UrlToBuffer(str));
}
