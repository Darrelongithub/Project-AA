# ROUTE_SCAN.md — functionality scan of every route

Scope: every HTTP route registered in `src/web/server.ts` (express app built
by `createApp`), verified against the real server (`tsx src/cli/serve.ts`)
and the vitest suite (393 tests, 29 files — all pass at time of writing).

Legend: **auth** = middleware chain · **verdict** = what the scan found.

---

## 1. Public & first-run

| Route | Auth | Verdict |
|---|---|---|
| `GET /login`, `POST /login` | public | ✓ constant-time password check, lockout-free but rate-guarded by session design; failed login re-renders with message. |
| `GET /setup`, `POST /setup` | public until the first account exists | ✓ one-time expiring `_setup` token (not CSRF — the page is unauthenticated by definition); after the first account `/setup` is 404 forever. Pinned by OR-1 tests. |
| `POST /logout` | session | ✓ burns the session row. |
| `POST /theme` | none | ✓ sets a `theme` cookie only — no state. The referer-based redirect is origin-checked (the previous open redirect is fixed and commented). |
| `GET /healthz` | none | ✓ `{ ok: true }`. |
| `GET /assets/*` (logo, favicon, fonts, manifest) | none | ✓ static, cache-busted. `/assets/email-banner` requires login (brand asset, staff-only). |

## 2. Case work (the scoped surface)

All `/case/:id…` routes sit behind the **OR-8 guard** (`app.use("/case/:id")`,
runs first): unknown ids and out-of-scope ids get the **same 403**, so scoped
staff cannot probe which cases exist. Realm separation (live vs demo) applies
on top.

| Route | Auth | Verdict |
|---|---|---|
| `GET /case/:id` | login + scope guard | ✓ case page; counts/emails/docs all from the same applicant. |
| `GET /case/:id/replay` | login + scope guard | ✓ decision replay (read-only). |
| `POST /case/:id/task/add`, `task/toggle` | login + CSRF | ✓ validated task bodies. |
| `POST /case/:id/draft` | login + CSRF | ✓ renders a draft; never sends. |
| `POST /case/:id/action` | login + CSRF | ✓ canned actions render from templates; pack attaches per template flag. |
| `POST /case/:id/send` | login + CSRF | ✓ duplicate-send guard (5s window), pack flag honoured, failures audited (`send_failed`), never a silent success. |
| `POST /case/:id/send-pack` | login + **admin** + CSRF | ✓ official pack send; missing pack files → `pack_incomplete` audit + visible warning. |
| `GET /case/:id/compose`, `POST /case/:id/compose` | login (+ CSRF on POST) | ✓ pre-filled from the case; empty subject/body re-renders with an error instead of sending. |
| `POST /case/:id/note` | login + CSRF | ✓ empty note refused. |
| `POST /case/:id/assign` | login + CSRF | ✓ unknown staff id refused before the FK could 500; assignee notified. |
| `POST /case/:id/priority` | login + CSRF | ✓ validated enum. |
| `POST /case/:id/category` | login + **admin** + CSRF | ✓ category correction. |
| `POST /case/:id/admission-decision` | login + CSRF | ✓ the human final call; recorded with actor + reason. |
| `POST /case/:id/reevaluate` | login + CSRF | ✓ re-runs the engine on the same frozen evidence. |

## 3. Lists, levels, dashboard (counts == lists)

| Route | Auth | Verdict |
|---|---|---|
| `GET /` | login | ✓ every counter passes through the same school scope as the lists (OR-8). |
| `GET /queue` | login | ✓ legacy alias → redirects to `/applicants?queue=human_review` (kept so old bookmarks survive). |
| `GET /applicants` | login | ✓ search + every queue tab scoped; LIKE wildcards escaped. |
| `GET /admissions` | login | ✓ level tabs scoped; counts come from the same scoped query as the rows. |
| `GET /notifications`, `POST /notifications/read-all` | login (+ CSRF) | ✓ scoped (out-of-scope case alerts hidden; broadcasts stay). |
| `GET /team` | login | ✓ legacy alias → `/staff`. |
| `GET /api/search` | login | ✓ command palette; scoped; returns JSON 404s under `/api/*`. |

## 4. Configuration (admin)

