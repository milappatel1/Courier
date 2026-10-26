# Improvements

Ideas for doing better next time: in this project, in the prompt, in the workflow or its skills. Not failures
(those go in MISTAKES.md). When one is done, delete it here and note where it landed.

| Date | Improvement | Where it should land (project / prompt template / skill / global) |
| --- | --- | --- |
| 2026-10-25 | Split a parity round into rounds that each fit one usage window; 1.1.0 (8 phases) ran into the limit twice | prompt template |
| 2026-10-25 | Visual diff tooling for goldens (parity row L-06) so look parity is measured, not eyeballed | project |
| 2026-10-25 | Run heavy jobs (fuzzer, perf) in a slot of their own, never beside e2e | workflow |
- Measure All Mail and the Inbox as separate perf numbers (label.firstRowsMs mixes them), so the slow view shows on its own. (2026-10-25)
- Check at the start of a round that /claude-security can run (it needs the Workflow tool, the 'Dynamic workflows' setting); on 2026-10-25 it couldn't, and a security-auditor agent stood in. (2026-10-25)
