#!/bin/bash
# Run every *.test.mts suite; report per-suite exit code (spec-008 T4 gate).
cd "$(dirname "$0")/.." || exit 1
fail=0
for t in tests/*.test.mts; do
  out=$(timeout 300 npx tsx "$t" 2>&1)
  code=$?
  tail_line=$(echo "$out" | grep -E "passed, [0-9]+ failed|TOTAL:" | tail -1)
  echo "$t -> exit $code ($tail_line)"
  if [ $code -ne 0 ]; then fail=1; echo "$out" | tail -30; fi
done
exit $fail
