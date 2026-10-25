# Skills

## Global skills this project leans on
| Skill | Used for, in which phase |
| --- | --- |
| pstack (mandatory) | figure-it-out under autonomous-run for the round; bug-fix per defect; visual-parity for the look; create/maintain-verification-skill; show-me-your-work (research/decisions.tsv); interrogate before the release |
| tdd, diagnosing-bugs, debugger agent | test-first fixes; any bug that beats two attempts goes to debugger |
| unlazy | acceptance gates for each round |
| /security-review, reviewer agent | every commit batch |
| claude-security, trivy | release gate |
| no-ai-slop | release notes, README, issue text |

## Installed in this project (`.claude/skills/`)
| Skill | Source | Why | When to use |
| --- | --- | --- | --- |
| verify-courier | written for this repo (in git) | drives Courier like a user, feature map | after every slice and phase |
| verify-ledger | written for this repo (in git) | proves the change ledger's invariants | after any change to sync, changes or the cache |
| reverse-engineer-anything (REA) | library copy, kept out of git | recon and parity checks against the web client | parity rounds |
| rust-review | Trail of Bits, library copy, kept out of git | Rust security review (unsafe, panics, concurrency) | when Rust code changes, and at the release gate |
| supply-chain-risk-auditor, differential-review | Trail of Bits, library copies, kept out of git | dependency risk and security review of the release diff | release gate |
