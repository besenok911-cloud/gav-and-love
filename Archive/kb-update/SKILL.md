---
name: kb-update
description: Update the project knowledge base with completed task details, bug fixes, or code issue analysis. Use after finishing a task, fixing a bug, or discovering a problematic code pattern. Invoke with /kb-update and describe what was done, or let Claude auto-invoke when a task/analysis is complete.
allowed-tools: Read, Write, Edit, Glob, Bash
---

# Knowledge Base Update Skill

## STEP 0 — LOCATE PROJECT ROOT AND KB

Run:
```bash
git rev-parse --show-toplevel
```
Store the result as `PROJECT_ROOT`. All paths below use this value.

KB lives at: `{PROJECT_ROOT}/.claude/kb/`

> **ВАЖЛИВО:** Пиши ТІЛЬКИ в `{PROJECT_ROOT}/.claude/kb/`. НЕ в `~/.claude/projects/*/memory/`.

---

## STEP 0.5 — INIT CHECK (first run in this project)

Check if `{PROJECT_ROOT}/.claude/kb/tasks/INDEX.md` exists.

**If it does NOT exist** — це перший запуск KB для цього проекту:

1. Створи структуру папок:
   - `{PROJECT_ROOT}/.claude/kb/tasks/INDEX.md`
   - `{PROJECT_ROOT}/.claude/kb/code-issues/INDEX.md`

2. Знайди memory-папку цього проекту в глобальній пам'яті. Для цього:
   ```bash
   # Перетвори PROJECT_ROOT у ключ пам'яті (замінюємо / на -)
   echo "$PROJECT_ROOT" | sed 's|^/||; s|/|-|g'
   ```
   Перевір чи існує: `~/.claude/projects/-{converted-path}/memory/tasks/INDEX.md`

3. Якщо memory/tasks/ існує — прочитай INDEX.md і скопіюй всі TASK-файли в `{PROJECT_ROOT}/.claude/kb/tasks/`. Це відновлює попередньо зроблену роботу.

4. Аналогічно для `memory/code-issues/` → `{PROJECT_ROOT}/.claude/kb/code-issues/`.

5. INDEX файли:
```markdown
# Task History Index

Index of completed bugfix/feature tasks. Each file contains: problem description, root cause, files changed, and test plan.

| ID | Title | Date | Files |
|---|---|---|---|
```

```markdown
# Code Issues Index

Discovered problematic patterns, architectural risks, and systemic bugs.
Each entry describes a pattern that causes or could cause bugs — even if already fixed.

| ID | Pattern | Severity | Area | Discovered | Status |
|---|---|---|---|---|---|
```

---

## STEP 0.7 — SYNC CROSS-AGENT CONTEXT (Claude ↔ Codex)

Codex пише в цю саму KB (`{PROJECT_ROOT}/.claude/kb/`), його скіли лежать у
`$CODEX_HOME/skills/{kb-update,start-task}/SKILL.md`. Приватні в нього тільки сесії.
Перед записом онови і прочитай міст:

```bash
python3 "$PROJECT_ROOT/.claude/kb/scripts/kb_agent_scan.py"
```

→ читай `{PROJECT_ROOT}/.claude/kb/AGENT-ACTIVITY.md`:

- чи інший агент уже описав цю саму роботу (щоб не створити дубль запису);
- які записи він змінював щойно (секція **Recently written KB entries**);
- секція **Id collisions**.

Якщо запис про цю роботу вже є від Codex — **онови його**, не створюй новий.

Протокол: [`.claude/kb/SHARED_KB_PROTOCOL.md`](.claude/kb/SHARED_KB_PROTOCOL.md).

---

## STEP 1 — CLASSIFY THE INPUT

ARGUMENTS: $ARGUMENTS

Read the ARGUMENTS and conversation context. Determine which databases to update (can be both):

**→ Update `tasks/`** when:
- A bug was fixed, a feature was implemented, a refactor was done
- The work involved code changes to specific files
- There are concrete steps, root causes, or test plans to document

**→ Update `code-issues/`** when:
- Analysis revealed a problematic code pattern (even if not yet fixed)
- A structural/architectural risk was found (e.g. missing cleanup, wrong ordering, race condition)
- The bug has a systemic cause that could recur elsewhere

