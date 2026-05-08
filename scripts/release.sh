#!/usr/bin/env bash
set -euo pipefail

VERSION=${1:-}
if [[ -z "$VERSION" ]]; then
  echo "Usage: ./scripts/release.sh v0.1.3"
  exit 1
fi

if [[ ! "$VERSION" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "Version must be vMAJOR.MINOR.PATCH (got: $VERSION)"
  exit 1
fi

if [[ -n "$(git status --porcelain)" ]]; then
  echo "Working tree is dirty. Commit or stash first."
  exit 1
fi

BRANCH=$(git branch --show-current)
if [[ "$BRANCH" != "main" ]]; then
  echo "Must be on main (currently on $BRANCH)"
  exit 1
fi

# Update version in package.json and package-lock.json
npm version "${VERSION#v}" --no-git-tag-version >/dev/null

git add package.json package-lock.json
git commit -m "Release $VERSION"
git tag "$VERSION"
git push origin main
git push origin "$VERSION"

echo ""
echo "Released $VERSION — GitHub Actions will create the release page."
echo "Install with: npm install -g github:carlkibler/toolsmith#$VERSION"
