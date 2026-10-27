#!/usr/bin/env bash
# Publish a Framework release (lock v2) from verified build output. Never pushes.
#
# Usage:
#   scripts/publish-framework-release.sh \
#     --output <build output root>   (holds core/core, core/rule, component/component,
#                                     utility/utility, smart/smart; e.g. wave-1/output
#                                     of verify-product-reproducibility.cjs)
#     --ui <ui checkout> --source <ui-source checkout> \
#     [--mirror <ui-smart checkout> | --no-mirror] \
#     --subject "<what the release changes>" \
#     --changelog-entry <file> [--changelog-section <### heading; default: the first one under [Unreleased]>] \
#     [--builder-revision <ui-builder commit that built the output, default HEAD>] \
#     [--work <directory for the receipt, default a new temporary one>] \
#     [--trailer "<last paragraph of every commit message, e.g. a Co-Authored-By line>"]
#
# What it does, in order, stopping at the first failure:
#   1. Lays the output into ui/distr/{core,rule,component,utility,smart} and,
#      while ui-smart is a mirror, the same Smart bytes into ui-smart/smart.
#   2. Commits ui ("Build: <subject>"): that commit is the release, ui-<12>.
#      Commits ui-smart when its Smart bytes moved.
#   3. Writes the receipt (write-release-receipt.py).
#   4. simai.linkage (when the source has scripts/linkage.mjs): writes the unit
#      inventory of the source commit to ui/contracts/releases/ui-<12>.inventory.json
#      and, when an earlier release of ui HEAD carries an inventory, the change
#      report against the newest one to ui/contracts/releases/ui-<12>.changes.json.
#      The passports and the hash-moves-version rule are checked before anything
#      is laid down: a unit whose hash moved without a version bump stops the
#      publish there.
#   5. Binds the owner manifests (phase owners); commits the mirror's metadata.
#   6. Writes the release lock v2, and the v1 alias lock while mirrored
#      (phase reference); the lock points at the inventory (`unit_inventory`:
#      path, sha256, change report) when ui's lock validator accepts the field.
#   7. Runs ui/scripts/release-gate.sh (builds and checks the registry, runs the
#      registry suite and the release-lock checks). Red: nothing more is
#      committed and the bind is left in the ui worktree to inspect.
#   8. Adds the changelog entry and commits "Bind the registry to the release ui-<12>".
#
# Both checkouts must be clean before it starts: it commits what it lays down
# and nothing else.
set -euo pipefail

BUILDER_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUTPUT='' UI='' MIRROR='' SOURCE='' SUBJECT='' ENTRY='' SECTION='' BUILDER_REVISION='' WORK='' NO_MIRROR=0 TRAILER=
while [ $# -gt 0 ]; do
    case "$1" in
        --output) OUTPUT="$2"; shift 2 ;;
        --ui) UI="$2"; shift 2 ;;
        --mirror) MIRROR="$2"; shift 2 ;;
        --no-mirror) NO_MIRROR=1; shift ;;
        --source) SOURCE="$2"; shift 2 ;;
        --subject) SUBJECT="$2"; shift 2 ;;
        --changelog-entry) ENTRY="$2"; shift 2 ;;
        --changelog-section) SECTION="$2"; shift 2 ;;
        --builder-revision) BUILDER_REVISION="$2"; shift 2 ;;
        --work) WORK="$2"; shift 2 ;;
        --trailer) TRAILER="$2"; shift 2 ;;
        *) printf 'unknown argument: %s\n' "$1" >&2; exit 2 ;;
    esac
done

fail() { printf 'PUBLISH_FAILED — %s\n' "$*" >&2; exit 1; }
[ -n "$OUTPUT" ] && [ -n "$UI" ] && [ -n "$SOURCE" ] && [ -n "$SUBJECT" ] && [ -n "$ENTRY" ] || {
    sed -n '2,15p' "$0" >&2; exit 2; }
[ "$NO_MIRROR" = 1 ] || [ -n "$MIRROR" ] || fail 'name the ui-smart mirror with --mirror, or say --no-mirror'
[ "$NO_MIRROR" = 0 ] || [ -z "$MIRROR" ] || fail '--mirror and --no-mirror together'

