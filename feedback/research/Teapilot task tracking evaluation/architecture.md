# Teapilot task tracking architecture

## What is the task state model and lifecycle?

### Takeaway
Teapilot provides a host-owned, schema-validated durable task ledger alongside model-authored plans and ordinary conversation history. The ledger records lifecycle/status and execution evidence, but step status and completion remain declarations rather than proof; several important transitions are guaranteed by host code.

### Cited Findings
- `TaskStore.open` keys records by scope hash under `<stateDir>/tasks`, validates stored JSON and scope/scratch identity, initializes status `active`, and turns any leftover pending receipts into `uncertain` while marking the task `blocked` rather than replaying an unknown operation — [workspace/task.ts](../../packages/teapilot/src/workspace/task.ts#L91-L118).
- Task-level status enum is `active | waiting | blocked | completed | cancelled`; step-level status is `ready | working | blocked | done` — [workspace/task.ts](../../packages/teapilot/src/workspace/task.ts#L17-L18), [workspace/task.ts](../../packages/teapilot/src/workspace/task.ts#L25-L38).
- Request start sets task/request active and tracks call/model budgets; finish marks pending receipts uncertain and maps only `completed` to completed, `cancelled` to cancelled, all other status strings to blocked — [workspace/task.ts](../../packages/teapilot/src/workspace/task.ts#L229-L245), [workspace/task.ts](../../packages/teapilot/src/workspace/task.ts#L400-L405).
- Steps have a short goal, optional acceptance text, evidence references and actor/request ownership; updates require exact current revision and validate evidence against accessible artifacts or settled receipts. A stale revision is rejected — [workspace/task.ts](../../packages/teapilot/src/workspace/task.ts#L17-L18), [workspace/task.ts](../../packages/teapilot/src/workspace/task.ts#L364-L398).
- The tool description explicitly cautions that “Claims and done are declarations, not verification”; tool schemas allow the model to set `done` without a host-side acceptance evaluator — [agents/task.ts](../../packages/teapilot/src/agents/task.ts#L10-L22).
- `/plan`-style plans are separate mutable markdown files tracked by a `{path, revision, status}` reference; saves create/update drafts and `approve()` changes the reference status, not the task status — [workspace/plan.ts](../../packages/teapilot/src/workspace/plan.ts#L7-L14), [workspace/plan.ts](../../packages/teapilot/src/workspace/plan.ts#L49-L65).

### Inferences
- Lifecycle safety around interrupted calls is deliberately conservative: uncertain side effects are surfaced as blocked, not retried automatically.
- The architecture distinguishes intention (plan), progress declaration (steps), observations (receipts/artifacts), and verification (execution checks); it does not equate any one with completion.

### Gaps
- The supplied working tree has extensive user modifications to task, run, planning, Discord and tests. These references describe the current on-disk code, not necessarily committed baseline behavior. In particular avoid attributing those modifications to upstream without comparing HEAD.
- No explicit transition matrix or host-enforced “all steps done before task completed” rule is established by these source sections; inspect completion/report flow before assuming one.

## How are records persisted, retrieved, and bounded?

### Takeaway
State is atomically persisted in bounded JSON snapshots, with older evidence records spilled into a cold archive. The model sees a bounded projection and can page/search for prior records and read integrity-checked artifact files; the full transcript is separately retained in scratch/session logs.

### Cited Findings
- State schema limits steps to 8, claims 16, artifacts 128, receipts 64, projection to 6000 chars, and snapshot to 512 KiB; constraints, artifact metadata and request budgets are validated — [workspace/task.ts](../../packages/teapilot/src/workspace/task.ts#L13-L38).
- Snapshot changes are cloned, schema parsed, size-checked, written to a mode-0600 temporary file, fsynced, and replaced atomically — [workspace/task.ts](../../packages/teapilot/src/workspace/task.ts#L162-L173).
- When hot receipt/artifact capacity is reached, settled/eligible records are archived under `task-records/<task-id>` and can be enumerated/read cold — [workspace/task.ts](../../packages/teapilot/src/workspace/task.ts#L180-L227), [workspace/task.ts](../../packages/teapilot/src/workspace/task.ts#L291-L300), [workspace/task.ts](../../packages/teapilot/src/workspace/task.ts#L351-L359).
- `task_state` can project state, list paginated catalog records (up to 8/page), filter literal query/tool/request, or retrieve a record; `artifact_read` reads artifact content by ID with line range/search — [agents/task.ts](../../packages/teapilot/src/agents/task.ts#L10-L40), [workspace/task.ts](../../packages/teapilot/src/workspace/task.ts#L499-L550), [workspace/task.ts](../../packages/teapilot/src/workspace/task.ts#L551-L592).
- Artifact reads enforce scratch containment, reject links/hardlinks, verify file size and SHA-256, and cap output — [workspace/task.ts](../../packages/teapilot/src/workspace/task.ts#L551-L592).
- Projection ranks active steps, omits completed ones, takes bounded recent claims/receipts/artifacts and reports omission counts; if still too large, it drops lower-priority content until within allowance — [workspace/task.ts](../../packages/teapilot/src/workspace/task.ts#L450-L484).
- Host-recorded observations derive from settled receipts even if the model does not use bookkeeping; stale/uncertain and out-of-epoch mutable file/inventory observations are excluded — [workspace/task.ts](../../packages/teapilot/src/workspace/task.ts#L486-L498).
- `runAttempt` opens a session log in scratch; source comment says compaction summaries point at it — [agents/run.ts](../../packages/teapilot/src/agents/run.ts#L154-L157).

### Inferences
- Retrieval is designed as an index-plus-evidence workflow rather than putting all history into every prompt. This controls prompt size while retaining a route to older evidence.
- Security/integrity controls improve trustworthiness of retrieved evidence, but hashes only show that the saved file matches its recorded snapshot, not that its contents are true.

### Gaps
- The cited source describes session log creation, but full retention/cleanup policy and whether every interaction survives all restart/clear paths require inspection of compaction and workspace lifecycle code.

## How does context compaction and task identity interact?

### Takeaway
The runtime keeps the current request/objective explicitly pinned and provides durable task state plus selective transcript/history replay. Compaction is not itself completeness enforcement: dropped details must be recovered through state/catalog/artifact tools, and that recovery depends partly on the model choosing to retrieve them.

### Cited Findings
- `runAttempt` pins host-provided current request and task objective separately from historical summaries, preserving oversized text outside lossy summary (scratch copy where possible, otherwise original message retained); current request is marked as authoritative over historical summaries/blockers — [agents/run.ts](../../packages/teapilot/src/agents/run.ts#L158-L181).
- Task projection tells models near context pressure to keep unresolved steps and source-backed findings in `task_state`, retrieving older evidence by ID rather than replaying transcripts — [agents/tips.ts](../../packages/teapilot/src/agents/tips.ts#L40-L41).
- History implementation supports full, compacted, and text-only turn forms and fits older turns within a token budget; current-turn tool steps are retained preferentially — [agents/history.ts](../../packages/teapilot/src/agents/history.ts#L267-L296).
- Context-compaction tests exercise task-identified summary selection and current-task-only replay of tool steps, plus persistence of source freshness/checks across reload — [tests/compaction.test.ts](../../packages/teapilot/tests/compaction.test.ts#L89-L120), [tests/context-retention.test.ts](../../packages/teapilot/tests/context-retention.test.ts#L105-L109).

### Inferences
- The persistence layer mitigates context loss; it cannot guarantee that a model will capture every important discovery in a claim/step or later retrieve an omitted artifact.
- Current-request pinning is a robust host guarantee against a lossy historical summary overriding the latest user amendment, but the meaning and decomposition of the overall objective still require model interpretation.

### Gaps
- Need inspect full history/compaction implementation and specific assertions to characterize all replay fallbacks and their exact guarantees.

## Does the architecture model dependencies, blocking, or enforce completeness?

### Takeaway
There are status fields for blocked work and durable unresolved-check tracking, but task steps do not encode dependency edges. The host enforces execution accounting, evidence access, source freshness and some check state; it does not establish that every subgoal is represented, every acceptance criterion is met, or every declared `done` is true.

### Cited Findings
- Step schema contains only id, goal, status, acceptance and evidence; there is no `dependsOn`/dependency field — [workspace/task.ts](../../packages/teapilot/src/workspace/task.ts#L17-L18).
- Projection includes execution changed files and unresolved checks, plus omission counters — [workspace/task.ts](../../packages/teapilot/src/workspace/task.ts#L443-L484).
- Recording a changed file increments source epoch and sets check state to `not-run-after-edit`; checks record command/status/epoch, and execution state reports unresolved failed checks — [workspace/task.ts](../../packages/teapilot/src/workspace/task.ts#L407-L449).
- The task tool expressly says bookkeeping is optional and never replaces execution/verification; done/claims are declarations — [agents/task.ts](../../packages/teapilot/src/agents/task.ts#L5-L11).
- Tests cover persistence of source freshness, changed files and unresolved checks across reload — [tests/context-retention.test.ts](../../packages/teapilot/tests/context-retention.test.ts#L105-L109).

### Inferences
- Blocking is available as a manually/model-authored status and host failure state, rather than a dependency solver. A model can represent a blocked reason only indirectly in goal/claim/other context, not in a dedicated structured field on a step.
- Best reading is “evidence-supported progress tracking,” not a formal workflow engine or proof-carrying task graph.

### Gaps
- Whether `report` or finalization code gates success on execution checks, and which tests assert that behavior, remains to be checked in `run.ts` and adjacent report/recovery code.

## Strengths, drawbacks, counterarguments, and unresolved questions

### Takeaway
The design has meaningful hard guarantees around durable bounded state, interrupted tool calls, ownership, revision conflicts, evidence integrity/freshness and context budgeting. Its principal limitation is semantic: task decomposition, record maintenance, dependency ordering and assertions of completion remain model/user-driven.

### Cited Findings
- Strength: schema constraints, atomic writes, scope binding and safe archive paths provide deterministic persistence safeguards — [workspace/task.ts](../../packages/teapilot/src/workspace/task.ts#L91-L118), [workspace/task.ts](../../packages/teapilot/src/workspace/task.ts#L162-L200).
- Strength: receipts capture tool calls with pending/succeeded/failed/uncertain status and arguments hash; abandoned pending calls become uncertain, avoiding blind replay — [workspace/task.ts](../../packages/teapilot/src/workspace/task.ts#L284-L341), [workspace/task.ts](../../packages/teapilot/src/workspace/task.ts#L112-L116).
- Strength: actor checks restrict visibility/update ownership; evidence references must resolve to accessible artifacts or settled receipts — [workspace/task.ts](../../packages/teapilot/src/workspace/task.ts#L278-L282), [workspace/task.ts](../../packages/teapilot/src/workspace/task.ts#L364-L398).
- Counterargument: bounded projections intentionally omit records and mark omission counts; catalog paging and artifact retrieval provide recovery paths rather than forcing huge prompts — [workspace/task.ts](../../packages/teapilot/src/workspace/task.ts#L461-L484), [workspace/task.ts](../../packages/teapilot/src/workspace/task.ts#L499-L550).
- Drawback: no dependency graph or host-side satisfaction test appears in step schema/update; model can set status `done` — [workspace/task.ts](../../packages/teapilot/src/workspace/task.ts#L17-L18), [agents/task.ts](../../packages/teapilot/src/agents/task.ts#L20-L22).
- Test suites include task/compaction/context-retention coverage; worktree status shows those files and task implementation have uncommitted modifications, so they are current-tree tests rather than clean baseline — [tests/compaction.test.ts](../../packages/teapilot/tests/compaction.test.ts#L89-L120), [tests/context-retention.test.ts](../../packages/teapilot/tests/context-retention.test.ts#L105-L109); `git status --short` observed modified `workspace/task.ts`, `agents/run.ts`, `agents/planning.ts` and related files.

### Inferences
- The user example (implement Goomba and Piranha Plant in a Mario level port) could be broken into independent feature steps by the model, but the core ledger itself cannot enforce “Goomba precedes X” or ensure both are tested unless that structure is written and checked.
- The ledger is substantially stronger than ephemeral prompting, but weaker than a deterministic issue tracker/workflow DAG: durability and traceability are host-owned; completeness and semantic correctness are not.

### Gaps
- Inspect `run.ts` report/final response logic and all relevant `task.test.ts`/`planning.test.ts` assertions before definitive claims about success gating.
- Confirm what is committed versus user-modified with `git diff`/HEAD comparison. Avoid overwriting user changes; no files were changed during this research.
