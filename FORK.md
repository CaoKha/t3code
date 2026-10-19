# CaoKha/t3code fork

This fork is upstream [pingdotgg/t3code](https://github.com/pingdotgg/t3code) plus:

- **difftastic diffs**: the `{}` toggle in the Diff panel shows structural diffs from `difft`
  (needs `difft` on the machine running the T3 server).
- **Neovim as an editor**: with `nvim` on the server's PATH, "Open in Neovim" (the default
  until another editor is picked) opens a new side-panel terminal running `nvim`, so LazyVim works
  locally and over remote connections.
- **Guide reading order in Code**: the sparkle button in a pull request's Code tab orders files as
  the review guide reads them, writing the guide first if there is none.
- **Swap chat and panel**: the ⇄ button next to Maximize moves the right panel to the left.
- **Updates from this fork**: builds of this fork update from this fork's releases.

## How updates flow

1. **You push to `main`** → [Fork release](.github/workflows/fork-release.yml) builds the macOS
   app (arm64) and the Linux server, publishes them as a release
   (`v<upstream>-nightly.<date>.<10000 + run>`, with `SHA256SUMS`), then uploads `latest.json`
   (version, tag, commit, and each asset's URL and SHA-256) to the fixed **`channel`** release.
   Markdown-only pushes build nothing; a build that `main` has moved past is not published.
2. **Upstream publishes a nightly** → [Fork upstream sync](.github/workflows/fork-upstream-sync.yml)
   (every 6 hours, on every push to `main`, or by hand) merges the newest upstream nightly tag
   into `main` and pushes it, which starts a release. It writes `upstream-status.json` to the
   `channel` release and keeps an "Upstream sync needs attention" issue open while it is stuck:
   - `conflict`: the merge conflicts. Resolve it locally:

     ```sh
     git fetch upstream --tags
     git merge <tag>   # fix conflicts
     git commit && git push
     ```

   - `needs-review`: upstream adds workflow files, which would start running here once pushed.
     Review them, then merge and push by hand as above (disable unwanted ones in Actions).
   - `push-failed`: the merge was clean but the push was rejected; check the run and the key.

   Your push reruns the sync, which then reports `in-sync` and closes the issue.

3. **Desktop app (macOS)**: the update button reads
   `https://github.com/CaoKha/t3code/releases/download/channel/latest.json` (download URLs are
   not subject to the GitHub API rate limit), downloads the app, verifies its size and SHA-256,
   and swaps it in after the app quits. When there is no newer build, it shows the sync status
   instead (conflict, needs review, push failed). The repository is baked in at build time
   (`T3CODE_FORK_RELEASE_REPOSITORY`; only unpackaged dev runs may override it at runtime);
   upstream builds are unaffected. Run the app from `/Applications` (or another writable folder):
   a translocated or read-only copy cannot update itself.
4. **Remote servers**: a server started with `T3CODE_SELF_UPDATE_DIR` and
   `T3CODE_RELEASE_BASE_URL=https://github.com/CaoKha/t3code/releases/download` offers
   **Update** in the desktop app whenever the app is newer. It installs the release under
   `$T3CODE_SELF_UPDATE_DIR/runtime/versions/<version>` (checked against that release's
   `SHA256SUMS`), repoints `$T3CODE_SELF_UPDATE_DIR/current` and exits for its supervisor
   (e.g. systemd `Restart=always`) to restart it.

## One-time setup

- **`fork-sync` environment** (Settings → Environments) holding the `FORK_SYNC_SSH_KEY`
  secret, with no required reviewers (the sync runs unattended) and deployments limited to
  `main`. The key pair is dedicated to this repository and matches the
  "fork-upstream-sync (Actions)" deploy key (write): a deploy key may push upstream's workflow
  changes and its pushes trigger the release. Rotate it under Settings → Deploy keys.
- Upstream's own workflows are disabled in this fork's Actions settings; only the two fork
  workflows run.
- The old `upstream-status` release is no longer used and can be deleted.

### nuc-5 (example remote server)

`~/mise.toml` in the service's working directory:

```toml
[tools]
"npm:t3" = "path:/home/agent/.local/share/t3-fork/launcher"

[env]
T3CODE_SELF_UPDATE_DIR = "/home/agent/.local/share/t3-fork"
T3CODE_RELEASE_BASE_URL = "https://github.com/CaoKha/t3code/releases/download"
```

`/home/agent/.local/share/t3-fork/launcher/bin/t3` runs `../../current/t3`.

To update it: update the desktop app first, then press **Update** on the server in the app.
Without the app, install the build `latest.json` names by hand:

```sh
curl -fsSL https://github.com/CaoKha/t3code/releases/download/channel/latest.json |
  jq -r '.assets["linux-x64"] | "\(.url) \(.sha256)"'
# download that URL, check `sha256sum`, unpack it under
# ~/.local/share/t3-fork/runtime/versions/<version>, repoint ~/.local/share/t3-fork/current
# and restart the service
```
