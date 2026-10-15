# CaoKha/t3code fork

This fork is upstream [pingdotgg/t3code](https://github.com/pingdotgg/t3code) plus:

- **difftastic diffs**: the `{}` toggle in the Diff panel shows structural diffs from `difft`
  (needs `difft` on the machine running the T3 server).
- **Swap chat and panel**: the ⇄ button next to Maximize moves the right panel to the left.
- **Updates from this fork**: builds of this fork update from this fork's releases.

## How updates flow

1. **You push to `main`** → [Fork release](.github/workflows/fork-release.yml) builds the macOS
   app (arm64) and the Linux server, and publishes them as a release
   (`v<upstream>-nightly.<date>.<10000 + run>`, with `SHA256SUMS`).
2. **Upstream publishes a nightly** → [Fork upstream sync](.github/workflows/fork-upstream-sync.yml)
   (every 6 hours, or run it by hand) merges the newest upstream nightly tag into `main` and
   starts a release. On a merge conflict it opens an "Upstream merge conflict" issue listing
   the files, and the desktop app's update button shows the same error until you resolve it:

   ```sh
   git fetch upstream --tags
   git merge <tag>   # fix conflicts
   git commit && git push
   ```

3. **Desktop app (macOS)**: the update button checks this fork's releases, downloads the app,
   verifies it against `SHA256SUMS` and swaps it in. The repository is baked in at build time
   (`T3CODE_FORK_RELEASE_REPOSITORY`); upstream builds are unaffected.
4. **Remote servers**: a server started with `T3CODE_SELF_UPDATE_DIR` and
   `T3CODE_RELEASE_BASE_URL=https://github.com/CaoKha/t3code/releases/download` offers
   **Update** in the desktop app whenever the app is newer. It installs the release under
   `$T3CODE_SELF_UPDATE_DIR/runtime/versions/<version>`, repoints `$T3CODE_SELF_UPDATE_DIR/current`
   and exits for its supervisor (e.g. systemd `Restart=always`) to restart it.

## One-time setup

- `FORK_SYNC_SSH_KEY` secret + "fork-upstream-sync (Actions)" deploy key (write): a key pair
  dedicated to this repository that the sync workflow pushes with. A deploy key may push
  upstream's workflow changes and its pushes trigger the release. Revoke or rotate it under
  Settings → Deploy keys.
- Upstream's own workflows are disabled in this fork's Actions settings; only the two fork
  workflows run.

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
