/**
 * SilkGateway - 邮件发送模块
 * 基于 Resend API,Cloudflare Workers 原生兼容 (fetch 调用)
 *
 * 需要配置: wrangler secret put RESEND_API_KEY
 * 可选配置: wrangler secret put MAIL_FROM (默认 onboarding@resend.dev)
 */

const RESEND_API_URL = 'https://api.resend.com/emails';
const DEFAULT_FROM = 'SilkGateway <onboarding@resend.dev>';
const BRAND_COLOR = '#c9a84c';
const BRAND_BG = '#0a0a0f';

/**
 * 底层邮件发送
 * @param {object} env - Workers env (需要 RESEND_API_KEY)
 * @param {string} to - 收件人
 * @param {string} subject - 邮件标题
 * @param {string} html - HTML 内容
 * @returns {Promise<{ success: boolean, error?: string }>}
 */
export async function sendEmail(env, to, subject, html) {
  const apiKey = env.RESEND_API_KEY;
  if (!apiKey) {
    console.error('RESEND_API_KEY not configured');
    return { success: false, error: 'Email service not configured' };
  }

  const from = env.MAIL_FROM || DEFAULT_FROM;

  try {
    const res = await fetch(RESEND_API_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ from, to: [to], subject, html }),
    });

    if (!res.ok) {
      const errText = await res.text();
      console.error('Resend API error:', res.status, errText);
      return { success: false, error: `Email send failed: ${res.status}` };
    }

    return { success: true };
  } catch (err) {
    console.error('Email send error:', err);
    return { success: false, error: err.message };
  }
}

/**
 * 发送邮箱验证邮件
 */
export async function sendVerificationEmail(env, email, verifyUrl) {
  const html = emailTemplate({
    title: 'Verify Your Email',
    greeting: `Welcome to SilkGateway!`,
    body: `
      <p>Please verify your email address to activate your account and receive your API key.</p>
      <div style="text-align:center;margin:32px 0">
        <a href="${verifyUrl}" style="display:inline-block;padding:14px 36px;background:${BRAND_COLOR};color:#0a0a0f;text-decoration:none;font-weight:600;border-radius:8px;font-size:16px">Verify Email Address</a>
      </div>
      <p style="color:#8b8b9a;font-size:13px">Or copy this link: ${verifyUrl}</p>
      <p style="color:#8b8b9a;font-size:13px">This link expires in 24 hours.</p>
    `,
  });

  return sendEmail(env, email, 'Verify Your Email - SilkGateway', html);
}

/**
 * 发送欢迎邮件 (验证成功后,含 API Key)
 */
export async function sendWelcomeEmail(env, email, apiKey, firstName) {
  const html = emailTemplate({
    title: 'Welcome to SilkGateway',
    greeting: `Welcome aboard, ${firstName || 'there'}!`,
    body: `
      <p>Your email has been verified. Here's your API key:</p>
      <div style="background:#16161f;border:1px solid rgba(255,255,255,0.1);border-radius:8px;padding:16px;margin:24px 0;font-family:monospace;font-size:14px;color:${BRAND_COLOR};word-break:break-all">${apiKey}</div>
      <p style="color:#f87171;font-weight:600">⚠️ Save this key securely! It will not be shown again.</p>
      <div style="text-align:center;margin:32px 0">
        <a href="https://silkgateway.ai/dashboard/" style="display:inline-block;padding:14px 36px;background:${BRAND_COLOR};color:#0a0a0f;text-decoration:none;font-weight:600;border-radius:8px;font-size:16px">Go to Dashboard</a>
      </div>
      <h3 style="color:#e8e8ed;margin-top:32px">Quick Start</h3>
      <pre style="background:#16161f;border-radius:8px;padding:16px;overflow-x:auto;font-size:13px;color:#8b8b9a">curl https://api.silkgateway.ai/v1/chat/completions \\
  -H "Authorization: Bearer ${apiKey}" \\
  -H "Content-Type: application/json" \\
  -d '{"model":"deepseek-chat","messages":[{"role":"user","content":"Hello!"}]}'</pre>
    `,
  });

  return sendEmail(env, email, 'Welcome to SilkGateway - Your API Key', html);
}

/**
 * 发送密码重置邮件
 */
export async function sendPasswordResetEmail(env, email, resetUrl) {
  const html = emailTemplate({
    title: 'Reset Your Password',
    greeting: 'Password Reset Request',
    body: `
      <p>We received a request to reset your SilkGateway password. Click the button below to set a new password:</p>
      <div style="text-align:center;margin:32px 0">
        <a href="${resetUrl}" style="display:inline-block;padding:14px 36px;background:${BRAND_COLOR};color:#0a0a0f;text-decoration:none;font-weight:600;border-radius:8px;font-size:16px">Reset Password</a>
      </div>
      <p style="color:#8b8b9a;font-size:13px">Or copy this link: ${resetUrl}</p>
      <p style="color:#8b8b9a;font-size:13px">This link expires in 1 hour.</p>
      <p style="color:#8b8b9a;font-size:13px">If you didn't request this, you can safely ignore this email.</p>
    `,
  });

  return sendEmail(env, email, 'Reset Your Password - SilkGateway', html);
}

/**
 * 发送密码已修改通知
 */
export async function sendPasswordChangedNotification(env, email) {
  const html = emailTemplate({
    title: 'Password Changed',
    greeting: 'Security Notification',
    body: `
      <p>Your SilkGateway account password has been successfully changed.</p>
      <p>If you did not make this change, please <a href="https://silkgateway.ai/dashboard/" style="color:${BRAND_COLOR}">log in immediately</a> and reset your password, or contact support.</p>
    `,
  });

  return sendEmail(env, email, 'Your Password Was Changed - SilkGateway', html);
}

// ============================================================
// 邮件 HTML 模板
// ============================================================

function emailTemplate({ title, greeting, body }) {
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title}</title>
</head>
<body style="margin:0;padding:0;background:${BRAND_BG};font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif">
  <div style="max-width:560px;margin:0 auto;padding:40px 24px">
    <div style="text-align:center;margin-bottom:32px">
      <div style="display:inline-block;width:48px;height:48px;background:linear-gradient(135deg,${BRAND_COLOR},#d4af37);border-radius:12px;line-height:48px;font-size:24px;font-weight:700;color:#0a0a0f">S</div>
      <div style="color:#e8e8ed;font-size:20px;font-weight:600;margin-top:12px">Silk<span style="color:${BRAND_COLOR}">Gateway</span></div>
    </div>
    <div style="background:#12121a;border:1px solid rgba(255,255,255,0.08);border-radius:16px;padding:32px">
      <h1 style="color:#e8e8ed;font-size:22px;margin:0 0 16px">${greeting}</h1>
      <div style="color:#8b8b9a;font-size:15px;line-height:1.6">
        ${body}
      </div>
    </div>
    <div style="text-align:center;margin-top:24px;color:#5a5a6e;font-size:12px">
      <p>© 2026 SilkGateway. All rights reserved.</p>
      <p>This email was sent to you because you have an account at silkgateway.ai</p>
    </div>
  </div>
</body>
</html>`;
}
