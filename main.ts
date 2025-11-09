import {
    Plugin,
    TFile,
    moment,
    Notice,
    MarkdownView,
} from "obsidian";

// -----------------------------
// CONFIGURATION
// -----------------------------

const STAGES: Record<string, { nextTag: string; plusDays: number }> = {
    "#revise":      { nextTag: "#revise_7",   plusDays: 7   },
    "#revise_7":    { nextTag: "#revise_30",  plusDays: 30  },
    "#revise_30":   { nextTag: "#revise_90",  plusDays: 90  },
    "#revise_90":   { nextTag: "#revise_365", plusDays: 365 },
    "#revise_365":  { nextTag: "#revise_365", plusDays: 365 }, // self-loop yearly
};

const REVISE_TAGS = [
    "#revise",
    "#revise_7",
    "#revise_30",
    "#revise_90",
    "#revise_365",
];

// Regex
const TASK_DONE_RE = /^\s*-\s*\[x\]\s+/i;
const TASK_OPEN_RE = /^\s*-\s*\[\s\]\s+/;
const DUE_RE = /\s*📅\s*\d{4}-\d{2}-\d{2}/;
const REVISE_ANY_RE = /\s+#revise(?:_(?:7|30|90|365))?\b/i;

const NEXT_SCHEDULED_TAG = "#nextscheduled";

function debounce<F extends (...args: any[]) => any>(fn: F, wait: number): F {
    let t: number | null = null;
    return <F>(function (...args: any[]) {
        if (t) window.clearTimeout(t);
        t = window.setTimeout(() => fn(...args), wait);
    });
}

// -----------------------------
// PLUGIN CLASS
// -----------------------------

export default class ReviseSchedulerPlugin extends Plugin {
    onload() {
        console.log("Revise Scheduler loaded.");

        this.registerEvent(
            this.app.vault.on("modify", this._debouncedProcessFile())
        );

        this.registerEvent(
            this.app.metadataCache.on("changed", (file) => {
                this._debouncedProcessFile()(file);
            })
        );

        this.addCommand({
            id: "revise-scheduler-scan-active",
            name: "Revise Scheduler: Scan Active File",
            callback: async () => {
                const file = this.app.workspace.getActiveFile();
                if (file) {
                    await this.processFile(file);
                    new Notice("Revise Scheduler: scanned active file");
                } else {
                    new Notice("No active file.");
                }
            },
        });

        this.addCommand({
            id: "revise-scheduler-scan-vault",
            name: "Revise Scheduler: Scan Entire Vault",
            callback: async () => {
                const files = this.app.vault.getMarkdownFiles();
                for (const f of files) {
                    await this.processFile(f);
                }
                new Notice("Revise Scheduler: scanned all markdown files");
            },
        });
    }

    onunload() {
        console.log("Revise Scheduler unloaded.");
    }

    private _debouncedProcessFile() {
        return debounce((file: TFile) => {
            if (!file || !(file instanceof TFile)) return;
            if (!file.path.toLowerCase().endsWith(".md")) return;

            this.processFile(file).catch((e) =>
                console.error("ReviseScheduler error:", e)
            );
        }, 400);
    }

    // -----------------------------
    // CORE LOGIC
    // -----------------------------

    async processFile(file: TFile) {
        let content = await this.app.vault.read(file);
        const lines = content.split("\n");

        let mutated = false;
        const out: string[] = [];

        for (let i = 0; i < lines.length; i++) {
            let line = lines[i];

            // Push original
            out.push(line);

            if (
                TASK_DONE_RE.test(line) &&
                REVISE_ANY_RE.test(line) &&
                !line.includes(NEXT_SCHEDULED_TAG)
            ) {
                const tag = REVISE_TAGS.find((t) =>
                    line.toLowerCase().includes(t)
                );
                if (!tag) continue;

                const stage = STAGES[tag.toLowerCase()];
                if (!stage) continue;

                const due = moment().add(stage.plusDays, "days").format("YYYY-MM-DD");

                // Clone
                const cloned = line
                    .replace(TASK_DONE_RE, (m) => m.replace("[x]", "[ ]"))
                    .replace(REVISE_ANY_RE, "")
                    .replace(DUE_RE, "")
                    .replace(/\s+$/, "");

                const openTask = TASK_OPEN_RE.test(cloned)
                    ? cloned
                    : cloned.replace(/^\s*/, (sp) => `${sp}- [ ] `);

                const nextLine = `${openTask} 📅 ${due} ${stage.nextTag}`.trim();

                // Insert next scheduled task
                out.push(nextLine);

                // Mark original completed task to avoid duplicates
                const marked = `${line} ${NEXT_SCHEDULED_TAG}`.replace(/\s+$/, "");
                out[out.length - 2] = marked;

                mutated = true;
            }
        }

        if (mutated) {
            const newContent = out.join("\n");
            if (newContent !== content) {
                await this.app.vault.modify(file, newContent);
            }
        }