/**
 * Sends the verification e-mail.
 *   SMTP_HOST set   -> real e-mail through nodemailer (any SMTP provider: Gmail app password, Resend, Mailgun, ...)
 *   no SMTP_HOST    -> "demo" delivery: the message is written to the server log, and (if EMAIL_DEMO_MODE is on)
 *                      the code is returned by the API so the demo deployment can be used without a mail server.
 */
import nodemailer from 'nodemailer';
import { config } from '../config.js';

let transport = null;
const getTransport = () => (transport ??= nodemailer.createTransport(config.smtp));

export function verificationMessage({ to, name, code, link, minutes }) {
  const greeting = name ? `Hello ${name},` : 'Hello,';
  const text = `${greeting}

Your Wayfarer verification code is: ${code}

Enter it in the sign-up window, or open this link to confirm your e-mail address:
${link}

The code expires in ${minutes} minutes. If you did not create a Wayfarer account, ignore this e-mail.`;
  const html = `<div style="font-family:Arial,sans-serif;max-width:480px;margin:auto;color:#202c24">
  <h2 style="font-family:Georgia,serif;font-weight:500">Confirm your e-mail</h2>
  <p>${greeting.replace(/[<>&]/g, '')}</p>
  <p>Your Wayfarer verification code is</p>
  <p style="font-size:30px;letter-spacing:8px;font-weight:700;margin:12px 0">${code}</p>
  <p><a href="${link}" style="display:inline-block;background:#263d32;color:#fff;padding:12px 20px;border-radius:3px;text-decoration:none">Verify my e-mail</a></p>
  <p style="color:#788078;font-size:12px">The code expires in ${minutes} minutes. If you did not create a Wayfarer account, ignore this e-mail.</p>
</div>`;
  return { from: config.mailFrom, to, subject: `Your Wayfarer code: ${code}`, text, html };
}

/** Returns 'email' when the message was handed to SMTP, 'demo' when it was only logged. */
export async function sendVerificationEmail(params) {
  const message = verificationMessage(params);
  if (config.smtp) {
    await getTransport().sendMail(message);
    return 'email';
  }
  if (process.env.NODE_ENV !== 'test') {
    console.log(`[mail:demo] to=${params.to} code=${params.code} link=${params.link}`);
  }
  return 'demo';
}
