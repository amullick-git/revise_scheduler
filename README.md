# Revise Scheduler (Spaced Ladder)

A lightweight, automatic spaced-repetition scheduler for Obsidian tasks.
Designed for long-term memory reinforcement using a “revision ladder” such as:

```
#revise       → +7 days   → #revise_7
#revise_7     → +30 days  → #revise_30
#revise_30    → +90 days  → #revise_90
#revise_90    → +365 days → #revise_365
#revise_365   → +365 days → #revise_365 (repeat yearly)
```

Whenever you complete (✓) a task tagged with any `#revise*` tag, the plugin automatically generates the next future task with an appropriate due date.

This plugin **requires no UI**, works on file changes and vault scanning, and integrates seamlessly with Obsidian Tasks-style workflows.

---

## ✅ Features

### ✅ Automatic spaced repetition scheduling

When you mark a revise task as completed:

```
- [x] Study Graph Algorithms #revise
```

The plugin automatically creates:

```
- [ ] Study Graph Algorithms ⏳ 2025-11-15 #revise_7
```

And marks the completed task:

```
- [x] Study Graph Algorithms #revise #nextscheduled
```

So it **never reschedules twice**, even in Vim mode or across file reloads.

---

### ✅ Revision Ladder (Configurable in code)

Default ladder:

| Current Tag   | Next Tag      | Interval                |
| ------------- | ------------- | ----------------------- |
| `#revise`     | `#revise_7`   | 7 days                  |
| `#revise_7`   | `#revise_30`  | 30 days                 |
| `#revise_30`  | `#revise_90`  | 90 days                 |
| `#revise_90`  | `#revise_365` | 365 days                |
| `#revise_365` | `#revise_365` | 365 days (cycle yearly) |

You can modify the ladder by editing the `STAGES` map in `main.ts`.

---

### ✅ Fixed Interval Repetition (#repeat_N)

If you want a task to repeat every N days without following the ladder, use the `#repeat_N` tag (where N is a number > 0).

Example:

```
- [x] Water plants #repeat_3
```

Will generate:

```
- [ ] Water plants ⏳ 2025-11-18 #repeat_3
```

This is useful for maintenance tasks or habits that don't need spaced repetition.

---

### ✅ Duplicate-proof scheduling

On completion, the plugin adds:

```
#nextscheduled
```

to the closed task, ensuring:

* No duplicates on Obsidian restart
* No duplicates during sync
* No duplicates when using Vim-mode edits
* No duplicates when modifying the same task multiple times

---

### ✅ Works automatically + optional manual commands

The plugin listens to:

* `vault.on("modify")`
* `metadataCache.on("changed")`

Additionally, it exposes two useful commands:

#### ✅ **Revise Scheduler: Scan Active File**

Process only the current note.

#### ✅ **Revise Scheduler: Scan Entire Vault**

Run the scheduler across all `.md` files.

Great for cleanup after importing notes or converting tasks.

---

## ✅ Installation

### **Manual Install**

1. Download:

   * `main.js`
   * `manifest.json`
   * (optional) `styles.css`

2. Place them in a folder inside:

```
.obsidian/plugins/revise-scheduler/
```

3. Reload Obsidian.
4. Enable **Revise Scheduler** from *Settings → Community Plugins*.

---

## ✅ Usage

### Step 1 — Create a task with a revise tag

```
- [ ] Review Chapter 1 #revise
```

### Step 1.5 — OR use a fixed repeat interval

If you prefer a fixed schedule (e.g., every 3 days) instead of a ladder:

```
- [ ] Water plants #repeat_3
```

### Step 2 — Mark it complete

```
- [x] Review Chapter 1 #revise
```

### Step 3 — Plugin auto-generates the next occurrence

```
- [x] Review Chapter 1 #revise #nextscheduled
- [ ] Review Chapter 1 ⏳ 2025-11-25 #revise_7
```

### Step 4 — Continue the ladder

Each completion will schedule the next stage automatically.

---

## ✅ Why this plugin?

Unlike conventional spaced-repetition plugins, this one:

* Works **entirely inside your existing task system**
* Uses **Obsidian Tasks conventions** (`📅 YYYY-MM-DD`)
* Does not require databases, UIs, or external dependencies
* Supports **year-long revision cycles**
* Is **Vim-mode safe**, **sync-safe**, and **idempotent**

Perfect for long-term memory reinforcement of:

* Interview prep
* Technical concepts
* Language learning
* Research reviews
* Skills practice
* Anything worth revisiting yearly

---

## ✅ Customization

Modify the ladder:

```ts
const STAGES = {
  "#revise":      { nextTag: "#revise_7",   plusDays: 7   },
  "#revise_7":    { nextTag: "#revise_30",  plusDays: 30  },
  "#revise_30":   { nextTag: "#revise_90",  plusDays: 90  },
  "#revise_90":   { nextTag: "#revise_365", plusDays: 365 },
  "#revise_365":  { nextTag: "#revise_365", plusDays: 365 },
};
```

Modify regex behavior or duplicate protection as needed.
