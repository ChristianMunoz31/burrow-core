// WCAG contrast measured in the browser, for text axe cannot judge.
//
// axe-core's color-contrast rule reports "incomplete" (not a violation) for any text that sits on
// Burrow's mesh-gradient background ("Element's background color could not be determined due to a
// background gradient"), so it can silently miss real failures such as issue #22. This helper
// composites the element's own translucent background and each ancestor's over a known page base
// colour and applies the WCAG 2.x formula.

/**
 * @param {import('@playwright/test').Locator} locator One element.
 * @param {{ base?: [number, number, number] }} [opts] Page base colour under every translucent layer
 *   (white for the light theme, near black for dark).
 * @returns {Promise<{ ratio: number, fg: string, bg: string, fontSize: string }>}
 */
export async function measureContrast(locator, { base = [255, 255, 255] } = {}) {
  return locator.evaluate((el, baseColour) => {
    const parse = (value) => {
      const m = /rgba?\(([^)]+)\)/.exec(value);
      if (!m) return null;
      const [r, g, b, a = 1] = m[1].split(/[ ,/]+/).filter(Boolean).map(Number);
      return { r, g, b, a };
    };
    const over = (top, under) => ({
      r: top.r * top.a + under.r * (1 - top.a),
      g: top.g * top.a + under.g * (1 - top.a),
      b: top.b * top.a + under.b * (1 - top.a),
      a: 1,
    });
    // Layers from the element up to <html>, painted bottom-up over the base colour.
    const layers = [];
    for (let node = el; node; node = node.parentElement) {
      const c = parse(getComputedStyle(node).backgroundColor);
      if (c && c.a > 0) layers.push(c);
    }
    let bg = { r: baseColour[0], g: baseColour[1], b: baseColour[2], a: 1 };
    for (const layer of layers.reverse()) bg = over(layer, bg);

    const fgRaw = parse(getComputedStyle(el).color);
    const fg = over(fgRaw, bg);
    const lum = ({ r, g, b }) => {
      const lin = (v) => {
        const s = v / 255;
        return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
      };
      return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
    };
    const [hi, lo] = [lum(fg), lum(bg)].sort((a, b) => b - a);
    const round = (c) => `rgb(${Math.round(c.r)}, ${Math.round(c.g)}, ${Math.round(c.b)})`;
    return {
      ratio: (hi + 0.05) / (lo + 0.05),
      fg: round(fg),
      bg: round(bg),
      fontSize: getComputedStyle(el).fontSize,
    };
  }, base);
}
