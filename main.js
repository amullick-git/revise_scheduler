// main.js — Revise Scheduler (Spaced Ladder) — CommonJS build for Obsidian
const { Plugin, Notice, moment, TFile } = require("obsidian");

module.exports = class RevisePlugin extends Plugin {
  constructor(app, manifest) {
    super(app, manifest);
    this.lastCheckedState = new Map(); // path -> Map("line:col" -> checked?)
    this.isProgrammaticWrite = false;

    // Define the spaced ladder (order matters)
    this.STAGES = [
      { tag: "#revise",    nextTag: "#revise_7",  offsetDays: 7 },
      { tag: "#revise_7",  nextTag: "#revise_30", offsetDays: 30 },
      { tag: "#revise_30", nextTag: "#revise_90", offsetDays: 90 },
      { tag: "#revise_90", nextTag: null,         offsetDays: null },
    ];
  }

  async onload() {
    this.addCommand({
      id: "insert-revise-task",
      name: "Insert #revise task (scheduled tomorrow)",
      editorCallback: (editor) => this.insertReviseTask(editor),
    });

    // Establish baseline when a file is opened (avoid "first parse" duplicates)
    this.registerEvent(
      this.app.workspace.on("file-open", (file) => {
        if (!(file instanceof TFile)) return;
        const cache = this.app.metadataCache.getFileCache(file);
        const items = (cache && cache.listItems) ? cache.listItems : [];
        const currentMap = this.buildCheckedMapFromCache(items);
        this.lastCheckedState.set(file.path, currentMap);
      })
    );

    // Detect toggles-to-done
    this.registerEvent(
      this.app.metadataCache.on("changed", (file, _data, cache) => {
        if (!(file instanceof TFile)) return;
        if (this.isProgrammaticWrite) return;

        try {
          const items = (cache && cache.listItems) ? cache.listItems : [];
          const currentMap = this.buildCheckedMapFromCache(items);
          const path = file.path;
          const prevMap = this.lastCheckedState.get(path);

          // First sighting: set baseline and bail
          if (!prevMap) {
            this.lastCheckedState.set(path, currentMap);
            return;
          }

          const toggledToDone = [];
          for (const [key, nowChecked] of currentMap.entries()) {
            const wasChecked = prevMap.get(key) ?? false;
            if (nowChecked && !wasChecked) {
              const lineStr = key.split(":")[0];
              toggledToDone.push({ line: Number(lineStr) });
            }
          }

          this.lastCheckedState.set(path, currentMap);
          if (toggledToDone.length === 0) return;

          this.handleCompletions(file, toggledToDone).catch(console.error);
        } catch (e) {
          console.error("Revise Scheduler error:", e);
        }
      })
    );

    new Notice("Revise Scheduler (spaced ladder) loaded");
  }

  onunload() {
    this.lastCheckedState.clear();
  }

  // Insert initial scheduled #revise task
  insertReviseTask(editor) {
    const selection = editor.getSelection && editor.getSelection();
    const baseText =
      selection && selection.trim().length ? selection.trim() : "Revise";
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

  // Handle completed tasks: #repeat_N and spaced ladder; mark source with #nextscheduled
  async handleCompletions(file, toggled) {
    const content = await this.app.vault.read(file);
    const lines = content.split("\n");
    let modified = false;

    // Process from bottom to top so insertions keep indices sane
    const sorted = toggled.slice().sort((a, b) => b.line - a.line);

    const appendTagPreservingBlockId = (line, rawTag) => {
      const tag = rawTag.trim();
      const hasTag = new RegExp(`(^|\\s)${this.escapeRegex(tag)}(\\s|$)`, "i").test(line);
      if (hasTag) return line;
      let s = line.replace(/\s+$/, ""); // trim end
      const idMatch = s.match(/\s\^[A-Za-z0-9._-]+$/);
      if (idMatch) {
        return s.replace(/\s\^[A-Za-z0-9._-]+$/, ` ${tag}${idMatch[0]}`);
      }
      return `${s} ${tag}`;
    };

    for (const { line } of sorted) {
      if (line < 0 || line >= lines.length) continue;
      let original = lines[line];

      // Must be a checked task
      const checkboxMatch = original.match(/^\s*(?:-|\d+\.)\s*\[([ xX])\]/);
      if (!checkboxMatch || checkboxMatch[1].trim() === "") continue;

      // Skip if already processed
      if (/(^|\s)#nextscheduled(\s|$)/i.test(original)) continue;

      // Strip checkbox markup for cloning
      const stripped = original
        .replace(/^\s*-\s*\[[ xX]\]\s+/, "")
        .replace(/^\s*\d+\.\s*\[[ xX]\]\s+/, "");

      // #repeat_N
      const repeatMatch = original.match(/#repeat_(\d+)/);
      if (repeatMatch && repeatMatch[1]) {
        const days = parseInt(repeatMatch[1], 10);
        if (!isNaN(days) && days > 0) {
          const nextScheduled = moment().add(days, "days").format("YYYY-MM-DD");
          const taskTextForNew = stripped
            .replace(/(?:📅|⏳|✅)\s+\d{4}-\d{2}-\d{2}/g, "")
            .trim();

          // Mark source, then insert follow-up
          original = appendTagPreservingBlockId(original, "#nextscheduled");
          lines[line] = original;

          const newTask = `- [ ] ${taskTextForNew} ⏳ ${nextScheduled}`;
          lines.splice(Math.min(line + 1, lines.length), 0, newTask);
          modified = true;
          continue;
        }
      }

      // Spaced ladder
      const stage = this.findStageTag(original);
      if (stage) {
        const mapping = this.STAGES.find((s) => s.tag === stage);
        if (mapping && mapping.nextTag && mapping.offsetDays) {
          const nextScheduled = moment().add(mapping.offsetDays, "days").format("YYYY-MM-DD");
          const taskTextForNew = stripped
            .replace(/(?:📅|⏳|✅)\s+\d{4}-\d{2}-\d{2}/g, "")
            .trim();
          const nextText = this.replaceStageTag(taskTextForNew, stage, mapping.nextTag).trim();

          // Mark source, then insert follow-up
          original = appendTagPreservingBlockId(original, "#nextscheduled");
          lines[line] = original;

          const newTask = `- [ ] ${nextText} ⏳ ${nextScheduled}`;
          lines.splice(Math.min(line + 1, lines.length), 0, newTask);
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
        setTimeout(() => (this.isProgrammaticWrite = false), 50);
      }
      new Notice("Created spaced follow-up task(s)");
    }
  }

  // Utilities

  findStageTag(line) {
    const tagsByLength = this.STAGES.map(s => s.tag).sort((a, b) => b.length - a.length);
    for (const t of tagsByLength) {
      const re = new RegExp(`(^|\\s)${this.escapeRegex(t)}(\\s|$)`);
      if (re.test(line)) return t;
    }
    return null;
  }

  replaceStageTag(text, currentTag, nextTag) {
    const re = new RegExp(`(^|\\s)${this.escapeRegex(currentTag)}(\\s|$)`);
    if (re.test(text)) {
      return text.replace(re, (_m, p1, p2) => `${p1}${nextTag}${p2}`);
    }
    return `${text} ${nextTag}`.trim();
  }

  buildCheckedMapFromCache(items) {
    const map = new Map();
    for (const li of items) {
      const isTask = li.task !== undefined && li.task !== null;
      if (!isTask || !li || !li.position || !li.position.start) continue;
      const key = `${li.position.start.line}:${li.position.start.col}`;
      const checked =
        typeof li.checked === "boolean"
          ? li.checked
          : (typeof li.task === "string" ? li.task.toLowerCase() === "x" : false);
      map.set(key, checked);
    }
    return map;
  }

  escapeRegex(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
};
