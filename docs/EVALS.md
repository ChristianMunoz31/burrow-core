# AI evals

`node pro/scripts/evalAi.js` runs a fixed set of Javi prompts against a real local Ollama and checks each answer in code. It is how the hardware tiers in [PRODUCT.md](PRODUCT.md) get validated. Tests (`npm test`) never need Ollama; the eval is the separate real-model check.

**Where the scripts live.** Javi's tool calling, briefing and Insights explain are Pro features, so their evals live in the private Pro module ([OPEN_CORE.md](OPEN_CORE.md)): `pro/scripts/evalAi.js`, `pro/scripts/evalJaviPro.js` and `pro/scripts/javiEvalProPaths.js`, with their result files in `pro/evals/`. There is no `npm run eval:ai` script any more. A checkout without `pro/` has `npm run eval:javi` only, with the Free paths. Eval result files that cover `jarvis_tools`, `briefing`, `insights_explain` or a Pro character (`valet`, `concierge`, `majordomo`) belong in `pro/evals/`; the others stay in `evals/` in core.

**It never runs in CI.** CI has no Ollama, and the eval is slow on CPU-only machines. Run it by hand.

## Running it

Prerequisites: Ollama is running, and the models you want are already pulled. The eval never pulls models.

```powershell
node pro/scripts/evalAi.js
node pro/scripts/evalAi.js --models qwen2.5:3b
node pro/scripts/evalAi.js --only todo_list,dining_spend
# example file name; the run creates it (no such file is committed)
node pro/scripts/evalAi.js --models qwen2.5:3b --out pro/evals/2026-10-04-qwen2.5-3b.json
```

Flags (from `pro/scripts/evalAi.js`):

| Flag | Default | Meaning |
| --- | --- | --- |
| `--models a,b` | `qwen2.5:7b,qwen2.5:3b` | Comma-separated models to test. A model that is not installed or does not support tools is skipped and reported as unavailable. |
| `--only id1,id2` | all prompts | Run only these prompt ids. |
| `--out path.json` | none | Also write the full results to this JSON file (parent folders are created). |

`--flag=value` also works. Prompt ids: `todo_list`, `add_todo`, `dining_spend`, `habits_missed`, `complete_first`, `multi_step`, `calendar_today`, `add_note`, `journal_recent`, `chitchat`.

How it works: it creates a throwaway data directory under the OS temp folder, seeds generic synthetic data through Burrow's own data layer, warms the model up with one untimed prompt, then runs each prompt through the real Javi agent. Checks are programmatic: expected tool calls with valid arguments, seeded values in the answer, and writes must come back as `confirm.required`. Javi tools are a Pro capability, so the eval runs under a temporary local trial started in its own temp data directory (never your real data folder, license or any store). It prints a pass table per model and exits 0 (it is an eval, not a gate); if any prompt fails with `pro_required` it prints a clear message and exits non-zero, because the results would not measure the model. Timeouts are longer than the app defaults unless you set them.

The eval has its own small seed (the checks depend on exact values) and is separate from the demo data used by `npm run sandbox`.

## Javi speed and accuracy (`npm run eval:javi`)

`npm run eval:javi` runs the core Javi paths on one local model: `advice_free`, `advice_free_cached` and `advice_conversation`. The Pro paths `jarvis_tools`, `briefing` and `insights_explain` run through `node pro/scripts/evalJaviPro.js`, which needs `pro/`. Together they measure every Javi path: the Free page insight card (`POST /api/jarvis/advice?fresh=1`, single shot, Budget, Todos and Habits pages; `fresh=1` skips the insight card cache so the model path is what is timed), the same budget card served from that cache (`advice_free_cached`), a Pro advice conversation turn (`javi_conversation`), Pro tool calling (`runJarvis`, including a write that must be parked for confirmation and safety prompts), the briefing (`runBriefing`) and Insights explain (`POST /api/insights/explain`). Like `evalAi.js` it needs a running Ollama with the model already pulled, never pulls, and never runs in CI or `npm test` (it lives in `scripts/`, outside the Vitest includes).

```powershell
npm run eval:javi -- --model llama3.2:1b
npm run eval:javi -- --model qwen2.5:3b --quick
npm run eval:javi -- --model llama3.2:1b --paths advice_free,jarvis_tools --runs 5
```

Run one model per invocation (`--model` takes a single name) and one invocation at a time: the cold run unloads the model with `keep_alive: 0`, so a second Ollama user or a parallel run skews every timing. On a machine with little free RAM, close other heavy apps first, stay with a small model (models above 4B parameters are refused unless `--allow-large`) and start with `--quick`.

| Flag | Default | Meaning |
| --- | --- | --- |
| `--model NAME` | `llama3.2:1b` | Model under test, set through the app's own `ai.settings` (chat and tool model) in the temp database. Models above 4B parameters are refused unless `--allow-large`. |
| `--runs N` | `3` (`1` with `--quick`) | Warm repeats of each path's speed case, after one cold run (the model is unloaded with `keep_alive: 0` first). |
| `--quick` | off | One warm run per path and only the core accuracy cases. |
| `--paths a,b` | all | Any of `advice_free`, `advice_free_cached`, `advice_conversation`, `jarvis_tools`, `briefing`, `insights_explain`. |
| `--judge` | off | Adds an LLM-judge faithfulness rating (1 to 5) from the same local model. A secondary signal only, never part of the score. |
| `--out FILE`, `--no-write` | `evals/YYYY-MM-DD-javi-<model>-<label>.json` | Where the JSON goes, or skip writing it. `--label` sets the suffix (default `baseline`). |
| `--fake` | off | Runs against the bundled fake Ollama: a fast self-check of the harness, not a measurement. |
| `--report FILE` | none | Re-renders the speed summary and tables of a saved result from its runs. Runs no model. |

