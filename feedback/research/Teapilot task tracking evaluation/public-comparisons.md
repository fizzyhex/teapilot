# Public comparisons for teapilot task tracking

## How do representative OSS approaches differ in semantics and fit?

### Takeaway
These tools solve distinct problems: OpenCode-style todos provide lightweight, mutable, session-local progress visibility; Beads models durable work items and dependency readiness; LangGraph persists execution state so a workflow can resume. None by itself establishes that a code change is correct. They are comparisons, not drop-in recommendations for teapilot.

### Cited Findings
- OpenCode documents `todowrite` as managing task lists during a coding session, and exposes retrieval via a session-specific `/session/:sessionID/todo` endpoint. Its docs describe LLM-authored structured todos, not automatic conversion of chat checklists. [OpenCode tools docs](https://opencode.ai/docs/tools/); [OpenCode API spec](https://github.com/anomalyco/opencode/blob/dev/specs/v2/api.html)
- OpenCode's prompt encourages using TodoWrite frequently, breaking complex operations into smaller tasks, and marking items completed as soon as done. This is a behavioral convention; it does not amount to dependency enforcement or independent correctness verification. [OpenCode agent prompt source](https://github.com/anomalyco/opencode/blob/dev/packages/opencode/src/session/prompt/anthropic.txt)
- Beads defines ready work as issues with no open blocking dependencies; only `blocks` dependencies affect readiness. It supports dependency types including `blocks`, `related`, `parent-child`, and `discovered-from`. [Beads dependency concepts](https://github.com/gastownhall/beads/blob/main/docs/core-concepts/dependencies.md); [Beads integration docs](https://github.com/gastownhall/beads/blob/main/docs/integrations/claude-code-plugin.md)
- Beads uses Dolt as its canonical database, with automatic Dolt history commits and push/pull for sync. Its JSONL export is explicitly not canonical storage, cross-machine sync, or full database backup; backups use Beads' backup commands. [Beads core concepts](https://github.com/gastownhall/beads/blob/main/docs/core-concepts/index.md); [Beads configuration](https://github.com/gastownhall/beads/blob/main/docs/reference/configuration.md); [Beads FAQ](https://github.com/gastownhall/beads/blob/main/docs/reference/faq.md)
- LangGraph persistence requires compiling with a checkpointer and supplying a `thread_id`; interrupts save state and suspend until resumed with a `Command(resume=...)`. Its docs advise persistent database-backed checkpointers in production. [LangGraph persistence](https://docs.langchain.com/oss/python/langgraph/persistence); [LangGraph interrupts](https://docs.langchain.com/oss/python/langgraph/interrupts)

### Inferences
- For the example “implement Goomba and Piranha Plant into existing Super Mario World level-1 discord.play port `tea-mario`,” an OpenCode-like list could show near-term stages: inspect the port, implement Goomba, implement Piranha Plant, run checks, exercise gameplay. This is useful visibility, but the list can be revised freely and doesn't guarantee prerequisites or persistence beyond its session model.
- If these are separately tracked feature requests or work spans sessions/contributors, Beads-like issues could encode a parent feature and blocking edges (e.g. inspect engine/assets before implementation; both enemy implementations before integrated playtest). That graph brings coordination and data-lifecycle overhead that is likely unnecessary for a small one-turn change.
- LangGraph is a workflow/runtime design analogy, not a task-list product: durable checkpoints help if execution must resume after process interruption or pause for a human approval. Adopting it solely to represent a short coding plan would conflate orchestration state with user-visible task tracking.
- A compact task list is best viewed as a plan/progress projection; an issue graph as durable project coordination; a checkpoint as resumable execution state. Each needs separate evidence that “done” is warranted.

### Gaps
- Beads is an actively evolving project; these claims are scoped to the cited current project documentation/source, not a fixed release or a guarantee of compatibility with teapilot.
- The comparisons do not establish adoption, performance, or failure rates in coding agents, and do not assess teapilot's internal implementation.

## What should be distinguished from task tracking: runtime recovery, verification, and conversational memory?

### Takeaway
Task status records intent/progress; runtime checkpoints preserve enough state to continue execution; verification supplies evidence for completion; conversational memory preserves context across turns. Treating any one as a substitute for the others creates false confidence.

### Cited Findings
- LangGraph states that persistence checkpoints graph state by thread and supports resuming; interrupts pause at a point and return control for a later resume. This preserves workflow state, not proof that an external side effect or code result is correct. [LangGraph persistence](https://docs.langchain.com/oss/python/langgraph/persistence); [LangGraph interrupts](https://docs.langchain.com/oss/python/langgraph/interrupts)
- LangGraph interrupt examples use a checkpointer and `thread_id`, then resume with a `Command`; its docs describe a persistent checkpointer as appropriate for production. [LangGraph interrupt guide](https://docs.langchain.com/oss/python/langgraph/interrupts)
- OpenCode's todo endpoint associates todos with a session, and the TodoWrite tool persists its structured todo payload. This is evidence of task-list persistence in its own session model, not a general memory system or runtime replay guarantee. [OpenCode API spec](https://github.com/anomalyco/opencode/blob/dev/specs/v2/api.html); [OpenCode tool implementation/docs](https://github.com/anomalyco/opencode/blob/dev/packages/web/src/content/docs/tools.mdx)
- Beads' database and dependency relations are durable issue-tracking semantics; its documentation differentiates the issue export from canonical database, sync, and backup. [Beads core concepts](https://github.com/gastownhall/beads/blob/main/docs/core-concepts/index.md); [Beads advanced reference](https://github.com/gastownhall/beads/blob/main/docs/reference/advanced.md)

### Inferences
- For `tea-mario`, a checkable completion condition should include repository-specific automated checks plus a gameplay or Discord-play exercise that demonstrates both enemies behave correctly in level 1. Marking “implement enemy” complete is a claim, not its evidence.
- Suggested evidence categories for reporting: changed files/implementation summary; test/build results; interaction/playtest evidence; known unverified cases. Keep those distinct from checklist state.
- Conversational memory is yet another axis: retaining a concise project/task summary may help a later turn, but does not guarantee issue durability, checkpointed tool execution, or verified correctness. This distinction is conceptual; no public claim about teapilot internals is made here.

### Gaps
- No comparative empirical study was found in the sources consulted that quantifies how these abstractions improve agent task success or how much overhead they add.
- The exact verification procedure depends on `tea-mario`'s available tests, build setup, and Discord play simulation; this research did not inspect that codebase.

## What public advice is relevant, and what are its limits?

### Takeaway
Primary agent-engineering advice should inform evaluation criteria rather than dictate a product: decompose work, make progress legible, and use concrete verification. Evidence gathered here supports those criteria most strongly through tool documentation; primary Anthropic advice was not retrievable in this run, so no precise Anthropic quotations or claims are attributed.

### Cited Findings
- OpenCode's published agent prompt gives concrete operational advice to plan complex tasks with todos, update status frequently, and complete items promptly. This is the project's own prompt convention, not independent evidence of efficacy. [OpenCode source prompt](https://github.com/anomalyco/opencode/blob/dev/packages/opencode/src/session/prompt/anthropic.txt)
- LangGraph's docs make resilience operationally explicit: checkpointing requires an appropriate saver and thread identity; pausing for human input requires an interrupt and later resume. These requirements entail runtime/storage design, rather than a free feature of a todo list. [LangGraph persistence](https://docs.langchain.com/oss/python/langgraph/persistence); [LangGraph interrupts](https://docs.langchain.com/oss/python/langgraph/interrupts)
- Beads makes the operational tradeoff explicit by using a Dolt database and separate push/pull and backup workflows; it is more than a markdown checklist, but entails storage and sync semantics to understand. [Beads FAQ](https://github.com/gastownhall/beads/blob/main/docs/reference/faq.md); [Beads configuration](https://github.com/gastownhall/beads/blob/main/docs/reference/configuration.md)

### Inferences
- A balanced evaluation of teapilot should ask: does task tracking reduce omissions and expose progress without excessive ceremony; does it accurately reflect actual execution; can it persist at the needed boundary; and does “complete” require relevant verification evidence?
- Start with the smallest semantics that meet actual use cases. Use a mutable list for one interaction, issue graph only for durable/dependent multi-issue coordination, and checkpointed workflows only where interruption/recovery or human gates merit the runtime complexity.
- A list's statuses and granularity can become stale; dependency graphs can over-model simple work and require lifecycle discipline; checkpointing adds storage/versioning and side-effect concerns. These are design inferences from the documented models, not measured claims about product performance.

### Gaps
- The requested primary-source Anthropic material (“Building effective agents” and advice on harnesses for long-running agents) was not available through the tools exposed in this research session, so this note intentionally does not paraphrase its recommendations. Verify the current primary pages before citing them in a final report.
- No source here establishes the specific operational or token cost of adopting any approach inside teapilot; implementation-specific inspection belongs to the local researchers.