OUTPUT="$(cd "$OUTPUT" && pwd)"; UI="$(cd "$UI" && pwd)"; SOURCE="$(cd "$SOURCE" && pwd)"
[ -z "$MIRROR" ] || MIRROR="$(cd "$MIRROR" && pwd)"
ENTRY="$(cd "$(dirname "$ENTRY")" && pwd)/$(basename "$ENTRY")"
[ -f "$ENTRY" ] || fail "no changelog entry at $ENTRY"
[ -n "$WORK" ] || WORK="$(mktemp -d "${TMPDIR:-/tmp}/framework-release.XXXXXX")"
mkdir -p "$WORK"; WORK="$(cd "$WORK" && pwd)"
BUILDER_REVISION="$(git -C "$BUILDER_ROOT" rev-parse --verify "${BUILDER_REVISION:-HEAD}^{commit}")"
SOURCE_REVISION="$(git -C "$SOURCE" rev-parse HEAD)"
# commit <repository> <message paragraphs...>: the trailer, when given, closes every message.
commit() {
    local repository="$1"; shift
    local arguments=()
    for paragraph in "$@" ${TRAILER:+"$TRAILER"}; do arguments+=(-m "$paragraph"); done
    git -C "$repository" commit -q "${arguments[@]}"
}
MIRROR_ARGS=()
[ -z "$MIRROR" ] || MIRROR_ARGS=(--mirror-root "$MIRROR")

LAYOUT=(core/core:distr/core core/rule:distr/rule component/component:distr/component utility/utility:distr/utility smart/smart:distr/smart)
for pair in "${LAYOUT[@]}"; do
    [ -d "$OUTPUT/${pair%%:*}" ] || fail "the build output has no ${pair%%:*}"
done
# A runtime tree git ignores is laid down and never committed.
git -C "$UI" check-ignore -q distr/smart/probe && fail "ui ignores distr/smart (.gitignore): the release would not carry Smart"
for repository in "$UI" ${MIRROR:+"$MIRROR"}; do
    [ -z "$(git -C "$repository" status --porcelain)" ] || fail "$repository is not clean"
done

step() { printf '\n== %s\n' "$*"; }

# simai.linkage: a source from before the standard has no linkage script.
LINKAGE="$SOURCE/scripts/linkage.mjs"
[ -f "$LINKAGE" ] || LINKAGE=''
# The newest release of ui HEAD whose inventory ui HEAD carries; read from
# HEAD, the checkout being clean.
PREVIOUS_INVENTORY='' PREVIOUS_ID=''
if [ -n "$LINKAGE" ]; then
    inventories="$(git -C "$UI" ls-tree --name-only HEAD contracts/releases/ | grep '\.inventory\.json$' || true)"
    if [ -n "$inventories" ]; then
        for writer in $(git -C "$UI" log --format=%H HEAD -- distr); do
            if printf '%s\n' "$inventories" | grep -qxF "contracts/releases/ui-${writer:0:12}.inventory.json"; then
                PREVIOUS_ID="ui-${writer:0:12}"
                PREVIOUS_INVENTORY="$WORK/$PREVIOUS_ID.inventory.json"
                git -C "$UI" show "HEAD:contracts/releases/$PREVIOUS_ID.inventory.json" > "$PREVIOUS_INVENTORY"
                break
            fi
        done
    fi
    step "simai.linkage passports${PREVIOUS_ID:+ against $PREVIOUS_ID}"
    node "$LINKAGE" passports --check --rev "$SOURCE_REVISION" ${PREVIOUS_INVENTORY:+--previous "$PREVIOUS_INVENTORY"} \
        || fail "simai.linkage is red for ui-source ${SOURCE_REVISION:0:12}: nothing was laid down"
fi

step 'lay the build output'
for pair in "${LAYOUT[@]}"; do
    mkdir -p "$UI/${pair##*:}"
    rsync -a --delete "$OUTPUT/${pair%%:*}/" "$UI/${pair##*:}/"
done
[ -z "$MIRROR" ] || rsync -a --delete "$OUTPUT/smart/smart/" "$MIRROR/smart/"

step 'commit the build'
BODY="Built from ui-source ${SOURCE_REVISION:0:8} with ui-builder ${BUILDER_REVISION:0:8}."
git -C "$UI" add -A distr
git -C "$UI" diff --cached --quiet && fail 'the output changes no byte in ui/distr: there is nothing to release'
commit "$UI" "Build: $SUBJECT" "$BODY"
RELEASE="$(git -C "$UI" rev-parse HEAD)"
if [ -n "$MIRROR" ]; then
    if [ -n "$(git -C "$MIRROR" status --porcelain smart)" ]; then
        git -C "$MIRROR" add -A smart
        commit "$MIRROR" "Build: $SUBJECT" "$BODY Mirror of simai/ui ${RELEASE:0:12}:distr/smart."
    fi
fi

step 'write the receipt'
python3 "$BUILDER_ROOT/scripts/write-release-receipt.py" --ui-root "$UI" ${MIRROR_ARGS[@]+"${MIRROR_ARGS[@]}"} \
    --source-root "$SOURCE" --builder-revision "$BUILDER_REVISION" --output "$WORK/receipt.json"

