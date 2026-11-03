---
name: localize-repo
description: Localize a repository with Translatize – find hardcoded user-visible strings, move them into translation keys with context on a Translatize branch, translate them, run QA and report the merge gate. Use when the user asks to localize, internationalize or translate an app, add languages, or extract hardcoded UI strings.
---

# Localize a repository with Translatize

This skill uses the `translatize` MCP server that ships with this plugin. Call
`get_project_info` first: it tells you the project, its languages, the token's base
branch and whether the token may create branches (`branchScope: create-own`). If
the token is `fixed`, skip step 4 and work on its base branch – but say so to the
user first, because the changes then land directly on that branch.

Ask the user for the target languages if they did not name them. Only languages
configured on the project can be written.

Follow these steps in order:

1. **Detect the framework and i18n library** – react-i18next, next-intl, vue-i18n,
   Angular, Svelte, iOS strings, Android XML or Flutter ARB. If none is set up,
   propose a setup (library, file layout, where the lookup call goes) and **wait for
   the user's approval** before changing anything.
2. **Find hardcoded user-visible strings.** Exclude logs, test files, enum values,
   CSS classes, URLs and analytics event names.
3. **Propose dotted key names** grouped by feature or component, e.g.
   `checkout.payment.submit_button`. Check existing keys with `search_labels` and
   reuse one only when the meaning is the same.
4. **`create_branch`** named `agent-<topic>` – letters, digits, `-` and `_` only, for
   example `agent-checkout-copy`. Pass that name as `branch` in every later call.
5. **Upsert source labels with context** using `upsert_labels`:
   - `description` says which UI element it is and where it appears;
   - `charLimit` only when the UI clearly constrains the length;
   - `location` = `path:line`.

   ```json
   { "branch": "agent-checkout-copy", "labels": [
     { "key": "checkout.payment.submit_button", "values": { "en": "Pay now" },
       "context": { "description": "Submit button of the checkout payment form", "charLimit": 20, "location": "src/checkout/PaymentForm.tsx:88" } }
   ] }
   ```
6. **Replace the strings in code** with the library's lookup call (`t('…')`,
   `useTranslations`, `$t`, `NSLocalizedString`, `getString`, `AppLocalizations`…).
7. **Run `auto_translate`** for the target languages and follow it with
   `translation_job_status`. If it fails with `feature_not_available` (no platform AI
   on the plan), translate yourself: `get_missing_translations`, check `get_glossary`
   and `find_translation_memory` for the project's wording, then `upsert_labels`.
8. **`run_qa`** on the branch, then fix the errors – rewrite the source or adjust the
   placeholders – and run it again until no errors are left.
9. **`check_merge_gate`** for the branch.
10. **Summarise for the user**: files changed, keys created, languages translated,
    the QA result, the gate verdict and the `review_changes` link. **Never merge into
    `main` without the user's explicit approval.**

When the user approves the merge, call `merge_branch` and then `delete_branch`.
Merging into `main` needs an admin-role token; on `admin_token_required_for_main`,
give the user the `review_changes` link so they merge in the web app. On
`qa_gate_blocked`, go back to step 8.