| Route | Auth | Verdict |
|---|---|---|
| `GET /config` (tabs: requirements / courses / replies) | **admin** | ✓ deterministic document matrix, generated grade builder, courses + schools, packs + branding. |
| `POST /config/course-owner` | admin + CSRF | ✓ unknown owner handled. |
| `POST /config/programme/edit` | admin + CSRF | ✓ name/school/reference notes; enforced rules are NOT free text (OR-6). |
| `POST /config/entry-requirements` | admin + CSRF | **refusal** (OR-6): legacy block editor wrote to a table the engine doesn't enforce; stale POSTs get an explicit redirect, nothing saved. |
| `POST /config/requirements/node-add` / `node-save` / `node-delete` | admin + CSRF | ✓ visual rule tree; values validated against the picker ladders (junk refused). |
| `POST /config/requirements/activate` / `discard` | admin + CSRF | ✓ draft → activate with frozen versions; empty drafts cannot activate. |
| `POST /config/requirements/catalogue-add` / `catalogue-rename` / `catalogue-toggle` | admin + CSRF | ✓ duplicates refused explicitly; renames keep active status. |
| `POST /config/schools/add` / `schools/rename` | admin + CSRF | ✓ renames cascade to every course; clashes refused. |
| `POST /config/reevaluate-open`, `/config/dead-letter/retry`, `/config/dead-letter/delete` | admin + CSRF | ✓ ops endpoints, audited. |
| `GET /pack/:key` | login | ✓ whitelisted keys only; 404 otherwise. |
| `POST /config/pack/replace` | admin + CSRF | ✓ PDF only, ≤12 MB, atomic swap; bad uploads get an explicit message. |

## 5. Settings (admin)

| Route | Auth | Verdict |
|---|---|---|
| `GET /settings` | **admin** | ✓ connections (Gmail/Gemini), automation, response targets, retention. |
| `POST /settings/gmail/credentials` / `disconnect` / `test` / `sync` | admin + CSRF | ✓ test connection makes one real lightweight API call; failures stored in `gmail_last_error`, never silent. |
| `GET /settings/gmail/connect`, `GET /settings/gmail/callback` | admin | ✓ OAuth: random `state` generated, verified, then burned. GET callback is protocol-required; CSRF covered by the state token. |
| `POST /settings/gemini` | admin + CSRF | ✓ key stored server-side, never echoed back (pinned by secret-echo tests). |
| `POST /settings/general`, `automation/global`, `automation/category`, `intake-deadline` | admin + CSRF | ✓ validated; automation changes apply instantly (hot-swap). |
| `POST /settings/rules/add` / `rules/delete` | admin + CSRF | **refusal** (OR-5): document requirements are generated deterministically; explicit message, no write. |
| `POST /settings/lists/add` | admin + CSRF | ✓ adds programmes (with school + level incl. Master's/PhD) and intakes. |
| `POST /settings/template` | admin + CSRF | **refusal** (OR-7): templates moved to the Templates section; explicit redirect, nothing saved. |

## 6. Templates & staff (admin)

| Route | Auth | Verdict |
|---|---|---|
| `GET /templates`, `POST /templates/save`, `POST /templates/reset` | **admin** (+ CSRF) | ✓ OR-7: every outgoing type, placeholders documented, live preview, unknown-placeholder warning, reset to official defaults, pack flags. |
| `GET /staff`, `POST /staff/add`, `/staff/toggle`, `/staff/password` | **admin** (+ CSRF) | ✓ accounts + performance; password resets generate one-time setup links. |
| `POST /staff/scopes` | admin + CSRF | ✓ OR-8: one action replaces a member's entire school set; unknown school names refused. |

## 7. Account & exports

| Route | Auth | Verdict |
|---|---|---|
| `GET /account`, `POST /account/username` / `password` / `theme` | login (+ CSRF) | ✓ self-service; current password required. |
| `GET /export/applicants.csv`, `/export/queue.csv`, `/export/audit.csv` | **admin** | ✓ admins cannot be scoped (OR-8), so exports stay complete for the one role allowed to take data out. |

## 8. Cross-cutting findings

1. **CSRF** — every state-changing POST carries `csrfCheck` except the four
   public flows that cannot (setup uses a one-time token; login/logout/theme
   carry no privileged state; OAuth callback uses its `state` as the token).
2. **No silent failures found** — sends, pack builds, uploads, OAuth and
   template saves all end in an explicit success or an explicit, audited
   error message.
3. **Refusals over dead ends** — the four retired endpoints
   (`entry-requirements`, `settings/template`, `settings/rules/add|delete`)
   answer with a redirect + message instead of 404-ing or silently writing.
4. **Scoping** — verified end-to-end by `test/scoping.test.ts` (queues,
   levels, dashboard, search, API, direct URLs, actions).
5. **Legacy aliases** (`/team`, `/queue`) redirect instead of 404 — old
   bookmarks keep working.
6. **Error handling** — branded 404 for unknown paths (JSON for `/api/*`)
   and a last-resort handler that logs detail but never leaks a stack trace.

**Open items:** none blocking. (Low nit: `/queue` and `/team` aliases can be
retired once no external links rely on them.)
