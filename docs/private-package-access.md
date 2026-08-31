# Why nothing consumes these contracts: package access, not code

**Recorded 2026-08-31 by projects-54.** Found while landing two duplication
fixes that George ruled as "fix consumption first". Both conversions are correct
and locally verified. **Neither can install the package it imports.**

## The measurement that started it

`npm run check:unconsumed` on `main`: **163 exports referenced nowhere** outside
their defining module, **159 exercised only by their own tests**, and exactly
**one** downstream consumer — `vinci-platform`, via two packages.

The obvious reading is that the estate is young and consumers have not caught
up. That reading is incomplete.

## What actually blocks a consumer

Both attempts to convert a duplicated type into a real import failed in CI, for
the same underlying reason and with two different symptoms.

**`vinci-code` PR #247** — importing `@getsimpledirect/vinci-model-classes`:

```
npm error code E403
npm error 403 Forbidden - GET https://npm.pkg.github.com/@getsimpledirect%2fvinci-model-classes
          Permission permission_denied: read_package
```

That repo's CI already resolves `@getsimpledirect/vinci-contracts` without
trouble. The token is not broken; **package read access is granted per package**,
and this one was never granted to that repo.

**`vinci-platform` PR #84** — importing `@getsimpledirect/vinci-policy`: a
lockfile-sync failure, and locally `npm install --package-lock-only` returns

```
npm error code E401
npm error 401 Unauthorized - GET https://npm.pkg.github.com/@getsimpledirect%2fvinci-policy
          unauthenticated: User cannot be authenticated with the token provided
```

so a correct lockfile cannot be produced from a developer machine either.

## Why this is structural rather than incidental

All thirteen `@getsimpledirect` npm packages are **private**. CI authenticates
with `secrets.GITHUB_TOKEN`, which is scoped to its own repository, so each
consuming repo needs an explicit per-package grant. A repo that already consumes
two packages has exactly two grants — importing a *third* fails, and fails at
`npm ci`, before any code runs.

**The cost is asymmetric and invisible.** Adding an export to this repo is free.
Consuming one from a new repo requires an out-of-band permission change that
nothing in the code, the tests or the CI configuration mentions. The gradient
points at *publishing more* and away from *consuming what exists*, which is
exactly the shape the 163 describes.

So part of the answer to "why does almost nothing import these contracts" is:
**in two of three candidate repos, nothing can.** Not by policy, and not because
the code is unready — by an unstated permission default.

## Resolved 2026-08-31, and the deeper cause was different

Both grants were issued the same day, and both blocked PRs landed:
`vinci-code` #247 and `vinci-platform` #84. So the access finding was real.

**But it was not the whole reason, and the whole reason is worse.** After the
grants cleared, `vinci-chat` still could not consume the Model Role ABI — and
this time the cause was that **the ABI had never been published at all**. The
registry's `0.2.0` carried eight `.d.ts` files where `main` had sixteen:
`endpoint`, `role`, `role-match`, `select`, `independence` and `registry` were
absent from every published artifact. `matchEndpointToRole` was installable by
nobody, whatever their permissions.

That is now fixed too: all twelve packages are published at `0.3.0`, verified by
installing from the registry into an empty directory and calling the matcher.

**The order in which these surfaced is the lesson.** The access problem was
visible — a `403` in CI, with a name and an owner. The publishing problem was
invisible: every check passed, the package installed cleanly, and it simply did
not contain the thing anyone wanted. It was found only by diffing the published
tarball's contents against `main`, which nothing asked anyone to do.

A release gate now closes it. `check:pack` asserts from an *installed* build
that the ABI still **decides** — not merely that it imports — and is
mutation-verified: restricting the `files` list to simulate `0.2.0`'s partial
ship makes it fail with `has no exported member 'matchEndpointToRole'`.

## What would change it

Only George or an org admin can do these; the package-repository API returns 404
to this session, which is itself evidence of where the boundary sits. Items 1 and
3 were done on 2026-08-31; item 2, the default, is still open.

1. **Grant per-package read access** to the repos that should consume them —
   at minimum `vinci-model-classes` to `vinci-code`, and `vinci-policy` to
   `vinci-platform`. That unblocks PRs #247 and #84 as they stand.
2. **Decide the default.** If contracts are meant to be consumed widely, grant
   the scope to consuming repos once rather than package-by-package as each
   import is attempted. The current default makes the first import of every new
   package a support ticket.
3. **A developer token that can resolve the scope**, so lockfiles can be
   produced correctly before CI sees them. Without one, a contributor cannot
   generate a valid `package-lock.json` for any change that adds a private
   dependency.

## What this does not claim

It does not claim the 163 unconsumed exports are all blocked this way. The
triage found the honest reason for most of them: every package here is 5–8 days
old, and 147 are published surface by design. Access is one contributing cause
among several, and the two blocked PRs are the direct evidence for it — not an
inference from the count.
