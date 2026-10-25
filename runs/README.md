# runs/

Experiment outputs (one folder per experiment, one subfolder per run). Everything here except this file and
`freeze.json` is gitignored and is produced locally by `npm run exp`, `npm run live:smoke`, `npm run report`,
`npm run humaneval:packets` and `npm run pack`.

**Status: no live experiment has been run yet.** The live smoke gate, pilot, freeze and the 36-run main
experiment are still to come (see `docs/NEXT_STEPS.md`).

Outputs of `npm run exp` without `--live` use the offline mock personas. They are
**PIPELINE VALIDATION ONLY — NOT EXPERIMENTAL FINDINGS**; the report generator labels them
"PIPELINE VALIDATION (mock LLM) — not findings" and refuses to mix them with live runs.

`freeze.json` (written by `npm run exp -- --freeze`) records hashes of every file a run executes plus the effective
settings; a live `main` run refuses to start without a matching freeze. It is tracked once it exists.
