#!/usr/bin/env bash
# Publish a component set release into the set's own repository from verified
# build output (standard simai.component-set, one-release-route). Never pushes.
#
# Usage:
#   scripts/publish-package-release.sh \
#     --report <workspace>/report.json  (verify-package-reproducibility.cjs, status PASS;
#                                        its output is what is laid)
#     --repo <set repository checkout, on a release branch, clean> \
#     --version <npm version of @simai-studio/<set>> \
#     --subject "<what the release changes>" \
#     [--ui <ui checkout: resolve and check the free release>] \
#     [--registry <ui-source contracts/registry/names.json>] \
#     [--out <folder under the package path, default dist>] \
#     [--work <directory for the receipt and stamped passport, default a new temporary one>] \
#     [--index <compatibility index.json to add the release row to>] \
#     [--trailer "<last paragraph of every commit message, e.g. a Co-Authored-By line>"]
#
# What it does, in order, stopping at the first failure:
#   1. Checks the build: the report passed and its output is the bytes it
#      hashed (bind-package-release.py output); for a set, the output root holds
#      set.json and smart/ and nothing else. Writes the receipt, which checks
#      the passport against the build (write-package-receipt.py).
#   2. Lays the output and its receipt into <repo>/<package path>/<out> and
#      commits "Build: <set> <subject>": that commit is the release build.
#   3. Writes the release lock contracts/releases/<set>-<12>.lock.json and the
#      stamped passport (a release asset, in --work), and runs the release gate
#      (bind-package-release.py lock, check). Red: the bind is left uncommitted.
#   4. Commits "Bind the <set> release <set>-<12>".
#   5. With --index, adds the release row to the compatibility index
#      (set-index.py add); the index is not committed here -- it lives in its
#      own package, @simai-studio/sets.
#
# The Pro route (publish-pro-release.sh) keeps its own lock schema and owner
# manifest and shares the checks of bind-package-release.py.
set -euo pipefail

BUILDER_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
REPORT='' REPO='' VERSION='' SUBJECT='' UI='' REGISTRY='' OUT=dist WORK='' INDEX='' TRAILER=
while [ $# -gt 0 ]; do
    case "$1" in
        --report) REPORT="$2"; shift 2 ;;
        --repo) REPO="$2"; shift 2 ;;
        --version) VERSION="$2"; shift 2 ;;
        --subject) SUBJECT="$2"; shift 2 ;;
        --ui) UI="$2"; shift 2 ;;
        --registry) REGISTRY="$2"; shift 2 ;;
        --out) OUT="$2"; shift 2 ;;
        --work) WORK="$2"; shift 2 ;;
        --index) INDEX="$2"; shift 2 ;;
        --trailer) TRAILER="$2"; shift 2 ;;
        *) printf 'unknown argument: %s\n' "$1" >&2; exit 2 ;;
    esac
done

fail() { printf 'PUBLISH_FAILED — %s\n' "$*" >&2; exit 1; }
[ -n "$REPORT" ] && [ -n "$REPO" ] && [ -n "$VERSION" ] && [ -n "$SUBJECT" ] || { sed -n '2,17p' "$0" >&2; exit 2; }

REPORT="$(cd "$(dirname "$REPORT")" && pwd)/$(basename "$REPORT")"
REPO="$(cd "$REPO" && pwd)"
[ -n "$WORK" ] || WORK="$(mktemp -d "${TMPDIR:-/tmp}/package-release.XXXXXX")"
mkdir -p "$WORK"; WORK="$(cd "$WORK" && pwd)"
BIND=(python3 "$BUILDER_ROOT/scripts/bind-package-release.py")
commit() {
    local repository="$1"; shift
    local arguments=()
    for paragraph in "$@" ${TRAILER:+"$TRAILER"}; do arguments+=(-m "$paragraph"); done
    git -C "$repository" commit -q "${arguments[@]}"
}
step() { printf '\n== %s\n' "$*"; }
field() { python3 -c 'import json,sys;v=json.load(open(sys.argv[1]))
for k in sys.argv[2].split("."): v=v[k]
print(v)' "$REPORT" "$1"; }

step 'check the build'
read -r NAME PACKAGE_REVISION SOURCE_REVISION <<< "$("${BIND[@]}" output --report "$REPORT")" \
    || fail 'the build output does not match a passing reproducibility report'
OUTPUT="$(dirname "$REPORT")/$(field output)"
PACKAGE_PATH="$(field package_source.path)"
BRANCH="$(git -C "$REPO" symbolic-ref --quiet --short HEAD || true)"
[ -n "$BRANCH" ] || fail "$REPO is on a detached HEAD"
case "$BRANCH" in main|master) fail "$REPO is on $BRANCH: publish on a release branch, merge after review" ;; esac
[ -z "$(git -C "$REPO" status --porcelain)" ] || fail "$REPO is not clean"
git -C "$REPO" cat-file -e "$PACKAGE_REVISION^{commit}" || fail "$REPO does not hold the built revision $PACKAGE_REVISION"
git -C "$REPO" merge-base --is-ancestor "$PACKAGE_REVISION" HEAD || fail "the built revision ${PACKAGE_REVISION:0:12} is not on $BRANCH"
if [ -f "$OUTPUT/set.json" ]; then
    [ "$(ls "$OUTPUT" | tr '\n' ' ' | sed 's/ $//')" = 'set.json smart' ] || fail "a set's output root holds set.json and smart/ only"
