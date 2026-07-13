/**
 * Change-alert prototype — end-to-end.
 *
 *   TRIGGER  → detect a new model version  (poll AEC Data Model for the watched file's version)
 *   DIFF     → mp_diff_versions            (Model Properties API, SSA — no 3LO)
 *   TRIAGE   → severity.ts                 (HOW it changed + does it MATTER — the differentiator)
 *   RULES    → rules.ts                    (category/property change → discipline)
 *   ALERT    → one ACC issue per discipline, PINNED to the worst changed element (issues API)
 *
 * Over Forma "Compare Versions" this adds the three things its export can't do:
 *   #1  HOW it changed — quantified old→new, incl. Geometry/Transform (severity.ts)
 *   #2  a locatable element — a 3D pushpin on the exact changed element (pin.ts)
 *   #3  an issue created straight from the compare, routed to the affected discipline
 *
 * Reuses the published core SDK (`acc-forma-mcp-server/core` → ../../src/core.ts).
 *
 * Run:
 *   npx tsx prototypes/change-alert/index.mts                 # dry-run on latest two versions
 *   FORCE=1 npx tsx prototypes/change-alert/index.mts         # ignore saved state, always diff
 *   PREV=3 CUR=4 npx tsx prototypes/change-alert/index.mts    # explicit version pair
 *   MIN_SEVERITY=MEDIUM npx tsx prototypes/change-alert/index.mts  # lower the alert threshold
 *   CREATE_ISSUES=1 npx tsx prototypes/change-alert/index.mts # actually create the ACC issue (draft) + pin
 */
import 'dotenv/config';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { SsaAuthProvider, aecdmApi, modelPropertiesApi, issuesApi } from '../../src/core.js';
import type { DiffElement } from '../../src/apis/model-properties.js';
import type { LinkedDocument } from '../../src/apis/issues.js';
import { evaluateRules, groupByDiscipline, type RuleMatch } from './rules.js';
import { assess, bySeverityDesc, SEVERITY_RANK, type Assessment, type Severity } from './severity.js';
import { buildElementPin, isPinnable } from './pin.js';

// ── Config (Ken - MCP Testing project) ─────────────────────────────────────────
const CONFIG = {
  aecdmProjectId: 'urn:adsk.workspace:prod.project:80424913-8ca5-4e39-80b0-ebf00ad69385',
  dmProjectId: '57deb033-4608-46de-ab21-fcb0404de6d3', // for MP diff + issues (no b.)
  watchModel: 'R27_Snowdon Towers Sample Architectural.rvt',
  // Calibrated viewer globalOffset for the Architectural model (see CLAUDE.md / pin-element.ts).
  archGlobalOffset: { x: -19.068394820, y: -5.405197144, z: 25.708333651 },
};
const __dir = dirname(fileURLToPath(import.meta.url));
const STATE_FILE = join(__dir, '.state.json');
const DRY_RUN = process.env['CREATE_ISSUES'] !== '1';
// Only alert on changes at or above this severity — suppresses low-impact noise (finish swaps,
// nudged non-structural elements). CRITICAL > HIGH > MEDIUM > LOW.
const MIN_SEVERITY = (process.env['MIN_SEVERITY'] as Severity) || 'HIGH';

const auth = new SsaAuthProvider(['data:read', 'data:write', 'account:read']);

// ── Trigger: is there a new version of the watched model? ───────────────────────
interface WatchState { [model: string]: number }
const loadState = (): WatchState => (existsSync(STATE_FILE) ? JSON.parse(readFileSync(STATE_FILE, 'utf8')) as WatchState : {});
const saveState = (s: WatchState): void => writeFileSync(STATE_FILE, JSON.stringify(s, null, 2));
const parseVersion = (urn: string): number => Number(/version=(\d+)/.exec(urn)?.[1] ?? '0');
const lineageOf = (urn: string): string => urn.replace(/\?version=\d+$/, '');

interface Detected { prevUrn: string; curUrn: string; prev: number; cur: number; elementGroupId: string }

async function detectNewVersion(): Promise<Detected | null> {
  const groups = await aecdmApi.listAecdmElementGroups(auth, CONFIG.aecdmProjectId);
  const model = groups.find((g) => g.name === CONFIG.watchModel);
  if (!model) throw new Error(`Watched model not found: ${CONFIG.watchModel}`);

  const cur = process.env['CUR'] ? Number(process.env['CUR']) : parseVersion(model.fileVersionUrn);
  const state = loadState();
  const last = process.env['PREV'] ? Number(process.env['PREV']) : (state[CONFIG.watchModel] ?? cur - 1);

  console.log(`  watched: ${CONFIG.watchModel}`);
  console.log(`  latest version: v${cur}   last processed: v${last}`);

  if (cur <= last && process.env['FORCE'] !== '1') {
    console.log('  → no new version. (set FORCE=1 to re-run, or PREV/CUR to pick a pair)');
    return null;
  }
  const lineage = lineageOf(model.fileVersionUrn);
  return {
    prevUrn: `${lineage}?version=${last}`,
    curUrn: `${lineage}?version=${cur}`,
    prev: last,
    cur,
    elementGroupId: model.id,
  };
}

