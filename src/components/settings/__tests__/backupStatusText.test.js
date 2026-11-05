import { describe, expect, it } from 'vitest';
import { noticeSentence, statusSentence } from '../backupStatusText';

const now = new Date(2026, 9, 5, 15, 30);
const hoursBack = (h) => new Date(now.getTime() - h * 60 * 60 * 1000).toISOString();

describe('statusSentence', () => {
  it('is empty without a status', () => {
    expect(statusSentence(null, now)).toBe('');
    expect(statusSentence(undefined, now)).toBe('');
  });

  it('describes a healthy backup with a friendly date', () => {
    const lastSuccessAt = new Date(2026, 9, 5, 9, 0).toISOString();
    expect(statusSentence({ health: 'ok', lastSuccessAt }, now)).toBe('Last backup: today 9:00, verified.');
  });

  it('does not print an empty date when lastSuccessAt is missing', () => {
    for (const lastSuccessAt of [undefined, null, '', 'bad']) {
      const text = statusSentence({ health: 'ok', lastSuccessAt }, now);
      expect(text).toBe('Your last backup was verified.');
      expect(text).not.toMatch(/: ,/);
    }
  });

  it('counts days for a stale backup and never invents a huge number', () => {
    expect(statusSentence({ health: 'stale', lastSuccessAt: hoursBack(24 * 4 + 5) }, now)).toBe(
      'Last backup was 4 days ago.',
    );
    expect(statusSentence({ health: 'stale', lastSuccessAt: hoursBack(24 + 1) }, now)).toBe('Last backup was 1 day ago.');
    for (const lastSuccessAt of [undefined, null]) {
      const text = statusSentence({ health: 'stale', lastSuccessAt }, now);
      expect(text).toBe("It's been a while since your last backup.");
      expect(text).not.toMatch(/\d{3,}/);
    }
  });

  it('says Burrow will try again only when automatic backups are on', () => {
    expect(statusSentence({ health: 'failing', autoEnabled: true }, now)).toBe(
      'The last backup did not finish. Burrow will try again.',
    );
    expect(statusSentence({ health: 'failing', autoEnabled: false }, now)).toBe(
      'The last backup did not finish. Try backing up again.',
    );
  });

  it('notes that automatic backups are off for a stale backup', () => {
    const stale = { health: 'stale', lastSuccessAt: hoursBack(24 * 3), autoEnabled: false };
    expect(statusSentence({ ...stale, autoSwitch: false }, now)).toBe(
      'Last backup was 3 days ago. Automatic backups are off.',
    );
  });

  it('never says paused or off when the switch is on but the scheduler is globally off', () => {
    const stale = { health: 'stale', lastSuccessAt: hoursBack(24 * 3), autoSwitch: true, autoEnabled: false };
    expect(statusSentence(stale, now)).toBe('Last backup was 3 days ago.');
  });

  it('noticeSentence says nothing while a restore is running', () => {
    expect(noticeSentence({ health: 'failing', restoring: true, autoSwitch: null, autoEnabled: true }, now)).toBe('');
    expect(noticeSentence({ health: 'stale', restoring: true, diskWarning: true }, now)).toBe('');
  });

  it('adds disk advice once, whether it comes from the error, the warning or both', () => {
    expect(statusSentence({ health: 'failing', lastError: 'disk_full' }, now)).toBe(
      'The last backup did not finish. Burrow will try again. Free up some disk space.',
    );
    expect(statusSentence({ health: 'failing', lastError: 'disk_low', diskWarning: true }, now)).toBe(
      'The last backup did not finish. Burrow will try again. Disk space is low. Free up some disk space.',
    );
    expect(statusSentence({ health: 'none', diskWarning: true }, now)).toBe(
      'No backups yet. Disk space is low. Free up some disk space.',
    );
  });

  it('asks for a restart when recovery is required, whatever the health says', () => {
    const copy = 'Burrow could not finish undoing the restore. Your data is safe. Restart Burrow to finish recovering it.';
    expect(statusSentence({ health: 'failing', recoveryRequired: true }, now)).toBe(copy);
    expect(statusSentence({ health: 'ok', recoveryRequired: true, diskWarning: true }, now)).toBe(copy);
    expect(noticeSentence({ health: 'failing', recoveryRequired: true }, now)).toBe(copy);
  });

  it('says no backups yet', () => {
    expect(statusSentence({ health: 'none' }, now)).toBe('No backups yet.');
  });
});

describe('noticeSentence', () => {
  it('stays quiet for a healthy status', () => {
    expect(noticeSentence({ health: 'ok', lastSuccessAt: hoursBack(1) }, now)).toBe('');
    expect(noticeSentence(null, now)).toBe('');
  });

  it('speaks up about low disk space even when health is ok', () => {
    expect(noticeSentence({ health: 'ok', lastSuccessAt: hoursBack(1), diskWarning: true }, now)).toBe(
      'Disk space is low. Free up some disk space.',
    );
  });

  it('is gentle about a first backup and does not overpromise', () => {
    expect(noticeSentence({ health: 'none', autoEnabled: true }, now)).toBe(
      "Burrow hasn't made a backup yet. It will make one soon.",
    );
    expect(noticeSentence({ health: 'none', autoEnabled: false }, now)).toBe(
      "Burrow hasn't made a backup yet. You can make one in Settings.",
    );
  });

  it('reuses the status sentence for stale and failing backups', () => {
    const failing = { health: 'failing', autoEnabled: false };
    expect(noticeSentence(failing, now)).toBe(statusSentence(failing, now));
  });
});
