# Agentic Capability Research

## Manus-style architecture

Public Manus docs point to a product architecture built around execution, not just chat:

- Browser operation: Manus Cloud Browser can visit sites, click controls, fill forms, extract data, and complete multi-page workflows in a dedicated browser environment. Source: https://manus.im/docs/features/cloud-browser
- Local/desktop execution: Manus Desktop can run terminal commands against local files, tools, and apps, with user approval for commands. Source: https://manus.im/blog/manus-my-computer-desktop
- Wide research: Manus splits large batches into independent agents with separate context windows, then synthesizes their outputs. Source: https://manus.im/docs/features/wide-research
- Skills: Manus uses modular, file-system-based skill instructions and loads deeper resources only when needed. Source: https://manus.im/docs/features/skills
- General agent framing: A 2026 arXiv revision describes Manus as combining LLM planning/reasoning with tool execution for end-to-end outcomes. Source: https://arxiv.org/abs/2505.02024

## What this repo already has

- Browser tools with screenshots, interactive element indexing, and progress detection.
- A planner/executor loop with policy guards, working memory, reflection, and output verification.
- File tools, web search, document reading, PDF export, image search, and constrained JavaScript execution.
- Skill-loading support through prompt attachments and local workflow instructions.

## High-leverage gaps

- Browser completion must be evidence-driven. The agent should not advance just because a generic cart, checkout, or success marker appears.
- Visual state should be tied back to the current objective. For shopping and form tasks, confirmation needs to include the requested item/action, not just a generic page state.
- Programming execution needs safe expansion beyond pure JavaScript only after an OS-level sandbox is available.
- Research scale needs independent worker contexts for large item lists instead of one long sequential context.

## Implemented in this pass

- Cart/bag/checkout completion now extracts requested item terms from the current step objective.
- Generic cart success is rejected when requested item terms are missing from the visible page/action evidence.
- Rejected completion evidence is surfaced back to the model as a corrective marker instead of silently doing nothing.
- Browser completion regression tests now cover wrong-item cart confirmation, exact-item confirmation, empty carts, homepage cart links, and a live add-to-bag flow.
