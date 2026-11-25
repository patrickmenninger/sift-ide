import { useState } from "preact/hooks";
import type { EditQuestion } from "@sift/core";
import { activityLabel, asksForSomething } from "./edit-model.js";
import type { UnitEditor } from "./logic-document.js";
import type { WebviewMessage } from "./protocol.js";

/**
 * The panel under a unit with a change in progress (phase-2-design §8.1–8.4, §8.9): the free-form
 * request, Propose, progress while the change is planned and written, the questions to answer,
 * the outcome (ready to review, failed, or the code changed underneath), and Discard.
 */
export function EditPanel({ editor, provider, post }: { editor: UnitEditor; provider: { id: string; local: boolean } | null; post: (m: WebviewMessage) => void }) {
  const edit = editor.edit;
  const req = edit?.request;
  const state = req?.state ?? "draft";
  const asks = asksForSomething(editor.edits, editor.request);

  if (edit?.activity) {
    const proposing = edit.activity !== "checks" && edit.activity !== "applying";
    return (
      <div class="edit-panel running" role="status">
        <span class="spinner" aria-hidden="true" /> {activityLabel(edit.activity)}
        {proposing && (
          <button class="secondary small" onClick={() => post({ type: "cancel", id: edit.request.id })}>
            Cancel
          </button>
        )}
      </div>
    );
  }

  if (req && state === "needs-review") {
    return (
      <div class="edit-panel needs-review">
        <div class="banner warning">
          <strong>The code changed since this edit was written.</strong> {req.review && req.review !== "The code changed since this edit was written." ? req.review : ""} Sift will not apply it to code it was not written for.
        </div>
        <Asked edits={req.edits.length} request={req.request} />
        <div class="edit-buttons">
          <button onClick={() => post({ type: "replan", id: req.id })} title="Start over from the code as it is now, keeping the edits that still fit, and propose the change again.">
            Re-plan on the current code
          </button>
          <button class="secondary" onClick={editor.close}>
            Discard
          </button>
        </div>
      </div>
    );
  }

  return (
    <div class={`edit-panel ${state}`}>
      {req && state === "failed" && req.error && (
        <div class="banner error">
          <strong>{req.error.message}</strong>
          {req.error.details.length > 0 && (
            <ul class="details">
              {req.error.details.slice(0, 8).map((d, i) => (
                <li key={i}>{d}</li>
              ))}
            </ul>
          )}
        </div>
      )}
      {req && state === "ready" && req.proposal && (
        <div class="ready">
          {req.plan?.interpretation && <p class="interpretation">{req.plan.interpretation}</p>}
          <p class="muted">
            {req.proposal.kind === "reword"
              ? "Only the wording changes; the code stays as it is."
              : `Changes ${req.proposal.scope.changed.length} unit${req.proposal.scope.changed.length === 1 ? "" : "s"} in ${req.proposal.files.length} file${req.proposal.files.length === 1 ? "" : "s"}.`}
            {req.proposal.scope.broader && <strong class="broader"> Reaches beyond this unit: {req.proposal.scope.broader.reason}</strong>}
            {req.proposal.verify && !req.proposal.verify.satisfied && <strong class="gap"> It may not do everything you asked.</strong>}
          </p>
          <div class="edit-buttons">
            <button onClick={() => post({ type: "review", id: req.id })}>Review change…</button>
            <button class="secondary" onClick={editor.close}>
              Discard
            </button>
          </div>
        </div>
      )}
      {req && state === "needs-answers" && (
        <Questions key={req.id + (req.rounds ?? 0)} questions={req.questions ?? []} onAnswer={(answers) => post({ type: "answer", id: req.id, answers })} />
      )}
      {req && req.answers.length > 0 && state !== "ready" && (
        <dl class="answers">
          {req.answers.map((a) => (
            <div key={a.questionId + a.question}>
              <dt>{a.question}</dt>
              <dd>{a.answer}</dd>
            </div>
          ))}
        </dl>
      )}
      {editor.editable && (
        <>
          <label class="request-label" for={`request-${editor.base.id}`}>
            Ask for a change
          </label>
          <textarea
            id={`request-${editor.base.id}`}
            class="request"
            rows={2}
            placeholder="In your own words, e.g. “Reject amounts of zero or less.” Or edit the description above."
            value={editor.request}
            onInput={(e) => {
              fit(e.currentTarget);
              editor.setRequest(e.currentTarget.value, false);
            }}
            onBlur={(e) => editor.setRequest(e.currentTarget.value, true)}
          />
          <div class="edit-buttons">
            {state !== "needs-answers" && (
              <button disabled={!asks} title={asks ? "Plan and write the change. Nothing in your files changes until you approve it." : "Edit the description or write what to change first."} onClick={editor.propose}>
                {state === "ready" || state === "failed" ? "Propose again" : "Propose change"}
              </button>
            )}
            <button class="secondary" onClick={editor.close}>
              {req || asks ? "Discard" : "Cancel"}
            </button>
            {provider && !provider.local && state !== "needs-answers" && <span class="muted note">Proposing sends this unit and the code around it to {provider.id}.</span>}
            {!provider && <span class="muted note">This project has no AI provider, so it cannot propose changes.</span>}
          </div>
        </>
      )}
    </div>
  );
}

