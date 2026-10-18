# The 90-second CleverSQL demo

Run the deterministic terminal story:

```bash
npm run demo:90s
```

Add `-- --pace` for pauses suitable for screen recording:

```bash
npm run demo:90s -- --pace
```

## Recording script

| Time | Scene | Spoken line |
| --- | --- | --- |
| 0:00 | Console overview | "Agents can query databases. The hard part is letting them change one." |
| 0:08 | SQL lab | "CleverSQL starts with a read-only connection, so exploration is fast and safe." |
| 0:22 | Change builder | "The agent proposes a typed update. CleverSQL runs it and rolls it back." |
| 0:35 | Diff modal | "This is the exact before and after. Nothing is committed yet." |
| 0:45 | Stale conflict | "A human changed the same row first. The agent's stale intent fails closed." |
| 0:57 | Re-preview + apply | "The agent sees the latest state, previews again, and applies the verified diff." |
| 1:08 | Undo | "One click restores the previous values, with a complete audit receipt." |
| 1:20 | Connect page | "The same eight tools are available to Codex, VS Code, Cursor, and any MCP client." |

## Screen setup

1. Run `npm start`.
2. Open the console at 1440×900.
3. Show the overview for two seconds, then open SQL lab.
4. Run the active MRR preset.
5. Open **Preview change**, keep `customers`, select a row, and show the reason.
6. After the diff appears, cut to the terminal stale-conflict run if recording the
   deterministic script, or use a second database connection to create the drift.
7. Apply, open the ledger, and revert.
8. End on the Connect page with the Codex config tab visible.

## Core message

Do not pitch this as text-to-SQL.

Pitch it as the first tool that makes agent writes **reviewable, conflict-aware,
auditable, and reversible**.
