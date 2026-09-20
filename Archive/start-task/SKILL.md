---
name: start-task
description: Start work on a new task or resume an existing one. Always runs in Plan Mode. Pass only the task ID for reopens — original context is restored from KB. Tracks reopen count automatically.
allowed-tools: Read, Write, Edit, Glob, Grep, Bash, EnterPlanMode, ToolSearch
---

# Start Task Skill

ARGUMENTS: $ARGUMENTS

---

## STEP 1 — PARSE ARGUMENTS

Parse `$ARGUMENTS`. Format depends on mode (determined in STEP 3):

```
<task-id>                           # reopen/continuation — нові вводні не потрібні
<task-id> <нові вводні від QA>      # reopen з новим feedback від тестувальника
<task-id> <опис задачі>             # нова задача — повний опис обов'язковий
```

Приклади:
- `MLL-13510` — реопен або продовження без нових вводних
- `MLL-13510 Тестувальник каже що баг відтворюється на iOS 17 при закритті банера` — реопен з feedback
- `MLL-13520 Додати анімацію монет при зборі нагороди` — нова задача

Витягни:
- **TASK_ID** — перше слово (Jira ID або TASK-XXX)
- **EXTRA_INPUT** — решта тексту (може бути порожнім)

---

## STEP 2 — LOCATE PROJECT KB

```bash
PROJECT_ROOT=$(git rev-parse --show-toplevel)
TODAY=$(date +%Y-%m-%d)
KB_TASKS="$PROJECT_ROOT/.claude/kb/tasks"
```

Прочитай `$KB_TASKS/INDEX.md`.

---

## STEP 2.5 — ПРОЧИТАТИ КОНТЕКСТ ІНШОГО АГЕНТА (Claude ↔ Codex)

Claude і Codex працюють у цьому репозиторії паралельно і пишуть в **одну й ту саму** KB
(`$PROJECT_ROOT/.claude/kb/`), але сесії кожного з них приватні. Міст між ними:

```bash
python3 "$PROJECT_ROOT/.claude/kb/scripts/kb_agent_scan.py"
```

Скрипт читає сесії Codex (`$CODEX_HOME/sessions/**/rollout-*.jsonl`, `session_index.jsonl`,
`archived_sessions/`) та сесії Claude (`~/.claude/projects/<repo-slug>/*.jsonl`), фільтрує їх
по `cwd` цього репозиторію і генерує `$PROJECT_ROOT/.claude/kb/AGENT-ACTIVITY.md`.

Далі **обов'язково прочитай** `$PROJECT_ROOT/.claude/kb/AGENT-ACTIVITY.md`:

- секція **In flight right now** — треди іншого рантайму, активні прямо зараз;
- останній запит і остання відповідь кожного треда;
- які `TASK-`/`ISSUE-` вже в роботі в іншого агента;
- секція **Id collisions** — де номери вже задубльовані.

Якщо інший агент уже веде цю саму задачу або ті самі файли — **не починай паралельно**.
Повідом користувача що тред `<назва>` вже в роботі, і запитай: перехопити, чи дочекатись.

Протокол цілком: [`.claude/kb/SHARED_KB_PROTOCOL.md`](.claude/kb/SHARED_KB_PROTOCOL.md).

---

## STEP 3 — CLASSIFY: NEW / CONTINUATION / REOPEN

Шукай в INDEX.md рядок що містить `TASK_ID`.

### A. Не знайдено в KB → **НОВА ЗАДАЧА**

- `EXTRA_INPUT` є повним описом нової задачі
- Якщо `EXTRA_INPUT` порожній — запитай:
  > "Задача `<TASK_ID>` не знайдена в KB. Опиши задачу:"
- Визнач `NEXT_TASK_ID` **тільки через міст** (враховує файли, INDEX і claim-и Codex):
  ```bash
  python3 "$PROJECT_ROOT/.claude/kb/scripts/kb_agent_scan.py" next-id task --agent claude
  ```
  Не бери «max + 1» на око — саме так з'явилися дублікати `TASK-004` і `TASK-016`.
- Перейди до STEP 4-A

### B. Знайдено в KB → прочитай файл задачі

Визнач ім'я файлу з INDEX.md і прочитай його повністю.

Визнач **поточний статус** (`Status:` поле у заголовку):

**`Status: Completed`** → **РЕОПЕН**
- Це повернення до завершеної задачі з новим repro або feedback
- `EXTRA_INPUT` — нові вводні від тестувальника (може бути порожнім якщо користувач просто відновлює)
- Перейди до STEP 4-B (REOPEN)

