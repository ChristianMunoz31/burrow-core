import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import html from '../../../index.html?raw';

// Executes the real inline pre-paint script from index.html against jsdom.
const SCRIPT = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)]
  .map((m) => m[1])
  .find((s) => s.includes('founderPerk'));

const root = document.documentElement;
const originalMatchMedia = window.matchMedia;

function reset() {
  localStorage.clear();
  root.className = '';
  root.removeAttribute('data-bg-light');
  root.removeAttribute('data-bg-dark');
}

function run({ light = false } = {}) {
  window.matchMedia = () => ({ matches: light });
  new Function(SCRIPT)();
}

const seed = (k, v) => localStorage.setItem(`burrow.${k}`, JSON.stringify(v));

beforeEach(reset);
afterEach(() => {
  reset();
  window.matchMedia = originalMatchMedia;
});

describe('index.html pre-paint script', () => {
  it('is present in index.html', () => {
    expect(SCRIPT).toBeTruthy();
  });

  it('applies founder when saved and the perk cache is "1"', () => {
    seed('appearance:bgDark', 'founder');
    seed('appearance:bgLight', 'founder');
    localStorage.setItem('burrow.license:founderPerk', '1');
    run();
    expect(root.getAttribute('data-bg-dark')).toBe('founder');
    expect(root.getAttribute('data-bg-light')).toBe('founder');
  });

  it('falls back to aurora when founder is saved but there is no cache', () => {
    seed('appearance:bgDark', 'founder');
    seed('appearance:bgLight', 'founder');
    run();
    expect(root.getAttribute('data-bg-dark')).toBe('aurora');
    expect(root.getAttribute('data-bg-light')).toBe('aurora');
  });

  it('treats any cache value other than "1" as absent', () => {
    seed('appearance:bgDark', 'founder');
    localStorage.setItem('burrow.license:founderPerk', 'true');
    run();
    expect(root.getAttribute('data-bg-dark')).toBe('aurora');
  });

  it('leaves other presets unaffected with or without the cache', () => {
    seed('appearance:bgDark', 'ocean');
    seed('appearance:bgLight', 'forest');
    run();
    expect(root.getAttribute('data-bg-dark')).toBe('ocean');
    expect(root.getAttribute('data-bg-light')).toBe('forest');
    localStorage.setItem('burrow.license:founderPerk', '1');
    run();
    expect(root.getAttribute('data-bg-dark')).toBe('ocean');
    expect(root.getAttribute('data-bg-light')).toBe('forest');
  });

  it('sets nothing for an invalid value or when nothing is saved', () => {
    seed('appearance:bgDark', 'nonexistent');
    localStorage.setItem('burrow.license:founderPerk', '1');
    run();
    expect(root.hasAttribute('data-bg-dark')).toBe(false);
    expect(root.hasAttribute('data-bg-light')).toBe(false);
  });

  it('applies the light class from the theme preference or the OS', () => {
    seed('theme', 'light');
    run();
    expect(root.classList.contains('light')).toBe(true);
    reset();
    run({ light: true });
    expect(root.classList.contains('light')).toBe(true);
    reset();
    seed('theme', 'dark');
    run({ light: true });
    expect(root.classList.contains('light')).toBe(false);
  });
});