/** What the person asked for, in one line (for a request whose code changed). */
function Asked({ edits, request }: { edits: number; request: string | undefined }) {
  const parts = [request ? `“${request}”` : "", edits > 0 ? `${edits} edit${edits === 1 ? "" : "s"} to the description` : ""].filter(Boolean);
  return parts.length > 0 ? <p class="muted">You asked for {parts.join(" and ")}.</p> : null;
}

/** The plan's questions (§8.4): pick an option or write an answer; all must be answered to go on. */
export function Questions({ questions, onAnswer }: { questions: EditQuestion[]; onAnswer: (answers: { questionId: string; answer: string }[]) => void }) {
  const [picked, setPicked] = useState<Record<string, string>>({});
  const [other, setOther] = useState<Record<string, string>>({});
  const choiceOf = (q: EditQuestion) => picked[q.id] ?? (q.options.length === 0 ? OTHER : undefined);
  const answerOf = (q: EditQuestion) => (choiceOf(q) === OTHER ? (other[q.id] ?? "").trim() : (choiceOf(q) ?? ""));
  const complete = questions.every((q) => answerOf(q) !== "");
  return (
    <form
      class="questions"
      onSubmit={(e) => {
        e.preventDefault();
        if (complete) onAnswer(questions.map((q) => ({ questionId: q.id, answer: answerOf(q) })));
      }}
    >
      <p class="questions-intro">Sift needs to know a little more before it writes the change.</p>
      {questions.map((q) => (
        <fieldset key={q.id} class="question">
          <legend>{q.text}</legend>
          {q.options.map((o) => (
            <label key={o} class="option">
              <input type="radio" name={q.id} value={o} checked={picked[q.id] === o} onChange={() => setPicked({ ...picked, [q.id]: o })} /> {o}
            </label>
          ))}
          <label class="option other">
            <input type="radio" name={q.id} value={OTHER} checked={choiceOf(q) === OTHER} onChange={() => setPicked({ ...picked, [q.id]: OTHER })} />{" "}
            <input
              type="text"
              aria-label={`Your answer to: ${q.text}`}
              placeholder={q.options.length > 0 ? "Something else…" : "Your answer"}
              value={other[q.id] ?? ""}
              onFocus={() => setPicked({ ...picked, [q.id]: OTHER })}
              onInput={(e) => setOther({ ...other, [q.id]: e.currentTarget.value })}
            />
          </label>
        </fieldset>
      ))}
      <div class="edit-buttons">
        <button type="submit" disabled={!complete}>
          Answer and continue
        </button>
      </div>
    </form>
  );
}

const OTHER = "\u0000other";

/** Grow a textarea to fit its text. */
export function fit(el: HTMLTextAreaElement): void {
  el.style.height = "auto";
  if (el.scrollHeight > 0) el.style.height = `${el.scrollHeight}px`;
}
