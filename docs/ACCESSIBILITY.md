# Accessibility

OpenCOI aims to make document-review decisions usable with a keyboard and common assistive
technology. Accessibility is an engineering requirement and a continuing verification activity,
not a claim that this release is certified or universally conformant.

## Implemented interaction contracts

- A visible-on-focus “Skip to main content” link targets the programmatically focusable main region.
- Client-side route changes update the document title and move focus to main content.
- Every shared `Field` control receives a programmatic visible label, unique ID, connected hint and
  error descriptions, and `aria-invalid` when an error is present. Compound fields give each control
  a unique ID rather than reusing one label target.
- Dialogs trap focus, close with Escape, and restore the previous focus target.
- One-time integration credentials open in a labelled focus-managed dialog, announce copy status,
  warn before an unsaved dismissal, and return focus to the relevant creation or rotation control.
- Irreversible credential revocation and integration disabling require an explicit confirmation.
- The programmatically activated PDF file input has an accessible name and is removed from the tab
  sequence; the visible “Choose PDF” button remains the keyboard entry point.
- The account disclosure supports Arrow Down, Escape, outside dismissal, controlled-state
  attributes, and focus movement to its first action.
- On narrow viewports, primary navigation becomes an identified focus-managed drawer. Background
  content is inert while open, focus stays inside, Escape closes it, and focus returns to the trigger.
- Toast notifications use a polite live region, status is never conveyed only by color, visible
  focus is global, and reduced-motion preferences shorten animation and transition effects.

These contracts are covered by focused jsdom regressions. They do not replace testing in real
browsers and assistive technologies.

## Keyboard smoke test

For every release candidate:

1. Start at sign-in and use only Tab, Shift+Tab, Enter, Space, arrow keys, and Escape.
2. Confirm the skip link appears on focus and moves focus to main content.
3. Traverse every primary-navigation item and confirm route changes announce a new title/focus
   context.
4. Open and close the account disclosure by keyboard; confirm focus returns to its trigger.
5. At 980 CSS pixels or narrower, open the navigation drawer, cycle from its last focusable item to
   its first, close with Escape, and confirm background controls cannot receive focus while open.
6. Open every modal used by vendor, requirement, exception, and certificate workflows. Confirm
   initial focus, Tab/Shift+Tab containment, Escape dismissal where safe, and focus restoration.
7. Complete a human-review form and verify every input's accessible name, description, validation
   state, and error recovery.
8. Confirm no approval, rejection, exception, upload, or reminder action depends on hover or color.
9. Create or rotate a synthetic integration credential. Confirm the one-time dialog is announced,
   unsaved dismissal warns, copy status is announced, and focus returns to the related control.
10. Attempt credential revocation and account/webhook disabling; confirm cancellation preserves the
    active state and acceptance is explicit.

## Manual assistive-technology matrix

Record exact product commit, OS, browser, assistive-technology version, zoom, viewport, input method,
tested workflows, blockers, and linked synthetic reproduction issue. A blank cell means untested,
not passed.

| Environment | Sign-in/navigation | Vendor directory | PDF review/correction | Exceptions | Upload link | Status |
| --- | --- | --- | --- | --- | --- | --- |
| NVDA + Firefox on Windows |  |  |  |  |  | Not tested |
| NVDA + Chrome on Windows |  |  |  |  |  | Not tested |
| VoiceOver + Safari on macOS |  |  |  |  |  | Not tested |
| Keyboard only at 200% zoom |  |  |  |  |  | Not tested |
| Windows forced-colors mode |  |  |  |  |  | Not tested |

Do not convert this matrix into a conformance statement. Publish failures and unresolved blockers,
not only successful combinations.

## Known verification gaps

- No automated browser/axe suite is included yet; the current automated checks are component-level.
- PDF pages are rendered to canvas. Controls have names, but the canvas is not a substitute for an
  accessible source document. Reviewers who cannot perceive the rendered page need an independently
  accessible source or accommodation; extracted text is not authoritative evidence.
- OCR progress, very large tables, 320-CSS-pixel reflow, 400% zoom, forced colors, and high-contrast
  charts/status styles still require systematic browser verification.
- Exception tabs need full arrow/Home/End-key tablist behavior before claiming the complete ARIA
  tabs pattern.
- Third-party browser/PDF/assistive-technology combinations may behave differently from the matrix.

## Usability evidence

The preregistered study kit in [`research/usability`](../research/usability/README.md) separates
protocols and synthetic analyzer tests from real participant evidence. The repository currently has
no participant usability result. Never present the synthetic fixture as proof of accessibility or
ease of use.

## Reporting a barrier

Use the public usability issue template only with synthetic reproduction steps and aggregate,
privacy-reviewed findings. Do not post a real certificate, policy number, vendor contact, participant
identity, quote, recording, consent record, session ID, or row-level study data.

Report security or privacy vulnerabilities privately through the process in [SECURITY.md](../SECURITY.md).
Accessibility barriers that could cause unintended approval, disclosure, destructive action, or a
false belief about insurer-side status should be treated as critical workflow incidents.
