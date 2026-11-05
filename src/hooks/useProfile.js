import { useCallback } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { profileService } from '../services/profileService';
import { lsKey } from '../utils/storageKeys';

const KEY = ['profile'];
const CACHE_KEY = lsKey('profile');
const MAX_NAME = 60;
const EMPTY = { displayName: null, onboardedAt: null };

function cleanName(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim().slice(0, MAX_NAME);
  return trimmed || null;
}

function normalize(value) {
  if (!value || typeof value !== 'object') return EMPTY;
  return {
    displayName: cleanName(value.displayName),
    onboardedAt: typeof value.onboardedAt === 'string' && value.onboardedAt ? value.onboardedAt : null,
  };
}

// The local copy lets the app paint with the right name (and skip onboarding) before the
// server answers, and keeps working when profile storage is unavailable (503).
// `pendingSync` marks a profile saved locally that the server has not stored yet.
function readCache() {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (raw === null) return undefined;
    const parsed = JSON.parse(raw);
    return { ...normalize(parsed), pendingSync: parsed?.pendingSync === true };
  } catch {
    return undefined;
  }
}

function writeCache(profile, pendingSync = false) {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(pendingSync ? { ...profile, pendingSync } : profile));
  } catch {
    /* storage unavailable: the in-memory profile still applies for this session */
  }
}

function strip({ displayName, onboardedAt }) {
  return { displayName, onboardedAt };
}

// Onboarded if either the server or the local copy says so.
function merge(server, cached) {
  return {
    displayName: server.displayName ?? cached.displayName,
    onboardedAt: server.onboardedAt ?? cached.onboardedAt,
  };
}

/**
 * The local profile: display name and whether first-run onboarding is done.
 * `save({ displayName?, onboarded? })` applies locally at once and never throws; it
 * resolves `{ saved: false }` when the server could not store it (kept on this device).
 */
export function useProfile() {
  const queryClient = useQueryClient();

  const query = useQuery({
    queryKey: KEY,
    queryFn: async () => {
      const raw = readCache();
      const cached = raw ?? EMPTY;
      let server;
      try {
        server = normalize(await profileService.get());
      } catch (err) {
        // Storage unavailable (503) with nothing cached: local-only mode, onboarding applies.
        if (!raw && err?.status === 503) return EMPTY;
        // Any other failure without a cache is unknown, not "not onboarded": surface it.
        if (!raw) throw err;
        return strip(cached);
      }
      if (cached.pendingSync) {
        // Saved locally while the server was unavailable: local values win, then sync up.
        const local = {
          displayName: cached.displayName ?? server.displayName,
          onboardedAt: cached.onboardedAt ?? server.onboardedAt,
        };
        const patch = {};
        if (cached.displayName) patch.displayName = cached.displayName;
        if (cached.onboardedAt) patch.onboarded = true;
        try {
          const saved = normalize(await profileService.update(patch));
          const next = {
            displayName: saved.displayName ?? local.displayName,
            onboardedAt: saved.onboardedAt ?? local.onboardedAt,
          };
          writeCache(next);
          return next;
        } catch {
          writeCache(local, true);
          return local;
        }
      }
      const merged = merge(server, cached);
      writeCache(merged);
      return merged;
    },
    initialData: () => {
      const raw = readCache();
      return raw ? strip(raw) : undefined;
    },
    initialDataUpdatedAt: 0,
    retry: false,
  });

  const profile = query.data ?? EMPTY;

  const save = useCallback(
    async (patch) => {
      await queryClient.cancelQueries({ queryKey: KEY });
      const current = queryClient.getQueryData(KEY) ?? strip(readCache() ?? EMPTY);
      const optimistic = {
        displayName: 'displayName' in patch ? cleanName(patch.displayName) : current.displayName,
        onboardedAt:
          patch.onboarded === true
            ? (current.onboardedAt ?? new Date().toISOString())
            : current.onboardedAt,
      };
      writeCache(optimistic);
      queryClient.setQueryData(KEY, optimistic);
      try {
        const saved = normalize(await profileService.update(patch));
        const next = {
          displayName: saved.displayName,
          onboardedAt: saved.onboardedAt ?? optimistic.onboardedAt,
        };
        writeCache(next);
        queryClient.setQueryData(KEY, next);
        return { saved: true };
      } catch {
        writeCache(optimistic, true);
        return { saved: false };
      }
    },
    [queryClient],
  );

  return {
    displayName: profile.displayName,
    onboarded: profile.onboardedAt !== null,
    isLoading: query.isPending,
    // True when the profile could not be read at all (failed load, nothing cached).
    unresolved: query.data === undefined,
    save,
  };
}
