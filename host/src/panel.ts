// The UI of one device: a screen for views, a transcript, a text box for the assistant and shortcuts
// that call tools directly. Elicitation dialogs open inside the panel that made the call.
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { RESOURCE, TOOL } from '@baton/contract/browser';
import { Assistant, proxyStatus } from './assistant.ts';
import { spoken, type Device, type ToolCall } from './device.ts';
import { elicitDialog } from './elicit.ts';
import { mountView, type DisplayMode, type MountedView } from './view-frame.ts';

export type Shortcut = { label: string; call: (d: Device) => ToolCall };
type Shifts = { now: string; members: { id: string; name: string }[]; onShift: string[] };

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}

const theme = (): 'light' | 'dark' => (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');

export class Panel {
  readonly root: HTMLElement;
  private readonly device: Device;
  private readonly assistant: Assistant;
  private readonly screen: HTMLElement;
  private readonly transcript: HTMLElement;
  private readonly who: HTMLElement;
  private mounted: MountedView | undefined;
  private lastView: ToolCall | undefined;
  private displayMode: DisplayMode = 'inline';
  private noScreen = false;
  private speak = false;
  private refreshTimer: ReturnType<typeof setTimeout> | undefined;
  /** Views are mounted one at a time; overlapping redraws would orphan a frame. */
  private drawing: Promise<void> = Promise.resolve();
  private onShift = new Set<string>();
  private readonly briefOnShift: boolean;
  getNow: () => string | undefined = () => undefined;

  /** briefOnShift: a shared device (the kitchen) greets whoever starts a shift with what happened since they left. */
  constructor(device: Device, title: string, shortcuts: Shortcut[], opts: { briefOnShift?: boolean } = {}) {
    this.briefOnShift = opts.briefOnShift ?? false;
    this.device = device;
    this.assistant = new Assistant(device);
    this.root = el('section', 'device');
    this.root.dataset.device = device.id;

    const head = el('header', 'device-head');
    head.append(el('h2', undefined, title));
    this.who = el('span', 'who', 'Not confirmed');
    this.who.dataset.testid = 'who';
    head.append(this.who);
    const toggles = el('div', 'toggles');
    toggles.append(this.toggle('No-screen device', (on) => this.setNoScreen(on)), this.toggle('Speak replies', (on) => (this.speak = on)));
    head.append(toggles);

    this.screen = el('div', 'screen');
    this.screen.dataset.testid = 'screen';
    this.transcript = el('div', 'transcript');
    this.transcript.dataset.testid = 'transcript';
    this.transcript.setAttribute('aria-live', 'polite');

    const form = el('form', 'say');
    const input = el('input');
    input.placeholder = 'Type what you would say';
    input.setAttribute('aria-label', `Say to the ${title}`);
    form.append(input, el('button', undefined, 'Send'));
    form.onsubmit = (e) => {
      e.preventDefault();
      const text = input.value.trim();
      if (!text) return;
      input.value = '';
      void this.ask(text);
    };

    const sc = el('div', 'shortcuts');
    sc.append(el('span', 'muted', 'Shortcuts (call the server directly):'));
    for (const s of shortcuts) {
      const b = el('button', undefined, s.label);
      b.type = 'button';
      b.onclick = () => void this.run(s.call(this.device), s.label);
      sc.append(b);
    }
    this.root.append(head, this.screen, this.transcript, form, sc);

    device.onElicit = (p) => elicitDialog(this.root, p);
    device.onUpdate = (uri) => this.onUpdate(uri);
  }

  private toggle(label: string, fn: (on: boolean) => void): HTMLElement {
    const l = el('label', 'toggle');
    const c = el('input');
    c.type = 'checkbox';
    c.onchange = () => fn(c.checked);
    l.append(c, ` ${label}`);
    return l;
  }

  setWho(name: string): void {
    this.who.textContent = `Logging as ${name}`;
  }

  line(who: 'you' | 'assistant' | 'server' | 'system', text: string, tag?: string): void {
    const row = el('div', `line ${who}`);
    row.append(el('span', 'speaker', who === 'you' ? 'You' : who === 'server' ? 'Server' : who === 'system' ? 'Note' : 'Assistant'));
    row.append(el('span', 'text', text));
    if (tag) row.append(el('span', 'badge', tag));
    this.transcript.append(row);
    this.transcript.scrollTop = this.transcript.scrollHeight;
    if ((this.speak || this.noScreen) && who !== 'you' && 'speechSynthesis' in window) {
      speechSynthesis.speak(new SpeechSynthesisUtterance(text));
      this.root.dataset.spoken = text;
    }
  }

  /** Runs a tool directly (shortcut) and shows its result. */
  async run(call: ToolCall, label?: string): Promise<CallToolResult | undefined> {
    if (label) this.line('you', label);
    try {
      const { result, ms } = await this.device.call(call);
      await this.show(call, result, ms, true);
      return result;
    } catch (e) {
      this.line('system', `Call failed: ${(e as Error).message}`);
      return undefined;
    }
  }

  private async ask(text: string): Promise<void> {
    this.line('you', text);
    const status = await proxyStatus();
    if (!status.ok) {
      this.line('system', 'The assistant proxy is not running. The shortcuts below still call the server directly.');
      return;
    }
    try {
      await this.assistant.send(text, this.getNow(), {
        say: (t, meta) => {
          this.line('assistant', t, meta.mode === 'mock' ? meta.badge : 'Live');
          if (meta.notice) this.line('system', meta.notice);
        },
        tool: (call, result, ms) => void this.show(call, result, ms, false),
      });
    } catch (e) {
      this.line('system', `Assistant error: ${(e as Error).message}`);
    }
  }

  private async show(call: ToolCall, result: CallToolResult, ms: number, speakIt: boolean): Promise<void> {
    if (speakIt) this.line('server', spoken(result), `${call.name}, ${ms} ms`);
    else this.line('system', `${call.name} ran in ${ms} ms`);
    if (call.name === 'who_is_here' && result.structuredContent) {
      const sc = result.structuredContent as { memberId: string; name: string };
      this.device.memberId = sc.memberId;
      this.setWho(sc.name);
    }
    const uri = this.device.viewOf(call.name);
    if (!uri || result.isError) return;
    this.lastView = this.replayable(call, result);
    if (!this.noScreen) await this.draw(uri, result);
  }

  /** visit_brief asks which notes to include; a refresh reuses the notes already chosen. */
  private replayable(call: ToolCall, result: CallToolResult): ToolCall {
    if (call.name !== 'visit_brief') return call;
    const rows = ((result.structuredContent as { rows?: { kind: string; refId: string }[] })?.rows ?? []);
    return { name: call.name, args: { ...call.args, observationIds: rows.filter((r) => r.kind === 'observation').map((r) => r.refId) } };
  }

  private draw(uri: string, result: CallToolResult): Promise<void> {
    const next = this.drawing.then(() => this.drawNow(uri, result));
    this.drawing = next.catch(() => undefined);
    return next;
  }

  private async drawNow(uri: string, result: CallToolResult): Promise<void> {
    const html = await this.device.viewHtml(uri);
    const previous = this.mounted;
    const next = await mountView({
      container: this.screen,
      client: this.device.client,
      html,
      result,
      theme: theme(),
      displayMode: this.displayMode,
      onDisplayMode: (mode) => {
        this.displayMode = mode;
        this.root.classList.toggle('fullscreen-view', mode === 'fullscreen');
        return mode;
      },
    });
    next.show();
    this.mounted = next;
    this.screen.dataset.view = uri;
    await previous?.close();
  }

  private setNoScreen(on: boolean): void {
    this.noScreen = on;
    this.root.classList.toggle('no-screen', on);
    if (on) {
      void this.mounted?.close();
      this.mounted = undefined;
      this.screen.replaceChildren(el('p', 'muted', 'No-screen device: replies are spoken, views are not drawn.'));
    } else {
      this.screen.replaceChildren();
    }
  }

  /** Remembers who is on shift now, so a later update can tell who just started. */
  async watchShifts(): Promise<void> {
    if (!this.briefOnShift) return;
    const s = await this.device.readJson<Shifts>(RESOURCE.shifts);
    this.onShift = new Set(s.onShift);
  }

  private async shiftChanged(): Promise<void> {
    const s = await this.device.readJson<Shifts>(RESOURCE.shifts);
    const started = s.onShift.filter((id) => !this.onShift.has(id));
    this.onShift = new Set(s.onShift);
    const m = s.members.find((x) => x.id === started[0]);
    if (!m) return;
    this.device.memberId = m.id;
    this.setWho(m.name);
    this.line('system', `${m.name}'s shift started.`);
    await this.run({ name: TOOL.handoffBrief, args: { memberId: m.id } });
  }

  private onUpdate(uri: string): void {
    if (uri === RESOURCE.shifts && this.briefOnShift) {
      void this.shiftChanged().catch((e) => this.line('system', `Shift check failed: ${(e as Error).message}`));
      return;
    }
    if (uri !== RESOURCE.ledgerToday && uri !== RESOURCE.windowsToday && uri !== RESOURCE.shifts) return;
    if (!this.lastView || this.noScreen) return;
    clearTimeout(this.refreshTimer);
    // Several updates often arrive together (ledger + windows); redraw once.
    this.refreshTimer = setTimeout(() => void this.refresh(), 120);
  }

  private async refresh(): Promise<void> {
    if (!this.lastView) return;
    const { result } = await this.device.call(this.lastView);
    const uri = this.device.viewOf(this.lastView.name);
    if (uri && !result.isError) await this.draw(uri, result);
    this.root.dataset.refreshed = String(Number(this.root.dataset.refreshed ?? 0) + 1);
  }
}
