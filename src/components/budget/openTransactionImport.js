// Open the Import transactions dialog from anywhere. The Budget page owns the dialog and
// listens for this event while it is mounted. When it is not mounted yet (command palette),
// navigate to IMPORT_TRANSACTIONS_PATH: the page opens the dialog from the `import=1` query
// param and removes it. Mirrors openJavi().
export const TRANSACTION_IMPORT_EVENT = 'budget:import-transactions';
export const IMPORT_QUERY_PARAM = 'import';
export const IMPORT_TRANSACTIONS_PATH = `/budget?${IMPORT_QUERY_PARAM}=1`;

export function openTransactionImport() {
  window.dispatchEvent(new CustomEvent(TRANSACTION_IMPORT_EVENT));
}
