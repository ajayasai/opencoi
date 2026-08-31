# Moderator guide

Use this guide with the registered v1.1 protocol and synthetic task pack. Replace bracketed local
administrative details only after legal, privacy, and ethics review.

## Before the session

- Confirm the participant consented using the approved form and knows recording is optional.
- Verify the exact OpenCOI commit, browser, viewport, input method, and synthetic seed.
- Remove real accounts, documents, notifications, browser autofill, and clipboard contents.
- Generate a random private session ID in the form `P-` plus 12 uppercase hexadecimal characters.
- Never place the identity-to-pseudonym mapping in this repository.
- Confirm the participant can adjust zoom, contrast, audio, input, and assistive technology.
- Start with a clean task state; do not preload the answer page.

## Opening script

“We are testing OpenCOI, not you. OpenCOI compares information in an uploaded insurance document
with rules configured by its operator. It does not contact an insurer or establish that a policy is
currently active. Please work as you normally would, say what you are looking for if comfortable,
and tell me when you believe a task is complete. You may pause, skip a task, or stop at any time.”

Ask permission before starting any optional recording. Do not infer recording consent from general
study consent.

## During each task

1. Read the task verbatim and answer vocabulary questions without describing the interface.
2. Start timing after the participant says the task is understood.
3. Observe silently. Record errors and fixed issue codes; put detailed notes only in the approved
   private location.
4. After 90 seconds without progress, on a direct request for help, or before a critical incident,
   offer the next neutral hint.
5. Stop timing at success, participant stop, or the stated time box.
6. Ask the fixed confidence question: “How confident are you that you completed this task correctly,
   from 1, not at all, to 5, completely?”

## Neutral hints

Use at most one hint from each level before advancing:

1. “What information would you expect to use for this decision?”
2. “Which part of the page appears related to that information?”
3. “You may inspect the navigation and the actions available on this record.”

For assistive-technology blockers, it is acceptable to ask the participant to describe the missing
name, state, order, or announcement. Do not switch off their assistive technology to force success.

## Incident rules

Mark a critical incident when the participant:

- approves, rejects, or excepts the wrong finding or vendor;
- believes an exception changed a failed base finding into a pass;
- believes a document result proves live insurer-side status;
- exposes a bearer upload link or unintended document data;
- becomes trapped with keyboard focus or cannot reach a required action with their assistive
  technology; or
- would lose or overwrite meaningful work without a clear warning.

Pause the study for an actual security, privacy, or data-loss event. Preserve no sensitive material
in GitHub. Follow the private security-reporting process when appropriate.

## Scope-comprehension check

After all tasks, ask without prompting:

“What does an OpenCOI ‘meets configured document checks’ result tell you, and what does it not tell
you?”

Mark correct only if the answer includes both:

- the uploaded document's confirmed facts met configured rules at the evaluation time; and
- OpenCOI did not confirm current status with an insurer or guarantee coverage.

## Closing script

Ask:

- “What, if anything, made you uncertain?”
- “Where would you expect to find supporting evidence?”
- “Was any status or action described in a misleading way?”

Remind the participant how to withdraw according to the approved consent form. Stop and secure all
private material before resetting the synthetic workspace.

## After the session

- Complete one schema row per attempted task.
- Verify the session ID, role, accessibility category, task code, and full product commit.
- Keep detailed notes and consent separate from the numeric CSV.
- Run the analyzer locally; do not publish row-level participant data.
- Log protocol deviations before reviewing aggregate outcomes.
