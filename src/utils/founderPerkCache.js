import { lsKey } from './storageKeys';

// Last-known "this install has a verified Founding license" flag, so the pre-paint script in
// index.html and the first render never show the Founder background to someone who is not
// entitled while the license status is still loading. A hint only: the real flag always wins
// once the status is known. index.html reads the same physical key ('burrow.license:founderPerk').
export const FOUNDER_PERK_KEY = 'license:founderPerk';

/** True when the last known license status had the founder perk. Never throws. */
export function readFounderPerkCache() {
  try {
    return localStorage.getItem(lsKey(FOUNDER_PERK_KEY)) === '1';
  } catch {
    return false;
  }
}

/** Record the known flag: '1' when true, removed when false. Never throws. */
export function writeFounderPerkCache(founderBackground) {
  try {
    if (founderBackground) localStorage.setItem(lsKey(FOUNDER_PERK_KEY), '1');
    else localStorage.removeItem(lsKey(FOUNDER_PERK_KEY));
  } catch {
    /* storage unavailable: the cache is only a hint */
  }
}