BIND=(python3 "$BUILDER_ROOT/scripts/bind-generated-runtime-contracts.py" --ui-root "$UI" --smart-root "$UI"
      ${MIRROR_ARGS[@]+"${MIRROR_ARGS[@]}"} --receipt "$WORK/receipt.json" --source-root "$SOURCE")
ID="ui-${RELEASE:0:12}"
LINKAGE_ARGS=()
if [ -n "$LINKAGE" ]; then
    step 'write the unit inventory and the change report'
    INVENTORY="$UI/contracts/releases/$ID.inventory.json"
    node "$LINKAGE" inventory --rev "$SOURCE_REVISION" --release "$ID" --out "$INVENTORY" \
        || fail "no unit inventory for $ID: the build commit is left in $UI"
    LINKAGE_ARGS=(--unit-inventory "$INVENTORY")
    if [ -n "$PREVIOUS_INVENTORY" ]; then
        CHANGES="$UI/contracts/releases/$ID.changes.json"
        node "$LINKAGE" compare "$PREVIOUS_INVENTORY" "$INVENTORY" --out "$CHANGES" \
            || fail "the change report $PREVIOUS_ID -> $ID has violations: the build commit is left in $UI"
        python3 -c 'import json,sys;r=json.load(open(sys.argv[1]));print("changes %s -> %s: %d added, %d removed, %d changed, %d with changed dependencies"%(r["from"]["release"],r["to"]["release"],len(r["added"]),len(r["removed"]),len(r["changed"]),len(r["dependencies_changed"])))' "$CHANGES"
        LINKAGE_ARGS+=(--change-report "$CHANGES")
    else
        printf 'no earlier release of ui HEAD carries an inventory: no change report\n'
    fi
fi

step 'bind the owner manifests'
"${BIND[@]}" --phase owners
if [ -n "$MIRROR" ] && [ -n "$(git -C "$MIRROR" status --porcelain)" ]; then
    git -C "$MIRROR" add -A contracts
    commit "$MIRROR" "Bind Smart metadata to the release for: $SUBJECT" "Mirror of simai/ui ${RELEASE:0:12}."
fi

step 'write the release lock'
REFERENCE="$("${BIND[@]}" --phase reference ${LINKAGE_ARGS[@]+"${LINKAGE_ARGS[@]}"} | tail -1)"
printf '%s\n' "$REFERENCE"
PAIR="$(printf '%s' "$REFERENCE" | python3 -c 'import json,sys;print(json.load(sys.stdin).get("pair") or "")')"

step 'release gate'
export SIMAI_UI_SMART_MANIFEST="$UI/contracts/owners/smart-component.manifest.json"
if [ -n "$MIRROR" ]; then export SIMAI_UI_SMART_ROOT="$MIRROR"; fi
bash "$UI/scripts/release-gate.sh" || fail "the release gate is red: the bind of $ID is left uncommitted in $UI"

step 'changelog and the bind commit'
python3 - "$UI/CHANGELOG.md" "$ENTRY" "$SECTION" <<'PY'
import sys
path, entry_path, section = sys.argv[1:4]
text = open(path, encoding='utf-8-sig').read()
entry = open(entry_path, encoding='utf-8').read()
unreleased = text.index('## [Unreleased]')
following = text.find('\n## ', unreleased + 1)
# The section names are the changelog's own, in its own language; without
# one named, the entry goes under the first section of [Unreleased].
if not section:
    first = text.find('\n### ', unreleased)
    if first == -1 or (following != -1 and first > following):
        raise SystemExit('CHANGELOG.md has no ### section under [Unreleased]; name one with --changelog-section')
    section = text[first + 5:text.index('\n', first + 1)].strip()
heading = f'### {section}\n'
at = text.find(heading, unreleased)
if at == -1 or (following != -1 and at > following):
    raise SystemExit(f'CHANGELOG.md has no "{heading.strip()}" under [Unreleased]')
at += len(heading) + 1
open(path, 'w', encoding='utf-8-sig').write(text[:at] + entry.rstrip('\n') + '\n\n' + text[at:])
PY
git -C "$UI" add -A
commit "$UI" "Bind the registry to the release $ID" \
    "$SUBJECT.${PAIR:+ While ui-smart is mirrored, v1 readers resolve it as $PAIR.}"

printf '\nRELEASE %s%s ui=%s bind=%s%s source=%s builder=%s receipt=%s\n' \
    "$ID" "${PAIR:+ (pair $PAIR)}" "${RELEASE:0:12}" "$(git -C "$UI" rev-parse --short=12 HEAD)" \
    "${MIRROR:+ mirror=$(git -C "$MIRROR" rev-parse --short=12 HEAD)}" "${SOURCE_REVISION:0:12}" "${BUILDER_REVISION:0:12}" "$WORK/receipt.json"
printf 'Nothing was pushed.\n'
