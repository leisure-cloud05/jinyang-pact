# runs/

Experiment outputs (one folder per experiment, one subfolder per run). Everything here except this file and the
tracked `freeze.json` is gitignored and is produced locally by `npm run exp`, `npm run live:smoke`, `npm run report`,
`npm run humaneval:packets` and `npm run pack`.

Live smoke, pilot and main experiment outputs are stored in their own local directories. These results are not
included in a fresh Git checkout. See the [Live Runbook](../docs/LIVE_RUNBOOK.md) for commands and freeze
requirements.

Outputs of `npm run exp` without `--live` use the offline mock personas. They are
**PIPELINE VALIDATION ONLY — NOT EXPERIMENTAL FINDINGS**; the report generator labels them
"PIPELINE VALIDATION (mock LLM) — not findings" and refuses to mix them with live runs.

`freeze.json` records hashes of every file a run executes plus the effective settings. Use `--runs-root` to create
a separate freeze and result directory for each study. A live `main` run refuses to start without a matching freeze
in its selected runs root.
