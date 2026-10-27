#!/usr/bin/env node
// Usage:
//   node scripts/reconcile.mjs [reconcile] --record <usage.json> --inventory <inventory>
//          [--inventory <inventory>]... [--releases <dir|url>] [--since <inventory>]...
//          [--changes <change-report>]... [--journal <journal.json|url>]
//          [--today <yyyy-mm-dd>] [--out <report.json>] [--json]
//          [--fail-on update-available|former-name|action-needed|missing]
//   node scripts/reconcile.mjs record --from-inventory <inventory> --units <id,id,...>
//          --place <locator> [--note <text>] [--consumer <id>] [--kind <kind>]
//          [--add-to <usage.json>] [--brought-up-on <yyyy-mm-dd>] [--out <usage.json>]
//
// Standard simai.linkage 1.0.0, requirements 11-16: a consumer of SIMAI
// Framework units (the Figma UI kit, a documentation page, a product, a
// customer project, an example) keeps a usage record -- the source and release
// it was brought up to, and for every place it uses a unit the unit's id,
// version and content hash -- and one command compares that record with a
// release's unit inventory. Every unit of every place gets one status:
//
//   current           the content hash is the inventory's;
//   update-available  a newer patch or minor (or the same version whose hash moved);
//   former-name       the id is a former id of a unit of the inventory (the journal
//                     names the new id and the date the former one stops working);
//   action-needed     a major step, or a journal entry between the two versions asks
//                     for a change (the entry's instruction is quoted);
//   missing           the inventory has no such unit and no unit took its name.
//
// Foundations count (requirement 13): a place's unit also depends on the
// token sets, fonts and icon sets it reaches through the inventory's
// dependencies, transitively. A foundation that moved between the record's
// release and the target marks the unit `via` that foundation, by the
// foundation's own step, even when the unit's hash is equal. To see what a
// foundation was, reconcile reads the inventory of the record's release
// (--since, or the record's release resolved like --inventory) or the change
// reports between the two (--changes).
//
// An inventory is a path, an http(s) URL (raw.githubusercontent.com or
// jsDelivr), or a release id (ui-<12 hex>) looked up as
// <releases>/<id>.inventory.json, where --releases is a local
// simai/ui checkout's contracts/releases folder or a URL of one.
//
// The script has no dependencies besides Node.js >= 20 and never writes to the
// consumer: the report goes to stdout and, with --out, to that file. The exit
// code is 0 unless --fail-on is given and a unit is at that status or worse
// (1), or the input is unusable (2).
import { existsSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const USAGE_SCHEMA = "simai.framework.unit-usage";
export const REPORT_SCHEMA = "simai.framework.unit-reconcile-report";
export const INVENTORY_SCHEMA = "simai.framework.unit-inventory";
export const CHANGE_REPORT_SCHEMA = "simai.framework.unit-change-report";
export const JOURNAL_SCHEMA = "simai.change-journal";
export const CONSUMER_KINDS = Object.freeze(["figma-kit", "docs", "product", "project", "example", "other"]);
// The status of a unit, from the best to the worst; a place takes its worst unit's.
export const STATUSES = Object.freeze(["current", "update-available", "former-name", "action-needed", "missing"]);
// The kinds the standard calls foundations: shared values other units read.
export const FOUNDATION_KINDS = Object.freeze(["tokens", "font", "icons"]);

const ID = /^[a-z][a-z0-9-]*\.[a-z0-9][a-z0-9.-]*$/u;
const VERSION = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const RELEASE = /^[a-z][a-z0-9-]*-[a-f0-9]{12}$/u;
const DATE = /^\d{4}-\d{2}-\d{2}$/u;

export class InputError extends Error
{
}

// ---------------------------------------------------------------------------
// Versions.

const parse = (version) => version.split(".").map(Number);

export function compareVersions(a, b)
{
    const [x, y] = [parse(a), parse(b)];
    for (let index = 0; index < 3; index += 1)
    {
        if (x[index] !== y[index])
        {
            return x[index] < y[index] ? -1 : 1;
        }
    }
    return 0;
}

/** major, minor, patch or none; below 1.0.0 a minor step is a major one, as a caret range reads it. */
export function versionStep(from, to)
{
    const [a, b] = [parse(from), parse(to)];
    if (a[0] !== b[0])
    {
        return "major";
    }
    if (a[1] !== b[1])
    {
        return a[0] === 0 ? "major" : "minor";
    }
    if (a[2] !== b[2])
    {
        return "patch";
    }
    return "none";
}

const severity = (status) => STATUSES.indexOf(status);
const worst = (statuses) => statuses.reduce((left, right) => (severity(right) > severity(left) ? right : left), "current");

// ---------------------------------------------------------------------------
// Loading: a path, a URL, or a release id under --releases.

async function readText(location)
{
    if (/^https?:\/\//u.test(location))
    {
        let response;
        try
        {
            response = await fetch(location);
        }
        catch (error)
        {
            throw new InputError(`cannot fetch ${location}: ${error.cause?.message || error.message}`);
        }
        if (!response.ok)
        {
            throw new InputError(`${location} answered ${response.status}`);
        }
        return response.text();
    }
    if (!existsSync(location) || !statSync(location).isFile())
    {
        throw new InputError(`no such file: ${location}`);
    }
    return readFileSync(location, "utf8");
}

export async function readJson(location)
{
    const text = await readText(location);
    try
    {
        return JSON.parse(text);
    }
    catch (error)
    {
        throw new InputError(`${location} is not JSON: ${error.message}`);
    }
}

/** Where an inventory argument points: itself, or <releases>/<id>.inventory.json for a release id. */
export function inventoryLocation(argument, releases)
{
    if (RELEASE.test(argument) && !existsSync(argument))
    {
        if (!releases)
        {
            throw new InputError(`${argument} is a release id: give --releases <simai/ui contracts/releases folder or URL> to find its inventory`);
        }
        return /^https?:\/\//u.test(releases)
            ? `${releases.replace(/\/+$/u, "")}/${argument}.inventory.json`
            : path.join(releases, `${argument}.inventory.json`);
    }
    return argument;
}

export function checkInventory(inventory, location)
{
    if (!inventory || inventory.schema !== INVENTORY_SCHEMA || inventory.schema_version !== 1 || !Array.isArray(inventory.units))
    {
        throw new InputError(`${location} is not a ${INVENTORY_SCHEMA} v1 inventory`);
    }
    for (const unit of inventory.units)
    {
        if (!ID.test(unit.id || "") || !VERSION.test(unit.version || "") || !SHA256.test(unit.content_sha256 || ""))
        {
            throw new InputError(`${location}: unit ${JSON.stringify(unit.id)} has no valid id, version or content_sha256`);
        }
    }
    return inventory;
}

export async function loadInventory(argument, releases)
{
    const location = inventoryLocation(argument, releases);
    return checkInventory(await readJson(location), location);
}

// ---------------------------------------------------------------------------
// The usage record.

/** The problems of a usage record against simai.framework.unit-usage v1; empty when it is valid. */
export function checkRecord(record)
{
    const problems = [];
    const at = (where, message) => problems.push(`${where}: ${message}`);
    const only = (value, where, keys) => {
        for (const key of Object.keys(value && typeof value === "object" ? value : {}))
        {
            if (!keys.includes(key))
            {
                at(`${where}${key}`, "is not a field of the record");
            }
        }
    };
    if (!record || typeof record !== "object" || Array.isArray(record))
    {
        return ["the record is not a JSON object"];
    }
    only(record, "", ["$schema", "schema", "schema_version", "consumer", "sources", "places"]);
    only(record.consumer, "consumer.", ["id", "kind", "title"]);
    if (record.schema !== USAGE_SCHEMA)
    {
        at("schema", `must be ${USAGE_SCHEMA}`);
    }
    if (record.schema_version !== 1)
    {
        at("schema_version", "must be 1");
    }
    const consumer = record.consumer;
    if (!consumer || typeof consumer.id !== "string" || !consumer.id)
    {
        at("consumer.id", "must be a non-empty string");
    }
    if (!consumer || !CONSUMER_KINDS.includes(consumer.kind))
    {
        at("consumer.kind", `must be one of ${CONSUMER_KINDS.join(", ")}`);
    }
    if (!Array.isArray(record.sources) || !record.sources.length)
    {
        at("sources", "must list at least one source");
    }
    for (const [index, source] of (Array.isArray(record.sources) ? record.sources : []).entries())
    {
        if (typeof source?.source !== "string" || !source.source)
        {
            at(`sources[${index}].source`, "must be a non-empty string");
        }
        only(source, `sources[${index}].`, ["source", "release", "revision", "brought_up_on"]);
        if (!source || !("release" in source))
        {
            at(`sources[${index}].release`, "must be given (a release id, or null)");
        }
        else if (source.release !== null && !RELEASE.test(source.release))
        {
            at(`sources[${index}].release`, "must be a release id such as ui-<12 hex>, or null");
        }
        if (source?.brought_up_on != null && !DATE.test(source.brought_up_on))
        {
            at(`sources[${index}].brought_up_on`, "must be a date yyyy-mm-dd");
        }
    }
    if (!Array.isArray(record.places))
    {
        at("places", "must be an array");
    }
    for (const [index, place] of (Array.isArray(record.places) ? record.places : []).entries())
    {
        only(place, `places[${index}].`, ["place", "note", "units"]);
        if (typeof place?.place !== "string" || !place.place)
        {
            at(`places[${index}].place`, "must be a non-empty locator");
        }
        if (!Array.isArray(place?.units) || !place.units.length)
        {
            at(`places[${index}].units`, "must list at least one unit");
            continue;
        }
        for (const [position, unit] of place.units.entries())
        {
            const where = `places[${index}].units[${position}]`;
            only(unit, `${where}.`, ["id", "version", "content_sha256", "source"]);
            if (!ID.test(unit?.id || ""))
            {
                at(`${where}.id`, "must be a unit id <kind>.<name>");
            }
            if (!VERSION.test(unit?.version || ""))
            {
                at(`${where}.version`, "must be major.minor.patch");
            }
            if (!SHA256.test(unit?.content_sha256 || ""))
            {
                at(`${where}.content_sha256`, "must be 64 lowercase hex digits");
            }
        }
    }
    return problems;
}

// ---------------------------------------------------------------------------
// The change journal: former ids and instructions.

/** The unit ids a journal record names: explicit `units`/`unit`, items' `unit`, and -- for a record without them -- a Smart component's tag. */
function journalUnits(record)
{
    const named = [];
    const add = (id, version) => ID.test(id || "") && named.push({ id, version: VERSION.test(version || "") ? version : null });
    for (const entry of Array.isArray(record.units) ? record.units : [])
    {
        typeof entry === "string" ? add(entry, record.version) : add(entry?.id, entry?.version ?? record.version);
    }
    if (typeof record.unit === "string")
    {
        add(record.unit, record.version);
    }
    for (const item of Array.isArray(record.items) ? record.items : [])
    {
        if (typeof item?.unit === "string")
        {
            add(item.unit, item.version ?? record.version);
        }
    }
    return named;
}

function journalTags(record)
{
    return new Set((Array.isArray(record.items) ? record.items : [])
        .map((item) => item?.component)
        .filter((tag) => typeof tag === "string" && tag.startsWith("sf-")));
}

/** What the entry asks a consumer to do, quoted from the journal. */
export function instructionOf(record)
{
    if (typeof record.manual === "string" && record.manual.trim())
    {
        return record.manual.trim();
    }
    const example = record.examples?.before && record.examples?.after
        ? ` (${record.examples.before} -> ${record.examples.after})`
        : "";
    return `${String(record.summary || record.id).trim()}${example}`;
}

export function indexJournal(journal)
{
    const records = Array.isArray(journal?.records) ? journal.records : [];
    const former = new Map();
    for (const record of records)
    {
        for (const item of Array.isArray(record.items) ? record.items : [])
        {
            if (ID.test(item?.from || "") && ID.test(item?.to || "") && item.from !== item.to)
            {
                former.set(item.from, { to: item.to, record });
            }
        }
    }
    const asking = records
        .filter((record) => record.rewrite !== "none")
        .map((record) => ({ record, units: journalUnits(record), tags: journalTags(record) }));
    return { records, former, asking };
}

function journalEntry(record, version)
{
    const entry = { id: record.id, recorded_on: record.recorded_on ?? null, stage: record.stage ?? null };
    if (version)
    {
        entry.version = version;
    }
    if (record.remove_after)
    {
        entry.remove_after = record.remove_after;
    }
    entry.instruction = instructionOf(record);
    return entry;
}

/**
 * The journal entries between a used and a target version of one unit that
 * ask for a change. An entry that names the unit with a version counts when
 * that version is above the used one and not above the target; an entry
 * without a version (the journal before per-version entries, matched by a
 * Smart component's tag) counts when it was recorded after the date the
 * consumer was brought up to that source.
 */
export function journalBetween(index, id, used, target, broughtUpOn)
{
    if (!index)
    {
        return [];
    }
    const found = [];
    const tag = id.startsWith("smart.") ? `sf-${id.slice("smart.".length)}` : null;
    for (const { record, units, tags } of index.asking)
    {
        const mine = units.filter((unit) => unit.id === id);
        const versioned = mine.find((unit) => unit.version);
        if (versioned)
        {
            if (used && target && compareVersions(used, versioned.version) < 0 && compareVersions(versioned.version, target) <= 0)
            {
                found.push(journalEntry(record, versioned.version));
            }
            continue;
        }
        const named = mine.length > 0 || (units.length === 0 && tag && tags.has(tag));
        if (named && broughtUpOn && typeof record.recorded_on === "string" && record.recorded_on > broughtUpOn)
        {
            found.push(journalEntry(record, null));
        }
    }
    return found.sort((a, b) => String(a.recorded_on).localeCompare(String(b.recorded_on)) || a.id.localeCompare(b.id));
}

// ---------------------------------------------------------------------------
// Reconcile.

/** Every unit an id reaches through the inventory's dependencies, without itself. */
export function closure(byId, id)
{
    const seen = new Set([id]);
    const queue = [id];
    while (queue.length)
    {
        const unit = byId.get(queue.shift());
        for (const dependency of unit?.dependencies ?? [])
        {
            if (!seen.has(dependency.id))
            {
                seen.add(dependency.id);
                queue.push(dependency.id);
            }
        }
    }
    seen.delete(id);
    return [...seen].sort();
}

/** The earliest from-version and latest to-version of every unit across change reports. */
function changesFrom(reports)
{
    const moved = new Map();
    for (const report of reports)
    {
        for (const change of report.changed ?? [])
        {
            const known = moved.get(change.id);
            if (!known)
            {
                moved.set(change.id, { from_version: change.from_version, to_version: change.to_version });
                continue;
            }
            if (compareVersions(change.from_version, known.from_version) < 0)
            {
                known.from_version = change.from_version;
            }
            if (compareVersions(change.to_version, known.to_version) > 0)
            {
                known.to_version = change.to_version;
            }
        }
    }
    return moved;
}

function statusOfStep(step)
{
    return step === "major" ? "action-needed" : "update-available";
}

/** How one foundation moved between the record's release and the target, or null when it did not. */
function foundationMove(id, target, context)
{
    const now = target.byId.get(id);
    let before = null;
    if (context.since)
    {
        before = context.since.byId.get(id);
        if (!before)
        {
            return null;
        }
        if (before.content_sha256 === now.content_sha256 && before.version === now.version)
        {
            return null;
        }
    }
    else if (context.moved)
    {
        before = context.moved.get(id) ? { version: context.moved.get(id).from_version } : null;
        if (!before)
        {
            return null;
        }
    }
    else
    {
        return null;
    }
    const step = versionStep(before.version, now.version);
    const via = { id, kind: now.kind, from_version: before.version, to_version: now.version, step };
    const reasons = [];
    let status = step === "none" ? "update-available" : statusOfStep(step);
    if (step === "none")
    {
        reasons.push(`${id} ${now.version}: its hash moved while its version did not`);
    }
    const journal = journalBetween(context.journal, id, before.version, now.version, null);
    if (journal.length)
    {
        status = "action-needed";
        via.journal = journal;
    }
    via.status = status;
    if (reasons.length)
    {
        via.reasons = reasons;
    }
    return via;
}

function reconcileUnit(used, context)
{
    const result = { id: used.id, version: used.version, content_sha256: used.content_sha256 };
    if (used.source)
    {
        result.source = used.source;
    }
    const reasons = [];
    let status = "current";
    let target = null;
    let id = used.id;
    let inventory = context.inventoryFor(used);

    if (!inventory || !inventory.byId.has(id))
    {
        const former = context.journal?.former.get(id);
        const owner = former && context.inventories.find((candidate) => candidate.byId.has(former.to));
        if (former && owner)
        {
            const { record } = former;
            result.former = {
                to: former.to,
                version: owner.byId.get(former.to).version,
                journal: record.id,
                until: record.removed_on ?? record.remove_after ?? null,
            };
            if (record.stage === "removed")
            {
                status = "missing";
                reasons.push(`${id} was renamed to ${former.to} and the former name was removed on ${record.removed_on ?? record.remove_after}`);
            }
            else
            {
                status = "former-name";
                reasons.push(`${id} is a former name of ${former.to}; it works until ${record.remove_after ?? "an undated removal"}`);
                if (record.remove_after && context.today > record.remove_after)
                {
                    result.former.expired = true;
                    reasons.push(`the former name stopped on ${record.remove_after}`);
                }
            }
            result.former.instruction = instructionOf(record);
            const renamed = owner.byId.get(former.to);
            if (status !== "missing" && compareVersions(renamed.version, used.version) > 0 && versionStep(used.version, renamed.version) === "major")
            {
                status = "action-needed";
                reasons.push(`major change ${used.version} -> ${renamed.version} under the new id`);
            }
            id = former.to;
            inventory = owner;
        }
        else
        {
            result.status = "missing";
            result.reasons = [inventory ? `${inventory.source} ${inventory.release ?? inventory.revision.slice(0, 12)} has no unit ${id}` : `no inventory carries ${id}`];
            return result;
        }
    }

    target = inventory.byId.get(id);
    result.current = { id, version: target.version, content_sha256: target.content_sha256 };
    if (id === used.id)
    {
        if (target.content_sha256 !== used.content_sha256)
        {
            const order = compareVersions(target.version, used.version);
            if (order > 0)
            {
                const step = versionStep(used.version, target.version);
                result.step = step;
                status = statusOfStep(step);
                reasons.push(step === "major" ? `major change ${used.version} -> ${target.version}` : `${step} ${used.version} -> ${target.version}`);
            }
            else if (order === 0)
            {
                status = "update-available";
                reasons.push(`${id} ${target.version}: the hash moved while the version did not`);
            }
            else
            {
                status = "action-needed";
                reasons.push(`the record names ${used.version}, newer than the inventory's ${target.version}`);
            }
        }
        const journal = journalBetween(context.journal, id, used.version, target.version, context.broughtUpOn(inventory.source));
        if (journal.length)
        {
            result.journal = journal;
            status = worst([status, "action-needed"]);
            reasons.push(`${journal.length} journal ${journal.length === 1 ? "entry asks" : "entries ask"} for a change`);
        }
    }

    const foundations = context.foundationContext(inventory);
    if (foundations)
    {
        const via = [];
        for (const dependency of closure(inventory.byId, id))
        {
            const unit = inventory.byId.get(dependency);
            if (!unit || !FOUNDATION_KINDS.includes(unit.kind))
            {
                continue;
            }
            const move = foundationMove(dependency, inventory, foundations);
            if (move)
            {
                via.push(move);
            }
        }
        if (via.length)
        {
            result.via = via;
            status = worst([status, ...via.map((move) => move.status)]);
            reasons.push(`foundations moved: ${via.map((move) => `${move.id} ${move.from_version} -> ${move.to_version}`).join(", ")}`);
        }
    }
    else
    {
        result.foundations = "unchecked";
    }

    result.status = status;
    if (reasons.length)
    {
        result.reasons = reasons;
    }
    return result;
}

const indexed = (inventory) => ({ ...inventory, byId: new Map(inventory.units.map((unit) => [unit.id, unit])) });
const identity = (inventory) => ({ source: inventory.source, release: inventory.release ?? null, revision: inventory.revision ?? null });

/**
 * The reconcile report of one usage record against one or more inventories
 * (one per source). `since` holds the inventories of the record's releases,
 * `changes` change reports between them and the targets, `journal` the change
 * journal; each is optional.
 */
export function reconcile(record, inventories, { since = [], changes = [], journal = null, today = new Date().toISOString().slice(0, 10) } = {})
{
    const problems = checkRecord(record);
    if (problems.length)
    {
        throw new InputError(`the usage record is not valid:\n  ${problems.join("\n  ")}`);
    }
    if (!inventories.length)
    {
        throw new InputError("give at least one inventory");
    }
    const targets = inventories.map(indexed);
    const before = since.map(indexed);
    const journalIndex = journal ? indexJournal(journal) : null;
    const notes = [];
    const recordSources = new Map(record.sources.map((source) => [source.source, source]));

    const context = {
        inventories: targets,
        journal: journalIndex,
        today,
        inventoryFor(unit)
        {
            if (unit.source)
            {
                return targets.find((inventory) => inventory.source === unit.source) ?? null;
            }
            return targets.find((inventory) => inventory.byId.has(unit.id)) ?? (targets.length === 1 ? targets[0] : null);
        },
        broughtUpOn(source)
        {
            return recordSources.get(source)?.brought_up_on ?? null;
        },
        foundationContext(inventory)
        {
            const earlier = before.find((candidate) => candidate.source === inventory.source);
            if (earlier)
            {
                return { since: earlier, journal: journalIndex };
            }
            const reports = changes.filter((report) => report.source === inventory.source);
            if (reports.length)
            {
                return { moved: changesFrom(reports), journal: journalIndex };
            }
            if (recordSources.get(inventory.source)?.release && recordSources.get(inventory.source).release === inventory.release)
            {
                return { since: inventory, journal: journalIndex };
            }
            return null;
        },
    };

    for (const inventory of targets)
    {
        const recorded = recordSources.get(inventory.source);
        if (!recorded)
        {
            notes.push(`the record lists no source ${inventory.source}; its units are matched by id`);
        }
        if (!context.foundationContext(inventory))
        {
            notes.push(`foundations of ${inventory.source} are unchecked: give --since <inventory of ${recorded?.release ?? "the record's release"}> or --changes <reports>`);
        }
    }
    if (!journalIndex)
    {
        notes.push("no change journal given: former names are reported missing and no instruction is quoted (--journal)");
    }
    else if (!record.sources.some((source) => source.brought_up_on))
    {
        notes.push("journal entries without a unit version are placed by date: give sources[].brought_up_on to include them");
    }

    const totals = Object.fromEntries(STATUSES.map((status) => [status, 0]));
    const placeTotals = Object.fromEntries(STATUSES.map((status) => [status, 0]));
    const places = record.places.map((place) => {
        const units = place.units.map((unit) => reconcileUnit(unit, context));
        for (const unit of units)
        {
            totals[unit.status] += 1;
        }
        const status = worst(units.map((unit) => unit.status));
        placeTotals[status] += 1;
        const entry = { place: place.place, status };
        if (place.note)
        {
            entry.note = place.note;
        }
        entry.units = units;
        return entry;
    });

    return {
        schema: REPORT_SCHEMA,
        schema_version: 1,
        checked_on: today,
        consumer: { id: record.consumer.id, kind: record.consumer.kind },
        record_sources: record.sources,
        inventories: targets.map(identity),
        since: before.map(identity),
        journal: journalIndex ? { records: journalIndex.records.length } : null,
        status: worst(places.map((place) => place.status)),
        totals: { places: placeTotals, units: totals },
        places,
        notes,
    };
}

// ---------------------------------------------------------------------------
// The human summary.

export function summarize(report)
{
    const lines = [];
    const release = (inventory) => inventory.release ?? (inventory.revision ? inventory.revision.slice(0, 12) : "?");
    const counts = (totals) => STATUSES.filter((status) => totals[status]).map((status) => `${totals[status]} ${status}`).join(", ") || "none";
    lines.push(`Reconcile ${report.consumer.id} (${report.consumer.kind}) against ${report.inventories.map((inventory) => `${inventory.source} ${release(inventory)}`).join(", ")}`
        + (report.since.length ? ` since ${report.since.map(release).join(", ")}` : ""));
    lines.push(`Places ${report.places.length}: ${counts(report.totals.places)}`);
    lines.push(`Units ${report.places.reduce((sum, place) => sum + place.units.length, 0)}: ${counts(report.totals.units)}`);
    for (const place of report.places)
    {
        lines.push("");
        lines.push(`[${place.status}] ${place.place}${place.note ? ` -- ${place.note}` : ""}`);
        for (const unit of place.units)
        {
            const now = unit.current ? `${unit.current.id === unit.id ? "" : `${unit.current.id} `}${unit.current.version}` : "gone";
            lines.push(`  ${unit.id} ${unit.version} -> ${now}: ${unit.status}${unit.foundations ? " (foundations unchecked)" : ""}`);
            for (const reason of unit.reasons ?? [])
            {
                lines.push(`    ${reason}`);
            }
            if (unit.former)
            {
                lines.push(`    journal ${unit.former.journal}: "${unit.former.instruction}"`);
            }
            for (const entry of unit.journal ?? [])
            {
                lines.push(`    journal ${entry.id} (${entry.recorded_on}${entry.version ? `, ${entry.version}` : ""}): "${entry.instruction}"`);
            }
            for (const via of unit.via ?? [])
            {
                lines.push(`    via ${via.id} ${via.from_version} -> ${via.to_version} (${via.step}): ${via.status}`);
                for (const entry of via.journal ?? [])
                {
                    lines.push(`      journal ${entry.id} (${entry.recorded_on}): "${entry.instruction}"`);
                }
            }
        }
    }
    if (report.notes.length)
    {
        lines.push("");
        for (const note of report.notes)
        {
            lines.push(`Note: ${note}`);
        }
    }
    return `${lines.join("\n")}\n`;
}

// ---------------------------------------------------------------------------
// Starting a record.

/** A usage record (new, or `base` with one more place) for units of an inventory. */
export function recordFrom(inventory, { units, place, note = null, consumer = "unnamed", kind = "other", base = null, broughtUpOn = null })
{
    if (!place)
    {
        throw new InputError("give --place <locator>");
    }
    if (!units.length)
    {
        throw new InputError("give --units <id,id,...>");
    }
    const byId = new Map(inventory.units.map((unit) => [unit.id, unit]));
    const unknown = units.filter((id) => !byId.has(id));
    if (unknown.length)
    {
        throw new InputError(`the inventory has no unit ${unknown.join(", ")}`);
    }
    if (!CONSUMER_KINDS.includes(kind))
    {
        throw new InputError(`--kind must be one of ${CONSUMER_KINDS.join(", ")}`);
    }
    const record = base
        ? JSON.parse(JSON.stringify(base))
        : { schema: USAGE_SCHEMA, schema_version: 1, consumer: { id: consumer, kind }, sources: [], places: [] };
    if (base)
    {
        const problems = checkRecord(base);
        if (problems.length)
        {
            throw new InputError(`the record to add to is not valid:\n  ${problems.join("\n  ")}`);
        }
    }
    const source = { source: inventory.source, release: inventory.release ?? null };
    if (inventory.revision)
    {
        source.revision = inventory.revision;
    }
    if (broughtUpOn)
    {
        source.brought_up_on = broughtUpOn;
    }
    const known = record.sources.findIndex((entry) => entry.source === inventory.source);
    if (known < 0)
    {
        record.sources.push(source);
    }
    else if (record.sources[known].release !== source.release)
    {
        throw new InputError(`the record was brought up to ${record.sources[known].release} of ${inventory.source}; reconcile and bring it up before adding places from ${source.release}`);
    }
    const entry = { place, units: units.map((id) => ({ id, version: byId.get(id).version, content_sha256: byId.get(id).content_sha256 })) };
    if (note)
    {
        entry.note = note;
    }
    const existing = record.places.findIndex((candidate) => candidate.place === place);
    if (existing < 0)
    {
        record.places.push(entry);
    }
    else
    {
        record.places[existing] = entry;
    }
    return record;
}

// ---------------------------------------------------------------------------
// The command line.

const REPEATED = new Set(["inventory", "since", "changes"]);
const FLAGS = new Set(["json"]);

export function parseArguments(argv)
{
    const options = { inventory: [], since: [], changes: [] };
    let command = "reconcile";
    const rest = [...argv];
    if (rest[0] && !rest[0].startsWith("--"))
    {
        command = rest.shift();
    }
    for (let index = 0; index < rest.length; index += 1)
    {
        const argument = rest[index];
        if (!argument.startsWith("--"))
        {
            throw new InputError(`unexpected argument ${argument}`);
        }
        const [key, inline] = argument.slice(2).split(/=(.*)/su, 2);
        if (FLAGS.has(key))
        {
            options[key] = true;
            continue;
        }
        const value = inline ?? rest[index += 1];
        if (value == null)
        {
            throw new InputError(`--${key} needs a value`);
        }
        if (REPEATED.has(key))
        {
            options[key].push(value);
        }
        else
        {
            options[key] = value;
        }
    }
    return { command, options };
}

export const USAGE = [
    "Usage: node scripts/reconcile.mjs [reconcile] --record <usage.json> --inventory <path|url|release-id>",
    "         [--inventory ...] [--releases <dir|url>] [--since <inventory>]... [--changes <report>]...",
    "         [--journal <path|url>] [--today yyyy-mm-dd] [--out <report.json>] [--json]",
    "         [--fail-on update-available|former-name|action-needed|missing]",
    "       node scripts/reconcile.mjs record --from-inventory <inventory> --units <id,id,...> --place <locator>",
    "         [--note <text>] [--consumer <id>] [--kind <kind>] [--add-to <usage.json>]",
    "         [--brought-up-on yyyy-mm-dd] [--releases <dir|url>] [--out <usage.json>]",
].join("\n");

export async function main(argv, io = { stdout: process.stdout, stderr: process.stderr })
{
    let parsed;
    try
    {
        parsed = parseArguments(argv);
        const { command, options } = parsed;
        if (command === "help" || options.help)
        {
            io.stdout.write(`${USAGE}\n`);
            return 0;
        }
        if (command === "record")
        {
            if (!options["from-inventory"])
            {
                throw new InputError("give --from-inventory <inventory>");
            }
            const inventory = await loadInventory(options["from-inventory"], options.releases);
            const base = options["add-to"] ? await readJson(options["add-to"]) : null;
            const record = recordFrom(inventory, {
                units: String(options.units || "").split(",").map((id) => id.trim()).filter(Boolean),
                place: options.place,
                note: options.note ?? null,
                consumer: options.consumer ?? "unnamed",
                kind: options.kind ?? "other",
                base,
                broughtUpOn: options["brought-up-on"] ?? null,
            });
            const text = `${JSON.stringify(record, null, 2)}\n`;
            options.out ? writeFileSync(options.out, text) : io.stdout.write(text);
            return 0;
        }
        if (command !== "reconcile")
        {
            throw new InputError(`unknown command ${command}`);
        }
        if (!options.record)
        {
            throw new InputError("give --record <usage.json>");
        }
        if (options["fail-on"] && severity(options["fail-on"]) < 1)
        {
            throw new InputError(`--fail-on must be one of ${STATUSES.slice(1).join(", ")}`);
        }
        if (options.today && !DATE.test(options.today))
        {
            throw new InputError("--today must be yyyy-mm-dd");
        }
        const record = await readJson(options.record);
        const problems = checkRecord(record);
        if (problems.length)
        {
            throw new InputError(`${options.record} is not a valid usage record:\n  ${problems.join("\n  ")}`);
        }
        const inventories = [];
        for (const argument of options.inventory)
        {
            inventories.push(await loadInventory(argument, options.releases));
        }
        const since = [];
        for (const argument of options.since)
        {
            since.push(await loadInventory(argument, options.releases));
        }
        // The record's own release, when it is not the target and --since did not give it.
        const notes = [];
        for (const inventory of inventories)
        {
            const recorded = record.sources.find((source) => source.source === inventory.source);
            if (!recorded?.release || recorded.release === inventory.release || since.some((entry) => entry.source === inventory.source) || !options.releases)
            {
                continue;
            }
            try
            {
                since.push(await loadInventory(recorded.release, options.releases));
            }
            catch (error)
            {
                notes.push(`the inventory of ${recorded.release} was not found (${error.message})`);
            }
        }
        const changes = [];
        for (const argument of options.changes)
        {
            const report = await readJson(argument);
            if (report?.schema !== CHANGE_REPORT_SCHEMA)
            {
                throw new InputError(`${argument} is not a ${CHANGE_REPORT_SCHEMA}`);
            }
            changes.push(report);
        }
        let journal = null;
        if (options.journal)
        {
            journal = await readJson(options.journal);
            if (journal?.schema !== JOURNAL_SCHEMA || !Array.isArray(journal.records))
            {
                throw new InputError(`${options.journal} is not a ${JOURNAL_SCHEMA}`);
            }
        }
        const report = reconcile(record, inventories, { since, changes, journal, ...(options.today ? { today: options.today } : {}) });
        report.notes.unshift(...notes);
        const text = `${JSON.stringify(report, null, 2)}\n`;
        if (options.out)
        {
            writeFileSync(options.out, text);
        }
        io.stdout.write(options.json ? text : summarize(report));
        if (options["fail-on"])
        {
            const threshold = severity(options["fail-on"]);
            return report.places.some((place) => place.units.some((unit) => severity(unit.status) >= threshold)) ? 1 : 0;
        }
        return 0;
    }
    catch (error)
    {
        if (error instanceof InputError)
        {
            io.stderr.write(`reconcile: ${error.message}\n${parsed ? "" : `${USAGE}\n`}`);
            return 2;
        }
        throw error;
    }
}

const invoked = process.argv[1] && existsSync(process.argv[1]) ? realpathSync(process.argv[1]) : null;
if (invoked && invoked === realpathSync(fileURLToPath(import.meta.url)))
{
    process.exitCode = await main(process.argv.slice(2));
}
