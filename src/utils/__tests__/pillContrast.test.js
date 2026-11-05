/* global process */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// Status chips (src/components/settings/pillStyles.js TONE_CLASS.ok) are the accent text colour on
// a 15% tint of itself over the card. WCAG AA for normal text needs 4.5:1 against the worst backdrop.
const css = readFileSync(resolve(process.cwd(), 'src/index.css'), 'utf8');

const block = (selector) => {
  const start = css.indexOf(`\n${selector} {`);
  return css.slice(start, css.indexOf('\n}', start));
};
const token = (selector, name) => {
  const m = new RegExp(`${name}:\\s*(\\d+)\\s+(\\d+)\\s+(\\d+)`).exec(block(selector));
  return m.slice(1).map(Number);
};
const over = (top, alpha, bottom) => top.map((c, i) => c * alpha + bottom[i] * (1 - alpha));
const lin = (c) => {
  const s = c / 255;
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
};
const lum = (c) => 0.2126 * lin(c[0]) + 0.7152 * lin(c[1]) + 0.0722 * lin(c[2]);
const ratio = (a, b) => {
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

describe('"Ollama is running" chip contrast', () => {
  it('is at least 4.5:1 in the light theme on the worst backdrop (founder light mesh)', () => {
    const text = token(':root.light', '--acc-green');
    // Page #f3f4f6 under the strongest light mesh blob (founder, 196/181/253 at 0.62), then the
    // 0.8 white glass card, then the 15% chip tint.
    const page = over([196, 181, 253], 0.62, [243, 244, 246]);
    const card = over([255, 255, 255], 0.8, page);
    expect(ratio(text, over(text, 0.15, card))).toBeGreaterThanOrEqual(4.5);
  });

  it('is at least 4.5:1 in the dark theme on the brightest backdrop (founder dark mesh)', () => {
    const text = token(':root', '--acc-green');
    const page = over([124, 58, 237], 0.46, [20, 17, 14]);
    const card = over([52, 45, 38], 0.66, page);
    expect(ratio(text, over(text, 0.15, card))).toBeGreaterThanOrEqual(4.5);
  });

  it('the Javi bar toast rule never outranks the open-window rules (specificity)', () => {
    // :root:has(.a:not(.b)) would be (0,3,0) and beat the media rules' :root:has(.glass-javi) (0,2,0) whatever the order.
    expect(css).toContain(':root:has(.glass-javi-bar:not(:where(.hidden)), .glass-javi)');
    expect(css).not.toMatch(/:root:has\(\.glass-javi-bar:not\(\.hidden\)/);
    expect(css).toContain('--javi-toast-offset: calc(85dvh + 0.5rem)');
  });
});

