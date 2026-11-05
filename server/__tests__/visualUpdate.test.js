import { describe, expect, it } from 'vitest';
import { PLAYWRIGHT_IMAGE } from '../../scripts/lib/playwrightImage.js';
import { CONTAINER_SCRIPT, buildDockerArgs, chooseMode } from '../../scripts/visualUpdate.js';

describe('visualUpdate mode choice', () => {
  it('prefers Docker when it works, and falls back to the CI dispatch when it does not', () => {
    expect(chooseMode({ dockerUsable: true })).toBe('docker');
    expect(chooseMode({ dockerUsable: false })).toBe('ci');
  });

  it('honours --ci, and refuses --docker when Docker is not running', () => {
    expect(chooseMode({ ci: true, dockerUsable: true })).toBe('ci');
    expect(() => chooseMode({ docker: true, dockerUsable: false })).toThrow(/not running/);
    expect(() => chooseMode({ docker: true, ci: true, dockerUsable: true })).toThrow(/either/);
  });
});

describe('visualUpdate docker command', () => {
  const args = buildDockerArgs('/repo');

  it('uses the pinned CI image and keeps the host node_modules out of the container', () => {
    expect(args).toContain(PLAYWRIGHT_IMAGE);
    expect(args).toContain('/work/node_modules');
    expect(args).toContain('/repo:/work');
    expect(args.slice(0, 2)).toEqual(['run', '--rm']);
  });

  it('only updates the visual project, after a build', () => {
    expect(args.at(-1)).toBe(CONTAINER_SCRIPT);
    expect(CONTAINER_SCRIPT).toContain('npm run build');
    expect(CONTAINER_SCRIPT).toContain('--project=visual --update-snapshots');
  });
});
