import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { UsageError } from "./config.js";

export const AGENTS_START = "<!-- translatize:agents:start -->";
export const AGENTS_END = "<!-- translatize:agents:end -->";

// Same rules as the translatize-strings skill of the Claude Code plugin – keep the two in step.
const RULES = `## Translations (Translatize)

User-visible text in this project is managed in Translatize. When you write or change code:

- Never hardcode user-visible strings – labels, buttons, headings, messages, errors, placeholders, \`title\`, \`alt\` and \`aria-label\` text. Use the project's i18n lookup call with a translation key.
- Not user-visible, so leave as is: log messages, test files, enum values, CSS classes, URLs and analytics event names.
- Create keys through the Translatize MCP server (\`upsert_labels\`), with the source text and context: a \`description\` of which UI element it is and where it appears, a \`charLimit\` only when the UI clearly limits the length, and \`location\` as \`path:line\`. Add context to existing keys with \`set_label_context\`.
- Use dotted key names grouped by feature or component, e.g. \`checkout.payment.submit_button\`. Reuse an existing key only when the meaning is the same – check with \`search_labels\` first.
- Work on a Translatize branch, never directly on \`main\`: \`create_branch\` with a name like \`agent-<topic>\` (letters, digits, \`-\` and \`_\` only) and pass it as \`branch\`.
- Before asking for a merge, run \`run_qa\`, fix every error, then check \`check_merge_gate\`. Never merge into \`main\` without the user's explicit approval.
- Never put secrets or personal data in translations.

Written by \`translatize init --agents\` – edits inside this section are replaced the next time it runs.`;

/** The full marked block, start and end markers included. */
export function agentsSection(): string {
    return `${AGENTS_START}\n${RULES}\n${AGENTS_END}`;
}

export type SectionAction = "created" | "updated" | "appended" | "unchanged";

/**
 * Insert or replace the marked block in a file's text. `existing === null`
 * means the file does not exist. Text outside the markers is never touched.
 */
export function upsertMarkedSection(existing: string | null, section: string, file = "file"): { content: string; action: SectionAction } {
    if (existing === null) {
        return { content: `${section}\n`, action: "created" };
    }
    const start = existing.indexOf(AGENTS_START);
    const end = existing.indexOf(AGENTS_END);
    if (start === -1 && end === -1) {
        const separator = existing === "" ? "" : existing.endsWith("\n\n") ? "" : existing.endsWith("\n") ? "\n" : "\n\n";
        return { content: `${existing}${separator}${section}\n`, action: "appended" };
    }
    const twice = existing.indexOf(AGENTS_START, start + 1) !== -1 || existing.indexOf(AGENTS_END, end + 1) !== -1;
    if (start === -1 || end === -1 || end < start || twice) {
        throw new UsageError(
            `${file} has a broken Translatize section: it needs exactly one "${AGENTS_START}" followed by one "${AGENTS_END}". ` +
                "Fix or remove the markers, then run the command again.",
        );
    }
    const content = existing.slice(0, start) + section + existing.slice(end + AGENTS_END.length);
    return { content, action: content === existing ? "unchanged" : "updated" };
}

/** Write the section into `<dir>/AGENTS.md` (created when missing) and `<dir>/CLAUDE.md` (only when it exists). */
export function writeAgentFiles(dir: string): { file: string; action: SectionAction }[] {
    const section = agentsSection();
    const results: { file: string; action: SectionAction }[] = [];
    for (const name of ["AGENTS.md", "CLAUDE.md"]) {
        const path = join(dir, name);
        const exists = existsSync(path);
        if (!exists && name === "CLAUDE.md") {
            continue;
        }
        const { content, action } = upsertMarkedSection(exists ? readFileSync(path, "utf8") : null, section, name);
        if (action !== "unchanged") {
            writeFileSync(path, content, "utf8");
        }
        results.push({ file: name, action });
    }
    return results;
}
