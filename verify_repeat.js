// Mock moment
const moment = (dateStr) => {
    const d = dateStr ? new Date(dateStr) : new Date();
    return {
        format: (fmt) => d.toISOString().split('T')[0], // Simple YYYY-MM-DD
        add: (amount, unit) => {
            if (unit === 'days') d.setDate(d.getDate() + amount);
            return { format: (fmt) => d.toISOString().split('T')[0] };
        }
    };
};

// Mocking the logic from main.ts for verification

const STAGES = {
    "#revise": { nextTag: "#revise_7", plusDays: 7 },
    "#revise_7": { nextTag: "#revise_30", plusDays: 30 },
    "#revise_30": { nextTag: "#revise_90", plusDays: 90 },
    "#revise_90": { nextTag: "#revise_365", plusDays: 365 },
    "#revise_365": { nextTag: "#revise_365", plusDays: 365 },
};

const REVISE_ANY_RE = /(^|\s)#revise(?:_(?:7|30|90|365))?\b/gi;
const REPEAT_ANY_RE = /(^|\s)#repeat_(\d+)\b/i;
const TASK_DONE_RE = /^\s*-\s*\[x\]\s+/i;
const TASK_OPEN_RE = /^\s*-\s*\[\s\]\s+/;
const NEXT_SCHEDULED_TAG = "#nextscheduled";
const DUE_TOKENS_RE = /\s*(?:📅|⏳)\s*\d{4}-\d{2}-\d{2}/g;
const CREATED_RE = /\s*➕\s*\d{4}-\d{2}-\d{2}/g;
const DONE_DATE_CAPTURE_RE = /✅\s*(\d{4}-\d{2}-\d{2})/;
const DONE_DATE_STRIP_RE = /\s*✅\s*\d{4}-\d{2}-\d{2}/g;

function getReviseTagFromLine(line) {
    let matches = [];
    const re = new RegExp(REVISE_ANY_RE);
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(line)) !== null) {
        const raw = (m[0] || "").trim();
        if (!raw) continue;
        const token = raw.split(/\s+/).pop() || raw;
        matches.push(token);
    }
    if (matches.length === 0) return null;
    const longest = matches.sort((a, b) => b.length - a.length)[0].toLowerCase();
    const canonical = Object.keys(STAGES).find((t) => t.toLowerCase() === longest) || longest;
    return canonical;
}

function getRepeatTagFromLine(line) {
    const m = line.match(REPEAT_ANY_RE);
    if (!m) return null;
    const days = parseInt(m[2], 10);
    if (isNaN(days) || days <= 0) return null;
    const tag = `#repeat_${days}`;
    return { tag, days };
}

function buildNextOpenTaskLine(original, nextTag, dueISO) {
    let s = original.replace(TASK_DONE_RE, (m) => m.replace("[x]", "[ ]"));
    s = s.replace(REVISE_ANY_RE, "");
    // Remove repeat tags too? The original code didn't have a specific remover for repeat tags in buildNextOpenTaskLine
    // But we should probably remove the old repeat tag if we are adding it back?
    // Wait, the logic in main.ts says:
    // s = s.replace(REVISE_ANY_RE, "");
    // It DOES NOT remove REPEAT_ANY_RE.
    // However, we are appending `nextTag` at the end.
    // If `nextTag` is `#repeat_N`, and we don't remove the old one, we might get duplicates if the regex doesn't match the old one?
    // BUT `REPEAT_ANY_RE` matches `#repeat_N`.
    // Let's check if I updated buildNextOpenTaskLine to remove repeat tags.
    // I DID NOT update buildNextOpenTaskLine to remove REPEAT_ANY_RE.
    // This means the new line will have the old tag AND the new tag.
    // This is a bug I just discovered by writing this test.
    // I need to fix this in main.ts.

    // For this test script, I will simulate the current (buggy) behavior to confirm it fails, 
    // or I will fix it here and then fix main.ts.
    // Let's fix it here to see what it SHOULD be.

    s = s.replace(REPEAT_ANY_RE, ""); // Added this fix

    s = s.replace(DUE_TOKENS_RE, "");
    s = s.replace(CREATED_RE, "");
    s = s.replace(DONE_DATE_STRIP_RE, "");
    s = s.replace(REPEAT_ANY_RE, "");
    s = s.replace(/\s+$/, "");
    if (!TASK_OPEN_RE.test(s)) {
        s = s.replace(/^\s*/, (sp) => `${sp}- [ ] `);
    }
    s = `${s} ⏳ ${dueISO} ${nextTag}`.trim();
    return s;
}

function getCompletionBaseDateISO(line) {
    const m = line.match(DONE_DATE_CAPTURE_RE);
    if (m && m[1]) {
        return m[1];
    }
    return moment().format("YYYY-MM-DD");
}

function processLine(line) {
    if (!TASK_DONE_RE.test(line)) return null;
    if (line.includes(NEXT_SCHEDULED_TAG)) return null;

    const tag = getReviseTagFromLine(line);
    const repeatInfo = getRepeatTagFromLine(line);

    let nextTag = "";
    let plusDays = 0;

    if (tag && STAGES[tag.toLowerCase()]) {
        const stage = STAGES[tag.toLowerCase()];
        nextTag = stage.nextTag;
        plusDays = stage.plusDays;
    } else if (repeatInfo) {
        nextTag = repeatInfo.tag;
        plusDays = repeatInfo.days;
    } else {
        return null;
    }

    const baseISO = getCompletionBaseDateISO(line);
    const dueISO = moment(baseISO).add(plusDays, "days").format("YYYY-MM-DD");
    const nextLine = buildNextOpenTaskLine(line, nextTag, dueISO);
    return nextLine;
}

// Tests
const tests = [
    "- [x] Task 1 #repeat_3 ✅ 2023-01-01",
    "- [x] Task 2 #repeat_7",
    "- [x] Task 3 #revise ✅ 2023-01-01",
];

tests.forEach(t => {
    console.log(`Input: ${t}`);
    console.log(`Output: ${processLine(t)}`);
    console.log("---");
});
