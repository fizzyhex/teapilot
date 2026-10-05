# Progress-aware long-running agent supervision (research notes)

Research snapshot: 2026-10-04. Sources below were accessible on this date. Evidence distinguishes vendor statements, OSS documentation/source, and proposed Teapilot adaptations; no implementation changes made.

## 1. Keep agents productive without arbitrary cutoffs

### Takeaway
Replace “N tools then kill” as the primary policy with task milestones, observable verification, and resumable safe boundaries. Preserve hard ceilings for safety, wall time, and spend, but treat them as last-resort resource limits—not evidence that work is unproductive.

### Cited Findings
- Anthropic (2026-03-23) recommends long-running work only where goals are well-scoped and success criteria clear; it uses a plan, persistent `CHANGELOG.md` (status, completed work, failed approaches, accuracy, limitations), and an external test oracle/reference implementation. Failed approaches are explicitly retained to prevent repeated dead ends. [Long-running Claude for scientific computing](https://www.anthropic.com/research/long-running-Claude)
- Anthropic describes Git commits after each meaningful unit as recoverable progress if a compute allocation ends; its example runs within an HPC scheduler’s 48-hour allocation, demonstrating that infrastructure ceilings may still exist but should not be confused with task completion. [Same source](https://www.anthropic.com/research/long-running-Claude)
- OpenAI (2026-02-11) reports agents working >6 hours and argues the main leverage comes from environments, feedback loops, explicit plans, verification and recovery. Execution plans include progress and decision logs; milestones validate, repair failures, then proceed. This is a company account, not an independent controlled evaluation. [Harness engineering](https://openai.com/index/harness-engineering/)
- OpenAI (2026-02-23) describes a ~25-hour experimental Codex run, not a production promise. Its recipe is milestone plans with acceptance criteria/validation, stop-and-fix on failed validation, durable spec/status/decision notes, and verification at each milestone. [Run long horizon tasks with Codex](https://developers.openai.com/blog/run-long-horizon-tasks-with-codex)
- LangGraph’s official docs describe checkpoints as enabling fault recovery, state inspection, replay/forking, and resuming after an interrupt; a production deployment should use persistent rather than in-memory checkpointing. [Checkpointers](https://docs.langchain.com/oss/python/langgraph/checkpointers) · [Interrupts](https://docs.langchain.com/oss/python/langgraph/interrupts)
- OpenHands SDK docs expose `pause()`/resume with `run()` and a goal stop endpoint that records an interrupted/resumable status. This is explicit pause/resume control, not evidence of automatic stagnation detection. [Pause/resume guide](https://github.com/openhands/docs/blob/main/sdk/guides/convo-pause-and-resume.mdx) · [Goal stop API](https://github.com/openhands/docs/blob/main/sdk/guides/agent-server/conversation-goals.mdx)

### Inferences
- Model supervision as a soft lease: at thresholds (elapsed time, spend, context pressure), warn/report and continue; at a safe boundary, checkpoint and offer continue / redirect / pause. Reserve hard stops for configured spend ceilings, safety/policy violations, irrecoverable runtime failures, or explicit user stop. Label these separately in telemetry.
- Use dual checkpoints: durable transcript/attempt state plus human-readable task state (goal, acceptance criteria, verified milestones, current hypothesis/next action, failed approaches, unresolved risks, exact validation results). Rehydrate only relevant notes/evidence after context compaction.
- A warning can be triggered before a limit is reached, but should not imply agent failure. Make the remaining budget visible and allow explicit extension or “continue until next checkpoint”; cap extension with user-configurable cost/runtime controls.
- Prefer task-level milestones for task quality and worker-level health for detecting a single stuck worker. Aggregate worker signals into task status; do not let one worker’s repeated calls automatically terminate useful parallel work.

### Gaps
- Public sources do not establish a generally reliable numerical threshold for stagnation, or a universally safe lease duration. Choose thresholds empirically per workload and expose uncertainty.

## 2. Detect stagnation with evidence, not raw tool counts

### Takeaway
Track whether the agent is learning/changing/verifying, not merely how many tools it calls. Treat stagnation heuristics as prompts to inspect or ask—not automatic proof of a loop.

### Cited Findings
- Anthropic’s scientific example uses measurable agreement with a reference implementation and test coverage as progress signals; it also candidly reports a period where tests covered only one fiducial parameter point, reducing the bug-catching surface, and a clunky trajectory that still made progress. [Long-running Claude](https://www.anthropic.com/research/long-running-Claude)
- OpenAI’s Codex harness exposes logs, metrics, traces, and functional UI evidence so agents can test outcome-based constraints (e.g. latency or trace spans) rather than relying on self-reported progress. [Harness engineering](https://openai.com/index/harness-engineering/)
- OpenCode’s current agent docs expose configurable `steps` as an iteration limit for cost management; configuration docs support automatic context compaction and pruning. These are explicit resource/context controls, not documented semantic stagnation detection. [Agents](https://github.com/anomalyco/opencode/blob/dev/packages/web/src/content/docs/agents.mdx) · [Config](https://github.com/anomalyco/opencode/blob/dev/packages/web/src/content/docs/config.mdx)
- OpenCode’s current source/docs contain a session runner that accepts “steer” input at provider-turn boundaries, while “queue” input waits until otherwise idle; source comments describe durable input admission and boundary promotion. This is a useful OSS pattern for mid-flight steering; the cited runner notes other pieces (including cancellation settlement) as unfinished in that source snapshot. [Runner source](https://github.com/anomalyco/opencode/blob/dev/packages/core/src/session/runner/llm.ts) · [Input source](https://github.com/anomalyco/opencode/blob/dev/packages/core/src/session/input.ts)

### Inferences
- Build a structured “progress evidence” tuple per checkpoint: acceptance criteria changed/passed, relevant artifact or diff changed, new diagnostic information, test/benchmark result, plan/decision updated, and repeated identical failures/actions. Compare within a task phase; repeated read-only exploration can be valid early, while repeated failed mutation/test cycles later are more concerning.
- Use a staged heuristic: emit a quiet internal observation first; if signals persist across several meaningful checkpoints, surface a compact warning (“same failing test and no new evidence since …”) and ask whether to continue, redirect, or pause. A model-generated summary should cite concrete tool/test events, not assert “stuck” unaided.
- False positives: repetitive calls can be deliberate retries, polling, slow builds, broad discovery, or a necessary convergence loop. False negatives: cosmetic diffs or changing commands can mask no progress. Therefore require multiple independent signals, phase-aware baselines, and user override; never equate call count alone with non-progress.
- Scope counters at worker/run level to identify loops; measure task progress at parent level against shared acceptance criteria. Workers may be stuck while sibling work remains productive, or make little local progress while enabling a task milestone.

### Gaps
- No reviewed source provides validated precision/recall of stagnation detectors or a principled “same action” equivalence algorithm. Evaluate locally using labeled histories before any automatic intervention.

## 3. Make progress visible and context bounded

### Takeaway
Separate durable event observability from occasional human-facing summaries. Compact context by preserving the decision-relevant state and evidence; don’t use compaction as a substitute for progress tracking.

### Cited Findings
- OpenAI’s Codex App Server article specifies a bidirectional event stream: lifecycle events, incremental progress, artifacts/diffs, approvals, durable thread history, and reconnect/catch-up; server-side state continues if a browser tab disappears. [Unlocking the Codex harness](https://openai.com/index/unlocking-the-codex-harness/) (2026-02-04)
- OpenAI’s harness engineering account describes versioned plans, progress/decision logs, isolated per-worktree observability, and automated knowledge-base freshness checks. [Harness engineering](https://openai.com/index/harness-engineering/)
- OpenAI describes automatic compaction above a threshold in Codex, replacing the prompt with a smaller representative list of items; it highlights preserving the model’s latent understanding via a special compaction item. [Unrolling the Codex agent loop](https://openai.com/index/unrolling-the-codex-agent-loop/) (2026-01-23)
- OpenCode docs define a compaction agent instructed to preserve exact paths/identifiers, keep every requested section, and use terse bullets; its config exposes auto-compaction and tool-output pruning. [Compaction prompt/source](https://github.com/anomalyco/opencode/blob/dev/packages/opencode/src/agent/prompt/compaction.txt) · [Config](https://github.com/anomalyco/opencode/blob/dev/packages/web/src/content/docs/config.mdx)
- LangGraph interrupt semantics suspend at a defined point, persist state via checkpointer, expose a serializable payload, wait for a response, then resume. This is a safe-point control pattern rather than arbitrary mid-tool termination. [Interrupts](https://docs.langchain.com/oss/python/langgraph/interrupts)

### Inferences
- Publish durable structured events (request started, plan/checkpoint, tool start/end, artifact/test result, context compaction, warning, pause/steer/stop, final outcome) with timestamps and attribution. UI can render a replayable status plus live delta; reconnect should not require the agent to regenerate status.
- Avoid model-generated progress chatter every tool call: derive most status from existing events; generate a concise milestone summary only at task milestones, meaningful inactivity/long operation, budget warning, or user request. Coalesce token/tool deltas and keep status updates separate from agent conversation to avoid polluting context and causing extra model calls.
- Context offloading should preserve goal/constraints, plan and current milestone, verified facts with source/event references, decisions and rationale, failed approaches, pending work, and exact commands/results. Store raw logs/tool output outside the prompt and retrieve slices on demand. Compact only at context pressure or boundary; verify continuation against durable artifacts after compaction.
- Distinguish a *soft lease* (warning/checkpoint opportunity and resumable pause) from *hard safety/cost ceiling* (enforced stop). Explain which fired and retain restart state. Cancellation should be cooperative at safe points; enforce immediate cancellation for dangerous operations via tool/runtime boundary.

### Gaps
- Product-specific acceptable notification cadence and token overhead are not established by these sources; instrument user interruption/ignore rates and event volume.

## 4. Evaluate supervision quality

### Takeaway
Test the supervisor on realistic long traces and outcomes, measuring utility as well as safety; passing tool-limit tests alone rewards precisely the arbitrary stopping behavior to avoid.

### Cited Findings
- OpenAI describes internal eval harnesses, CI checks, reviews and feedback loops as part of the agent environment, but does not publish validated measures for early warnings or stagnation detection. [Harness engineering](https://openai.com/index/harness-engineering/)
- Anthropic’s worked example charts numerical accuracy at milestones and reports actual limitations/missing test coverage, illustrating both objective progress measurement and the risk that a metric/test slice misses failures elsewhere. [Long-running Claude](https://www.anthropic.com/research/long-running-Claude)
- OpenAI’s long-horizon Codex account reports milestone-wise tests/lint/typecheck and caveats the demonstration as experimental and not production-ready. [Run long horizon tasks with Codex](https://developers.openai.com/blog/run-long-horizon-tasks-with-codex)

### Inferences
- Offline replay suite should include productive long tasks, slow/polling tools, genuine repeated failures, cyclic edits, independently progressing workers, compaction, user steer/queue, restart, external timeout, and cost exhaustion. Score task completion/quality, unnecessary interruptions, missed stagnation, cost, recovery correctness, and time-to-human-action.
- Run warnings in shadow mode first; compare heuristic flags with expert labels, then tune by task class. Measure warnings accepted/ignored/redirected, useful work after warning, false-positive burden, and resume success. Report results stratified by capability and worker vs parent task.
- Preserve hard ceilings and security permissions independently of progress scoring. A quality heuristic must never relax sandbox, approval, budget, or destructive-action safeguards.

### Gaps
- Public sources reviewed do not publish robust benchmark data for pause-warning policies, notification fatigue, or checkpoint fidelity across agent frameworks.
