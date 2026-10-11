#!/usr/bin/env bash
# Publish a SIMAI Framework Pro release into ui-pro from verified build output.
# Never pushes.
#
# Usage:
#   scripts/publish-pro-release.sh \
#     --report <workspace>/report.json  (verify-pro-reproducibility.cjs, status PASS;
#                                        its wave-1/output/pro/smart is what is laid)
#     --pro <ui-pro checkout> \
#     --pro-source <ui-source-pro checkout holding the built revision> \
#     --source <ui-source checkout holding the pinned revision> \
#     --ui <ui checkout holding the free release> --framework ui-<12> \
#     --subject "<what the release changes>" \
#     [--builder-revision <ui-builder commit that built the output, default HEAD>] \
#     [--work <directory for the receipt, default a new temporary one>] \
#     [--trailer "<last paragraph of every commit message, e.g. a Co-Authored-By line>"]
#
# What it does, in order, stopping at the first failure:
#   1. Checks the build: the report passed, its output is the bytes it hashed,
#      and they are the four Pro folders and smart/rule.js, nothing else. Checks
#      the free release: ui-<12> exists, was built from the ui-source revision Pro
#      was built over, and its package reference (distr/core/contracts/packages/pro.package.json)
#      agrees with the Pro rules (bind-pro-release.py package).
#   2. Lays wave-1/output/pro/smart into ui-pro/smart and commits ui-pro
#      ("Build: <subject>"): that commit is the release, pro-<12>.
#   3. Writes the receipt, binds ui-pro's owner manifest and writes the release
#      lock contracts/releases/pro-<12>.lock.json, which requires ui-<12> and the
#      ui-source revision (bind-pro-release.py receipt, owners, reference).
#   4. Runs the Pro release gate (bind-pro-release.py check, against ui). Red:
#      nothing more is committed and the bind is left in the ui-pro worktree.
#   5. Commits "Bind the Pro release pro-<12>".
#
# ui-pro must be clean before it starts; ui is only read.
set -euo pipefail

BUILDER_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
REPORT='' PRO='' PRO_SOURCE='' SOURCE='' UI='' FRAMEWORK='' SUBJECT='' BUILDER_REVISION='' WORK='' TRAILER=
while [ $# -gt 0 ]; do
    case "$1" in
        --report) REPORT="$2"; shift 2 ;;
        --pro) PRO="$2"; shift 2 ;;
        --pro-source) PRO_SOURCE="$2"; shift 2 ;;
        --source) SOURCE="$2"; shift 2 ;;
        --ui) UI="$2"; shift 2 ;;
        --framework) FRAMEWORK="$2"; shift 2 ;;
        --subject) SUBJECT="$2"; shift 2 ;;
        --builder-revision) BUILDER_REVISION="$2"; shift 2 ;;
        --work) WORK="$2"; shift 2 ;;
        --trailer) TRAILER="$2"; shift 2 ;;
        *) printf 'unknown argument: %s\n' "$1" >&2; exit 2 ;;
    esac
done

fail() { printf 'PUBLISH_FAILED — %s\n' "$*" >&2; exit 1; }
[ -n "$REPORT" ] && [ -n "$PRO" ] && [ -n "$PRO_SOURCE" ] && [ -n "$SOURCE" ] && [ -n "$UI" ] \
    && [ -n "$FRAMEWORK" ] && [ -n "$SUBJECT" ] || { sed -n '2,16p' "$0" >&2; exit 2; }
[[ "$FRAMEWORK" =~ ^ui-[0-9a-f]{12}$ ]] || fail "--framework must be a free release id, ui-<12>"

REPORT="$(cd "$(dirname "$REPORT")" && pwd)/$(basename "$REPORT")"
PRO="$(cd "$PRO" && pwd)"; PRO_SOURCE="$(cd "$PRO_SOURCE" && pwd)"; SOURCE="$(cd "$SOURCE" && pwd)"; UI="$(cd "$UI" && pwd)"
OUTPUT="$(dirname "$REPORT")/wave-1/output/pro"
[ -n "$WORK" ] || WORK="$(mktemp -d "${TMPDIR:-/tmp}/pro-release.XXXXXX")"
mkdir -p "$WORK"; WORK="$(cd "$WORK" && pwd)"
BUILDER_REVISION="$(git -C "$BUILDER_ROOT" rev-parse --verify "${BUILDER_REVISION:-HEAD}^{commit}")"
BIND=(python3 "$BUILDER_ROOT/scripts/bind-pro-release.py")
commit() {
    local repository="$1"; shift
    local arguments=()
    for paragraph in "$@" ${TRAILER:+"$TRAILER"}; do arguments+=(-m "$paragraph"); done
    git -C "$repository" commit -q "${arguments[@]}"
}
step() { printf '\n== %s\n' "$*"; }

