import { invokeNovaJson, type JsonModel } from '@centopus/ai';
import type { BehaviorEvent, CentopusReport, SyntheticPersona } from '@centopus/contracts';

function bounded(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const clean = value.replace(/\s+/g, ' ').trim();
  return clean ? clean.slice(0, max) : undefined;
}

function boundedList(value: unknown, maxItems = 4, maxLength = 500): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const clean = value
    .map(item => bounded(item, maxLength))
    .filter((item): item is string => Boolean(item));
  return clean.length ? [...new Set(clean)].slice(0, maxItems) : undefined;
}

function evidenceFor(events: readonly BehaviorEvent[], sessionId: string) {
  return events.filter(event => event.session_id === sessionId).map((event, sequence) => ({
    sequence: sequence + 1,
    elapsed_ms: event.elapsed_ms,
    page_title: event.page_title,
    route: event.route,
    action: event.action_type,
    target: event.target_descriptor,
    result: event.result,
    reason: event.agent_reason_code,
    checkpoint: event.task_checkpoint,
    thought: event.thought,
  }));
}

function signature(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim();
}

/** Refines presentation only. Recorded outcomes, metrics, evidence and confidence remain immutable. */
export async function refineReportWithNova(
  report: CentopusReport,
  personas: readonly SyntheticPersona[],
  events: readonly BehaviorEvent[] = [],
  model: JsonModel = invokeNovaJson,
  modelId = process.env.NOVA_REPORT_MODEL_ID || 'amazon.nova-lite-v1:0',
): Promise<CentopusReport> {
  const personaById = new Map(personas.map(persona => [persona.persona_id, persona]));
  const chunks = Array.from({ length: Math.ceil(report.agent_feedback.length / 20) }, (_, index) =>
    report.agent_feedback.slice(index * 20, index * 20 + 20));
  const refined = await Promise.all(chunks.map(async feedbackChunk => model<{ feedback?: Record<string, unknown>[] }>({
    modelId,
    system: 'You are a rigorous UX research editor. Produce natural, independent synthetic-user reflections grounded only in supplied browser evidence. Return valid JSON only. Never invent a screen, control, action, success, failure, emotion, or task completion.',
    prompt: `Rewrite each session as feedback from a genuinely different person. Use the persona's background, patience, technical ability, reading style, expectations, and the exact UI labels/pages/actions in that session. Describe what the person noticed about navigation, wording, controls, hierarchy, feedback, and task clarity only when the evidence supports it.

Hard rules:
- The immutable outcome, feeling, confidence, and evidence count cannot change.
- ABANDONED, TIMED_OUT, FAILED, and zero-evidence sessions must never claim task success.
- Successful clicks or typing may be described as locally positive even if the overall task failed.
- Different agents must not share a sentence, opening pattern, recommendation, or list item word-for-word.
- Avoid generic phrases such as "easy to navigate", "user friendly", "I could interact", or "make it clearer" unless tied to an exact observed UI element.
- Do not mention infrastructure, APIs, models, automation, BehaviorEvents, or system internals.
- If evidence cannot support a UI claim, omit it.

Return {"feedback":[{"session_id","direct_feedback","journey_summary","feeling_summary","ui_observations":[string],"what_i_liked":[string],"what_frustrated_me":[string],"expectation_gap","task_confidence_reason","would_use_again_reason","improvement_suggestion"}]}.

Drafts:\n${JSON.stringify(feedbackChunk.map(item => ({
      session_id: item.session_id,
      immutable_outcome: report.agent_results.find(result => result.session_id === item.session_id),
      immutable_feeling: item.overall_feeling,
      immutable_confidence: item.task_confidence,
      evidence_event_count: item.evidence_event_count,
      persona: personaById.get(item.persona_id),
      browser_evidence: evidenceFor(events, item.session_id),
      draft: item,
    })))}`,
    maxTokens: Math.min(10000, 1400 + feedbackChunk.length * 650),
    temperature: 0.72,
  })));

  const edits = new Map<string, Record<string, unknown>>(refined
    .flatMap((result: { feedback?: Record<string, unknown>[] }) => Array.isArray(result.feedback) ? result.feedback : [])
    .filter((item: Record<string, unknown>) => typeof item.session_id === 'string')
    .map((item: Record<string, unknown>) => [item.session_id as string, item]));
  const usedSentences = new Set<string>();
  const uniqueText = (value: string | undefined): string | undefined => {
    if (!value) return undefined;
    const parts = value.split(/(?<=[.!?])\s+/).map(part => signature(part)).filter(Boolean);
    if (parts.some(part => usedSentences.has(part))) return undefined;
    parts.forEach(part => usedSentences.add(part));
    return value;
  };
  const uniqueList = (values: string[] | undefined): string[] | undefined => values?.filter(value => {
    const key = signature(value);
    if (!key || usedSentences.has(key)) return false;
    usedSentences.add(key);
    return true;
  });
  const agent_feedback = report.agent_feedback.map(item => {
    const edit = edits.get(item.session_id);
    if (!edit) return item;
    const direct = uniqueText(bounded(edit.direct_feedback, 1200));
    const journey = uniqueText(bounded(edit.journey_summary, 1200));
    const feeling = uniqueText(bounded(edit.feeling_summary, 900));
    const ui = uniqueList(boundedList(edit.ui_observations));
    const liked = uniqueList(boundedList(edit.what_i_liked));
    const frustrated = uniqueList(boundedList(edit.what_frustrated_me));
    return {
      ...item,
      direct_feedback: direct || item.direct_feedback,
      journey_summary: journey || item.journey_summary,
      feeling_summary: feeling || item.feeling_summary,
      ui_observations: ui || item.ui_observations,
      what_i_liked: liked || item.what_i_liked,
      what_frustrated_me: frustrated || item.what_frustrated_me,
      expectation_gap: uniqueText(bounded(edit.expectation_gap, 900)) || item.expectation_gap,
      task_confidence_reason: uniqueText(bounded(edit.task_confidence_reason, 700)) || item.task_confidence_reason,
      would_use_again_reason: uniqueText(bounded(edit.would_use_again_reason, 700)) || item.would_use_again_reason,
      improvement_suggestion: uniqueText(bounded(edit.improvement_suggestion, 700)) || item.improvement_suggestion,
    };
  });
  return { ...report, agent_feedback };
}
