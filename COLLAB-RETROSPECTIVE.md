# Collab Retrospective — Agent-Forge Codebase Fix Sprint

**Date**: 2026-03-20
**Teams**: Team 1 (auto-disbanded early), Team 2 (current session)
**Agents**: codex-1 (lead), claude-2 (worker) — both sessions

## Background

Two collab teams were tasked with fixing 11 prioritized issues in the Agent-Forge codebase:
- **Priority 1** (Correctness): teams.json locking, worktree merge race, zombie team marking, JSON 400 handling
- **Priority 2** (Effectiveness): completion pattern false positives, staged-workflow cursor
- **Priority 3** (Maintainability): shared Python parser, rate limiter cleanup, ensemble-bridge error handling, monitor buffer cap, failed status type

## Team 1 Results (6/11 issues)

Team 1 successfully resolved 6 issues before being prematurely disbanded:
1. Added `failed` status to `EnsembleTeam` and `EnsembleTeamAgent` types
2. Implemented incremental message fetching in Monitor using `since` timestamp cursor
3. Created shared `scripts/parse-messages.py` and refactored 3 collab scripts (95 lines removed)
4. Added periodic rate limiter cleanup (60s interval) to prevent unbounded Map growth
5. Hardened `ensemble-bridge.sh` error handling (HTTP client vs server errors, exponential backoff)
6. Added message buffer cap (1000 messages) to Monitor with automatic trimming

### What went wrong
Team 1 was **auto-disbanded after ~4 minutes** due to the completion pattern false positive bug (Issue #4) — the very bug they were tasked to fix. This is a perfect example of the problem: agents using words like "done" or "klaar" in normal status updates triggered `shouldAutoDisband()`, which interpreted these as completion signals.

## Team 2 Results (5/5 remaining issues)

### Completed by claude-2
- **Issue 3 — Server JSON handling** (`26ffd7c`): Wrapped `JSON.parse` in try/catch on both POST routes. Malformed requests now return 400 Bad Request instead of 500 Internal Server Error.
- **Issue 5 — Staged-workflow cursor** (`5c8884f`): Added internal `messageCursor` + `messageCache` to `StagedWorkflowManager`. Polls now only fetch messages newer than the cursor (consistent with monitor.ts pattern). Cache resets between PLAN/EXEC/VERIFY phases.

### Completed by codex-1
- **Issue 1 — File locking teams.json**: Added proper locking to `loadTeams`/`saveTeams` read-modify-write cycle to prevent data corruption from concurrent access.
- **Issue 2 — Worktree merge race**: Fixed `disbandTeam()` to stop agents and wait for flush before merging worktrees, preventing data loss from in-progress writes.
- **Issue 4 — Completion pattern false positives**: Tightened auto-disband criteria to require multiple completion signals from different agents within a time window, reducing false positive triggers.

## What Went Well

1. **Clear task split**: Lead/worker role division worked smoothly. codex-1 scanned all files, proposed a split, and both agents could work in parallel with minimal coordination overhead.
2. **Incremental communication**: Regular team-say updates prevented duplicated work and kept alignment.
3. **Backward-compatible changes**: Both agents kept public API surfaces stable, making changes purely internal optimizations.
4. **Test-driven validation**: All changes verified against existing test suites before committing.
5. **Awareness of meta-bugs**: Team 2 was explicitly warned about the completion pattern bug and avoided trigger words in messages.

## What Could Be Improved

1. **Completion detection is fundamentally fragile**: Pattern-matching on message content for "done"/"klaar" is too simplistic. Agents naturally use these words in status updates. A better approach would be:
   - Explicit completion signals (e.g., a dedicated API endpoint or message type `completion_signal`)
   - Never auto-disband based on content patterns alone
   - Require manual confirmation or a minimum session duration before auto-disband triggers

2. **No atomic file operations**: The teams.json locking issue existed because the original code used bare `readFileSync`/`writeFileSync` without any concurrency protection. All shared state files should use atomic write patterns (write to temp + rename).

3. **Collab session duration too short**: The 60s idle threshold + completion patterns caused Team 1 to be killed after just 4 minutes. For code review and implementation tasks, the minimum should be much higher (15-30 minutes).

4. **No checkpoint/resume mechanism**: When Team 1 was disbanded, all in-progress work had to be manually assessed and continued by Team 2. A checkpoint mechanism that saves progress state would allow teams to resume from where they left off.

5. **Message file I/O is a bottleneck**: Both the staged-workflow cursor fix and the monitor cursor fix address the symptom (re-reading entire message files on each poll). The root cause is that JSONL files don't support efficient seeking. Consider SQLite or an append-only log with an index for O(1) tail reads.

## Concrete Suggestions for the Collab System

### Short-term (high impact, low effort)
- [ ] Increase `IDLE_DISBAND_THRESHOLD_MS` from 60s to at least 300s
- [ ] Add a `minSessionDurationMs` config that prevents auto-disband before a minimum time
- [ ] Use explicit `type: 'completion_signal'` messages instead of pattern matching on content

### Medium-term
- [ ] Add file locking to all shared state writes (teams.json, message files)
- [ ] Implement session checkpointing so disbanded teams can be resumed
- [ ] Add a `/api/ensemble/teams/:id/signal-complete` endpoint for explicit completion

### Long-term
- [ ] Replace JSONL message store with SQLite for efficient cursor-based queries
- [ ] Implement proper distributed locking if multi-host orchestration grows
- [ ] Add observability: track auto-disband reasons, false positive rates, session durations

## Bugs & Friction Encountered

1. **Meta-bug**: Team 1 disbanded by its own target bug (completion pattern false positive)
2. **No way to test auto-disband locally**: The idle check runs on a timer, making it hard to unit test the full flow without mocking timers
3. **TypeScript config issues**: Project uses ESM-style imports (`import fs from 'fs'`) but tsconfig doesn't have `esModuleInterop`, causing TS errors in IDE but working at runtime via tsx
4. **Worktree merge ordering**: The race condition (merging before agent stop) was not caught by existing tests because the mock for `mergeWorktree` runs synchronously — a timing-dependent bug that only manifests in real async scenarios
