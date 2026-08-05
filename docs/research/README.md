# Research — how the references solve the problems we are solving

> Working documents, written 2026-08-05. **Reference, not authority.** When any of
> these disagree with `docs/scope.md`, `docs/stack.md` or `docs/design.md`, those
> documents win and this one gets corrected.

Five reference implementations were read at source level, plus vendor documentation
for the three closed commercial products we are measured against. The purpose is
narrow: we already have a working stack and a locked scope, and what we lacked was
concrete knowledge of *how* the credible products in this category actually compute
and present the things `docs/scope.md` asks for. "They have good categorisation" is
not usable. "They match a compiled regex per field, evaluate every rule, and let the
deepest category path win" is something you can build from.

---

## ⚠️ Licence discipline

None of the source-readable references can be borrowed from at the code level.

| Project | Licence | Consequence |
| --- | --- | --- |
| Cattr | **SSPL** | Not OSI-approved. Reaches the whole service stack, not just the binary. |
| Kimai | **AGPL-3.0** | Copying obliges us to release AEMS under AGPL. Fatal for white-label. |
| ActivityWatch | **MPL-2.0** | File-level copyleft — the mildest here, still not to be copied. |

**Nothing in these documents is copied source.** Every algorithm is described in
prose or in pseudocode written for this repo. Where a formula or a constant appears,
it is a *fact about their behaviour* — the same category of thing as "their default
timeout is 180 seconds" — not a transcription of their code. Two short attributed
quotations appear where prose genuinely could not carry the point; both are marked.

When you implement from these documents: read the description, close this file,
write our version against our contracts in `packages/types`. Do not go back to their
repository to "check the details" while you have an editor open on ours.

---

## Source-confidence key

Every claim in these documents carries one of three markings. Build decisions rest on
this distinction, so it is applied strictly.

| Marking | Means |
| --- | --- |
| **VERIFIED** | Read from source at a cited path, or read from our own repo at a cited `file:line`. |
| **DOCUMENTED** | Vendor help-centre or support documentation for a closed product (Hubstaff, Apploye, ActivTrak). Their own description of their own behaviour — better than marketing, worse than source. |
| **INFERRED** | Reasoning from the above. Explicitly a conclusion, not an observation. |

Unmarked claims about *our* codebase are VERIFIED by definition — every one carries a
`file:line`. If you find one that does not, treat it as INFERRED and check it.

Closed products (Hubstaff, Apploye, ActivTrak) can never be VERIFIED. Where their
documented behaviour is corroborated by a source-readable implementation doing the
same thing, that is noted — two independent descriptions agreeing is the strongest
evidence available for a closed product.

---

## The documents

| File | Covers | Scope clauses |
| --- | --- | --- |
| [`activity-engine.md`](./activity-engine.md) | Window/app capture, URL and domain extraction, heartbeats vs closed intervals, idle detection, activity-level %, app/site categorisation | §2.2, §2.4, §2.5, §2.6 |
| [`screenshots.md`](./screenshots.md) | Capture, upload, storage layout, interval grouping, thumbnails, multi-monitor, retention, deletion, the review UI | §2.3, §4.4 |
| [`timeline.md`](./timeline.md) | The employee day view — reduction, proportional rendering, zoom, colour, gaps, timezone | §2.7, §4.4 |
| [`reports-analytics.md`](./reports-analytics.md) | Report types, columns, formats, CSV/PDF, team comparison, trends, AI summaries, scheduling | §5, §6 |
| [`dashboard-ia.md`](./dashboard-ia.md) | Navigation, overview, live status, people list, employee detail, master-detail, filters, employee transparency | §4.1–§4.4 |
| [`priority-matrix.md`](./priority-matrix.md) | Every recommendation in one table, sorted by value per unit of work, split before/after the client demo | all |

---

## How to use these

**Start with `priority-matrix.md`.** It is the only document that ranks. The five
area documents explain *why* a recommendation exists and what it costs to get wrong;
the matrix says what to do first.

Each area document follows the same four-part shape:

1. **What the references do** — concrete, with algorithm names, field names, defaults and edge cases.
2. **What we do today** — with `file:line`, so you can open it.
3. **The gap** — stated as a failing test you could actually run, not as an opinion.
4. **The recommendation** — in our stack, naming the files it touches, ending in a verdict.

Every recommendation carries one of three verdicts:

- **ADOPT** — take the approach as they do it. The problem is the same and their answer is right.
- **ADAPT** — take the idea, change the mechanism. Usually because our stack, our scale or our positioning differs.
- **REJECT** — considered and declined, with the reason recorded so it does not get reopened.

