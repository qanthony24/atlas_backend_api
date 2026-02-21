import nodemailer from 'nodemailer';
import crypto from 'crypto';
import { config } from '../config';

export function isEmailAllowlisted(recipientEmail: string): boolean {
  const allow = (config.otpEmailAllowlist || '').trim();
  if (!allow) return true; // default: attempt send (can still fail in SES sandbox)

  const email = String(recipientEmail || '').trim().toLowerCase();
  const parts = allow
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);

  const domain = email.includes('@') ? '@' + email.split('@')[1] : '';

  return parts.some((p) => p === email || (p.startsWith('@') && p === domain));
}

export async function sendOtpEmail(params: {
  to: string;
  code: string;
  magicLink: string;
}): Promise<{ attempted: boolean; messageId?: string; error?: string }> {
  const to = params.to;
  if (!config.smtpHost || !config.smtpUser || !config.smtpPass) {
    return { attempted: false, error: 'SMTP not configured' };
  }

  if (!isEmailAllowlisted(to)) {
    return { attempted: false, error: 'Recipient not allowlisted' };
  }

  const transport = nodemailer.createTransport({
    host: config.smtpHost,
    port: config.smtpPort,
    secure: config.smtpPort === 465, // true for 465, false for 587 STARTTLS
    auth: {
      user: config.smtpUser,
      pass: config.smtpPass,
    },
    // Avoid hanging HTTP requests if SMTP is misconfigured/unreachable.
    connectionTimeout: 4000,
    greetingTimeout: 4000,
    socketTimeout: 6000,
  } as any);

  const text = [
    'Your Atlas login code:',
    '',
    params.code,
    '',
    'Or tap this link to sign in:',
    params.magicLink,
    '',
    'This code/link expires in 10 minutes.',
    'If you did not request this, you can ignore this email.',
  ].join('\n');

  const html = `
    <p>Your Atlas login code:</p>
    <p style="font-size:24px; font-weight:700; letter-spacing:0.1em">${params.code}</p>
    <p>Or tap this link to sign in:</p>
    <p><a href="${params.magicLink}">${params.magicLink}</a></p>
    <p><small>This code/link expires in 10 minutes. If you did not request this, you can ignore this email.</small></p>
  `;

  try {
    const info = await transport.sendMail({
      from: config.emailFrom,
      to,
      subject: 'Your Atlas login code',
      text,
      html,
      headers: {
        'X-Entity-Ref-ID': crypto.randomUUID(),
      },
    });

    return { attempted: true, messageId: info.messageId };
  } catch (err: any) {
    return { attempted: true, error: err?.message || String(err) };
  }
}
