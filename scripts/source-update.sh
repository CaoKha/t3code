#!/usr/bin/env bash
# Merges an upstream T3 Code release tag into this fork and builds it as a macOS app.
#
# Usage: scripts/source-update.sh <tag> <version>   (run from the repository root)
#
# Driven by the desktop app's source-build updater, which parses these stdout lines:
#   PROGRESS <percent>    build progress
#   CONFLICT <path>       a file that conflicts with the fork's changes (exit code 3)
#   ERROR <message>       why the update failed (exit code 1)
#   STAGED_APP <path>     the built .app, ready to install
# Everything else goes to stderr, which the app keeps in its update log.
set -uo pipefail

# The merge can rewrite this file while it runs, so run from a copy.
if [ -z "${T3_SOURCE_UPDATE_COPY:-}" ]; then
  copy="$(mktemp -t t3-source-update)"
  cp "$0" "$copy"
  T3_SOURCE_UPDATE_COPY=1 exec bash "$copy" "$@"
fi

TAG="${1:?usage: source-update.sh <tag> <version>}"
VERSION="${2:?usage: source-update.sh <tag> <version>}"
REMOTE="${T3_SOURCE_UPDATE_REMOTE:-upstream}"
REPO="$(pwd)"

# Apps started from the Dock do not inherit the login shell PATH.
export PATH="$HOME/.local/share/mise/shims:$HOME/.local/bin:$HOME/.cargo/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"

fail() {
  echo "ERROR $*"
  exit 1
}
progress() { echo "PROGRESS $1"; }

progress 2
if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
  fail "The fork at $REPO has uncommitted changes. Commit or stash them, then check for updates again."
fi
git fetch --quiet "$REMOTE" "refs/tags/$TAG:refs/tags/$TAG" 1>&2 ||
  fail "Could not fetch $TAG from the '$REMOTE' remote."

progress 5
if ! git merge --no-edit "$TAG" 1>&2; then
  conflicts="$(git diff --name-only --diff-filter=U)"
  git merge --abort 1>&2 || true
  if [ -n "$conflicts" ]; then
    while IFS= read -r file; do echo "CONFLICT $file"; done <<<"$conflicts"
    exit 3
  fi
  fail "git merge $TAG failed."
fi

progress 10
PNPM_VERSION="$(node -p "require('./package.json').packageManager.split('@')[1]")" ||
  fail "Node.js is not available on PATH."
run_pnpm() {
  if command -v mise >/dev/null 2>&1; then
    mise exec "pnpm@$PNPM_VERSION" -- pnpm "$@"
  else
    corepack pnpm "$@"
  fi
}
run_pnpm install --frozen-lockfile 1>&2 || fail "pnpm install failed."

progress 20
case "$(uname -m)" in
  arm64) ARCH=arm64 ;;
  *) ARCH=x64 ;;
esac
OUTPUT_DIR="$REPO/release/$VERSION"
rm -rf "$OUTPUT_DIR"
unset GITHUB_REPOSITORY T3CODE_DESKTOP_UPDATE_REPOSITORY
run_pnpm exec node scripts/build-desktop-artifact.ts \
  --platform mac --arch "$ARCH" --target zip \
  --build-version "$VERSION" --output-dir "$OUTPUT_DIR" 2>&1 |
  while IFS= read -r line; do
    echo "$line" >&2
    case "$line" in
      *"Staging release app"*) progress 55 ;;
      *"Installing staged production dependencies"*) progress 65 ;;
      *"Building mac/"*) progress 75 ;;
    esac
  done
[ "${PIPESTATUS[0]}" -eq 0 ] || fail "The desktop build failed."

progress 90
zip="$(find "$OUTPUT_DIR" -maxdepth 1 -name '*.zip' | head -n 1)"
[ -n "$zip" ] || fail "The desktop build produced no zip in $OUTPUT_DIR."
stage="$OUTPUT_DIR/stage"
mkdir -p "$stage"
ditto -x -k "$zip" "$stage" 1>&2 || fail "Could not unpack $zip."
app="$(find "$stage" -maxdepth 1 -name '*.app' | head -n 1)"
[ -n "$app" ] || fail "No app bundle found in $zip."

progress 100
echo "STAGED_APP $app"