// ── Triage: assess + dedupe + rank the elements routed to a discipline ──────────
interface AssessedEl { el: DiffElement; assessment: Assessment }

function assessedForDiscipline(matches: RuleMatch[]): AssessedEl[] {
  const seen = new Map<string, AssessedEl>();
  for (const m of matches) {
    for (const el of m.elements) {
      const key = el.externalId ?? `${el.category ?? '?'}::${el.name ?? '?'}`;
      if (!seen.has(key)) seen.set(key, { el, assessment: assess(el) });
    }
  }
  return [...seen.values()].sort((a, b) => bySeverityDesc(a.assessment, b.assessment));
}

const SEVERITY_TALLY = (items: AssessedEl[]): string =>
  (['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'] as Severity[])
    .map((s) => ({ s, n: items.filter((i) => i.assessment.severity === s).length }))
    .filter((x) => x.n > 0)
    .map((x) => `${x.n} ${x.s.toLowerCase()}`)
    .join(', ');

// ── Alerting: turn ranked, assessed elements into an ACC issue payload ──────────
// ACC Issues caps `description` at 1000 chars — assemble greedily within that budget.
const DESC_MAX = 1000;

function buildIssueBody(
  discipline: string,
  ranked: AssessedEl[],
  prev: number,
  cur: number,
  pinNote?: string,
): { title: string; description: string } {
  const title = `[Auto] ${discipline} review — ${CONFIG.watchModel} v${prev}→v${cur} (${SEVERITY_TALLY(ranked)})`;

  const header = `Impact triage of Architectural diff v${prev}→v${cur} — ${ranked.length} change(s) need ${discipline} review:`;
  const footer = pinNote ? `\n📍 ${pinNote}` : '';

  // One compact block per element: "[SEV] ~ Name [Cat] — headline · changed: detail".
  const blocks = ranked.map(({ el, assessment }) => {
    const sign = el.kind === 'ADDED' ? '+' : el.kind === 'REMOVED' ? '-' : '~';
    let b = `[${assessment.severity}] ${sign} ${el.name ?? '(unnamed)'} [${el.category ?? '?'}] — ${assessment.headline}`;
    // Only append the delta when it adds info beyond the headline (property changes).
    if (el.changes && el.changes.length > 0) b += ` · ${assessment.detail}`;
    return b;
  });

  const parts: string[] = [header];
  let used = header.length + footer.length;
  let shown = 0;
  for (const b of blocks) {
    const cost = b.length + 1; // + newline
    const moreNote = `\n…and ${ranked.length - shown} more (open the model to see all)`;
    if (used + cost + moreNote.length > DESC_MAX && shown > 0) break;
    parts.push(b);
    used += cost;
    shown++;
  }
  if (shown < ranked.length) parts.push(`…and ${ranked.length - shown} more (open the model to see all)`);

  let description = parts.join('\n') + footer;
  if (description.length > DESC_MAX) description = description.slice(0, DESC_MAX - 1) + '…';
  return { title, description };
}

async function pickIssueSubtypeId(): Promise<string | undefined> {
  const types = await issuesApi.listIssueTypes(auth, CONFIG.dmProjectId);
  for (const t of types) {
    const sub = t.subtypes?.find((s) => s.isActive !== false);
    if (sub) return sub.id;
  }
  return undefined;
}

