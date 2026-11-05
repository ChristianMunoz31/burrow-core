// Test-only fixtures for the Folders UI: synthetic folders in the shape of the API contract.

export const LIMITS = {
  maxFolders: 20,
  maxFiles: 5000,
  maxFileBytes: 2097152,
  maxTotalBytes: 209715200,
  maxDepth: 12,
  summaryFiles: 300,
  maxIndexChunks: 10000,
  embedModel: 'nomic-embed-text',
};

export const STATS = {
  filesTotal: 124,
  filesRead: 118,
  bytesTotal: 13002342,
  bytesRead: 12900000,
  linesTotal: 4200,
  wordsTotal: 30500,
  byStatus: { ok: 118, binary: 6 },
  byKind: {
    text: { files: 80, bytes: 1000 },
    data: { files: 0, bytes: 0 },
    code: { files: 30, bytes: 2000 },
    other: { files: 14, bytes: 3000 },
  },
  byExt: [{ ext: '.md', files: 80, bytes: 1000 }],
  oldestModifiedAt: '2026-01-02T10:00:00Z',
  newestModifiedAt: '2026-09-30T10:00:00Z',
  largestFiles: [{ path: 'notes/big.md', bytes: 5000 }],
  duplicateGroups: 2,
  dirsScanned: 10,
  dirsSkipped: 1,
  limitsHit: [],
  index: { status: 'ready', files: 118, chunks: 300, skipped: null },
};

export const jobView = (over = {}) => ({
  id: 'job-1',
  folderId: 'f1',
  kind: 'scan',
  trigger: 'user',
  status: 'running',
  phase: 'inventory',
  queuePosition: null,
  progress: { filesSeen: 0, filesRead: 0, bytesRead: 0, summariesTotal: 0, summariesDone: 0, chunksTotal: 0, chunksDone: 0 },
  startedAt: '2026-10-08T10:00:00Z',
  finishedAt: null,
  error: null,
  notices: [],
  ...over,
});

export const folderView = (over = {}) => ({
  id: 'f1',
  name: 'Project notes',
  path: 'C:\\Users\\tester\\Documents\\Notes',
  autoRescan: false,
  createdAt: '2026-10-01T10:00:00Z',
  lastScanAt: '2026-10-08T10:00:00Z',
  stats: STATS,
  summary: { status: 'ok', text: 'Meeting notes and plans for a small project.', model: 'llama3.2:3b', at: '2026-10-08T10:05:00Z' },
  report: null,
  job: null,
  lastJob: { status: 'done', errorCode: null, message: null, at: '2026-10-08T10:06:00Z' },
  warnings: [],
  ...over,
});

/** An Error shaped like the service's rejection for a coded response. */
export const apiError = (code, message, extra = {}) =>
  Object.assign(new Error(message), { code, userFacing: true, status: 422, ...extra });
