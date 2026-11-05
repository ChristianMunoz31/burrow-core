// Every localStorage key Burrow writes starts with this prefix. Settings keys such as
// 'theme' or 'budget:targets' stay the logical (server app_state) names; lsKey() maps
// them to the physical browser key. index.html mirrors this prefix in its pre-paint script.
export const STORAGE_PREFIX = 'burrow.';

export const lsKey = (key) => `${STORAGE_PREFIX}${key}`;
