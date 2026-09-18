import type { ActionResult, PageObservation } from '@synthetic-beta/contracts';

export interface ActionOutcome {
  result: ActionResult;
  console_error: string | null;
  network_error: string | null;
}

/** Everything the loop needs from a browser. Playwright implements this today; AgentCore Browser later. */
export interface BrowserPagePort {
  open(url: string): Promise<void>;
  observe(): Promise<PageObservation>;
  perform(action: { type: 'click'; ref: string }
    | { type: 'type'; ref: string; text: string }
    | { type: 'scroll'; direction: 'down' | 'up' }
    | { type: 'back' }
    | { type: 'wait' }): Promise<ActionOutcome>;
  screenshot(name: string): Promise<string | null>;
  close(): Promise<void>;
}
