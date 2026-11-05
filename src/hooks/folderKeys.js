// Query keys for the Folders feature, in one place so the hooks and the invalidations cannot drift.

export const FOLDERS_KEY = ['folders'];
export const folderJobKey = (folderId) => ['folder-job', folderId];
/** Prefix of every cached page of one folder's file list. */
export const folderFilesKey = (folderId) => ['folder-files', folderId];
/** Prefix of every cached preview of one folder's files. */
export const folderPreviewKey = (folderId) => ['folder-preview', folderId];
export const folderFilePreviewKey = (folderId, fileId) => [...folderPreviewKey(folderId), fileId];
export const folderFilesPageKey = (folderId, params) => [...folderFilesKey(folderId), params];
