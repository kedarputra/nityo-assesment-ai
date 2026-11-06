"use client";

import { useActionState } from "react";
import { signInAction, type SignInFormState } from "@/server/auth/actions";

const ERROR_ID = "sign-in-error";

export function SignInForm({ next }: { next: string | undefined }) {
  const [state, formAction, pending] = useActionState<SignInFormState, FormData>(signInAction, {
    message: null,
    username: "",
  });

  return (
    <form action={formAction} className="sign-in-form" noValidate>
      {next ? <input type="hidden" name="next" value={next} /> : null}
      <label className="field">
        <span className="field-label">Username</span>
        <input
          name="username"
          autoComplete="username"
          autoCapitalize="none"
          spellCheck={false}
          defaultValue={state.username}
          aria-describedby={state.message ? ERROR_ID : undefined}
          required
        />
      </label>
      <label className="field">
        <span className="field-label">Password</span>
        <input
          name="password"
          type="password"
          autoComplete="current-password"
          aria-describedby={state.message ? ERROR_ID : undefined}
          required
        />
      </label>
      <p id={ERROR_ID} className="inline-error" aria-live="polite" hidden={!state.message}>
        {state.message}
      </p>
      <button type="submit" className="btn btn--primary" disabled={pending} aria-busy={pending}>
        {pending ? <span className="spinner" aria-hidden="true" /> : null}
        Sign in
      </button>
    </form>
  );
}
