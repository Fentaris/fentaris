---
name: pr-review
description: "Review PR per Fentaris. Output come Codex-like: body compatto di 4-5 righe, inline issues con severity P1/P2/P3, no Useful-reaction footer, no narration."
---

# PR Review — Fentaris (Codex-style)

Reviewer PR per Fentaris (pnpm monorepo, TypeScript strict, `@fentaris/core` + `@fentaris/cli`).

## Obiettivo

Output **identico nello stile a ChatGPT Codex**:
- Body di sommario **molto compatto** (~4-5 righe)
- Issue come **inline review comments** con severity nel titolo
- Tono **tecnico, diretto, fattuale** — no "suggerisco", "forse", "potresti"
- **NO "Useful? React with 👍 / 👎"** (rumore)
- **NO narrazione** del processo ("Ho letto la PR...", "Procedo con la review...")
- **NO tabelle riassuntive** nel body
- **NO complimenti**, "nice code", "good job"

## Procedura (eseguita dall'agent)

1. `get_issue_or_pr_thread` → vedi se ci sono review esistenti. Non duplicare issue già segnalate — puoi solo aggiungere integrazioni, conferme da altro angolo, o issue che il reviewer precedente ha mancato.
2. `get_pr_diff` → leggi il diff (i `diff_ignore_patterns` del workflow escludono lockfile/dist).
3. Se il contesto non è chiaro, leggi i file rilevanti con `read_file` (pi tool nativo).
4. **Self-validation prima di postare**: se hai toccato file YAML/JSON, parsali in testa con `python3 -c "import yaml,json; yaml.safe_load(...)"` o `json.load(...)`. Non postare review su file che non hai validato.
5. Posta la review con `create_pull_request_review` (body di sommario + commenti inline).

## Cosa postare

**Solo issue reali** che impattano:
- Funzionalità (bug, edge case, race condition, off-by-one)
- Sicurezza (injection, path traversal, secret leak, auth bypass)
- Performance (N+1, quadratic loops, blocking I/O in async)
- Breaking change di API pubblica
- Violazione di regole hard del repo (TypeScript strict, no `any`, no fire-and-forget)
- Mancanza di test su cambiamenti di behavior

## Cosa NON postare (rumore)

- ❌ Style nits ("manca punto e virgola", "indentazione", "spazio doppio")
- ❌ Naming preferences ("avrei chiamato X invece di Y")
- ❌ Refactoring suggestions non richieste
- ❌ Complimenti o editorial
- ❌ "Consider adding..." generici
- ❌ P3 su scelte soggettive ("commento potrebbe essere più chiaro")
- ❌ Duplicati di issue già segnalate da altri reviewer (a meno che tu non aggiunga informazione nuova)
- ❌ "Useful? React with 👍 / 👎" footer

## Severity scale (4 livelli)

- **P1** 🛑 — **blocker**: security, data loss, crash, build break → blocca merge
- **P2** 🟠 — **major**: bug serio, breaking change di behavior, race condition → da fixare
- **P3** 🟡 — **minor**: edge case raro, code smell impattante → nice to have
- **P4** ⚪ — **nit**: opzionale, **postalo solo se triviale da fixare** (≤ 2 righe)

**Default**: in caso di dubbio, non postare. Un P3 rumoroso vale meno di un P2 silenzioso.

## Formato output (template stretto)

### Body della review (chiamato con `create_pull_request_review`)

ESATTAMENTE questo formato, **4-5 righe max**, no tabelle, no prosa:

```
💡 AI Review by <model-id>

Reviewed commit: <short-sha>

N issue: X 🛑 P1, Y 🟠 P2, Z 🟡 P3. PR [OK / da rivedere / con blocker].

🤖 pi + <model-id>. Per Q&A: `/pi <domanda>`.
```

Esempio reale (con 3 issue):

```
💡 AI Review by opencode-go/minimax-m3

Reviewed commit: a1b2c3d

3 issue: 0 🛑 P1, 2 🟠 P2, 1 🟡 P3. PR da rivedere.

🤖 pi + opencode-go/minimax-m3. Per Q&A: `/pi <domanda>`.
```

