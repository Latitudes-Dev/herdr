# PLAN: Merge upstream v0.7.2 into Latitudes-Dev fork

## Current Context

Review date: 2026-07-07.

The local shared checkout is `/home/shuv/repos/herdr` on `master`.
After fetching both remotes, the current state is:

| Ref | Repo | Tip | Notes |
| --- | --- | --- | --- |
| `origin/master` | `Latitudes-Dev/herdr` | `c4f6503` | fork tip; local `master` is already here |
| `upstream/master` | `ogulcancelik/herdr` | `53d85be` | 16 commits ahead of merge-base; includes `v0.7.2` and post-release fixes |
| merge-base | shared | `5b4450c` | `docs: remove star history embed` |
| `v0.7.2` | upstream tag | `199c276` | upstream release commit |

Divergence from merge-base:

```bash
git rev-list --left-right --count origin/master...upstream/master
# expected: 5 16
```

The fork carries four behavior commits plus one prior upstream merge commit on
top of `5b4450c`. The goal is to absorb upstream `v0.7.2` and the newer
upstream `master` fixes while preserving the fork-specific behavior and making
sure changed bundled integrations update correctly for existing installs.

## Constraints

- Do the merge in a disposable worktree, not the shared checkout. The shared
  checkout currently contains this untracked plan file, and previous Herdr
  upstream syncs have been safest in isolated worktrees.
- Use `just` recipes by default.
- Set Herdr's pinned Zig before source-build validation:

  ```bash
  export ZIG=/home/shuv/.local/opt/zig-x86_64-linux-0.15.2/zig
  ```

  `/usr/bin/zig` is `0.16.0` on this machine and is not the expected Herdr
  vendored `libghostty-vt` build tool.
- When running a newly built Herdr from inside an existing Herdr session, clear
  inherited socket overrides so `cargo run` validates the debug build instead
  of accidentally talking through the installed stable client:

  ```bash
  env -u HERDR_SOCKET_PATH -u HERDR_CLIENT_SOCKET_PATH cargo run -- <command>
  ```

## Fork-Specific Behavior To Preserve

| Commit | Subject | Files touched | Purpose |
| --- | --- | --- | --- |
| `88bbb2c` | `fix: preserve user focus on programmatic workspace close/worktree remove` | `src/app/actions.rs`, `src/app/api/workspaces.rs`, `src/app/api/worktrees/deferred.rs` | Adds `AppState::close_workspace_preserving_focus`; API workspace-close and worktree-remove no longer yank TUI focus |
| `870dad7` | `feat: embed build commit in version and status` | `build.rs`, `src/build_info.rs`, `src/cli/status.rs`, `src/update.rs`, tests | Fork builds report `0.7.x+<sha>` via `herdr --version` and expose `client.commit` in status JSON |
| `7419712` | `Preserve user focus on remaining workspace-collapse paths (#1)` | `src/app/actions.rs`, `src/app/api/panes.rs` | Extends focus preservation to API `pane.close` last-pane collapse and `PaneDied` self-exit collapse |
| `c4f6503` | `fix: keep pi and omp panes working during agent_end auto-retry and retry undelivered pi state reports (#2)` | `src/integration/assets/pi/herdr-agent-state.ts`, `src/integration/assets/omp/herdr-agent-state.ts`, `src/integration/assets/herdr-agent-state.test.ts` | Honors `willRetry` on `agent_end`; requeues undelivered Pi state reports |

Supporting merge commit already on origin:

- `319441a merge: sync upstream master`

## Upstream Commits To Absorb

Since merge-base `5b4450c`:

```text
53d85be docs: update preview manifest
f535478 ci: ignore microsoft apt repos in artifact builds
1d49fa7 ci: clear zig cache before windows checks
2b99ced fix: keep cursor hide inside sync output
e4a7095 fix: guard windows process tree cycles
0a684b4 fix: clear done status on repeated pane focus
1e1d063 fix: preserve navigator search commands (#1140)
d0b75de docs: update website manifest for v0.7.2
199c276 release: v0.7.2
fb5a46a docs: finalize release docs
d190c1f fix: send shifted punctuation as text in kitty mode
39ba6b7 fix: preserve alt-shift letters (#1102)
b425260 perf: move session autosaves off main loop
b017d21 fix: stop windows server over named pipes
7a85249 fix: support esc interrupt for github copilot (#1120)
670a2bb chore: approve contributor liby
```

