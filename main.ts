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
 *
 * Stages:
 *   #revise   -> +7d  -> #revise_7
 *   #revise_7 -> +30d -> #revise_30
 *   #revise_30-> +90d -> #revise_90
 *
 * Insert command creates an initial #revise scheduled +1 day.
 * Completed tasks generate their next-stage task unless already marked
 * with #nextscheduled — this prevents duplicate generations on reload/VIM.
 */
export default class RevisePlugin extends Plugin {
  private lastCheckedState: Map<string, Map<string, boolean>> = new Map();
  private isProgrammaticWrite = false;

  // Define the spaced repetition ladder
  private STAGES: Array<{
    tag: string;
    nextTag: string | null;
    offsetDays: number | null;
  }> = [
    { tag: "#revise", nextTag: "#revise_7", offsetDays: 7 },
    { tag: "#revise_7", nextTag: "#revise_30", offsetDays: 30 },
    { tag: "#revise_30", nextTag: "#revise_90", offsetDays: 90 },
    { tag: "#revise_90", nextTag: null, offsetDays: null },
  ];

  async onload() {
    this.addCommand({
      id: "insert-revise-task",
      name: "Insert #revise task (scheduled tomorrow)",
      editorCallback: (editor: Editor) => {
        this.insertReviseTask(editor);
      },
    });

    // Establish a baseline on file-open to avoid duplicate generation
    this.registerEvent(
      this.app.workspace.on("file-open", (file) => {
        if (!(file instanceof TFile)) return;
        const cache = this.app.metadataCache.getFileCache(file);
        const items = cache?.listItems ?? [];
        const currentMap = this.buildCheckedMapFromCache(items);
        this.lastCheckedState.set(file.path, currentMap);
      })
    );

    // Detect task completions
    this.registerEvent(
      this.app.metadataCache.on("changed", (file, _data, cache) => {
        if (!(file instanceof TFile)) return;
        if (this.isProgrammaticWrite) return;

        try {
          const items = cache?.listItems ?? [];
          const currentMap = this.buildCheckedMapFromCache(items);
          const path = file.path;

          const prevMap = this.lastCheckedState.get(path);

          // First parse of file: establish baseline
          if (!prevMap) {
            this.lastCheckedState.set(path, currentMap);
            return;
          }

          // Detect new toggles → done
          const toggledToDone: Array<{ line: number }> = [];
          for (const [key, nowChecked] of currentMap.entries()) {
            const wasChecked = prevMap.get(key) ?? false;
            if (nowChecked && !wasChecked) {
              const [lineStr] = key.split(":");
              toggledToDone.push({ line: Number(lineStr) });
            }
          }

          this.lastCheckedState.set(path, currentMap);

          if (toggledToDone.length === 0) return;

          this.handleCompletions(file, toggledToDone).catch(console.error);
        } catch (err) {
          console.error("Revise Scheduler error:", err);
        }
      })
    );

    new Notice("Revise Scheduler (spaced ladder) loaded");
  }

  onunload(): void {
    this.lastCheckedState.clear();
  }

  /** Insert initial scheduled #revise task */
  private insertReviseTask(editor: Editor) {
    const selection = editor.getSelection();
    const baseText = selection?.trim().length ? selection.trim() : "Revise";
    const scheduled = moment().add(1, "day").format("YYYY-MM-DD");

    const line = `- [ ] ${baseText} #revise ⏳ ${scheduled}`;
    if (selection) {
      editor.replaceSelection(line);
    } else {
      const cursor = editor.getCursor();
      editor.replaceRange(line + "\n", cursor);
    }

    new Notice(`Inserted #revise task scheduled for ${scheduled}`);
  }

