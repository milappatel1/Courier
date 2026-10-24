#!/usr/bin/env python3
"""Where a macOS `sample` profile's busy time went (research/PERF.md): samples per function, inclusive, over every
thread, leaving out time spent waiting (kernel waits, counted from the bottom of each stack up).

    python3 -I research/tools/sample-top.py <file.sample.txt> [how many] [substring a function must contain]

Rust's v0 symbols are shortened to their path (`_RNvMs0_NtCs…_11courier_lib6engineNtB5_6Engine4list` reads
`courier_lib::engine::Engine::list`)."""
import re
import sys
from collections import Counter

WAITS = {"__psynch_cvwait", "mach_msg2_trap", "__workq_kernreturn", "semaphore_wait_trap", "kevent", "__semwait_signal", "__select", "__ulock_wait", "__psynch_mutexwait"}
NODE = re.compile(r"^([\s+!:|]*)(\d+) (.+?)  \(in ([^)]+)\)")


def short(sym: str) -> str:
    """The identifiers of a Rust v0 symbol's path, read by their length prefixes once crate hashes, back references
    and disambiguators (which also hold digits) are taken out."""
    if not sym.startswith("_R"):
        return sym
    rest = re.sub(r"B[0-9A-Za-z]*_", "", re.sub(r"Cs[0-9A-Za-z]+_", "C", sym[2:]))
    words, i = [], 0
    while True:
        m = re.compile(r"\d+").search(rest, i)
        if not m:
            break
        n, start = int(m.group()), m.end()
        if rest[start : start + 1] == "_" and n:
            start += 1
        word = rest[start : start + n]
        i = start + n if n else m.end()
        if n > 1 and re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", word):
            words.append(word)
    return "::".join(words) or sym


def main() -> None:
    path = sys.argv[1]
    top = int(sys.argv[2]) if len(sys.argv) > 2 else 40
    keep = sys.argv[3] if len(sys.argv) > 3 else ""
    nodes = []  # [depth, count, name, parent index]
    stack: list[int] = []
    for line in open(path, encoding="utf-8", errors="replace"):
        if line.startswith("Total number in stack") or line.startswith("Sort by top of stack"):
            break
        if re.match(r"^\s+\d+ Thread_", line):
            stack = []
            continue
        m = NODE.match(line)
        if not m:
            continue
        depth = len(m.group(1))
        while stack and nodes[stack[-1]][0] >= depth:
            stack.pop()
        nodes.append([depth, int(m.group(2)), f"{short(m.group(3))} ({m.group(4)})", stack[-1] if stack else -1])
        stack.append(len(nodes) - 1)
    waiting = [0] * len(nodes)
    for i in range(len(nodes) - 1, -1, -1):
        depth, count, name, parent = nodes[i]
        if name.split(" (")[0] in WAITS:
            waiting[i] = count
        if parent >= 0:
            waiting[parent] += waiting[i]
    busy = Counter()
    total = 0
    for (depth, count, name, parent), w in zip(nodes, waiting):
        b = max(0, count - w)
        if parent < 0:
            total += b
        if b and (not keep or keep in name):
            busy[name] += b
    print(f"busy samples, all threads: {total}")
    for name, n in busy.most_common(top):
        print(f"{n:8d}  {name}")


if __name__ == "__main__":
    main()
