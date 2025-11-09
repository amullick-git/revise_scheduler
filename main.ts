// main.ts
// Obsidian plugin: Revise Scheduler (Spaced Ladder)
// Chain:
//   #revise      -> +7d    -> #revise_7
//   #revise_7    -> +30d   -> #revise_30
//   #revise_30   -> +90d   -> #revise_90
//   #revise_90   -> +365d  -> #revise_365
//   #revise_365  -> +365d  -> #revise_365 (repeat yearly)
//
// Key fixes in this version:
// - Robust tag detection: picks the *longest* match so "#revise_90" doesn't get read as "#revise".
// - Supports both ⏳/📅 due markers and strips ➕ (created) / ✅ (done) tokens when cloning.
// - Duplicate-prevention by tagging completed lines with #nextscheduled.
// - Uses completion date (✅ YYYY-MM-DD) as base for next due, falling back to "today" if absent.

import { Plugin, TFile, Notice, moment } from "obsidian";

type Stage = { nextTag: string; plusDays: number };

const STAGES: Record<string, Stage> = {
  "#revise":      { nextTag: "#revise_7",   plusDays: 7   },
  "#revise_7":    { nextTag: "#revise_30",  plusDays: 30  },
  "#revise_30":   { nextTag: "#revise_90",  plusDays: 90  },
  "#revise_90":   { nextTag: "#revise_365", plusDays: 365 },
  "#revise_365":  { nextTag: "#revise_365", plusDays: 365 }, // yearly loop
};

// Keep the canonical list for scanning. Order doesn't matter because we resolve longest match.
const REVISE_TAGS = ["#revise_365", "#revise_90", "#revise_30", "#revise_7", "#revise"];

// Regex helpers
const TASK_DONE_RE = /^\s*-\s*\[x\]\s+/i;
const TASK_OPEN_RE = /^\s*-\s*\[\s\]\s+/;
const NEXT_SCHEDULED_TAG = "#nextscheduled";

// Match any of the revise tags (case-insensitive), ensuring word boundary.
// We still choose the longest actual match we find.
const REVISE_ANY_RE = /(^|\s)#revise(?:_(?:7|30|90|365))?\b/gi;

// Strip any existing due markers (both styles supported): "⏳ YYYY-MM-DD" or "📅 YYYY-MM-DD"
const DUE_TOKENS_RE = /\s*(?:📅|⏳)\s*\d{4}-\d{2}-\d{2}/g;
// Strip created token: "➕ YYYY-MM-DD"
const CREATED_RE = /\s*➕\s*\d{4}-\d{2}-\d{2}/g;
// Capture completed date if present: "✅ YYYY-MM-DD"
const DONE_DATE_CAPTURE_RE = /✅\s*(\d{4}-\d{2}-\d{2})/;

// Also strip any raw ✅ YYYY-MM-DD tokens from cloned lines
const DONE_DATE_STRIP_RE = /\s*✅\s*\d{4}-\d{2}-\d{2}/g;

// Simple debounce
function debounce<T extends (...args: any[]) => void>(fn: T, wait: number): T {
  let t: number | null = null;
  return function (this: any, ...args: any[]) {
    if (t) window.clearTimeout(t);
    t = window.setTimeout(() => fn.apply(this, args), wait);
  } as T;
}

/**
 * Returns the *longest* revise tag found in the line (e.g., "#revise_90" over "#revise"),
 * normalized to lowercase as a canonical key for STAGES and comparisons.
 */
function getReviseTagFromLine(line: string): string | null {
  let matches: string[] = [];
  // Collect all #revise* occurrences in a case-insensitive way
  const re = new RegExp(REVISE_ANY_RE);
  re.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(line)) !== null) {
    const raw = (m[0] || "").trim();
    if (!raw) continue;
    // m[0] may include leading space; extract the actual hashtag token
    const token = raw.split(/\s+/).pop() || raw;
    matches.push(token);
  }
  if (matches.length === 0) return null;

  // Choose the longest match so "#revise_90" wins over "#revise"
  const longest = matches.sort((a, b) => b.length - a.length)[0].toLowerCase();
  // Normalize to one of our canonical forms (case-insensitive)
  const canonical =
    REVISE_TAGS.find((t) => t.toLowerCase() === longest) ||
    // In case the match differs in case, try a direct map
    longest;
  return canonical;
}

