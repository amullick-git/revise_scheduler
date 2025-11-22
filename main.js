// Obsidian plugin: Revise Scheduler (Spaced Ladder)
// Behavior:
//   #revise      -> +7d    -> #revise_7
//   #revise_7    -> +30d   -> #revise_30
//   #revise_30   -> +90d   -> #revise_90
//   #revise_90   -> +365d  -> #revise_365
//   #revise_365  -> +365d  -> #revise_365 (repeat yearly)
//
// Notes:
// - Exact tag detection (longest-first) so "#revise_7" does NOT match "#revise".
// - Strips prior due tokens (📅, ⏳, ➕) before adding new 📅.
// - Adds "#nextscheduled" to completed tasks to avoid re-scheduling on future scans.
// - Per-file lock avoids duplicate appends from closely spaced events.

'use strict';

const obsidian = require('obsidian');

// Stage map
const STAGES = {
  '#revise': { nextTag: '#revise_7', plusDays: 7 },
  '#revise_7': { nextTag: '#revise_30', plusDays: 30 },
  '#revise_30': { nextTag: '#revise_90', plusDays: 90 },
  '#revise_90': { nextTag: '#revise_365', plusDays: 365 },
  '#revise_365': { nextTag: '#revise_365', plusDays: 365 }, // yearly self-loop
};

// For fast membership checks if needed later
const REVISE_SET = new Set(Object.keys(STAGES));

// Regexes
const TASK_DONE_RE = /^\s*-\s*\[x\]\s+/i;
const TASK_OPEN_RE = /^\s*-\s*\[\s\]\s+/;

// Any of the date tokens your notes might carry; we’ll strip before adding a fresh 📅
const DATE_TOKEN_RE = /\s*(?:📅|⏳|➕)\s*\d{4}-\d{2}-\d{2}/g;

