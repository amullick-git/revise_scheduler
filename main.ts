import {
  App,
  Editor,
  MarkdownView,
  Plugin,
  TFile,
  moment,
  Notice,
} from "obsidian";

/**
 * Revise Scheduler (Spaced Ladder)
 * Stages:
 *   #revise   -> +7d  -> #revise_7
 *   #revise_7 -> +30d -> #revise_30
 *   #revise_30-> +90d -> #revise_90
 * Insert command creates an initial #revise due +1d.
 */
export default class RevisePlugin extends Plugin {
  private lastCheckedState: Map<string, Map<string, boolean>> = new Map();
  private isProgrammaticWrite = false;

  // Define your ladder here (order matters).
  private STAGES: Array<{
    tag: string;
    nextTag: string | null;
    offsetDays: number | null; // null = terminal (no follow-up)
  }> = [
    { tag: "#revise",    nextTag: "#revise_7",  offsetDays: 7 },
    { tag: "#revise_7",  nextTag: "#revise_30", offsetDays: 30 },
    { tag: "#revise_30", nextTag: "#revise_90", offsetDays: 90 },
    { tag: "#revise_90", nextTag: null,         offsetDays: null }, // stop after 90
  ];

  async onload() {
    this.addCommand({
      id: "insert-revise-task",
      name: "Insert #revise task (due tomorrow)",
      editorCallback: (editor: Editor, _view: MarkdownView) => {
        this.insertReviseTask(editor);
      },
    });

    this.registerEvent(
      this.app.metadataCache.on("changed", (file, _data, cache) => {
        if (!(file instanceof TFile)) return;
        if (this.isProgrammaticWrite) return;

        try {
          const items = cache?.listItems ?? [];
          const currentMap: Map<string, boolean> = new Map();

          for (const li of items) {
            const isTask = li.task !== undefined && li.task !== null;
            if (!isTask) continue;

            const key = `${li.position.start.line}:${li.position.start.col}`;
            const checked =
              typeof (li as any).checked === "boolean"
                ? (li as any).checked
                : (li.task as string)?.toLowerCase() === "x";
            currentMap.set(key, checked);
          }

          const path = file.path;
          const prevMap = this.lastCheckedState.get(path) ?? new Map();

          const toggledToDone: Array<{ line: number }> = [];
          for (const [key, nowChecked] of currentMap.entries()) {
            const wasChecked = prevMap.get(key) ?? false;
            if (!wasChecked && nowChecked) {
              const [lineStr] = key.split(":");
              toggledToDone.push({ line: Number(lineStr) });
            }
          }

          this.lastCheckedState.set(path, currentMap);

          if (toggledToDone.length === 0) return;
          this.handleCompletions(file, toggledToDone).catch(console.error);
        } catch (e) {
          console.error("Revise Scheduler error (changed handler):", e);
        }
      })
    );

    new Notice("Revise Scheduler (spaced ladder) loaded");
  }

  onunload(): void {
    this.lastCheckedState.clear();
  }

  /** Inserts an initial #revise task due +1 day at the cursor (or replacing selection). */
  private insertReviseTask(editor: Editor) {
    const selection = editor.getSelection();
    const baseText = selection?.trim().length ? selection.trim() : "Revise";
    const due = moment().add(1, "day").format("YYYY-MM-DD");

    const line = `- [ ] ${baseText} #revise 📅 ${due}`;
    if (selection) {
      editor.replaceSelection(line);
    } else {
      const cursor = editor.getCursor();
      editor.replaceRange(line + "\n", cursor);
    }
    new Notice(`Inserted #revise task due ${due}`);
  }

  /** For each toggled line, if it contains a ladder tag, insert the next-stage task with the mapped due date. */
  private async handleCompletions(
    file: TFile,
    toggled: Array<{ line: number }>
  ) {
    const content = await this.app.vault.read(file);
    const lines = content.split("\n");

    let modified = false;
    const sorted = [...toggled].sort((a, b) => b.line - a.line);

    for (const { line } of sorted) {
      if (line < 0 || line >= lines.length) continue;
      const original = lines[line];

      // Must be a checkbox task
      const isCheckbox =
        /^\s*-\s*\[[ xX]\]\s+/.test(original) || /^\s*\d+\.\s*\[[ xX]\]\s+/.test(original);
      if (!isCheckbox) continue;

      // Does this line contain any of our ladder tags?
      const stage = this.findStageTag(original);
      if (!stage) continue;

      const mapping = this.STAGES.find((s) => s.tag === stage);
      if (!mapping || !mapping.nextTag || !mapping.offsetDays) {
        // Terminal stage or not found; do nothing.
        continue;
      }

      const nextDue = moment().add(mapping.offsetDays, "days").format("YYYY-MM-DD");

      // Strip leading checkbox markup
      const stripped = original
        .replace(/^\s*-\s*\[[ xX]\]\s+/, "")
        .replace(/^\s*\d+\.\s*\[[ xX]\]\s+/, "");

      // Remove existing 📅 YYYY-MM-DD occurrences (just tidy; won't remove other natural dates)
      const noDate = stripped.replace(/📅\s+\d{4}-\d{2}-\d{2}/g, "").trim();

      // Replace the ladder tag with the next stage tag, preserving any other tags/words
      const nextText = this.replaceStageTag(noDate, stage, mapping.nextTag).trim();

      const newTask = `- [ ] ${nextText} 📅 ${nextDue}`;
      const insertAt = Math.min(line + 1, lines.length);
      lines.splice(insertAt, 0, newTask);
      modified = true;
    }

    if (modified) {
      const newContent = lines.join("\n");
      this.isProgrammaticWrite = true;
      try {
        await this.app.vault.modify(file, newContent);
      } finally {
        window.setTimeout(() => (this.isProgrammaticWrite = false), 50);
      }
      new Notice("Created spaced follow-up task(s)");
    }
  }

  /** Detect which stage tag appears in a line, preferring the most specific (e.g., #revise_30 over #revise). */
  private findStageTag(line: string): string | null {
    // Sort tags by length descending to match longer tags first
    const tagsByLength = [...this.STAGES.map((s) => s.tag)].sort(
      (a, b) => b.length - a.length
    );
    for (const t of tagsByLength) {
      // Match as a tag token, not a substring of another word.
      const re = new RegExp(`(^|\\s)${this.escapeRegex(t)}(\\s|$)`);
      if (re.test(line)) return t;
    }
    return null;
  }

  /** Replace the current ladder tag with the next one, preserving other tags. */
  private replaceStageTag(text: string, currentTag: string, nextTag: string): string {
    const re = new RegExp(`(^|\\s)${this.escapeRegex(currentTag)}(\\s|$)`);
    if (re.test(text)) {
      return text.replace(re, (_m, p1, p2) => `${p1}${nextTag}${p2}`);
    }
    // If somehow missing (user deleted it), just append the nextTag at the end.
    return `${text} ${nextTag}`.trim();
  }

  private escapeRegex(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
}

