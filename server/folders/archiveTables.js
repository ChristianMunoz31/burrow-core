// What the full export ZIP carries of the Folders module, as plain data (no imports, so the backup worker bundle can load it).
// These definitions are NOT part of DATA_TABLES: adding them there would put folders into the data browser, the cloud
// category map and Javi's data page. They only feed the export archive (server/export/buildArchive.js) and the import rules
// (server/folders/importRules.js).
//
// Never exported: `path_key` and `confirm_state` (an import sets its own), `last_job_*`, the index fields of a file row
// (`index_hash`, `index_model`, `chunk_count`, `seen_at`), and every `folder_chunks` column (chunk text and vectors are
// derived from the user's files; a re-scan rebuilds them).

const cols = (spec) =>
  Object.freeze(
    spec.split(',').map((pair) => {
      const [name, type] = pair.trim().split(':');
      return Object.freeze({ name, type });
    }),
  );

const def = (d) =>
  Object.freeze({
    primaryKey: 'id',
    group: 'Folders',
    amountColumn: null,
    dateColumn: null,
    sortable: Object.freeze([]),
    search: Object.freeze([]),
    ...d,
    defaultSort: Object.freeze(d.defaultSort),
  });

/** @type {ReadonlyArray<import('../dataBrowser/tables.js').DataTableDef>} */
export const FOLDER_EXPORT_DEFS = Object.freeze([
  def({
    id: 'folders',
    label: 'Folders',
    columns: cols(
      'id:uuid,name:text,path:text,auto_rescan:boolean,stats:jsonb,summary:text,summary_status:text,summary_model:text,summary_input_hash:text,summary_at:timestamptz,report:text,report_model:text,report_at:timestamptz,last_scan_at:timestamptz,created_at:timestamptz,updated_at:timestamptz',
    ),
    defaultSort: { column: 'created_at', order: 'asc' },
  }),
  def({
    id: 'folder_files',
    label: 'Folder files',
    columns: cols(
      'id:uuid,folder_id:uuid,rel_path:text,ext:text,kind:text,status:text,size_bytes:integer,mtime:timestamptz,sha256:text,line_count:integer,word_count:integer,char_count:integer,summary:text,summary_status:text,summary_hash:text,summary_model:text,created_at:timestamptz',
    ),
    defaultSort: { column: 'rel_path', order: 'asc' },
  }),
]);
