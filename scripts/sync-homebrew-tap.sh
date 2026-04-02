#!/bin/bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TARGET_DIR="${1:-}"
GITHUB_REPO="${ANTI_API_GITHUB_REPO:-}"
TAP_REPO="${ANTI_API_HOMEBREW_TAP_REPO:-}"

if [ -z "$GITHUB_REPO" ]; then
    GITHUB_REPO="$(git -C "$REPO_ROOT" remote get-url origin 2>/dev/null | sed -E 's#^git@github.com:##; s#^https://github.com/##; s#\.git$##')"
fi

if [ -z "$GITHUB_REPO" ]; then
    echo "Unable to resolve GitHub repo. Set ANTI_API_GITHUB_REPO=owner/repo"
    exit 1
fi

OWNER="${GITHUB_REPO%%/*}"
if [ -z "$TAP_REPO" ]; then
    TAP_REPO="${OWNER}/homebrew-anti-api"
fi
TAP_NAME="${TAP_REPO#*/}"
if [[ "$TAP_NAME" == homebrew-* ]]; then
    TAP_INSTALL_NAME="${OWNER}/${TAP_NAME#homebrew-}"
else
    TAP_INSTALL_NAME="${TAP_REPO}"
fi

if [ -z "$TARGET_DIR" ]; then
    echo "Usage: scripts/sync-homebrew-tap.sh /path/to/homebrew-anti-api"
    exit 1
fi

mkdir -p "$TARGET_DIR/Formula"
cp "$REPO_ROOT/Formula/anti-api.rb" "$TARGET_DIR/Formula/anti-api.rb"

cat > "$TARGET_DIR/README.md" <<'EOF'
# homebrew-anti-api

Homebrew tap for [Anti-API](https://github.com/__GITHUB_REPO__).

## Install

```bash
brew tap __TAP_INSTALL_NAME__
brew install anti-api
```

## Upgrade

```bash
brew upgrade anti-api
```

## Run

```bash
anti-api
```

## Notes

- The formula installs a prebuilt macOS Apple Silicon bundle. It does not download Rust, LLVM, or Bun at install time.
- In-app self-update is disabled for Homebrew-managed installs. Use `brew upgrade anti-api` instead.
- Formula source of truth: `Formula/anti-api.rb` from the main Anti-API repository.
EOF

sed -i.bak \
    -e "s#__GITHUB_REPO__#${GITHUB_REPO}#g" \
    -e "s#__TAP_INSTALL_NAME__#${TAP_INSTALL_NAME}#g" \
    "$TARGET_DIR/README.md"
rm -f "$TARGET_DIR/README.md.bak"

echo "Synced Homebrew tap files to $TARGET_DIR"