If ARGUMENTS is empty or vague, scan the current conversation context to extract:
- What was the problem/task?
- What files were changed?
- What was the root cause?
- What patterns were discovered?

---

## STEP 2 — UPDATE TASKS DATABASE (if applicable)

### 2a. Read the current index
Read: `{PROJECT_ROOT}/.claude/kb/tasks/INDEX.md`

### 2b. Determine: NEW task or UPDATE existing?

Scan index for matching title keywords.

**If UPDATE** — read the existing TASK-XXX file and add/amend:
- New fixes applied
- Additional root causes
- Updated test plan
- Notes/pitfalls
- Add "Updated: YYYY-MM-DD" line at the top

**If NEW task** — виділи ID через міст, а не «max + 1» вручну:

```bash
python3 "$PROJECT_ROOT/.claude/kb/scripts/kb_agent_scan.py" next-id task --agent claude
```

Скрипт враховує імена файлів, INDEX і активні claim-и Codex, тож паралельні сесії не
отримають однаковий номер.

### 2c. Write the task file

> **Правило заголовку:** Якщо ARGUMENTS містить номер тікету (формат `MFUP-XXXX`, `JIRA-XXX`, або аналогічний) — він **обов'язково** включається першим у заголовок після `TASK-NNN:`:
> `# TASK-NNN: MFUP-XXXX — [Short Title]`

```markdown
# TASK-NNN: [MFUP-XXXX — ][Short Title — what was fixed/done]

**Date:** YYYY-MM-DD
**Branch:** [current git branch]
**Status:** Completed | In Progress | Partial Fix

---

## Problem
[1-3 sentences: what the user experienced, what was wrong]

---

## Root Causes
### N. [Short name]
**File:** `path/to/file:line`
[Explanation]

---

## Fixes Applied
### Fix N — [Short name]
**File:** `path/to/file:line_range`
[What changed and why]

---

## Files Changed
- `path/to/file1`
- `path/to/file2`

---

## Test Plan
1. [Step 1]
2. [Step 2]

---

## Notes / Pitfalls
[Anything surprising or non-obvious]
```

### 2d. Update INDEX.md
`| [TASK-NNN](TASK-NNN_slug.md) | Title | YYYY-MM-DD | File1, File2 |`

---

## STEP 3 — UPDATE CODE ISSUES DATABASE (if applicable)

### 3a. Read existing issues index
`{PROJECT_ROOT}/.claude/kb/code-issues/INDEX.md`

### 3b. Determine: NEW issue or UPDATE existing?

Новий ID — теж через міст:

```bash
python3 "$PROJECT_ROOT/.claude/kb/scripts/kb_agent_scan.py" next-id issue --agent claude
```

**Severity levels:** `critical` / `high` / `medium` / `low`

### 3c. Write the code issue file: `ISSUE-NNN_short-slug.md`

```markdown
# ISSUE-NNN: [Pattern Name]

**Discovered:** YYYY-MM-DD
**Severity:** critical | high | medium | low
**Area:** [subsystem]
**Status:** Fixed | Partially Fixed | Known / Unfixed | Monitoring

---

## Pattern Description
[What is the problematic pattern?]

## Why It Causes Bugs
[The invariant that is violated.]

## Known Occurrences

| File | Lines | Status |
|---|---|---|
| `path/to/file` | 10-13 | Fixed in TASK-001 |

## Detection Heuristic
```
grep -r "pattern" src/
```

## Fix Template
```
// BEFORE: bad pattern
// AFTER: correct
```

## Related Tasks
- [TASK-NNN](../tasks/TASK-NNN_slug.md)
```

### 3d. Update code-issues INDEX.md

---

## STEP 4 — REFRESH THE BRIDGE AND REPORT

Після запису ще раз онови дайджест, щоб Codex одразу бачив результат:

```bash
python3 "$PROJECT_ROOT/.claude/kb/scripts/kb_agent_scan.py"
```

```
KB updated:
- [tasks/TASK-NNN] Created / Updated: [title]
- [code-issues/ISSUE-NNN] Created / Updated: [pattern name]
- AGENT-ACTIVITY.md refreshed (Claude + Codex)
```
