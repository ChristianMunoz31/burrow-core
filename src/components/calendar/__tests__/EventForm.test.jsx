import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import EventForm from '../EventForm';

afterEach(cleanup);

const DAY_MS = 86400000;

function localISO(y, m, d, h = 0, min = 0) {
  return new Date(y, m - 1, d, h, min).toISOString();
}

function setup(mode, initialValues) {
  const onSubmit = vi.fn().mockResolvedValue(undefined);
  render(<EventForm mode={mode} initialValues={initialValues} onSubmit={onSubmit} onCancel={() => {}} />);
  return onSubmit;
}

const overnight = {
  summary: 'Night shift',
  start: localISO(2026, 3, 10, 22, 0),
  end: localISO(2026, 3, 11, 1, 0),
  allDay: false,
};

describe('EventForm edit/validation', () => {
  it('title-only edit of an overnight event saves without time fields', async () => {
    const onSubmit = setup('edit', overnight);
    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Renamed' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    const payload = onSubmit.mock.calls[0][0];
    expect(payload.summary).toBe('Renamed');
    expect(payload).not.toHaveProperty('start');
    expect(payload).not.toHaveProperty('end');
    expect(payload).not.toHaveProperty('allDay');
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('date-only change of a multi-day timed event keeps its duration', async () => {
    const initial = { ...overnight, end: localISO(2026, 3, 12, 1, 0) };
    const onSubmit = setup('edit', initial);
    fireEvent.change(screen.getByLabelText('Date'), { target: { value: '2026-03-15' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    const p = onSubmit.mock.calls[0][0];
    expect(p.start).toBe(localISO(2026, 3, 15, 22, 0));
    expect(p.end).toBe(localISO(2026, 3, 17, 1, 0));
    expect(new Date(p.end) - new Date(p.start)).toBe(new Date(initial.end) - new Date(initial.start));
    expect(p.allDay).toBe(false);
  });

  it('date-only change of a multi-day all-day event shifts its end', async () => {
    const initial = {
      summary: 'Trip',
      start: localISO(2026, 3, 10),
      end: localISO(2026, 3, 13),
      allDay: true,
    };
    const onSubmit = setup('edit', initial);
    fireEvent.change(screen.getByLabelText('Date'), { target: { value: '2026-03-20' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    const p = onSubmit.mock.calls[0][0];
    expect(p.allDay).toBe(true);
    expect(p.start).toBe(localISO(2026, 3, 20));
    expect(p.end).toBe(localISO(2026, 3, 23));
    expect(Math.round((new Date(p.end) - new Date(p.start)) / DAY_MS)).toBe(3);
  });

  it('add mode rejects end before start', async () => {
    const onSubmit = setup('add', { date: '2026-03-10' });
    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'X' } });
    fireEvent.click(screen.getByLabelText('All day'));
    fireEvent.change(screen.getByLabelText('Start time'), { target: { value: '10:00' } });
    fireEvent.change(screen.getByLabelText('End time'), { target: { value: '09:00' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add event' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('End time must be after start time.');
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('edit with changed times rejects end before start for a same-day event', async () => {
    const onSubmit = setup('edit', {
      summary: 'Meet',
      start: localISO(2026, 3, 10, 9, 0),
      end: localISO(2026, 3, 10, 10, 0),
      allDay: false,
    });
    fireEvent.change(screen.getByLabelText('End time'), { target: { value: '08:00' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('End time must be after start time.');
    expect(onSubmit).not.toHaveBeenCalled();
  });
});
