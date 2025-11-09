// main.js
// Obsidian plugin: Revise Scheduler (Spaced Ladder)
// Behavior:
//   #revise      -> +7d    -> #revise_7
//   #revise_7    -> +30d   -> #revise_30
//   #revise_30   -> +90d   -> #revise_90
//   #revise_90   -> +365d  -> #revise_365
//   #revise_365  -> +365d  -> #revise_365 (repeat yearly)
//
// Prevents duplicate scheduling by tagging completed items with #nextscheduled.

'use strict';

const obsidian = require('obsidian');

const STAGES = {
  '#revise':      { nextTag: '#revise_7',   plusDays: 7   },
  '#revise_7':    { nextTag: '#revise_30',  plusDays: 30  },
  '#revise_30':   { nextTag: '#revise_90',  plusDays: 90  },
  '#revise_90':   { nextTag: '#revise_365', plusDays: 365 },
  '#revise_365':  { nextTag: '#revise_365', plusDays: 365 }, // self-loop yearly
};

const REVISE_TAGS = ['#revise', '#revise_7', '#revise_30', '#revise_90', '#revise_365'];

const TASK_DONE_RE = /^\s*-\s*\[x\]\s+/i;
const TASK_OPEN_RE = /^\s*-\s*\[\s\]\s+/;
const DUE_RE = /\s*📅\s*\d{4}-\d{2}-\d{2}/; // matches " 📅 YYYY-MM-DD"
const REVISE_ANY_RE = /\s+#revise(?:_(?:7|30|90|365))?\b/i;
const NEXT_SCHEDULED_TAG = '#nextscheduled';

// Simple debounce
function debounce(fn, wait) {
  let t = null;
  return function (...args) {
    if (t) clearTimeout(t);
    t = setTimeout(() => fn.apply(this, args), wait);
  };
}

class ReviseSchedulerPlugin extends obsidian.Plugin {
  async onload() {
    this.registerEvent(
      this.app.vault.on('modify', this._debouncedProcessFile())
    );
    this.registerEvent(
      this.app.metadataCache.on('changed', (file) => {
        // metadata change can happen without file content change; still process
        this._debouncedProcessFile()(file);
      })
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

  onunload() {}

  _debouncedProcessFile() {
    return debounce((file) => {
      // Only markdown files
      if (!file || !(file instanceof obsidian.TFile)) return;
      if (!file.path.toLowerCase().endsWith('.md')) return;
      this.processFile(file).catch((e) => console.error('ReviseScheduler error:', e));
    }, 400);
  }

  /**
   * Reads a file, finds completed revise tasks (not yet #nextscheduled),
   * creates the next task with computed due date, and tags the completed task
   * with #nextscheduled to prevent duplicates.
   */
  async processFile(file) {
    let content = await this.app.vault.read(file);
    const lines = content.split('\n');

    let mutated = false;
    const out = [];

    for (let i = 0; i < lines.length; i++) {
      let line = lines[i];

      // Copy line by default
      out.push(line);

      // Only operate on completed tasks that contain a revise tag and are NOT already marked nextscheduled
      if (
        TASK_DONE_RE.test(line) &&
        REVISE_ANY_RE.test(line) &&
        !line.includes(NEXT_SCHEDULED_TAG)
      ) {
        // Determine which revise tag is present
        const tag = REVISE_TAGS.find((t) => line.toLowerCase().includes(t));
        if (!tag) continue;

        const stage = STAGES[tag.toLowerCase()];
        if (!stage) continue;

        // Compute next due date from "now"
        const due = obsidian.moment().add(stage.plusDays, 'days').format('YYYY-MM-DD');

        // Build the cloned open task:
        // 1) make it unchecked
        // 2) strip any existing revise tag
        // 3) strip any existing due date token like " 📅 YYYY-MM-DD"
        const clonedBase = line
          .replace(TASK_DONE_RE, (m) => m.replace('[x]', '[ ]')) // done -> open
          .replace(REVISE_ANY_RE, '')                            // remove old revise tag
          .replace(DUE_RE, '');                                  // remove old due

        // Normalize trailing spaces
        const cleanedCloned = clonedBase.replace(/\s+$/, '');

        // Ensure it is a task; if the original was malformed, enforce "- [ ] "
        const openTask = TASK_OPEN_RE.test(cleanedCloned)
          ? cleanedCloned
          : cleanedCloned.replace(/^\s*/, (sp) => `${sp}- [ ] `);

        const nextTaskLine = `${openTask} 📅 ${due} ${stage.nextTag}`.trim();

        // Append the new task just below the completed one
        out.push(nextTaskLine);

        // Mark original completed task to avoid duplicate rescheduling
        const markedCompleted = line.includes(NEXT_SCHEDULED_TAG)
          ? line
          : `${line} ${NEXT_SCHEDULED_TAG}`.replace(/\s+$/, '');
        // Replace the just-pushed original line with the marked one
        out[out.length - 2] = markedCompleted;

        mutated = true;
      }
    }

    if (mutated) {
      const newContent = out.join('\n');
      if (newContent !== content) {
        await this.app.vault.modify(file, newContent);
      }
    }
  }
}

module.exports = ReviseSchedulerPlugin;