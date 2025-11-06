'use strict';
const obsidian = require("obsidian");

class RevisePlugin extends obsidian.Plugin {
  constructor(app, manifest) {
    super(app, manifest);
    this.lastCheckedState = new Map();
    this.isProgrammaticWrite = false;
    this.STAGES = [
      { tag: "#revise", nextTag: "#revise_7", offsetDays: 7 },
      { tag: "#revise_7", nextTag: "#revise_30", offsetDays: 30 },
      { tag: "#revise_30", nextTag: "#revise_90", offsetDays: 90 },
      { tag: "#revise_90", nextTag: null, offsetDays: null },
    ];
  }

  async onload() {
    this.addCommand({
      id: "insert-revise-task",
      name: "Insert #revise task (due tomorrow)",
      editorCallback: (editor) => {
        this.insertReviseTask(editor);
      },
    });

    this.registerEvent(
      this.app.metadataCache.on("changed", (file, _data, cache) => {
        if (!(file instanceof obsidian.TFile)) return;
        if (this.isProgrammaticWrite) return;
        try {
          const items = cache?.listItems ?? [];
          const currentMap = new Map();
          for (const li of items) {
            const isTask = li.task !== undefined && li.task !== null;
            if (!isTask) continue;
            const key = `${li.position.start.line}:${li.position.start.col}`;
            const checked =
              typeof li.checked === "boolean"
                ? li.checked
                : (li.task ?? "").toLowerCase() === "x";
            currentMap.set(key, checked);
          }
          const path = file.path;
          const prevMap = this.lastCheckedState.get(path) ?? new Map();
          const toggledToDone = [];
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
          console.error("Revise Scheduler error:", e);
        }
      })
    );

    new obsidian.Notice("Revise Scheduler (spaced ladder) loaded");
  }

  onunload() {
    this.lastCheckedState.clear();
  }

  insertReviseTask(editor) {
    const selection = editor.getSelection();
    const baseText = selection?.trim().length ? selection.trim() : "Revise";
    const due = window.moment().add(1, "day").format("YYYY-MM-DD");
    const line = `- [ ] ${baseText} #revise 📅 ${due}`;
    if (selection) {
      editor.replaceSelection(line);
    } else {
      const cursor = editor.getCursor();
      editor.replaceRange(line + "\n", cursor);
    }
    new obsidian.Notice(`Inserted #revise task due ${due}`);
  }

  async handleCompletions(file, toggled) {
    const content = await this.app.vault.read(file);
    const lines = content.split("\n");
    let modified = false;
    const sorted = [...toggled].sort((a, b) => b.line - a.line);

    for (const { line } of sorted) {
      if (line < 0 || line >= lines.length) continue;
      const original = lines[line];
      const isCheckbox =
        /^\s*-\s*\[[ xX]\]\s+/.test(original) ||
        /^\s*\d+\.\s*\[[ xX]\]\s+/.test(original);
      if (!isCheckbox) continue;
      const stage = this.findStageTag(original);
      if (!stage) continue;
      const mapping = this.STAGES.find((s) => s.tag === stage);
      if (!mapping || !mapping.nextTag || !mapping.offsetDays) continue;
      const nextDue = window
        .moment()
        .add(mapping.offsetDays, "days")
        .format("YYYY-MM-DD");
      const stripped = original
        .replace(/^\s*-\s*\[[ xX]\]\s+/, "")
        .replace(/^\s*\d+\.\s*\[[ xX]\]\s+/, "");
      const noDate = stripped.replace(/📅\s+\d{4}-\d{2}-\d{2}/g, "").trim();
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
      new obsidian.Notice("Created spaced follow-up task(s)");
    }
  }

  findStageTag(line) {
    const tagsByLength = [...this.STAGES.map((s) => s.tag)].sort(
      (a, b) => b.length - a.length
    );
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

  escapeRegex(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
}

module.exports = RevisePlugin;

