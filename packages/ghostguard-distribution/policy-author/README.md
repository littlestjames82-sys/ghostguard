# GhostGuard Policy Author — plain English in, tested policy out

Write governance rules in a tiny controlled English, get back a
real GhostGuard `policy.json` **and** a behavior-test file generated
from the same statements — then run those tests against the real
engine to prove the policy does what the English said.

```
never allow spending
always ask before deploying
owner must approve messages to strangers
allow reading
```

## Use
```sh
node author.mjs build examples/rules.en.txt [--out <dir>]  # writes policy.json + behavior-tests.json
node author.mjs verify examples/rules.en.txt               # build + run the generated tests
node run-behavior-tests.mjs <policy.json> <behavior-tests.json>
```

## The one guarantee that matters
Unsupported sentences are a **loud error** (exit 2, line named) —
never silently dropped. A dropped safety rule would fail open; this
tool would rather refuse to compile. Duplicate statements that
compile to the same rule id also error. See `GRAMMAR.md` for the
full (deliberately tiny) grammar and action vocabulary.

## Honest limits
This is not natural-language understanding. It's a controlled
vocabulary: seven statement forms, nine action classes, one special
form (stranger messages). Anything richer — amounts, payload fields,
time windows — still belongs in hand-written GhostGuard policy.