// Exact revise tag extractor: prefer specific tags before bare "#revise"
const EXTRACT_REVISE_TAG_RE = /(?:#revise_(?:365|90|30|7)\b)|(?:#revise\b)/i;

// Used to strip an existing revise tag (any of the forms)
const STRIP_REVISE_TAG_RE = /\s+#revise(?:_(?:7|30|90|365))?\b/gi;

// Match #repeat_N where N is a number > 0
const REPEAT_ANY_RE = /(^|\s)#repeat_(\d+)\b/i;
// Used to strip an existing repeat tag
const STRIP_REPEAT_TAG_RE = /\s+#repeat_\d+\b/gi;

// Strip done date token: "✅ YYYY-MM-DD"
const DONE_DATE_STRIP_RE = /\s*✅\s*\d{4}-\d{2}-\d{2}/g;

const NEXT_SCHEDULED_TAG = '#nextscheduled';

// Simple debounce helper
function debounce(fn, wait) {
  let t = null;
  return function (...args) {
    if (t) clearTimeout(t);
    t = setTimeout(() => fn.apply(this, args), wait);
  };
}

// Per-file in-flight guard to avoid duplicate scheduling when multiple events fire quickly
const inFlight = new Set();

class ReviseSchedulerPlugin extends obsidian.Plugin {
  async onload() {
    // Process only on file content modification (fewer duplicates than also hooking metadata changes)
    this.registerEvent(
      this.app.vault.on('modify', this._debouncedProcessFile())
    );

    this.addCommand({
      id: 'revise-scheduler-scan-active-file',
      name: 'Revise Scheduler: scan & schedule in active file',
      callback: async () => {
        const file = this.app.workspace.getActiveFile();
        if (file) {
          await this.processFile(file);
          new obsidian.Notice('Revise Scheduler: scanned active file');
        } else {
          new obsidian.Notice('Revise Scheduler: no active file');
        }
      },
    });

    this.addCommand({
      id: 'revise-scheduler-scan-all-files',
      name: 'Revise Scheduler: scan & schedule across vault',
      callback: async () => {
        const files = this.app.vault.getMarkdownFiles();
        for (const f of files) {
          await this.processFile(f);
        }
        new obsidian.Notice('Revise Scheduler: scanned all markdown files');
      },
    });
  }

  onunload() { }

  _debouncedProcessFile() {
    return debounce((file) => {
      if (!file || !(file instanceof obsidian.TFile)) return;
      if (!file.path.toLowerCase().endsWith('.md')) return;
      this.processFile(file).catch((e) => console.error('ReviseScheduler error:', e));
    }, 350);
  }

  /**
   * Process a single markdown file:
   *  - Find completed revise tasks not yet marked #nextscheduled
   *  - Append the next task with computed due date
   *  - Mark the completed task with #nextscheduled
   */
  async processFile(file) {
    // per-file lock
    if (inFlight.has(file.path)) return;
    inFlight.add(file.path);

    try {
      let content = await this.app.vault.read(file);
      const lines = content.split('\n');

      let mutated = false;
      const out = [];

      for (let i = 0; i < lines.length; i++) {
        let line = lines[i];
        out.push(line); // push original first

        // Only act on completed tasks with a revise tag, not already marked nextscheduled
        if (!TASK_DONE_RE.test(line)) continue;
        if (line.includes(NEXT_SCHEDULED_TAG)) continue;

        const reviseMatch = line.match(EXTRACT_REVISE_TAG_RE);
        const repeatMatch = line.match(REPEAT_ANY_RE);

        let nextTag = '';
        let plusDays = 0;

        if (reviseMatch) {
          const tag = reviseMatch[0].toLowerCase();
          if (REVISE_SET.has(tag)) {
            const stage = STAGES[tag];
            nextTag = stage.nextTag;
            plusDays = stage.plusDays;
          }
        }

        // Fallback to repeat tag if no valid revise tag found (or prioritize revise?)
        // Logic: If we found a valid revise stage, we used it. If not, check repeat.
        if (!nextTag && repeatMatch) {
          const days = parseInt(repeatMatch[2], 10);
          if (!isNaN(days) && days > 0) {
            nextTag = `#repeat_${days}`;
            plusDays = days;
          }
        }

        if (!nextTag) continue;

        // Compute next due date from now
        const due = obsidian.moment().add(plusDays, 'days').format('YYYY-MM-DD');

        // Build next open task:
        // 1) Convert to open checkbox
        // 2) Remove any existing revise tag, repeat tag, and any due-like tokens
        // 3) Trim trailing spaces and normalize to ensure "- [ ] " present
        const clonedBase = line
          .replace(TASK_DONE_RE, (m) => m.replace('[x]', '[ ]'))
          .replace(STRIP_REVISE_TAG_RE, '')
          .replace(STRIP_REPEAT_TAG_RE, '')
          .replace(DATE_TOKEN_RE, '')
          .replace(DONE_DATE_STRIP_RE, '');

        const cleaned = clonedBase.replace(/\s+$/, '');
        const openTask = TASK_OPEN_RE.test(cleaned)
          ? cleaned
          : cleaned.replace(/^\s*/, (sp) => `${sp}- [ ] `);

        const nextTaskLine = `${openTask} ⏳ ${due} ${nextTag}`.trim();

        // Append newly scheduled task directly after the completed one
        out.push(nextTaskLine);

        // Mark the original line as nextscheduled to avoid future re-processing
        const marked = line.includes(NEXT_SCHEDULED_TAG) ? line : `${line} ${NEXT_SCHEDULED_TAG}`.trimEnd();
        // Replace the original (which we already pushed) with the marked version
        out[out.length - 2] = marked;

        mutated = true;
      }

      if (mutated) {
        const newContent = out.join('\n');
        if (newContent !== content) {
          await this.app.vault.modify(file, newContent);
        }
      }
    } catch (e) {
      console.error('ReviseScheduler processing error:', e);
    } finally {
      // release lock
      inFlight.delete(file.path);
    }
  }
}

module.exports = ReviseSchedulerPlugin;