// ── Main ───────────────────────────────────────────────────────────────────────
async function main(): Promise<void> {
  console.log('\n[1] TRIGGER — checking for a new model version…');
  const ver = await detectNewVersion();
  if (!ver) return;
  console.log(`  → NEW VERSION detected: diffing v${ver.prev} → v${ver.cur}`);

  console.log('\n[2] DIFF — Model Properties version diff (SSA)…');
  let status = await modelPropertiesApi.createVersionDiff(auth, CONFIG.dmProjectId, ver.prevUrn, ver.curUrn);
  const deadline = Date.now() + 90_000;
  while (status.state !== 'FINISHED' && status.state !== 'FAILED' && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 4000));
    status = await modelPropertiesApi.getVersionDiff(auth, CONFIG.dmProjectId, status.diffId);
  }
  if (status.state !== 'FINISHED' || !status.fieldsUrl || !status.propertiesUrl) {
    console.log(`  diff not ready (state=${status.state}). Try again.`);
    return;
  }
  console.log(`  stats: +${status.stats?.added} added, -${status.stats?.removed} removed, ~${status.stats?.modified} modified`);

  const fields = await modelPropertiesApi.downloadDiffFields(auth, status.fieldsUrl);
  const elements = await modelPropertiesApi.downloadDiffProperties(auth, status.propertiesUrl, fields, 5000);

  console.log('\n[3] TRIAGE + RULES — routing changes to disciplines by impact…');
  const matches = evaluateRules(elements);
  if (matches.length === 0) {
    console.log('  no rules matched — nothing to alert.');
    return;
  }
  const byDiscipline = groupByDiscipline(matches);

  console.log('\n[4] ALERT — ' + (DRY_RUN ? 'DRY-RUN (set CREATE_ISSUES=1 to create + pin)' : 'creating ACC issues (draft) + pinning') + '…');
  console.log(`  alert threshold: >= ${MIN_SEVERITY}`);
  const subtypeId = DRY_RUN ? undefined : await pickIssueSubtypeId();

  for (const [discipline, ms] of byDiscipline) {
    const all = assessedForDiscipline(ms);
    const ranked = all.filter((a) => SEVERITY_RANK[a.assessment.severity] >= SEVERITY_RANK[MIN_SEVERITY]);
    const suppressed = all.length - ranked.length;

    console.log(`\n  ${discipline}: ${all.length} changed element(s) — ${ranked.length} >= ${MIN_SEVERITY}, ${suppressed} suppressed as noise`);
    if (ranked.length === 0) {
      console.log('  → nothing above threshold; no issue.');
      continue;
    }

    // Anchor the issue on the WORST element that can actually be pinned. Only point-placed
    // elements (columns, doors, fixtures) have an AECDM origin, and not every instance does —
    // so walk the ranked candidates in severity order and take the first that resolves.
    let pin: LinkedDocument | undefined;
    let pinNote: string | undefined;
    const candidates = ranked.filter((a) => isPinnable(a.el.category) && a.el.externalId).slice(0, 8);
    if (candidates.length === 0) {
      const worst = ranked[0]!;
      pinNote = `(No 3D pin: the top changes (${worst.el.category}) are planar/linear — no point origin in AECDM. Pinning needs a point-placed element: column, door, fixture.)`;
      console.log('  pin: skipped — no point-placed element among the ranked changes');
    } else {
      const skips: string[] = [];
      for (const cand of candidates) {
        try {
          const res = await buildElementPin(auth, {
            elementGroupId: ver.elementGroupId,
            category: cand.el.category!,
            externalId: cand.el.externalId!,
            modelVersionUrn: ver.curUrn,
            globalOffset: CONFIG.archGlobalOffset,
          });
          if ('skipped' in res) {
            skips.push(res.skipped);
            continue;
          }
          pin = res.linkedDocument;
          const p = res.viewerPosition;
          pinNote = `Pinned in the 3D model on "${res.elementName}" [${cand.el.category}] ` +
            `(externalId ${cand.el.externalId}) — open this issue in ACC to jump straight to it.`;
          console.log(
            `  pin: → "${res.elementName}" @ viewer (${p.x.toFixed(2)}, ${p.y.toFixed(2)}, ${p.z.toFixed(2)})` +
            `${res.objectId !== undefined ? `, objectId ${res.objectId}` : ' (no objectId)'}`,
          );
          break;
        } catch (e) {
          skips.push((e as Error).message);
        }
      }
      if (!pin) {
        pinNote = `(No 3D pin: none of ${candidates.length} point-placed candidate(s) had an AECDM origin.)`;
        console.log(`  pin: skipped — tried ${candidates.length}, none resolved (${skips.slice(0, 3).join('; ')})`);
      }
    }

    const { title, description } = buildIssueBody(discipline, ranked, ver.prev, ver.cur, pinNote);
    console.log('\n' + '─'.repeat(72));
    console.log('TITLE:  ' + title);
    console.log(description);

    if (!DRY_RUN) {
      if (!subtypeId) { console.log('  (skip create — no active issue subtype found)'); continue; }
      const published = process.env['PUBLISH'] === '1';
      const issue = await issuesApi.createIssue(auth, CONFIG.dmProjectId, {
        title, description, issueSubtypeId: subtypeId, status: 'open', published,
        ...(pin ? { linkedDocuments: [pin] } : {}),
      });
      console.log(`  → created issue #${(issue as { displayId?: number }).displayId ?? '?'} (${published ? 'published' : 'draft'})${pin ? ' with 3D pin' : ''}`);
    }
  }

  // Persist the processed version so the next run is a no-op until a newer version appears.
  if (!DRY_RUN || process.env['SAVE_STATE'] === '1') {
    const state = loadState();
    state[CONFIG.watchModel] = ver.cur;
    saveState(state);
    console.log(`\n  state saved: ${CONFIG.watchModel} → v${ver.cur}`);
  }
}

main().catch((e) => {
  console.error('\nERROR:', e);
  const body = (e as { body?: unknown }).body;
  if (body) console.error('\nDETAILS:', JSON.stringify(body, null, 2));
  process.exit(1);
});
