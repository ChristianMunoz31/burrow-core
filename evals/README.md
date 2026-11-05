# Eval results

`npm run eval:javi` (speed and accuracy per Javi path, see docs/EVALS.md) writes dated results here, one JSON file per run, named `YYYY-MM-DD-javi-<model>-<label>.json` (for example `2026-11-04-javi-llama3.2-1b-baseline.json`). The core eval covers the Free paths only: `advice_free`, `advice_free_cached` and `advice_conversation`. Files here hold synthetic data only; the folder is not gitignored, so you can commit a run you want to keep.

The real-model eval of the Pro paths and the earlier dated results that include them are not part of the core.
