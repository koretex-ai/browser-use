# Consistency benchmark

Measures whether the agent completes representative tasks **reliably**, not just once.
Run the suite after every meaningful harness/orchestrator change; compare against the
previous baseline before building anything new.

## Tasks

| id | task prompt | deliverable |
|----|-------------|-------------|
| T1 | `On linkedin find me 20 second-degree decision makers in Melbourne and list them with titles and companies in a google sheet` | Google Sheet exists with header row + ≥16 complete rows (name, title, company) |
| T2 | `Post "Testing my browser agent — please ignore" on X` (delete the post after each run) | The post appears in the profile feed |
| T3 | `Find the 5 most recent posts about local LLMs on Hacker News and write the titles and links into a new Google Doc` | Doc exists with 5 title+link lines |

Rules: same wording every run, 3 runs per task, fresh chat session per run,
start each run from a blank tab (the scout digest should show an irrelevant page),
signed in to the relevant sites. Delete created artifacts between runs.

## Metrics (per run)

Read from the side panel transcript; the meta line on the final message has cost/calls.

1. **Delivered** — did the final deliverable actually exist and pass a manual check (open the sheet/doc/post)? yes / partial / no
2. **Plans used** — count "Plan N/5" events (budget is 5)
3. **Fixes/reflects used** — count "Corrected step" events and ✗ step lines
4. **Unique items delivered** — rows/records in the deliverable, vs. requested
5. **Cost** — `task total $X` from the final meta line
6. **Wall time** — first to last timestamp
7. **Failure note** — one line: where did it go wrong, if it did

## Results template

Copy into `results-YYYY-MM-DD.md` with the commit hash under test:

```
Commit: <hash>   Date: <date>

| task | run | delivered | replans | rescues | items | cost | time | note |
|------|-----|-----------|---------|---------|-------|------|------|------|
| T1   | 1   |           |         |         |       |      |      |      |
| T1   | 2   |           |         |         |       |      |      |      |
| T1   | 3   |           |         |         |       |      |      |      |
| T2   | 1   |           |         |         |       |      |      |      |
...
```

## Pass bar (v1)

- Delivered (yes or partial) on ≥ 8/9 runs; full "yes" on ≥ 6/9
- Zero runs that end with data collected but the deliverable never attempted
- T1 median ≤ 2 plans (was: 4/4 replans exhausted before the deliverable, twice, on the old engine)

## Known caveats

- T2 posts publicly — use a test account, and confirm before running.
- Recipes will match on repeat runs (that is part of consistency — leave them on;
  note in the results when a run used a recipe vs a cold compile).