step 'check the build and the free release'
REVISIONS="$("${BIND[@]}" output --report "$REPORT")" || fail 'the build output does not match a passing reproducibility report'
read -r PRO_REVISION SOURCE_REVISION <<< "$REVISIONS"
[ "$(ls "$OUTPUT")" = smart ] || fail "the build output holds more than smart/"
EXPECTED='admin-menu data-view property-view rule.js rule.js.gz table'
[ "$(ls "$OUTPUT/smart" | tr '\n' ' ' | sed 's/ $//')" = "$EXPECTED" ] || fail "smart/ must hold exactly: $EXPECTED"
git -C "$PRO_SOURCE" cat-file -e "$PRO_REVISION^{commit}" || fail "ui-source-pro does not hold the built revision $PRO_REVISION"
git -C "$SOURCE" cat-file -e "$SOURCE_REVISION^{commit}" || fail "ui-source does not hold the pinned revision $SOURCE_REVISION"
[ -z "$(git -C "$PRO" status --porcelain)" ] || fail "$PRO is not clean"
git -C "$PRO" check-ignore -q smart/probe && fail "ui-pro ignores smart/ (.gitignore): the release would not carry it"
"${BIND[@]}" package --ui-root "$UI" --framework "$FRAMEWORK" --smart-root "$OUTPUT/smart" \
    || fail "the Pro rules disagree with the package reference of $FRAMEWORK"

step 'lay the build output'
mkdir -p "$PRO/smart"
rsync -a --delete "$OUTPUT/smart/" "$PRO/smart/"

step 'commit the build'
git -C "$PRO" add -A smart
git -C "$PRO" diff --cached --quiet && fail 'the output changes no byte in ui-pro/smart: there is nothing to release'
commit "$PRO" "Build: $SUBJECT" \
    "Built from ui-source-pro ${PRO_REVISION:0:8} over ui-source ${SOURCE_REVISION:0:8} with ui-builder ${BUILDER_REVISION:0:8}; tested against $FRAMEWORK."
RELEASE="$(git -C "$PRO" rev-parse HEAD)"
ID="pro-${RELEASE:0:12}"

step 'write the receipt'
"${BIND[@]}" receipt --pro-root "$PRO" --ui-root "$UI" --framework "$FRAMEWORK" --report "$REPORT" \
    --builder-revision "$BUILDER_REVISION" --output "$WORK/receipt.json"

step 'bind the owner manifest'
"${BIND[@]}" owners --pro-root "$PRO" --ui-root "$UI" --receipt "$WORK/receipt.json"

step 'write the release lock'
"${BIND[@]}" reference --pro-root "$PRO" --ui-root "$UI" --receipt "$WORK/receipt.json" \
    --source-root "$SOURCE" --pro-source-root "$PRO_SOURCE"

step 'Pro release gate'
"${BIND[@]}" check --pro-root "$PRO" --ui-root "$UI" \
    || fail "the Pro release gate is red: the bind of $ID is left uncommitted in $PRO"

step 'the bind commit'
git -C "$PRO" add -A contracts
commit "$PRO" "Bind the Pro release $ID" "$SUBJECT. Requires $FRAMEWORK (ui-source ${SOURCE_REVISION:0:12})."

printf '\nRELEASE %s build=%s bind=%s requires=%s source=%s pro-source=%s builder=%s receipt=%s\n' \
    "$ID" "${RELEASE:0:12}" "$(git -C "$PRO" rev-parse --short=12 HEAD)" "$FRAMEWORK" "${SOURCE_REVISION:0:12}" \
    "${PRO_REVISION:0:12}" "${BUILDER_REVISION:0:12}" "$WORK/receipt.json"
printf 'Nothing was pushed.\n'