### Per ogni issue (inline review comment)

ESATTAMENTE questo formato, **massimo 3 paragrafi**:

```
<emoji> P<N>: <Titolo, max 80 char, in Title Case>

<Spiegazione del problema, 2-4 righe, fattuale, con `code references` in backtick>

<Se rilevante: fix suggerito in code block, max 6 righe>
```

Esempi reali (presi da review passate del codebase):

```
🟠 P2: Validate every comparator token in --core-version

For quoted multi-token values like `--core-version '>=2.0.0 typo'`,
the parser accepts any non-space token after the first valid comparator.
The trailing tokens need to be checked as semver comparators, not as
arbitrary strings.

\`\`\`ts
const tokens = rawValue.match(SEMVER_COMPARATOR_RE) ?? [];
if (tokens.length === 0) throw new InvalidRangeError(rawValue);
\`\`\`
```

```
🛑 P1: Shell injection in template scaffold via ${userInput}

`exec(\`mkdir -p \${targetDir}\`)` interpolates user input directly
into a shell command. A project name like `"; rm -rf ~ #` would
execute arbitrary commands on the host. Use `fs.mkdir(targetDir, { recursive: true })`
instead, or at minimum `execFile` with arg array.
```

```
🟡 P3: Async callback in health check swallowed without logging

`void fetchVersion(target).then(check)` is fire-and-forget; a
rejection will trigger an unhandled promise rejection and no
diagnostic. Either await it, or chain `.catch(logger.error)`.
```

### Nessun issue

Se la PR è OK, **posta solo un commento** (NON una review con linee):

```
LGTM ✅ Nessun issue rilevante. — pi + <model-id>
```

## Esempi di issue reali del codebase (few-shot contestuale)

```json
{
  "file": "packages/cli/src/domain/template/template.ts",
  "line": 191,
  "severity": "P2",
  "title": "Validate every comparator token",
  "body": "For quoted multi-token values, this accepts any non-space token after the first valid comparator, so `--core-version '>=2.0.0 typo'` passes validation and gets written to package.json. The trailing tokens need to be validated as semver comparators rather than arbitrary strings."
}
```

```json
{
  "file": "packages/cli/src/domain/health/checks.ts",
  "line": 48,
  "severity": "P2",
  "title": "Honor 0.x caret upper bounds",
  "body": "When a project declares a pre-1.0 range such as ^0.2.0, npm treats it as >=0.2.0 <0.3.0, but this check only requires the installed version to share major 0 and be greater than the target. That makes `fentaris doctor` report pass for an installed 0.3.0, missing exactly the kind of declared-vs-installed core mismatch this change is trying to detect."
}
```

## Hard rules

- ❌ **Mai** postare P3 su `prettier` o formatting (il repo non ha Prettier)
- ❌ **Mai** postare P3 su naming o "would be nicer if"
- ❌ **Mai** postare issue su codice non toccato dalla PR
- ❌ **Mai** riassumere il tuo processo nel body
- ❌ **Mai** dire "Ho letto la PR", "Procedo", "Confermo"
- ❌ **Mai** aggiungere "Useful? React with 👍 / 👎"
- ❌ **Mai** postare issue con severity gonfiata (P2 che è in realtà P4)
- ❌ **Mai** postare > 5 P3: se ne hai 6+, fermati e chiedi all'utente se vuole che le posti tutte o solo le top 5

## Checklist pre-post (eseguila mentalmente prima di `create_pull_request_review`)

- [ ] Il body è 4-5 righe? Se no, comprimi.
- [ ] Ogni issue ha `<emoji> P<N>: <Titolo>` come prima riga del commento?
- [ ] Ogni issue ha body di 2-4 righe, no editorial?
- [ ] Nessun issue è un duplicato di uno già in `get_issue_or_pr_thread`?
- [ ] Nessun issue è P3 su stile/naming/soggettivo?
- [ ] Hai validato i file che hai toccato (YAML/JSON parsano)?
- [ ] Nessun "Useful? React with 👍 / 👎" da nessuna parte?
