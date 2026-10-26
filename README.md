# dsh-session-title-idle-refresh

DSH (DeepSeek Harness 0.2.1) session-title plugin built for Yoshiki Tamura.

- Registers the session-title provider with `automatic: "first-prompt"` —
  the initial title is generated exactly once, as with the stock
  provider — but generation reads **all** human messages (stock
  all-prompts policy, including its keep-an-adequate-title stability
  rules, with the input trimmed to the byte budget).
- A timer scans live sessions every `scanMs`. A session is refreshed
  once via `ctx.sessionTitle.refresh()` when **all** hold:
  - its title does not yet cover the latest human message,
  - the last event and the last human message are older than `idleMs`
    (default 30 min),
  - it has at least `minMessages` human messages (default 2),
  - it is not a subagent child session,
  - its title is not user-pinned (rename).
  Attempts per uncovered tail are recorded in memory; a refresh is
  never retried for the same tail before `max(idleMs, 30min)` passes.

## Install (web profile)

```sh
dsh plugin --profile web add dsh-session-title-idle-refresh
# then restart dsh web
```

The package ships a bundle patch (`cordis.patch.yml`) that inserts
the provider row with the defaults below and disables the stock
`session-title-llm` row — only one title provider may be registered,
and this plugin replaces it (the same swap pattern the official
session-titles bundle uses for its all-prompts provider). To tune,
restate the row in your profile's `cordis.patch.yml`:

```yaml
- id: session-title-idle-refresh
  config:
    idleMs: 1800000
    scanMs: 60000
```

## Config defaults

idleMs 1800000 · scanMs 60000 · minMessages 2 · maxPerScan 3 ·
targetWords 5 · targetCjkCharacters 10 · maxInputBytes 16384 ·
maxOutputTokens 4096 · timeoutMs 60000. No provider/model is pinned:
titles use each session's own logged route, like the stock provider.

## Upstream

This behavior is also implemented in-tree as a proposed third
automatic mode (idle) for the session-title service, on a fork
branch of deepseek-ai/deepseek-harness (which currently does not
accept external PRs; a Discussion proposal is being prepared):

https://github.com/2001Y/deepseek-harness/tree/feat/session-title-idle-mode
