// Store policy 11.16 "Report content". The link opens the default mail app with an empty template:
// nothing from the conversation is added, and nothing is sent by Burrow. The address must equal
// supportContact in config/support.json (a test checks it) and the shell's Help > Report content.
export const REPORT_EMAIL = 'burrowsupport@gmail.com';
export const REPORT_SUBJECT = 'Burrow: report AI content';
export const REPORT_BODY =
  'Describe what Javi said that was inappropriate. Paste the text here only if you want to share it.';

const enc = (value) => encodeURIComponent(value);

/** The mailto link for reporting a Javi reply. Takes no arguments on purpose: no message text. */
export function reportContentHref() {
  return `mailto:${REPORT_EMAIL}?subject=${enc(REPORT_SUBJECT)}&body=${enc(REPORT_BODY)}`;
}
