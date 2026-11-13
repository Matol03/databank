/**
 * Checks the e-mail configuration and sends a test verification e-mail.
 *   npm run email:test -- you@example.com
 * Uses the same provider selection as the server (SMTP_HOST, else RESEND_API_KEY, else demo).
 */
import { config } from '../src/config.js';
import { emailProvider, verifyProvider, sendVerificationEmail, senderAddress, describeMailError } from '../src/services/mailer.js';

const to = process.argv[2];
const provider = emailProvider();
console.log(`provider: ${provider}`);
console.log(`sender:   ${senderAddress()}`);
console.log(`link URL: ${config.appUrl}/?verify=...`);
if (provider === 'demo') {
  console.log('\nNo provider configured: set SMTP_HOST/SMTP_USER/SMTP_PASS (or RESEND_API_KEY) in .env first.');
  process.exit(1);
}
try {
  await verifyProvider();
  if (provider === 'smtp') console.log(`SMTP login to ${config.smtp.host}:${config.smtp.port} OK`);
  if (!to) {
    console.log('\nAdd a recipient to send a test message: npm run email:test -- you@example.com');
    process.exit(0);
  }
  await sendVerificationEmail({ to, name: 'Wayfarer test', code: '123456', link: `${config.appUrl}/?verify=test`, minutes: 15 });
  console.log(`\nTest e-mail sent to ${to}. Check the inbox (and the spam folder).`);
} catch (err) {
  console.error(`\nFAILED: ${describeMailError(err)}`);
  console.error(`(${err.message})`);
  process.exit(1);
}
