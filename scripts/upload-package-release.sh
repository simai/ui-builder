#!/usr/bin/env bash
# Create the GitHub release of a bound set release from the assets
# publish-package-release.sh laid out, then download every asset back and
# check it (package-release-assets.py check --github).
#
# Usage:
#   scripts/upload-package-release.sh \
#     --assets <work>/assets  (package-release-assets.py prepare output) \
#     --release <set>-<12> \
#     --github <owner/repo of the set> \
#     [--title "<title>", default "<set> <version> (<set>-<12>)"] \
#     [--notes-file <release notes>] \
#     [--lock <set repo>/contracts/releases/<set>-<12>.lock.json] \
#     [--dry-run]
#
# The release carries package-<set>-<12>.tar and package-<set>.tar -- the
# same bytes; consumers fetch the second name, as they fetch package-pro.tar
# from a Pro release -- package-<set>.tar.sha256, package-receipt.json and,
# for a set, set-<set>-<12>.json and, over a free pair, pair-range.json (its
# pair range, set-pair-range.py write). The assets are checked before anything is
# sent and again after the download; a release is never moved or rewritten.
set -euo pipefail

BUILDER_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ASSETS='' RELEASE='' GITHUB='' TITLE='' NOTES='' LOCK='' DRY_RUN="${DRY_RUN:-0}"
while [ $# -gt 0 ]; do
    case "$1" in
        --assets) ASSETS="$2"; shift 2 ;;
        --release) RELEASE="$2"; shift 2 ;;
        --github) GITHUB="$2"; shift 2 ;;
        --title) TITLE="$2"; shift 2 ;;
        --notes-file) NOTES="$2"; shift 2 ;;
        --lock) LOCK="$2"; shift 2 ;;
        --dry-run) DRY_RUN=1; shift ;;
        *) printf 'unknown argument: %s\n' "$1" >&2; exit 2 ;;
    esac
done
fail() { printf 'UPLOAD_FAILED — %s\n' "$*" >&2; exit 1; }
[ -n "$ASSETS" ] && [ -n "$RELEASE" ] && [ -n "$GITHUB" ] || { sed -n '6,14p' "$0" >&2; exit 2; }
ASSETS_TOOL=(python3 "$BUILDER_ROOT/scripts/package-release-assets.py")
LOCK_ARGS=()
[ -n "$LOCK" ] && LOCK_ARGS=(--lock "$LOCK")

"${ASSETS_TOOL[@]}" check --dir "$ASSETS" --release "$RELEASE" ${LOCK_ARGS[@]+"${LOCK_ARGS[@]}"} \
    || fail "the assets in $ASSETS are not the release $RELEASE"

NAME="${RELEASE%-*}"
FILES=("$ASSETS/package-$RELEASE.tar" "$ASSETS/package-$NAME.tar" "$ASSETS/package-$NAME.tar.sha256" "$ASSETS/package-receipt.json")
[ -f "$ASSETS/set-$RELEASE.json" ] && FILES+=("$ASSETS/set-$RELEASE.json")
[ -f "$ASSETS/pair-range.json" ] && FILES+=("$ASSETS/pair-range.json")
if [ -z "$TITLE" ]; then
    VERSION="$(python3 -c 'import json,sys
try: print(json.load(open(sys.argv[1]))["release"]["version"])
except Exception: print("")' "$ASSETS/set-$RELEASE.json" 2>/dev/null || true)"
    TITLE="$NAME${VERSION:+ $VERSION} ($RELEASE)"
fi
CREATE=(gh release create "$RELEASE" -R "$GITHUB" --title "$TITLE")
if [ -n "$NOTES" ]; then CREATE+=(--notes-file "$NOTES"); else CREATE+=(--notes "$TITLE"); fi
CREATE+=("${FILES[@]}")

if [ "$DRY_RUN" = 1 ]; then
    printf 'dry-run    would run:'; printf ' %q' "${CREATE[@]}"; printf '\n'
    printf 'dry-run    would download %s from %s and check every asset\n' "$RELEASE" "$GITHUB"
    exit 0
fi
gh release view "$RELEASE" -R "$GITHUB" >/dev/null 2>&1 && fail "$GITHUB already has a release $RELEASE: a release is never rewritten"
"${CREATE[@]}"
"${ASSETS_TOOL[@]}" check --github "$GITHUB" --release "$RELEASE" ${LOCK_ARGS[@]+"${LOCK_ARGS[@]}"} \
    || fail "the published release $RELEASE on $GITHUB does not carry the checked assets"
printf 'RELEASED %s on %s\n' "$RELEASE" "$GITHUB"