Notable upstream surface areas:

- Version bump: `Cargo.toml`, `Cargo.lock` to `0.7.2`
- Input encoding: `src/input/encode.rs`, `src/input/parse.rs`
- Agent detection: `src/detect/manifests/github-copilot.toml`,
  `src/app/agents.rs`
- Navigator search: `src/ui/navigator.rs`
- Background session autosave: `src/app/runtime.rs`,
  `src/server/headless.rs`
- Pane focus and seen state: `src/app/api/panes.rs`, `src/app/mod.rs`
- Windows process and named-pipe handling: `src/platform/windows.rs`
- Docs, release manifests, preview manifests, and CI workflows

## Merge Analysis

Dry merge analysis from current refs:

```bash
base=$(git merge-base origin/master upstream/master)
git merge-tree --write-tree origin/master upstream/master
```

The synthetic merge tree writes successfully, so there are no textual
conflicts.

Only one file overlaps between fork-only and upstream-only diffs:

- `src/app/api/panes.rs`

Expected `src/app/api/panes.rs` result:

- Keep upstream's `self.state.mark_active_tab_seen()` in `handle_pane_focus`.
- Keep fork behavior in `handle_pane_close` when the closed pane collapses a
  workspace:

  ```rust
  self.state.close_workspace_preserving_focus(ws_idx);
  ```

- Keep upstream tests:
  - `api_pane_send_keys_sends_shifted_punctuation_as_text_in_kitty_mode`
  - `api_pane_focus_marks_already_focused_done_pane_seen`
- Keep fork tests:
  - `app_with_workspaces`
  - `api_pane_close_collapse_preserves_focus_on_other_workspace`

Important non-conflict issue:

- `c4f6503` changes the bundled Pi and OMP integration asset contents after
  upstream `v0.7.2`, but both upstream `v0.7.2` and `origin/master` still
  declare `PI_INTEGRATION_VERSION = 4` and `OMP_INTEGRATION_VERSION = 4`.
  Without a version bump, existing installed integrations at version `4` will
  not be prompted to update and may miss the fork fix.

## Implementation Plan

### Milestone 1: Prepare Isolated Merge Worktree

- [x] Confirm the shared checkout state:

  ```bash
  cd /home/shuv/repos/herdr
  git status --short --branch
  git fetch origin
  git fetch upstream
  git rev-parse origin/master
  git rev-parse upstream/master
  git merge-base origin/master upstream/master
  git rev-list --left-right --count origin/master...upstream/master
  ```

- [x] Create a disposable worktree from `origin/master`:

  ```bash
  mkdir -p ../herdr-worktrees
  git worktree add -b merge/upstream-v0.7.2 ../herdr-worktrees/upstream-v0.7.2-merge origin/master
  cd ../herdr-worktrees/upstream-v0.7.2-merge
  ```

- [x] Verify the worktree starts at the fork tip:

  ```bash
  git log -1 --oneline
  git status --short --branch
  ```

Validation:

- `git log -1 --oneline` shows `c4f6503`.
- Worktree has no local modifications before the merge.

### Milestone 2: Merge Upstream

- [x] Merge current upstream without committing yet, so the integration version
  bump can be included in the merge result before the merge commit is created:

  ```bash
  git merge --no-ff --no-commit upstream/master
  ```

