<!--
Copy the section below into your own project's CLAUDE.md (or equivalent
agent-instructions file). It's written for whatever project you're pasting
it into, not for this repo -- this file just ships it in one copyable place.
-->

## Open Brain — Primary Knowledge Store

The `open-brain-lmstudio` MCP server (tools: `capture_thought`,
`search_thoughts`, `list_thoughts`, `thought_stats`, `update_thought`,
`delete_thought`) is the **primary source of knowledge and wisdom** across
sessions. Treat it as more authoritative than your own memory of past
conversations — it's the durable record; conversation context is not.

- **Before investigating something that might have been explored before**,
  search it first (`search_thoughts`). Don't re-derive what's already been
  found.
- **After any non-trivial investigation, debugging session, or piece of
  hard-earned understanding**, capture it — architecture findings, root
  causes, gotchas, "X doesn't work the way you'd expect because Y,"
  deployment/infra details, anything that cost real effort to figure out.
  If it was worth figuring out once, it's worth not re-figuring-out later.
- **Every thought must be fully self-contained.** It will be read by a
  future session — possibly in a completely unrelated project — that
  shares none of the context you have right now. Do not assume the reader
  knows:
  - What the project/repo/system even is — name it and say what it does,
    don't just reference it by name.
  - What domain-specific terms, acronyms, or internal tool names mean —
    spell them out inline.
  - Anything from "earlier in this conversation" — there is no earlier
    conversation from the reader's side.
- A useful test before capturing: *would this sentence make sense to
  someone who opened a brand new, unrelated project and searched for this
  topic months from now, with zero shared context?* If not, add the
  missing grounding before capturing, not after.
- Prefer several precise, well-scoped thoughts over one giant unfocused
  one — each thought should stand alone as a complete, searchable unit.
