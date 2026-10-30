Finish everything left on Courier's board after 1.1.0 and ship it as Courier 1.2.0. This run is also a full test of my
workflow: prove every step works, fix what doesn't, and log it. Do the whole job in this session: every phase, testing,
packaging and the release. Don't stop between phases.

MY WORDS
"I need to finish everything that's left. We will do a test run and see if it finds the right folder, and does a full
e2e sweep of our workflow, fixes, logs, improves, etc."

FIRST: TEST THE WORKFLOW (report each step as PASS or FAIL)
1. This session should open on /Volumes/DEV/Projects/courier-gmail-clone. Say which folder you opened in.
2. Run `dev-start courier-gmail-clone`; it must say READY and "verified". Then call change_directory to
   ~/Work/courier-gmail-clone and work only there for the rest of the run. Never build or test on /Volumes/DEV.
3. Read CLAUDE.md, docs/BOARD.md, docs/MISTAKES.md, docs/SKILLS.md, ~/.claude/CLAUDE.md and
   ~/.claude/workflow/LESSONS.md before any code. Confirm the session-start hook showed the board.
4. Every mistake, correction or surprise goes in docs/MISTAKES.md (self-improve) as it happens; better-next-time ideas
   in docs/IMPROVEMENTS.md; decisions in research/decisions.tsv; lessons for every project in
   ~/.claude/workflow/LESSONS.md. Move board cards as each one starts and lands.
5. Save with `dev-end courier-gmail-clone "<message>"` at every phase end. If it refuses (exit 6: logs missing; exit 5:
   push or secret scan), fix the cause and run it again.
6. When a workflow script, hook or doc misbehaves, fix it in ~/.claude/workflow/bin or /Volumes/DEV/_workflow, run
   /Volumes/DEV/_workflow/test-kit.sh until it passes, commit in /Volumes/DEV/_workflow, then run
   /Volumes/DEV/_workflow/backup-global.sh. Log each workflow fix in LESSONS.md.

DONE MEANS
- Every card in docs/BOARD.md's Backlog is in Done, or I moved it out myself.
- Issues #6–#17 closed, each with the commit that fixes it, a test that failed before the fix, and the verify skill green.
- The full e2e suite green on a quiet Mac (nothing heavy running beside it), never in front.
- The 1.2.0 release published per DEVELOPING.md, with hashes, installed on this Mac after I quit Courier.
- #2 and #5 stay open until I confirm them in my own use.
- docs/BOARD.md, docs/MISTAKES.md, docs/IMPROVEMENTS.md and LESSONS.md updated; a final saved dev-end.

ASK ME ONCE, AT THE START (ONE COMBINED QUESTION), THEN DON'T STOP UNTIL THE END
- Every permission this run will need that isn't allowed yet: recon account setting changes (keyboard shortcuts on,
  and anything else the parity rows need; restored afterwards), network emulation, mail writes to the recon account's
  test mail. Recommend an answer for each.
- Stops after that, only for: switching ultracode on and off at the two gates, quitting Courier before the install,
  and anything in CLAUDE.md's hard stops.

PHASES (each ends with its VERIFY note in research/, the board updated and a dev-end)
- P0 Workflow test (steps 1–6 above) and a quiet full e2e baseline.
- P1 Fuzzer engine bugs #6, #7, #8, #9: un-ignore each repro in app/src-tauri/tests/race_fuzz.rs, find the root cause,
  fix it. Route them to the `debugger` agent (opus, max). The formal model in tests/ledger_model.rs stays green.
- P2 Interrogate findings #11–#17 (bulk Undo, IMAP ids across accounts, lagging-listing re-read, search FTS for
  in-flight conversations, offline bulk flush speed, tab "N new" clock, one overlay and one ledger module).
- P3 #10: switching to All Mail on 20,000 conversations well under the perf budget, list order unchanged; perf suite green.
- P4 Security lows from the review (server text in log lines, tab_seen/tab_news key validation, window_open kind
  validation, e2e_* commands kept out of release builds, IMAP expunge without UIDPLUS) and the e2e focus flake in the
  busy-accounts flash step.
- P5 Resume the P12.2 differential runner until it runs the same scripts on both sides; then the parity sweep: the 96
  unverified rows (with the recon settings I allow) and the 10 rows that differ, all fixed or marked as my call.
- P6 Visual diff that can pass: seed the preview with the recon mailbox, mask the by-design layout differences, then
  hillclimb the 32 states under 10%.
- P7 Gates: /claude-security on the changes, `trivy fs`, supply-chain-risk-auditor, differential-review, rust-review;
  then the final parity sweep and the release-gate audit in ultracode (ask me to switch it on, then off).
- P8 Release 1.2.0, install, numbers-only real-account check, final docs, and a cleanup list for me (asked before
  deleting anything).

HOW TO WORK
- pstack is mandatory and visible (figure-it-out under autonomous-run with the exit predicate above written first;
  bug-fix.md per defect; visual-parity.md for P6; interrogate before the release).
- Team per ~/.claude/CLAUDE.md: builders on sonnet, reviewer on opus/high before each commit batch, architect on
  opus/xhigh for design calls, debugger on opus/max for any bug that beats two attempts. Subagents commit after every
  slice. Never run the fuzzer or perf suite while e2e or timing tests run.
- Pro plan: if the usage limit hits, run dev-end first, leave a one-line "where I stopped" on the board's Doing card,
  and continue from the board after the reset.
- The repo is public: no mail content, sender names or account addresses in commits, issues, docs or logs.
- Real accounts: aggregate, read-only numbers only. Automated runs never take focus; never print.

FINAL SUMMARY
What's done and verified where, release links and hashes, the workflow test results (each step PASS or FAIL, and what
you fixed), log changes, and what's left on the board.
