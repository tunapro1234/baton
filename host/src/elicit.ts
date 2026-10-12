// Draws an MCP elicitation request as a dialog inside one device panel and resolves with the
// user's answer. Handles the three shapes Baton uses: confirm (no fields), single select, multi select.
import type { ElicitRequest, ElicitResult } from '@modelcontextprotocol/sdk/types.js';

type Option = { const: string; title?: string };
type Prop = { type?: string; title?: string; oneOf?: Option[]; enum?: string[]; default?: unknown; items?: { anyOf?: Option[]; oneOf?: Option[]; enum?: string[] } };

function options(p: Prop): Option[] {
  if (p.oneOf) return p.oneOf;
  if (p.enum) return p.enum.map((v) => ({ const: v, title: v }));
  const it = p.items ?? {};
  if (it.anyOf) return it.anyOf;
  if (it.oneOf) return it.oneOf;
  return (it.enum ?? []).map((v) => ({ const: v, title: v }));
}

export function elicitDialog(host: HTMLElement, params: ElicitRequest['params']): Promise<ElicitResult> {
  const schema = (params as { requestedSchema?: { properties?: Record<string, Prop> } }).requestedSchema ?? {};
  const props = Object.entries(schema.properties ?? {});
  const confirm = props.length === 0;

  const box = document.createElement('div');
  box.className = 'elicit';
  box.setAttribute('role', 'dialog');
  box.setAttribute('aria-modal', 'true');
  box.dataset.testid = 'elicit';
  const msg = document.createElement('p');
  msg.className = 'elicit-msg';
  msg.textContent = params.message;
  box.append(msg);

  const form = document.createElement('form');
  for (const [name, p] of props) {
    const multi = p.type === 'array';
    const fs = document.createElement('fieldset');
    if (p.title) {
      const lg = document.createElement('legend');
      lg.textContent = p.title;
      fs.append(lg);
    }
    for (const o of options(p)) {
      const label = document.createElement('label');
      const input = document.createElement('input');
      input.type = multi ? 'checkbox' : 'radio';
      input.name = name;
      input.value = o.const;
      input.checked = multi || p.default === o.const;
      label.append(input, ` ${o.title ?? o.const}`);
      fs.append(label);
    }
    form.append(fs);
  }
  box.append(form);

  const actions = document.createElement('div');
  actions.className = 'elicit-actions';
  const yes = document.createElement('button');
  yes.type = 'button';
  yes.textContent = confirm ? 'Yes' : 'OK';
  yes.dataset.testid = 'elicit-accept';
  const no = document.createElement('button');
  no.type = 'button';
  no.textContent = confirm ? 'No' : 'Cancel';
  no.dataset.testid = 'elicit-decline';
  actions.append(yes, no);
  box.append(actions);
  host.append(box);

  return new Promise((resolve) => {
    const done = (r: ElicitResult) => {
      box.remove();
      resolve(r);
    };
    yes.onclick = () => {
      const content: Record<string, string | string[]> = {};
      for (const [name, p] of props) {
        const checked = [...form.querySelectorAll<HTMLInputElement>(`input[name="${CSS.escape(name)}"]:checked`)].map((i) => i.value);
        if (p.type === 'array') content[name] = checked;
        else if (checked[0] !== undefined) content[name] = checked[0];
      }
      // A single select with nothing chosen cannot be accepted.
      if (props.some(([n, p]) => p.type !== 'array' && content[n] === undefined)) {
        msg.textContent = `${params.message} Please choose one.`;
        return;
      }
      done({ action: 'accept', content });
    };
    no.onclick = () => done({ action: confirm ? 'decline' : 'cancel' });
  });
}
