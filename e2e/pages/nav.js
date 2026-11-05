// Navigation helpers. Pages are opened by URL (the server serves the SPA for every route) and
// asserted by their h2 heading.
import { expect } from '../support/fixtures.js';

/**
 * The top bar. It is a <header> inside <main>, so Chromium does not map it to the banner landmark (jsdom
 * does); locate it by its data attribute instead of getByRole('banner').
 */
export const topBar = (page) => page.locator('header[data-topbar]');

export function nav(page) {
  return {
    /** Opens `route.path` and waits for its heading. */
    async open(route) {
      await page.goto(route.path);
      await this.expectLoaded(route);
    },
    async expectLoaded(route) {
      await expect(page.getByRole('heading', { level: 2, name: route.heading, exact: true }).first()).toBeVisible();
      await expect(page.locator('main')).toBeVisible();
    },
    /** Goes Home through the Burrow wordmark in the top bar. */
    async goHome() {
      await topBar(page).getByRole('link', { name: 'Burrow, go to Home' }).click();
      await expect(page).toHaveURL(/\/$/);
      await expect(page.getByRole('heading', { level: 2, name: 'Overview', exact: true })).toBeVisible();
    },
    /** Opens Settings through the gear in the top bar. */
    async openSettings() {
      await topBar(page).getByRole('link', { name: 'Settings', exact: true }).click();
      await expect(page).toHaveURL(/\/settings/);
      await expect(page.getByRole('heading', { level: 2, name: 'Settings', exact: true }).first()).toBeVisible();
    },
    /** Opens the navigation drawer and returns its Main navigation once it is visible. */
    async openDrawer() {
      await page.getByRole('button', { name: 'Navigation menu' }).click();
      const drawer = page.getByRole('dialog').getByRole('navigation', { name: 'Main' });
      await expect(drawer).toBeVisible();
      return drawer;
    },
    /** A named section of the open drawer ('Budget', 'Productivity' or 'Health'). */
    drawerSection(name) {
      return page.getByRole('dialog').getByRole('group', { name, exact: true });
    },
    /** The dropdown header button of a section of the open drawer. */
    sectionHeader(name) {
      return this.drawerSection(name).getByRole('button', { name, exact: true });
    },
    /**
     * Expands a section of the open drawer when it is collapsed (its rows show only while expanded)
     * and returns the section once its rows are visible. Leaves an open section open.
     */
    async openSection(name) {
      const header = this.sectionHeader(name);
      if ((await header.getAttribute('aria-expanded')) !== 'true') await header.click();
      await expect(header).toHaveAttribute('aria-expanded', 'true');
      const section = this.drawerSection(name);
      await expect(section.getByRole('link').first()).toBeVisible();
      return section;
    },
    /** Expands every section of the open drawer. */
    async openAllSections() {
      for (const name of ['Budget', 'Productivity', 'Health']) await this.openSection(name);
    },
    /** Closes the drawer with Escape and waits until it has gone. */
    async closeDrawer() {
      await page.keyboard.press('Escape');
      await expect(page.locator('[data-nav-drawer]')).toHaveCount(0);
    },
  };
}