**`Status: In Progress` або `Status: Partial Fix`** → **ПРОДОВЖЕННЯ**
- Задача вже відкрита, просто продовжуємо роботу
- `EXTRA_INPUT` — додаткові вводні якщо є (необов'язково)
- Перейди до STEP 4-C (CONTINUATION)

---

## STEP 4-A — НОВА ЗАДАЧА: збери контекст

По ключових словах з `EXTRA_INPUT` зроби цільовий пошук (2-4 запити):
- Grep по назвах класів/систем згаданих в описі
- Glob по потенційно пов'язаних файлах

Підготуй для STEP 6:
```
MODE = NEW
TASK_ID = <визначений>
DESCRIPTION = <EXTRA_INPUT>
EXISTING_CONTEXT = (результати пошуку)
```

---

## STEP 4-B — РЕОПЕН: оновити KB і відновити контекст

### 4B-1. Визнач номер реопену

В файлі задачі підрахуй кількість існуючих секцій `## Reopen #`:
```
REOPEN_COUNT = (кількість знайдених секцій + 1)
```

### 4B-2. Оновити файл задачі в KB

Додай секцію в кінець файлу:

```markdown
---

## Reopen #<N> — <TODAY>

**QA Feedback:**
<EXTRA_INPUT або "(нових вводних не надано — повторна перевірка)">

**Статус до реопену:** Completed → Reopened
```

Оновити заголовок файлу:
- `Status: Completed` → `Status: Reopened (#<N>)`
- Додати рядок `Reopened: <TODAY>` після `Date:`

### 4B-3. Зібрати повний контекст з KB

З файлу задачі витягни:
- Оригінальний `Problem`
- `Root Causes` — чому баг виник
- `Fixes Applied` — що вже фіксили
- `Files Changed` — які файли чіпали
- `Notes / Pitfalls` — відомі пастки
- Всі попередні `Reopen #` секції (хронологія проблеми)

Підготуй для STEP 6:
```
MODE = REOPEN
REOPEN_COUNT = N
PREVIOUS_FIXES = (список з KB)
QA_FEEDBACK = <EXTRA_INPUT>
KNOWN_PITFALLS = (з KB)
```

---

## STEP 4-C — ПРОДОВЖЕННЯ: відновити контекст

З файлу задачі витягни:
- `Problem` — оригінальна задача
- `Fixes Applied` — що вже зробили
- `Files Changed` — що вже міняли
- `Notes / Pitfalls` — відомі пастки
- `Remaining Work` — якщо є така секція

Підготуй для STEP 6:
```
MODE = CONTINUATION
DONE_SO_FAR = (список з KB)
REMAINING = (якщо є)
EXTRA_INPUT = <додаткові вводні якщо були>
```

---

## STEP 5 — ENTER PLAN MODE

Якщо схема EnterPlanMode не завантажена:
```
ToolSearch("select:EnterPlanMode")
```
Потім викликай `EnterPlanMode`.

---

## STEP 6 — СКЛАСТИ ПЛАН

### Для НОВОЇ ЗАДАЧІ:

```
# План: <TASK_ID> — <назва>
**Тип:** Нова задача

## Опис
<DESCRIPTION>

## Цілі
1. ...

## Кроки виконання
### Крок 1 — ...

## Ризики і невизначеності
- ...

## Критерії завершення
- [ ] ...

## KB запис
Після завершення: /kb-update <TASK_ID>
```

### Для РЕОПЕНУ:

```
# План: <TASK_ID> — <назва> [Reopen #<N>]
**Тип:** Реопен (повернення #<N>)
**Дата реопену:** <TODAY>

## Нові вводні від тестувальника
<QA_FEEDBACK або "(не надано)">

## Хронологія проблеми
- Оригінальний фікс: <дата> — <що робили>
[- Reopen #1: <дата> — <що було>]
[- Reopen #2: <дата> — <що було>]
- **Reopen #<N>: сьогодні** — поточна сесія

## Що вже фіксили і чому не допомогло
<PREVIOUS_FIXES з аналізом чому баг повернувся>

## Гіпотеза чому баг повернувся
<На основі нових вводних і попередніх фіксів — твоя версія причини>

## Відомі пастки
<KNOWN_PITFALLS>

## Кроки виконання
### Крок 1 — Діагностика
(Перш за все зрозуміти чому попередній фікс не спрацював)
...

## Критерії завершення
- [ ] ...

## KB запис
Після завершення: /kb-update <TASK_ID> reopen #<N> fixed
```

### Для ПРОДОВЖЕННЯ:

```
# План: <TASK_ID> — <назва> [Continuation]
**Тип:** Продовження in-progress задачі

## Що вже зроблено
<DONE_SO_FAR>

## Що залишилось
<REMAINING або "визначити з контексту">

## Додаткові вводні
<EXTRA_INPUT або "(не надано)">

## Кроки виконання
(Починаємо з того де зупинились)
### Крок 1 — ...

## Критерії завершення
- [ ] ...
```

---

## STEP 7 — ПІДТВЕРДЖЕННЯ

Після складання плану запитай:

> "Підтверджуєш план? Чи є правки до підходу?"

**НЕ починай виконання доки користувач не підтвердив план.**

Якщо є правки — скоригуй і покажи знову.