fi
DIST="${PACKAGE_PATH:+$PACKAGE_PATH/}$OUT"
git -C "$REPO" check-ignore -q "$DIST/probe" && fail "$REPO ignores $DIST (.gitignore): the release would not carry it"

step 'write the receipt'
RECEIPT_ARGS=(--report "$REPORT" --output "$WORK/package-receipt.json" --archive "$WORK/package-$NAME.tar")
[ -n "$UI" ] && RECEIPT_ARGS+=(--ui "$UI")
[ -n "$REGISTRY" ] && RECEIPT_ARGS+=(--registry "$REGISTRY")
python3 "$BUILDER_ROOT/scripts/write-package-receipt.py" "${RECEIPT_ARGS[@]}" \
    || fail 'the receipt was refused: the build disagrees with its passport or the free release'

step 'lay the build output'
mkdir -p "$REPO/$DIST"
rsync -a --delete "$OUTPUT/" "$REPO/$DIST/"
cp "$WORK/package-receipt.json" "$REPO/$DIST/package-receipt.json"

step 'commit the build'
git -C "$REPO" add -A "$DIST"
git -C "$REPO" diff --cached --quiet && fail "the output changes no byte in $DIST: there is nothing to release"
BUILDER_REVISION="$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["builder"]["revision"])' "$WORK/package-receipt.json")"
commit "$REPO" "Build: $NAME $SUBJECT" \
    "Built from ${PACKAGE_REVISION:0:12} over ui-source ${SOURCE_REVISION:0:12} with ui-builder ${BUILDER_REVISION:0:12}."
BUILD="$(git -C "$REPO" rev-parse HEAD)"
ID="$NAME-${PACKAGE_REVISION:0:12}"

step 'write the release lock'
"${BIND[@]}" lock --report "$REPORT" --receipt "$WORK/package-receipt.json" --repo "$REPO" --out "$OUT" \
    --version "$VERSION" --set-out "$WORK/set.json"

step 'release gate'
CHECK_ARGS=(--repo "$REPO")
[ -n "$UI" ] && CHECK_ARGS+=(--ui-root "$UI")
"${BIND[@]}" check "${CHECK_ARGS[@]}" || fail "the release gate is red: the bind of $ID is left uncommitted in $REPO"

step 'the bind commit'
git -C "$REPO" add contracts/releases/"$ID".lock.json
commit "$REPO" "Bind the $NAME release $ID" "$SUBJECT. Version $VERSION, over ui-source ${SOURCE_REVISION:0:12}."

if [ -n "$INDEX" ]; then
    step 'the compatibility index row'
    python3 "$BUILDER_ROOT/scripts/set-index.py" add --index "$INDEX" --passport "$WORK/set.json" \
        --lock "$REPO/contracts/releases/$ID.lock.json" --published-on "$(date -u +%F)"
fi

printf '\nRELEASE %s version=%s build=%s bind=%s source=%s builder=%s receipt=%s passport=%s\n' \
    "$ID" "$VERSION" "${BUILD:0:12}" "$(git -C "$REPO" rev-parse --short=12 HEAD)" "${SOURCE_REVISION:0:12}" \
    "${BUILDER_REVISION:0:12}" "$WORK/package-receipt.json" "$WORK/set.json"
printf 'Nothing was pushed.\n'