  /**
   * Handle completed tasks:
   * - If #repeat_N → schedule next after N days.
   * - If spaced ladder tag → schedule next-stage task.
   * - Add #nextscheduled to completed tasks so they won't regenerate.
   */
  private async handleCompletions(
    file: TFile,
    toggled: Array<{ line: number }>
  ) {
    const content = await this.app.vault.read(file);
    const lines = content.split("\n");

    let modified = false;
    const sorted = [...toggled].sort((a, b) => b.line - a.line);

    const appendTagPreservingBlockId = (line: string, rawTag: string): string => {
      const tag = rawTag.trim();

      // Do not re-add if already present
      const hasTag = new RegExp(
        `(^|\\s)${this.escapeRegex(tag)}(\\s|$)`,
        "i"
      ).test(line);
      if (hasTag) return line;

      let s = line.replace(/\s+$/, ""); // trim trailing spaces

      // If ending with ^blockid, insert before it
      const idMatch = s.match(/\s\^[A-Za-z0-9._-]+$/);
      if (idMatch) {
        return s.replace(
          /\s\^[A-Za-z0-9._-]+$/,
          ` ${tag}${idMatch[0]}`
        );
      }

      return `${s} ${tag}`;
    };

    for (const { line } of sorted) {
      if (line < 0 || line >= lines.length) continue;
      let original = lines[line];

      // Must be a checked task
      const checkboxMatch = original.match(/^\s*(?:-|\d+\.)\s*\[([ xX])\]/);
      if (!checkboxMatch || checkboxMatch[1].trim() === "") continue;

      // Skip already-processed tasks
      if (/(^|\s)#nextscheduled(\s|$)/i.test(original)) continue;

      // Strip checkbox to get main body text
      const stripped = original
        .replace(/^\s*-\s*\[[ xX]\]\s+/, "")
        .replace(/^\s*\d+\.\s*\[[ xX]\]\s+/, "");

      // 1) Handle #repeat_N
      const repeatMatch = original.match(/#repeat_(\d+)/);
      if (repeatMatch && repeatMatch[1]) {
        const days = parseInt(repeatMatch[1], 10);
        if (!isNaN(days) && days > 0) {
          const nextScheduled = moment()
            .add(days, "days")
            .format("YYYY-MM-DD");

          const taskTextForNew = stripped
            .replace(/(?:📅|⏳|✅)\s+\d{4}-\d{2}-\d{2}/g, "")
            .trim();

          // Mark completed source
          original = appendTagPreservingBlockId(original, "#nextscheduled");
          lines[line] = original;

          // Insert next task
          const newTask = `- [ ] ${taskTextForNew} ⏳ ${nextScheduled}`;
          lines.splice(line + 1, 0, newTask);

          modified = true;
          continue;
        }
      }

      // 2) Handle spaced ladder
      const stage = this.findStageTag(original);
      if (stage) {
        const mapping = this.STAGES.find((s) => s.tag === stage);
        if (mapping && mapping.nextTag && mapping.offsetDays) {
          const nextScheduled = moment()
            .add(mapping.offsetDays, "days")
            .format("YYYY-MM-DD");

          const taskTextForNew = stripped
            .replace(/(?:📅|⏳|✅)\s+\d{4}-\d{2}-\d{2}/g, "")
            .trim();

          const nextText = this.replaceStageTag(
            taskTextForNew,
            stage,
            mapping.nextTag
          ).trim();

          // Mark completed source
          original = appendTagPreservingBlockId(original, "#nextscheduled");
          lines[line] = original;

          // Insert next task
          const newTask = `- [ ] ${nextText} ⏳ ${nextScheduled}`;
          lines.splice(line + 1, 0, newTask);

          modified = true;
        }
      }
    }

    if (modified) {
      const newContent = lines.join("\n");
      this.isProgrammaticWrite = true;
      try {
        await this.app.vault.modify(file, newContent);
      } finally {
        window.setTimeout(
          () => (this.isProgrammaticWrite = false),
          50
        );
      }
      new Notice("Created spaced follow-up task(s)");
    }
  }

  /** Match most-specific stage tag first */
  private findStageTag(line: string): string | null {
    const tagsByLength = [...this.STAGES.map((s) => s.tag)].sort(
      (a, b) => b.length - a.length
    );
    for (const t of tagsByLength) {
      const re = new RegExp(`(^|\\s)${this.escapeRegex(t)}(\\s|$)`);
      if (re.test(line)) return t;
    }
    return null;
  }

  /** Replace one ladder tag with the next */
  private replaceStageTag(
    text: string,
    currentTag: string,
    nextTag: string
  ): string {
    const re = new RegExp(
      `(^|\\s)${this.escapeRegex(currentTag)}(\\s|$)`
    );
    if (re.test(text)) {
      return text.replace(re, (_m, p1, p2) => `${p1}${nextTag}${p2}`);
    }
    return `${text} ${nextTag}`.trim();
  }

  /** Build map of "line:col" → checked?  */
  private buildCheckedMapFromCache(items: any[]): Map<string, boolean> {
    const map = new Map<string, boolean>();
    for (const li of items) {
      const isTask = li.task !== undefined && li.task !== null;
      if (!isTask || !li?.position?.start) continue;

      const key = `${li.position.start.line}:${li.position.start.col}`;
      const checked =
        typeof li.checked === "boolean"
          ? li.checked
          : typeof li.task === "string"
            ? li.task.toLowerCase() === "x"
            : false;

      map.set(key, checked);
    }
    return map;
  }

  private escapeRegex(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
}