/** Clean a task line to prepare the cloned "open" next task. */
function buildNextOpenTaskLine(original: string, nextTag: string, dueISO: string): string {
  // 1) Make it unchecked
  let s = original.replace(TASK_DONE_RE, (m) => m.replace("[x]", "[ ]"));

  // 2) Remove any revise tag tokens (all of them)
  s = s.replace(REVISE_ANY_RE, "");

  // 3) Remove due/created/done tokens to avoid clutter duplication
  s = s.replace(DUE_TOKENS_RE, "");
  s = s.replace(CREATED_RE, "");
  s = s.replace(DONE_DATE_STRIP_RE, "");

  // 4) Collapse excessive spaces
  s = s.replace(/\s+$/, "");

  // 5) Ensure it starts as a task line "- [ ] " even if malformed
  if (!TASK_OPEN_RE.test(s)) {
    s = s.replace(/^\s*/, (sp) => `${sp}- [ ] `);
  }

  // 6) Append the next due token (use ⏳ to match user's sample) and the next tag
  s = `${s} ⏳ ${dueISO} ${nextTag}`.trim();
  return s;
}

/** Compute the base date for scheduling: prefer ✅ date, else today. */
function getCompletionBaseDateISO(line: string): string {
  const m = line.match(DONE_DATE_CAPTURE_RE);
  if (m && m[1]) {
    return m[1]; // already YYYY-MM-DD
  }
  return moment().format("YYYY-MM-DD");
}

export default class ReviseSchedulerPlugin extends Plugin {
  async onload() {
    // Re-scan modified files (debounced)
    this.registerEvent(this.app.vault.on("modify", this._debouncedProcessFile()));

    // Also react on metadata changes; they can happen without content change
    this.registerEvent(
      this.app.metadataCache.on("changed", (file) => this._debouncedProcessFile()(file))
    );

    this.addCommand({
      id: "revise-scheduler-scan-active-file",
      name: "Revise Scheduler: scan & schedule in active file",
      callback: async () => {
        const file = this.app.workspace.getActiveFile();
        if (file) {
          await this.processFile(file);
          new Notice("Revise Scheduler: scanned active file");
        } else {
          new Notice("Revise Scheduler: no active file");
        }
      },
    });

    this.addCommand({
      id: "revise-scheduler-scan-all-files",
      name: "Revise Scheduler: scan & schedule across vault",
      callback: async () => {
        const files = this.app.vault.getMarkdownFiles();
        for (const f of files) {
          await this.processFile(f);
        }
        new Notice("Revise Scheduler: scanned all markdown files");
      },
    });
  }

  onunload() {}

  private _debouncedProcessFile() {
    return debounce(async (file?: TFile) => {
      if (!file || !(file instanceof TFile)) return;
      if (!file.path.toLowerCase().endsWith(".md")) return;
      try {
        await this.processFile(file);
      } catch (e) {
        console.error("ReviseScheduler error:", e);
      }
    }, 400);
  }

  /**
   * Reads a file, finds completed revise tasks (not yet #nextscheduled),
   * schedules the next one based on the ladder, and marks the original with #nextscheduled.
   */
  async processFile(file: TFile) {
    const content = await this.app.vault.read(file);
    const lines = content.split("\n");

    let mutated = false;
    const out: string[] = [];

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      // By default, keep the original line
      out.push(line);

      // Only operate on completed tasks that contain a revise tag and are NOT already marked nextscheduled
      if (!TASK_DONE_RE.test(line)) continue;
      if (line.includes(NEXT_SCHEDULED_TAG)) continue;

      const tag = getReviseTagFromLine(line);
      if (!tag) continue;

      const stage = STAGES[tag.toLowerCase()];
      if (!stage) continue;

      // Determine base date (completion date if present, else today)
      const baseISO = getCompletionBaseDateISO(line);
      const dueISO = moment(baseISO).add(stage.plusDays, "days").format("YYYY-MM-DD");

      // Build the next open task
      const nextLine = buildNextOpenTaskLine(line, stage.nextTag, dueISO);

      // Append the new task just below the completed one
      out.push(nextLine);

      // Mark original line with #nextscheduled to avoid duplicates in future scans
      const marked =
        line.includes(NEXT_SCHEDULED_TAG) ? line : `${line} ${NEXT_SCHEDULED_TAG}`.replace(/\s+$/, "");
      // Replace the just-pushed original with the marked one
      out[out.length - 2] = marked;

      mutated = true;
    }

    if (mutated) {
      const newContent = out.join("\n");
      if (newContent !== content) {
        await this.app.vault.modify(file, newContent);
      }
    }
  }
}
