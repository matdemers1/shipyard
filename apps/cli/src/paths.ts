/** Where the CLI reads/writes under a data root, the same layout the agent uses (SHP-T-1.12). */
export interface DataPaths {
  dataRoot: string;
  journalPath: string;
  ledgerPath: string;
  workDir: string;
  historyDir: string;
}

export function dataPaths(dataRoot: string): DataPaths {
  return {
    dataRoot,
    journalPath: `${dataRoot}/agent/journal.jsonl`,
    ledgerPath: `${dataRoot}/agent/ledger.jsonl`,
    workDir: `${dataRoot}/agent/work`,
    historyDir: `${dataRoot}/agent/history`,
  };
}