REJECT entries are load-bearing. Several of them exist because the idea is genuinely
attractive and would cost a week. A rejection with a reason is cheaper than the same
argument had three times.

---

## Scope honesty

`docs/scope.md` is locked and its closing line is unambiguous: *"Any feature outside
this list is Phase 2, after the client demo and validation."*

Every recommendation in these documents is mapped to a scope clause. Anything that is
not is labelled **PHASE 2** in the body text *and* in the matrix, in both cases with
the reason it was worth naming at all. Items in that category include: report
templates and a report builder, scheduled email delivery of reports, productivity
goals and expected-hours targets, screenshot blur, screenshot retention policy, a
browser extension for Windows URL capture, a month-calendar navigator, cross-employee
timeline swimlanes, and configurable dashboard widgets.

Several of those are good ideas. None of them is in scope. A research document that
quietly widens scope is worse than no research document, because the team discovers
the widening in the last two days rather than the first.

Two items sit deliberately outside scope for compliance rather than time reasons and
should not be revisited without the client: **location tracking** (non-negotiable #6)
and anything on the §8 *Later* list — remote control, file monitoring, USB control,
software deployment, MDM, endpoint protection, SSO, advanced compliance. Nothing
recommended in these documents touches either.

---

## What was read

| Reference | Read at | Level |
| --- | --- | --- |
| ActivityWatch — `aw-core`, `aw-server`, `aw-client`, `aw-watcher-window`, `aw-watcher-afk`, `aw-webui`, `aw-server-rust` | `master`, raw.githubusercontent.com | Source |
| Cattr — `server-application`, `desktop-application`, `frontend-application` | `main`, raw.githubusercontent.com + jsdelivr mirror | Source |
| Kimai — `src/Reporting`, `src/Export`, `src/EventSubscriber`, `src/Controller` | `main`, raw.githubusercontent.com | Source |
| Hubstaff | support.hubstaff.com | Vendor documentation |
| Apploye | apploye.com/help | Vendor documentation |
| ActivTrak | support.activtrak.com | Vendor documentation |

Cattr's repository has moved since `docs/inspiration.md` was written: the URL
`cattr-app/cattr` 404s, and the code now lives in `cattr-app/server-application`,
`cattr-app/desktop-application` and `cattr-app/frontend-application`. That correction
is already reflected in `docs/inspiration.md`.

---

## Re-checked against the repo, 2026-08-05

Claims about *their* code cannot be re-run; claims about *ours* can, and the ones the
matrix leads with were re-checked against the working tree after the documents were
written. All five held:

| Claim | Check | Result |
| --- | --- | --- |
| Idle-threshold defaults disagree | `collector.ts:27` vs `…0001_init_schema.sql:82` | 300 vs 120 — confirmed, and the comment claiming they match is still there |
| The timeline queries are uncapped | `routes/analytics.ts:77-107` | three `.select("*")` with no `.order()` and no `.limit()` — confirmed |
| `/live` can never return idle | `routes/analytics.ts:206-233` | `online ? "active" : "offline"`, derived from `devices.last_seen_at` alone — confirmed |
| The timeline component has no importers | grep over `apps/admin-dashboard/src` | only its own definitions at `activity-timeline.tsx:44,123` — confirmed |
| `thumbnail_path` is written and read by nothing | grep over `apps`, `packages/*/src`, `supabase` | one migration line and two generated-type lines — confirmed |

`apps/admin-dashboard/src/app` still contains only `page.tsx`, `layout.tsx`,
`globals.css`, `people/` and `devices/` — four of the seven sidebar entries, and the
whole of §4.4, remain unbuilt.

These documents were written while another workflow was editing `apps/desktop-agent`.
Every agent-side `file:line` was read, never written; if a line number has drifted, the
surrounding claim is still the thing to check, not the number.

---

# Critic's addendum — completeness review, 2026-08-05

> Appended by a reviewer whose job was to find what is missing or wrong, not to
> approve. The five area documents are not rewritten. Everything below is either a
> gap, a contradiction between two of these documents, or a claim that does not
> carry the evidence its verdict rests on.
>
> **Headline: strong on the four areas it covers; not usable as a build plan on its
> own.** It silently narrows the product to desktop + web, its headline schedule is
> out by roughly 2.3x, and it mints three colliding migration numbers.

## 1. Scope clauses with no research at all

`docs/scope.md` §§2–7 contain seven areas. Two Critical ones are untouched.

**§3 — the entire Android application. Zero coverage.** `docs/scope.md`'s own
priority matrix marks *Android Monitoring App* 🔥 **Critical**, level with the
desktop agent. `apps/android-agent/` already exists and contains
`modules/aems-usage/android/src/main/java/com/primexmeta/aems/usage/AemsUsageModule.kt`
and `MonitoringService.kt`. Across all six research documents the word "Android"
appears five times, every one of them incidental — a row label inside a quoted scope
block (`dashboard-ia.md:255`), a hypothetical second device (`timeline.md:327`), and
a reason not to categorise on the agent (`activity-engine.md:536`). §3.1 device
registration, §3.2 app-usage tracking, §3.3 device activity, §3.4 device inventory:
**0 of 4 addressed.** No mobile reference was read; none of the five references has a
mobile agent, and no substitute was sought.

**§2.1 — Employee Authentication on the agent. Zero coverage.** Login, device
registration, device binding, secure token management, auto-start with system,
background operation. `dashboard-ia.md` §7 covers *dashboard* auth and says so
explicitly. Nothing covers the agent's enrolment handshake, token custody
(`main/config.ts`'s `safeStorage` allowlist — CLAUDE.md open item #4 names it as the
untested compliance surface), token rotation, or auto-launch. Cattr's
`desktop-application` was read for its event counter and its capture path but not for
its first-run, login or update flow.

**Non-negotiable #2 — "monitoring is never silent" — has no prior art in the
survey.** CLAUDE.md open item #5 says the visible-indicator guarantee is weaker than
it reads on both platforms, `main/indicator.ts` and
`renderer/screens/IndicatorWindow.tsx` now exist to close it, and no research document
studies how *any* reference makes agent presence visible (ActivityWatch ships `aw-qt`;
Cattr's desktop app has a tray). The one non-negotiable currently being actively
rebuilt got no research support.

**The desktop agent's own UI is unresearched.** `docs/design.md` specifies that
surface (`Company Monitor / Status / Today's Time / Last Sync`) and
`apps/desktop-agent/src/renderer/screens/` holds `LoginScreen`, `StatusScreen`,
`ConsentScreen` and `IndicatorWindow`. `dashboard-ia.md` covers the web dashboard
only. Two of the three surfaces `docs/design.md` binds have design research; the agent
has none.

**§7 is half covered.** The render path is addressed (`dashboard-ia.md` §8, matrix
#37). The *collection* side — installed applications, CPU, RAM per §7's "Desktop
devices" list — is not, and `main/device.ts` is never cited. §3.4 (Android inventory)
is absent along with the rest of §3.

Also absent, one line each: **electron-updater / the update channel**
(`docs/stack.md` §13); and **how breaks are declared** — only the Work Breaks *report*
was studied, not the break policies that produce §2.2's "break time".

## 2. Prose that asserts a benefit without naming a mechanism

Quoted, so they can be edited rather than argued about.

- `dashboard-ia.md:275` — *"Roughly two hours, and it is the highest
  credibility-per-minute item in this document because the client will look for that
  amber row specifically."* The claim about client behaviour is presented as fact and
  has no source. The finding underneath it (`/live` computes
  `online ? "active" : "offline"` and never reads `idle_events`) is excellent and
  needs no help.
- `timeline.md:142-143` — *"This is the single most valuable structural idea in the
  whole survey."* A superlative over a comparison that was never performed, attached
  to the one idea in the survey resting on **DOCUMENTED-only** evidence (see §3).
- `screenshots.md:96-97` — *"That is the difference between a screenshots tab and a
  screenshots tab that a manager will open twice."* The sentence above it gives
  ~10 MB → ~400 KB. Keep the number, drop the flourish.
- `priority-matrix.md:159` — *"Those two are the product."*
- `activity-engine.md:182-183` — *"It is defensible to an employee precisely because
  it measures presence at the machine rather than intensity of work."* This is the
  justification for a new table, a new agent timer and a new DTO. "Defensible" is a
  position, not a mechanism.
- **Every effort estimate in `priority-matrix.md` is unsourced, and they do not add
  up.** `priority-matrix.md:152-155` says the minimum credible cut is *"1–12 plus 14,
  15 and 21 — about seven days."* Summing that table's **own** numbers for those
  fifteen items (0.01 + 0.15 + 0.25 + 0.25 + 0.5 + 1 + 1 + 1.5 + 1 + 3 + 1.5 + 1 + 2 +
  1.5 + 1.5) gives **≈16 developer-days**. The headline is out by ~2.3x. The full
  "before the demo" table of 30 items is far beyond that again, and `docs/stack.md`
  §10 records a five-day deadline. Either the estimates or the summary is wrong; both
  cannot be used to plan.

## 3. Marked VERIFIED, actually inferred — or unmarked entirely

- `reports-analytics.md:66-71` carries the header **"VERIFIED / DOCUMENTED"** and then
  concludes *"i.e. **PDF and HTML share one template**, differing only by extension."*
  That conclusion is an inference from two renderer factories coexisting plus one
  sentence of vendor docs. The template sharing was not read.
- `reports-analytics.md:313-316` — the `pdf-lib` / `pdfkit` paragraph carries **no
  marking of any kind**. *"the known Supabase failure mode is `pdfkit`, which trips a
  blocklisted `Deno.readFileSync` reading font files"* is stated as fact about a third
  party and is the sole basis for a dependency choice. The README's own key says only
  claims about *our* codebase are verified by default.
- **`screenshots.md:102-113` — the fixed 10-minute grid is DOCUMENTED-only, and four
  ADOPT verdicts stand on it.** `timeline.md` R2/R8, `screenshots.md` R3/R4 and
  `activity-engine.md` R1's segmentation all derive from Apploye and Hubstaff
  help-centre pages. This README states plainly that closed products can never be
  VERIFIED. The idea may well be right; the evidence class should be visible at the
  point of the verdict, not only in the key.
- `activity-engine.md:180-183` is correctly marked INFERRED, but the conclusion ("the
  metric is seconds containing input") is stated with more confidence than two data
  points support, one of which is a competitor's help centre.
- **One claim re-verified, and it holds exactly.** `reports-analytics.md:236`:
  `list_extensions` against project `dayyrqcfktwwnkttlres` returns `pg_cron` 1.6.4 and
  `pg_net` 0.20.4, both `installed_version: null`. Recommendation A also depends on
  **pgTAP**, which is likewise available (1.3.3) and uninstalled — the document does
  not mention that it too must be installed.

## 4. Scope creep, stack change, or a §8 "Later" item in disguise

- **`pdf-lib` is a new runtime dependency**, introduced mid-paragraph inside
  recommendation B rather than raised as the stack addition it is. §5 does name PDF,
  so the need is real — but CLAUDE.md says do not add a library without raising it.
- **`reports-analytics.md:395` asserts *"Not a stack change"* about `pg_cron` +
  `pg_net`.** Two new Postgres extensions and a scheduling mechanism absent from
  `docs/stack.md` §9 is a stack addition even though Edge Functions remain the worker
  runtime. The document is right that `pgmq` is forbidden; that does not make
  `pg_cron` automatically free. Raise it, do not assert it away.
- **Matrix #13 (Postgres-side aggregation) is the largest architectural change in the
  survey and is filed at demo-impact `L`.** It relocates the activity maths out of
  `packages/analytics` into SQL and then proposes keeping the TypeScript as an
  "oracle" — two permanent implementations of the same arithmetic. `docs/stack.md` §4
  puts business logic in Fastify. Its own author flags the core SQL as *"INFERRED, not
  executed"* (`reports-analytics.md:294-296`). The row understates the risk.
- **The categorisation settings UI (matrix #32) has no scope clause.** §4.2 enumerates
  employee management; nothing asks for a category-rule admin surface with
  drag-to-reorder and a rule-preview simulator. Matrix #12 claims "§2.4, §2.5, §4.4,
  §5, §6" for the engine — §2.4 and §2.5 ask for app name + duration and domain + time
  spent, not classification. The engine is defensible via §6; the mapping as written is
  the most generous in the survey.
- **`screenshots.md:323-325` contradicts `reports-analytics.md:362-365`.** The first
  wires shift-click multi-select to *"Export selected"*; the second says *"Screenshot
  history is deliberately excluded from CSV and PDF."* Screenshot export is not a §5
  format. Pick one.
- Matrix #30 (screenshot-capture policy enum) is well argued and correctly notes that
  it forces a new policy version and fresh consent — which makes it a **client
  decision**, not a build decision. It is not flagged as one.

## 5. Contradictions with `docs/design.md`, the non-negotiables, or each other

**Nothing in the survey weakens consent or the indicator.** `screenshots.md` R6 puts
enforcement server-side per NN#1; both `timeline.md` §4 and `activity-engine.md` §3
refuse Apploye's red bands and reserve indigo for AI; interval editing is rejected
against NN#5 in two places; location is rejected against NN#6. That posture is sound
and should be preserved as-is.

Three real conflicts remain, all internal:

1. **Migration numbers collide.** Existing migrations stop at `…0006`. Three documents
   each mint `20260805000007`: `activity_segments` (`activity-engine.md:249`),
   `screenshot_capture_group` (`screenshots.md:191`), `report_aggregates`
   (`reports-analytics.md:297`). Two mint `…0008`: `activity_categories`
   (`activity-engine.md:506`) and `…0008_schedules` (`priority-matrix.md:42`).
   `screenshots.md:502` compounds it by putting a `worker_state` table "in the R1
   migration". Renumber before anyone writes SQL.
2. **`bucketSeconds` default.** `screenshots.md:146-149` — *"default stays 3600 for the
   day strip, but the review view requests 600."* `timeline.md:344-346` — constrain to
   a fixed set *"defaulting to **600**."* Whoever implements first wins, and the other
   document's reasoning silently breaks.
3. **Copy tension.** `reports-analytics.md:350` puts a column named **"Active %"** in
   `time_and_activity`, while matrix #26 and `docs/design.md:173-181` say replace the
   bare score with a work pattern. A number in a report is arguably fine — but the same
   quantity must not be "Focused time" on one screen and "Active %" on another.
   Reconcile the label once.

## 6. Licence exposure

- **This README's own §"Licence discipline" is inaccurate as written.** It states
  *"Two short attributed quotations appear where prose genuinely could not carry the
  point; both are marked."* There are at least eleven quoted fragments across the five
  documents, six of them from copyleft source: `activity-engine.md:90-91` (aw-server
  `FIXME`), `:97-98` (aw-server-rust test comment), `:105` (aw-client retry string),
  `:395` (classify.py comment), `:592` (url-transform comment), and `timeline.md:91-92`
  (the `VisTimeline` TODO). **None is a function body, all are attributed, and the real
  exposure is low** — but this paragraph is the licence-audit statement someone will
  rely on, so it has to be true. Correct the count.
- **The one genuinely code-shaped quote is `activity-engine.md:156`** — a verbatim
  expression from Cattr `app/src/utils/event-counter.js`, which is **SSPL**, the most
  aggressive licence in the set — and the R1 pseudocode immediately below it is a close
  paraphrase of that same counter. A one-line arithmetic expression is very unlikely to
  be protectable. It is still the single line in this survey most worth restating in
  prose.
- **Structural note, not a defect.** `activity-engine.md:390-427` and
  `timeline.md:35-51` are near-complete specifications of `classify.py` and `flood.py`
  — rule shape, precedence, constants, edge cases. Algorithms are not copyrightable and
  this is exactly what clean-room research is supposed to produce; its value is that an
  implementer never needs to open the MPL-2.0 source. **Keep that property: build from
  these documents, not from upstream.** One caution — the default category tree
  described at `activity-engine.md:421-427` is detailed enough to be transcribed by
  accident, and the same document (`:516`) rightly says not to. Treat that paragraph as
  a warning, not a starting seed.

## 7. The single most valuable thing not researched

**The Android agent (`docs/scope.md` §3).** Four Critical sub-sections, an existing
`apps/android-agent` with a Kotlin `MonitoringService`, and not one line of research.
The questions a build needs answered and this survey does not touch:

- How `UsageStatsManager`'s bucketed foreground stats map onto `ActivityEventInput` —
  it reports aggregates over a window, not the closed focus intervals our contract and
  the whole timeline reduction assume.
- What the undismissable foreground-service notification must say to satisfy
  non-negotiable #2, and what happens to collection when the user revokes the
  usage-access grant.
- How Doze and App Standby change sync cadence and heartbeat expectations — the
  dashboard's two-minute `OFFLINE_AFTER_MS` will mark every backgrounded phone offline.
- What "screen active time" (§3.3) is as an interval, and whether idle even has a
  meaning on a device with no keyboard.
- Whether one `activity_events` row shape can carry a mobile package name without the
  agent-specific leakage `docs/stack.md` §10 forbids.

It is half the collection surface of the product, it is the only platform with no open
reference read, and CLAUDE.md open item #7 says the toolchain has never even been
built. **Runner-up:** §2.1 agent enrolment and token custody together with prior art
for the visible-indicator guarantee — the two places where a compliance promise meets
an untested code path.
