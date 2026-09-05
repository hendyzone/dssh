# Interaction and Input Implementation Plan

> Execute inline with executing-plans; keep the user's existing edits intact.

**Goal:** Make terminal focus and keyboard handling predictable and server editing recoverable.

**Architecture:** Shared keyboard predicates classify IME and application shortcuts. TerminalView receives an explicit input-enabled flag independent of pane selection. ServerForm owns validation and async submission state; App retains persistence.

**Tech Stack:** React 18, TypeScript, Tauri 2, Vitest + jsdom + Testing Library.

## Task 1: Regression harness

- [x] Add `apps/desktop/vitest.config.ts`, `tests/setup.ts`, and `test` script. Mock native API boundaries only.
- [x] Write component tests against current code: reverse tab switching, shortcuts in inputs, IME rename/submit, port/key validation, duplicate submit and retry, inactive terminal initialization.
- [x] Run `npm test` and confirm expected behavior failures before implementation (19 failures, 2 existing behaviors passing).

## Task 2: Keyboard and focus

- [x] Create `src/lib/keyboard.ts` with `isComposingKey(event)` and `isAppShortcut(event)`; use the same shortcut ownership in App and TerminalView.
- [x] Update `src/App.tsx`: capture owned shortcuts before terminal encoding, skip editable controls/modals/composition, wrap reverse switching, guard rename Enter, pass `inputEnabled`.
- [x] Update `src/components/TerminalView.tsx`: latest active/input refs gate initialization focus and DOM user input; active transitions focus textarea after layout and fit; modal transitions blur only the terminal textarea. Keep protocol responses flowing through onData.
- [x] Preserve existing echoSuppress changes and standard terminal control keys.
- [x] Add `src/lib/useDialogFocus.ts` for initial focus and Tab containment in server form, settings, and picker; cover missing behavior with failing tests before implementation.

## Task 3: Form feedback

- [x] Update `src/components/ServerForm.tsx`: field errors, first-invalid focus, decimal integer port validation, required key path, IME guard and async submission with synchronous duplicate lock.
- [x] Disable fieldset and cancellation while pending; render accessible error/status feedback. Retry retains values and record ID; edit spreads original metadata.
- [x] Update `src/App.tsx` submit handler to return rejected persistence errors to form and close only on success.
- [x] Add focused CSS for disabled fields, visible errors and consistent fieldset layout.

## Task 4: Review and verification

- [x] Run `npm test` and `npm run build` in `apps/desktop` (27 tests passing; build succeeds with the pre-existing large chunk warning).
- [x] Request bounded independent review of changes while inspecting test coverage and working diff locally. The reviewer process could not start because its login refresh token was revoked; local review completed instead.
- [x] Address local review findings: preserve DSR responses; include initial modal focus and Tab containment; verify new-record retry IDs and valid port boundaries.

## Verification limits

Tests render actual React components in jsdom. Tauri calls and ghostty initialization are mocked. They verify event routing, DOM focus, and async form behavior, not native Windows IME candidate rendering or live SSH behavior. Existing Rust/echo suppression changes were preserved; no remote server operations were run.
