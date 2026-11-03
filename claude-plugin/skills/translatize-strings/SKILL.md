---
name: translatize-strings
description: Rules for user-visible text in projects whose translations live in Translatize. Use whenever you add or change UI text, labels, messages, errors, placeholders or alt/aria text, or create translation keys.
---

# Writing user-visible strings with Translatize

User-visible text in this project is managed in Translatize, through the
`translatize` MCP server. When you write or change code:

- **Never hardcode user-visible strings** – labels, buttons, headings, messages,
  errors, placeholders, `title`, `alt` and `aria-label` text. Use the project's i18n
  lookup call with a translation key.
- Not user-visible, so leave as is: log messages, test files, enum values, CSS
  classes, URLs and analytics event names.
- **Create keys through the Translatize MCP server** (`upsert_labels`), with the
  source text and context: a `description` of which UI element it is and where it
  appears, a `charLimit` only when the UI clearly limits the length, and `location`
  as `path:line`. Add context to existing keys with `set_label_context`.
- **Use dotted key names** grouped by feature or component, e.g.
  `checkout.payment.submit_button`. Reuse an existing key only when the meaning is
  the same – check with `search_labels` first.
- **Work on a Translatize branch**, never directly on `main`: `create_branch` with a
  name like `agent-<topic>` (letters, digits, `-` and `_` only) and pass it as
  `branch`.
- **Before asking for a merge**, run `run_qa`, fix every error, then check
  `check_merge_gate`. Never merge into `main` without the user's explicit approval.
- Never put secrets or personal data in translations.

For a whole-repository pass, use the `localize-repo` skill.
