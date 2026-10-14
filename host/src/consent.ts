// One-time permission prompt. Nothing talks to the Baton server (no MCP session, no clock) until the
// person has read what is sent and why and pressed Continue. "Not now" opens no connection. The answer is
// remembered per room (per server when there are no rooms) in this browser only.
import { PERMISSION_PROMPT } from '@baton/contract/browser';

export type ConsentStore = Pick<Storage, 'getItem' | 'setItem'>;

const PREFIX = 'baton-consent:';
const GIVEN = 'given';

/** localStorage when the browser allows it; a private window or blocked storage just asks every time. */
export function browserStore(): ConsentStore | undefined {
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
}

export function consentGiven(store: ConsentStore | undefined, scope: string): boolean {
  try {
    return store?.getItem(PREFIX + scope) === GIVEN;
  } catch {
    return false;
  }
}

/**
 * Resolves true once the person continues (now or on an earlier visit), false if they choose "Not now".
 * Sets body[data-consent] to asking, given or declined, so a test can tell the states apart.
 */
export function askConsent(doc: Document, store: ConsentStore | undefined, scope: string): Promise<boolean> {
  const body = doc.body;
  if (consentGiven(store, scope)) {
    body.dataset.consent = 'given';
    return Promise.resolve(true);
  }
  body.dataset.consent = 'asking';
  const box = doc.createElement('div');
  box.className = 'consent';
  box.setAttribute('role', 'dialog');
  box.setAttribute('aria-modal', 'true');
  box.setAttribute('aria-labelledby', 'consent-text');
  box.dataset.testid = 'consent';
  const card = doc.createElement('div');
  card.className = 'consent-card';
  const text = doc.createElement('p');
  text.id = 'consent-text';
  text.textContent = PERMISSION_PROMPT;
  const actions = doc.createElement('div');
  actions.className = 'consent-actions';
  const yes = doc.createElement('button');
  yes.type = 'button';
  yes.textContent = 'Continue';
  yes.dataset.testid = 'consent-continue';
  const no = doc.createElement('button');
  no.type = 'button';
  no.textContent = 'Not now';
  no.dataset.testid = 'consent-not-now';
  actions.append(yes, no);
  card.append(text, actions);
  box.append(card);
  body.append(box);
  yes.focus();

  return new Promise((resolve) => {
    yes.onclick = () => {
      try {
        store?.setItem(PREFIX + scope, GIVEN);
      } catch {
        // Storage blocked: the prompt shows again next time, nothing else changes.
      }
      box.remove();
      body.dataset.consent = 'given';
      resolve(true);
    };
    no.onclick = () => {
      box.remove();
      body.dataset.consent = 'declined';
      resolve(false);
    };
  });
}