- [x] If a conflict appears despite the dry-run result, resolve
  `src/app/api/panes.rs` according to the expected result in
  [Merge Analysis](#merge-analysis).
- [x] Check for conflict markers and whitespace issues:

  ```bash
  rg -n '<<<<<<<|=======|>>>>>>>' .
  git diff --check
  git diff --cached --check
  ```

- [x] Verify version/protocol after the merge:

  ```bash
  rg -n '^version = "0.7.2"$' Cargo.toml
  rg -n 'pub const PROTOCOL_VERSION: u32 = 16;' src/protocol/wire.rs
  ```

Validation:

- Merge stages the upstream changes without creating the merge commit yet.
- No conflict markers remain.
- `Cargo.toml` is `0.7.2`.
- Protocol remains `16`.

### Milestone 3: Bump Changed Pi/OMP Integration Versions

Because the fork changes the installed Pi and OMP assets after the latest
released tag, bump each affected integration once from the `v0.7.2` version.

- [x] Update `src/integration/mod.rs`:

  ```rust
  const PI_INTEGRATION_VERSION: u32 = 5;
  const OMP_INTEGRATION_VERSION: u32 = 5;
  ```

- [x] Update the matching markers:

  ```text
  src/integration/assets/pi/herdr-agent-state.ts
  // HERDR_INTEGRATION_VERSION=5

  src/integration/assets/omp/herdr-agent-state.ts
  // HERDR_INTEGRATION_VERSION=5
  ```

- [x] Confirm constants and markers match:

  ```bash
  rg -n 'PI_INTEGRATION_VERSION|OMP_INTEGRATION_VERSION|HERDR_INTEGRATION_VERSION=5' src/integration/mod.rs src/integration/assets/pi/herdr-agent-state.ts src/integration/assets/omp/herdr-agent-state.ts
  ```

- [x] Stage the integration version bump so it is included in the merge commit:

  ```bash
  git add src/integration/mod.rs \
    src/integration/assets/pi/herdr-agent-state.ts \
    src/integration/assets/omp/herdr-agent-state.ts
  ```

Validation:

- Pi and OMP constants are both `5`.
- Pi and OMP asset markers are both `HERDR_INTEGRATION_VERSION=5`.
- No other integration version is changed unless its installed asset changes in
  this merge.

### Milestone 4: Create Merge Commit

- [x] Review the staged merge summary:

  ```bash
  git status --short
  git diff --cached --stat
  ```

- [x] Propose the commit message and get alignment before committing:

  ```text
  merge: sync upstream v0.7.2
  ```

- [x] Create the merge commit:

  ```bash
  git commit -m "merge: sync upstream v0.7.2"
  ```

Validation:

- `git log -1 --oneline` shows the new merge commit.
- `git rev-parse HEAD^1` is the fork parent from `origin/master`.
- `git rev-parse HEAD^2` is `upstream/master` or the fetched upstream tip.
- Pi/OMP version bumps are included in the merge commit.

### Milestone 5: Targeted Regression Checks

Set the pinned Zig once in the worktree shell:

```bash
export ZIG=/home/shuv/.local/opt/zig-x86_64-linux-0.15.2/zig
```

- [x] Run focused fork regression tests through `just test-one`:

  ```bash
  just test-one api_workspace_close_preserves_focus
  just test-one api_pane_close_collapse_preserves_focus
  just test-one pane_died_earlier_workspace_preserves_focus
  ```

- [x] Run upstream/fork overlap tests in `src/app/api/panes.rs`:

  ```bash
  just test-one api_pane_focus_marks_already_focused_done_pane_seen
  just test-one api_pane_send_keys_sends_shifted_punctuation_as_text_in_kitty_mode
  ```

- [x] Run integration asset tests:

  ```bash
  just integration-assets-test
  ```

- [x] Confirm merged source version and build-commit reporting:

  ```bash
  env -u HERDR_SOCKET_PATH -u HERDR_CLIENT_SOCKET_PATH cargo run -- --version
  env -u HERDR_SOCKET_PATH -u HERDR_CLIENT_SOCKET_PATH cargo run -- status --json | jq '.client.commit'
  ```

Expected:

- Version output is `0.7.2+<short-sha>` for a Git checkout build.
- `status --json` exposes the commit at `.client.commit`, not top-level
  `.commit`.

### Milestone 6: Full Validation

- [x] Run the full project check with the pinned Zig:

  ```bash
  export ZIG=/home/shuv/.local/opt/zig-x86_64-linux-0.15.2/zig
  just check
  ```

- [x] If full validation fails, do not push. Fix the failure or document why a
  narrower check is sufficient before proceeding.
- [x] Re-run any focused tests affected by fixes.

Validation:

- `just check` passes.
- No generated, vendored, or release manifest maintenance check is failing.

### Milestone 7: Review The Final Merge Diff

- [x] Review fork-critical files for accidental reversions:

  ```bash
  git diff 5b4450c..HEAD -- \
    build.rs \
    src/build_info.rs \
    src/cli/status.rs \
    src/update.rs \
    src/app/actions.rs \
    src/app/api/panes.rs \
    src/app/api/workspaces.rs \
    src/app/api/worktrees/deferred.rs \
    src/integration/mod.rs \
    src/integration/assets/herdr-agent-state.test.ts \
    src/integration/assets/pi/herdr-agent-state.ts \
    src/integration/assets/omp/herdr-agent-state.ts
  ```

- [x] Specifically verify:
  - `close_workspace_preserving_focus` is still used by API workspace close,
    worktree remove, API pane close last-pane collapse, and `PaneDied`
    workspace collapse paths.
  - `src/app/api/panes.rs` contains both upstream `mark_active_tab_seen()` and
    fork focus-preserving close behavior.
  - `src/cli/status.rs` serializes `.client.commit`.
  - Pi and OMP installed asset versions are bumped to `5`.
  - `website/latest.json`, `website/preview.json`, `CHANGELOG.md`,
    `README.md`, and docs changes are upstream release/doc changes, not local
    fork-specific rewrites.

Validation:

- Diff review shows no accidental loss of fork behavior.
- Integration version bump is included in the merge result.

### Milestone 8: Integrate Back To Shared Checkout And Push

- [x] Push the ready branch only after validation:

  ```bash
  git push origin HEAD:master
  ```

- [x] Fast-forward the shared checkout:

  ```bash
  cd /home/shuv/repos/herdr
  git fetch origin
  git merge --ff-only origin/master
  ```

- [x] Confirm pushed state:

  ```bash
  git rev-parse HEAD
  git rev-parse origin/master
  git status --short --branch
  ```

Validation:

- Shared checkout and `origin/master` point to the same commit.
- CI is green on `Latitudes-Dev/herdr`.

### Milestone 9: Optional Local Runtime Refresh

Only do this if the goal includes replacing the installed local Herdr runtime.
Merging and pushing the fork does not by itself update the running local Herdr
session.

- [x] Build the release binary with the pinned Zig:

  ```bash
  export ZIG=/home/shuv/.local/opt/zig-x86_64-linux-0.15.2/zig
  just build
  ```

- [x] Replace the PATH binary while preserving executable mode:

  ```bash
  install -m 0755 target/release/herdr ~/.local/bin/herdr
  ```

- [ ] Relaunch the normal Herdr TUI path and verify the live runtime:

  ```bash
  herdr --version
  herdr status --json | jq '.client.version, .client.commit, .client.protocol, .server.version, .server.protocol'
  ```

  Implementation note: the installed client and detached default server now
  report `0.7.2+a8cdaadff087` and protocol `16`. A stale interactive TUI
  process from another SSH terminal still has `/home/shuv/.local/bin/herdr
  (deleted)` open; it was not forcibly relaunched from this non-interactive
  shell.

Validation:

- Installed client reports `0.7.2+<short-sha>`.
- Live server protocol is `16`.
- The live session is relaunched through the normal TUI path, not only a
  short-lived headless server.

## Fork Invariants Checklist

| Invariant | Verification |
| --- | --- |
| API workspace-close does not steal focus | `just test-one api_workspace_close_preserves_focus` |
| Worktree remove does not steal focus | existing worktree remove tests under `src/app/api/worktrees.rs` plus diff review of `src/app/api/worktrees/deferred.rs` |
| API `pane.close` last-pane collapse preserves focus | `just test-one api_pane_close_collapse_preserves_focus` |
| `PaneDied` workspace collapse preserves focus | `just test-one pane_died_earlier_workspace_preserves_focus` |
| Upstream repeated pane focus clears done/seen state | `just test-one api_pane_focus_marks_already_focused_done_pane_seen` |
| Upstream kitty shifted punctuation behavior survives | `just test-one api_pane_send_keys_sends_shifted_punctuation_as_text_in_kitty_mode` |
| Source build version includes `+<commit>` | `env -u HERDR_SOCKET_PATH -u HERDR_CLIENT_SOCKET_PATH cargo run -- --version` |
| Status JSON exposes build commit | `env -u HERDR_SOCKET_PATH -u HERDR_CLIENT_SOCKET_PATH cargo run -- status --json \| jq '.client.commit'` |
| Pi `agent_end.willRetry` keeps pane working | `just integration-assets-test` |
| OMP `agent_end.willRetry` keeps pane working | `just integration-assets-test` |
| Pi undelivered state reports are retried | `just integration-assets-test` |
| Existing Pi/OMP installs see the changed asset as an update | Pi/OMP constants and markers are bumped from `4` to `5` |

## Risk Notes

1. The merge is textually clean, but the Pi/OMP integration version bump is a
   semantic requirement. Without it, a green source tree can still leave
   already-installed integrations stale.
2. Upstream `mark_active_tab_seen()` in `handle_pane_focus` composes with fork
   focus preservation. Keep both behaviors.
3. Background session autosave changes runtime timing. Watch for timing or
   persistence flakes if `just check` fails after the merge.
4. Upstream docs and release manifests intentionally modify stable docs,
   `website/latest.json`, `website/preview.json`, root `README.md`, and
   `CHANGELOG.md`. Treat these as upstream release artifacts unless the fork
   explicitly needs a different distribution channel.
5. The current GitHub account is `shuv1337`, not upstream maintainer
   `ogulcancelik`; push only to the fork remote `origin`
   (`git@github.com:Latitudes-Dev/herdr.git`).

## Rollback

Before pushing:

```bash
git merge --abort
```

If the merge already completed in the disposable worktree but has not been
pushed:

```bash
git reset --hard origin/master
```

If `origin/master` has already been pushed and must be backed out, do not use
`git reset --hard` on shared history without explicit approval. Prepare a
revert of the merge commit, validate it, and push the revert:

```bash
git revert -m 1 <merge-commit-sha>
export ZIG=/home/shuv/.local/opt/zig-x86_64-linux-0.15.2/zig
just check
git push origin HEAD:master
```

The known pre-merge fork tip is `c4f6503`, not `319441a`.

## Cleanup

After the merge has landed and the shared checkout is fast-forwarded:

```bash
cd /home/shuv/repos/herdr
git worktree remove ../herdr-worktrees/upstream-v0.7.2-merge
git branch -D merge/upstream-v0.7.2
```

If worktree removal fails because the worktree is dirty, inspect it first. Do
not force-remove unreviewed changes.

## Future Sync Cadence

1. After each upstream stable release tag on `ogulcancelik/herdr`, repeat the
   divergence check and dry merge analysis before merging.
2. Keep fork changes focused and covered by tests.
3. For any fork change to installed integration assets, compare against the
   latest released tag and bump that integration's migration version once per
   release window.
4. Consider upstreaming the focus-preservation and build-commit reporting
   changes if they should become normal Herdr behavior.

## References

- Upstream repo: `https://github.com/ogulcancelik/herdr`
- Fork repo: `https://github.com/Latitudes-Dev/herdr`
- Upstream release tag: `v0.7.2` (`199c276`)
- Fork focus preservation: `src/app/actions.rs`,
  `src/app/api/workspaces.rs`, `src/app/api/panes.rs`,
  `src/app/api/worktrees/deferred.rs`
- Fork build identity: `build.rs`, `src/build_info.rs`,
  `src/cli/status.rs`, `src/update.rs`
- Pi/OMP retry fix: `src/integration/assets/pi/herdr-agent-state.ts`,
  `src/integration/assets/omp/herdr-agent-state.ts`,
  `src/integration/assets/herdr-agent-state.test.ts`