Data guard: the eval runs only on a fresh folder inside the OS temp directory. With `BURROW_DATA_DIR` unset it creates one (and removes it at the end); a set `BURROW_DATA_DIR` must be empty or missing, and the eval refuses any folder that is, contains or lies inside `%APPDATA%\Burrow`, `%APPDATA%\Burrow Dev` or `%USERPROFILE%\Burrow Data`. It sets `BURROW_SCHEDULER=0` and the data folder before it imports any server module, and seeds its own synthetic fixture (`scripts/lib/javiEval/fixture.js`). Pro paths run under the temporary local trial of that folder, the same seam as `evalAi.js`.

How it measures: Burrow's Ollama host setting points at a passive loopback proxy (`scripts/lib/javiEval/ollamaProxy.js`) that forwards every request unchanged, refuses pulls and any other model, and records the options sent (`num_ctx`, `num_predict`, `temperature`, `keep_alive`, `format`, tools) plus Ollama's final `done` chunk. Per path it reports time to first token (cold and warm median, p90 with 3 or more warm runs), total latency, tokens per second (`eval_count / eval_duration`), prompt tokens and prompt evaluation time (Ollama reports `prompt_eval_count` as the whole prompt even when it reuses its prompt cache, so the time is what shows cache reuse: a cached prompt evaluates in milliseconds), the number of Ollama calls per request and retries, and a prompt profile (the size of each system prompt section, the page snapshot and the tool schemas, calibrated to tokens, and how much of the prompt is identical to the next request).

Accuracy is scored in code against ground truth read back through the data layer: number grounding (every number, amount, percent and date in the answer must appear in what the model was given; `$1,234.50` and `1234.5` match, rounding to the displayed precision is accepted), required facts (for example the top category and the over-budget category), invented entity names, format (bullets, word limits, no headers, emoji, em or en dashes, URLs or field names, sanitizer is a no-op), tool selection and arguments (writes must come back parked, nothing written), and safety prompts (data exfiltration, a social security number, a prompt injection in a todo title and in a note, and math the model must not do). Each path gets one 0 to 100 score with the breakdown. Page snapshots come from the real client builders (`src/utils/javiBuilders`, bundled in memory with esbuild).

Reading the numbers:

- Cold vs warm: for each path (except `advice_free_cached`) the model is unloaded first and the first run is cold, so it includes the model load and an empty prompt cache. The warm runs that follow measure the steady state a user sees after the first answer. Compare cold TTFT with warm TTFT to see load cost, and cold with warm prompt evaluation time to see prompt cache reuse.
- `advice_free_cached` does not unload anything: one priming run (`fresh=1`, which stores the answer) and then `--runs` requests without `fresh`. A cache hit makes no Ollama call, so its row shows near-zero latency and zero Ollama calls (`product.cacheHit` in the saved result). A hit leaves no AI audit row.
- Scoring is deterministic by default. The scorer scores the model's own text (the `content` of the answer). Notices that code appends (the unverified-figure note, the cut-short note) are recorded separately from the text, and whether the grounding note fired is recorded per run as a product signal, so a notice never hides or inflates the model's score. For Insights explain the route appends fixed copy after the model text: the causation caveat and, for a local model whose text suggests no experiment, a fixed experiment line. The harness splits both off and scores the model's own text. Per run it records `caveatAppended` / `caveatInModelText` / `caveatInFinalText` and `experimentAppended` / `experimentInModelText` / `experimentInFinalText`, and the summary counts each, so you can tell what the model wrote from what code added.
- `--judge` adds a faithfulness rating from the same local model after the run. It is optional, adds one extra model call per answer, and is never part of the 0 to 100 score.

## Recording results

Save each notable run as a dated JSON file under `evals/` (Pro eval files under `pro/evals/`), named `YYYY-MM-DD-<model>.json`:

```powershell
# example file name; --out writes it when the run finishes (nothing is committed unless you commit it)
node pro/scripts/evalAi.js --models qwen2.5:3b --out pro/evals/2026-10-04-qwen2.5-3b.json
```

The file contains the generation time, the context size and timeout settings, per-prompt results (pass or fail, reason, time, tool calls, truncated answer), and the markdown table. It does not record the machine, so write that down alongside the result (in the commit message, PR description or a note next to the file):

- Hardware: CPU model and whether a GPU was used (Burrow assumes CPU-only).
- RAM: total and roughly how much was free when the run started.
- Model: exact name and tag as shown by `ollama list`, plus the Ollama version.
- Anything unusual: other heavy apps running, changed `OLLAMA_NUM_CTX`, `OLLAMA_KEEP_ALIVE` or timeouts.

Results contain only synthetic data, so they are safe to commit.
