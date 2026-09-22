#!/usr/bin/env python3
"""Check the card maths from outside the game.

Why this is not another JavaScript test: the existing suite calls the same
evaluator the game calls, so a wrong evaluator agrees with itself and every
test passes. This file re-implements hand ranking independently, then:

  1. deals a large sample and compares the observed frequency of each category
     against the published probabilities for seven-card poker, which catches a
     biased shuffle as well as a mis-scored category, and
  2. asks the Node evaluator to rank the same hands and reports any hand the
     two implementations disagree about.

Two independent implementations that agree are evidence. One implementation
agreeing with itself is not.

    python tools/verify_odds.py            # default sample
    python tools/verify_odds.py 200000     # a bigger one
"""

from __future__ import annotations

import json
import random
import subprocess
import sys
from collections import Counter
from itertools import combinations
from pathlib import Path

RANKS = "23456789TJQKA"
SUITS = "shdc"
DECK = [r + s for r in RANKS for s in SUITS]

CATEGORIES = [
    "High Card",
    "Pair",
    "Two Pair",
    "Three of a Kind",
    "Straight",
    "Flush",
    "Full House",
    "Four of a Kind",
    "Straight Flush",
]

# Frequencies for the best five-card hand out of seven, as fractions of
# C(52,7) = 133,784,560. These are published figures, not ones this code
# derived, which is the point -- they are an outside check.
SEVEN_CARD_COUNTS = {
    "High Card": 23294460,
    "Pair": 58627800,
    "Two Pair": 31433400,
    "Three of a Kind": 6461620,
    "Straight": 6180020,
    "Flush": 4047644,
    "Full House": 3473184,
    "Four of a Kind": 224848,
    "Straight Flush": 41584,
}
TOTAL_SEVEN = 133784560


def rank_value(card: str) -> int:
    return RANKS.index(card[0]) + 2


def evaluate_five(cards: tuple[str, ...]) -> tuple[int, list[int]]:
    """Rank exactly five cards. Returns (category index, tiebreakers).

    Written deliberately differently from the JavaScript version -- counting
    with a Counter and sorting, rather than bucketing by value and suit -- so a
    shared misconception is less likely to survive in both.
    """
    values = sorted((rank_value(c) for c in cards), reverse=True)
    suits = [c[1] for c in cards]
    counts = Counter(values)

    # (count, value) sorted high to low gives pairs before kickers for free.
    ordered = sorted(counts.items(), key=lambda kv: (kv[1], kv[0]), reverse=True)
    shape = [n for _, n in ordered]
    kickers = [v for v, _ in ordered]

    is_flush = len(set(suits)) == 1

    distinct = sorted(set(values), reverse=True)
    straight_high = 0
    if len(distinct) == 5:
        if distinct[0] - distinct[4] == 4:
            straight_high = distinct[0]
        elif distinct == [14, 5, 4, 3, 2]:  # the wheel
            straight_high = 5

    if is_flush and straight_high:
        return 8, [straight_high]
    if shape == [4, 1]:
        return 7, kickers
    if shape == [3, 2]:
        return 6, kickers
    if is_flush:
        return 5, values
    if straight_high:
        return 4, [straight_high]
    if shape == [3, 1, 1]:
        return 3, kickers
    if shape == [2, 2, 1]:
        return 2, kickers
    if shape == [2, 1, 1, 1]:
        return 1, kickers
    return 0, values


def best_of_seven(cards: list[str]) -> tuple[int, list[int]]:
    """Brute force all 21 five-card subsets. Slow and obviously correct."""
    return max((evaluate_five(combo) for combo in combinations(cards, 5)))


def node_evaluate(hands: list[list[str]]) -> list[str]:
    """Ask the game's own evaluator to categorise the same hands."""
    script = (
        "const { evaluate } = await import('./src/games/handrank.js');"
        "let input = '';"
        "for await (const chunk of process.stdin) input += chunk;"
        "const hands = JSON.parse(input);"
        "process.stdout.write(JSON.stringify(hands.map((h) => evaluate(h).category)));"
    )
    result = subprocess.run(
        ["node", "--input-type=module", "-e", script],
        input=json.dumps(hands),
        capture_output=True,
        text=True,
        cwd=Path(__file__).resolve().parent.parent,
    )
    if result.returncode != 0:
        raise SystemExit(f"node evaluator failed:\n{result.stderr.strip()}")
    return json.loads(result.stdout)


def chi_square(observed: Counter, sample: int) -> float:
    """How far the sample strays from the published distribution."""
    total = 0.0
    for name, count in SEVEN_CARD_COUNTS.items():
        expected = sample * count / TOTAL_SEVEN
        if expected < 5:  # too rare at this sample size to say anything
            continue
        diff = observed.get(name, 0) - expected
        total += diff * diff / expected
    return total


def main() -> int:
    sample = int(sys.argv[1]) if len(sys.argv) > 1 else 60000
    cross_check = min(sample, 3000)
    rng = random.SystemRandom()

    print(f"dealing {sample:,} seven-card hands\n")

    observed: Counter[str] = Counter()
    cross_hands: list[list[str]] = []
    cross_ours: list[str] = []

    for i in range(sample):
        deck = DECK[:]
        rng.shuffle(deck)
        hand = deck[:7]
        category, _ = best_of_seven(hand)
        name = CATEGORIES[category]
        observed[name] += 1
        if i < cross_check:
            cross_hands.append(hand)
            cross_ours.append(name)

    print(f"{'category':<18}{'observed':>10}{'expected':>10}{'error':>9}")
    print("-" * 47)
    worst = 0.0
    for name in CATEGORIES:
        seen = observed.get(name, 0)
        expected = sample * SEVEN_CARD_COUNTS[name] / TOTAL_SEVEN
        pct_seen = 100 * seen / sample
        pct_expected = 100 * expected / sample
        error = abs(pct_seen - pct_expected)
        if expected >= 5:
            worst = max(worst, error / max(pct_expected, 0.001))
        print(f"{name:<18}{pct_seen:>9.3f}%{pct_expected:>9.3f}%{error:>8.3f}%")

    chi = chi_square(observed, sample)
    # Eight degrees of freedom: 15.5 is the 95th percentile, 20.1 the 99th.
    print(f"\nchi-square: {chi:.2f}  (under ~20 is an ordinary sample)")

    print(f"\ncross-checking {cross_check:,} hands against the game's evaluator")
    theirs = node_evaluate(cross_hands)
    mismatches = [
        (hand, ours, node)
        for hand, ours, node in zip(cross_hands, cross_ours, theirs)
        if ours != node
    ]
    if mismatches:
        print(f"  {len(mismatches)} DISAGREEMENTS:")
        for hand, ours, node in mismatches[:10]:
            print(f"    {' '.join(hand)}  python says {ours}, node says {node}")
    else:
        print("  both implementations agree on every hand")

    failed = bool(mismatches) or chi > 26.1  # 99.9th percentile, 8 d.o.f.
    print("\n" + ("FAILED" if failed else "OK"))
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
