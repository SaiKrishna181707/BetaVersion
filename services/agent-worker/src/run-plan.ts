import {
  GUARDRAILS,
  runLimitsFromConfiguration,
  type RunConfiguration,
  type RunExecutionLimits,
  type RunPlan,
  type SessionPlan,
  type SyntheticPersona,
} from '@synthetic-beta/contracts';

export interface BuildRunPlanInput {
  run_id: string;
  configuration: RunConfiguration;
  /** One session per persona. The population service produced these before anything ran. */
  personas: readonly SyntheticPersona[];
  allowed_origins: readonly string[];
  checkpoint_plan: readonly string[];
  /** Reference to a disposable test account per session. Never a credential. */
  account_refs?: readonly string[];
  /** Derived from the configuration when absent, so a caller cannot invent looser limits. */
  limits?: RunExecutionLimits;
}

/**
 * Turns a reviewed configuration and a sampled cohort into one plan per session.
 *
 * Personas are never reused across sessions: session `n` gets persona `n`, so "twenty
 * synthetic users" always means twenty independently seeded execution contexts, not one
 * context labelled twenty times. Budget is allocated by reservation — each session is
 * granted a share up front and every session grants can never exceed the run cap.
 */
export function buildRunPlan(input: BuildRunPlanInput): RunPlan {
  const limits = input.limits ?? runLimitsFromConfiguration(input.configuration);
  const personas = input.personas;
  if (personas.length === 0) throw new Error('A run needs at least one persona to plan a session.');
  if (personas.length > GUARDRAILS.MAX_USERS) {
    throw new Error(`A run may not plan more than ${GUARDRAILS.MAX_USERS} sessions.`);
  }

  const sessions: SessionPlan[] = [];
  let remaining = limits.run_budget_cents;
  for (let index = 0; index < personas.length; index += 1) {
    const persona = personas[index];
    if (persona === undefined) continue;
    const sessionsLeft = personas.length - index;
    const share = Math.floor(remaining / sessionsLeft);
    const granted = Math.max(1, share);
    remaining = Math.max(0, remaining - granted);
    sessions.push({
      run_id: input.run_id,
      session_id: sessionId(index),
      persona,
      objective: input.configuration.objective,
      target_url: input.configuration.target_url,
      allowed_origins: input.allowed_origins,
      checkpoint_plan: input.checkpoint_plan,
      max_actions: limits.max_actions,
      max_session_seconds: limits.max_session_seconds,
      remaining_budget_cents: granted,
      account_ref: input.account_refs?.[index] ?? null,
    });
  }

  return {
    run_id: input.run_id,
    configuration: input.configuration,
    sessions,
    total_budget_cents: limits.run_budget_cents,
  };
}

/** Stable, sortable session identifiers: s-001, s-002, ... */
export function sessionId(index: number): string {
  return `s-${String(index + 1).padStart(3, '0')}`;
}