# Live runbook (run by a team member; the API key never leaves `.env`)

All commands run in PowerShell from the project folder. First refresh PATH in each new window:

```powershell
$env:PATH = [Environment]::GetEnvironmentVariable('PATH','Machine') + ';' + [Environment]::GetEnvironmentVariable('PATH','User')
```

## 0. One-time setup

```powershell
copy .env.example .env
notepad .env
```

In `.env` set exactly two lines: `LLM_PROVIDER=openrouter` and `OPENROUTER_API_KEY=<your key>`. Leave everything else
as is. Never paste the key into chat, a commit or a log; every program output redacts it.

## 1. Gate: smoke test (12 calls, a fraction of a cent)

```powershell
npm run live:smoke -- --live
```

Output: `runs/smoke-<timestamp>/` (`report.md`, `calls.jsonl`, `attempts.jsonl`; all redacted). Pass = every role
parses against its schema, costs are reported, prices are within the bounds. Tell the Commander it finished; the
Commander reads the folder (never `.env`).

## 2. Pilot (dev/pilot configs D1–D3, P1–P3 only)

```powershell
npm run exp -- --plan pilot --live
```

Output: `runs/pilot-live-<timestamp>/`. The Commander inspects it and tunes prompts on these configs only; this
step may be repeated. The held-out cases C1–C6 are refused by the pilot plan.

## 3. Freeze

After the Commander commits the final prompts:

```powershell
npm run exp -- --freeze
```

Writes `runs/freeze.json` (hashes of every executed file + effective settings). From now on nothing that a run
executes may change; a live `main` run refuses to start on any mismatch.

## 4. Main experiment (36 runs: C1–C6 × baseline/no_judge/full × 2 reps)

```powershell
npm run exp -- --plan main --live
npm run reconcile -- runs/<main dir> --live
npm run report -- runs/<main dir>
npm run humaneval:packets -- runs/<main dir>
```

Hard cap per run: 100 calls and US$0.50 (`BUDGET_*` in `.env.example`). The report, figures and 18 blind
human-evaluation packets are written under the run folder; the packet key is kept separately for unblinding.

## 5. Human evaluation

At least two raters fill the CSV sheets of the 18 packets independently, without seeing the key. Then:

```powershell
npm run humaneval:agreement -- <ratings dir> --key <packet key file>
```

## Play the interactive version

```powershell
npm run play:web:build
npm run play:server              # mock LLM, http://127.0.0.1:8787
npm run play:server -- --live    # real model (uses .env)
```
