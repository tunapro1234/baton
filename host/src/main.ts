// Two simulated devices side by side, each its own MCP session, plus the clock and protocol panel.
import { TOOL } from '@baton/contract/browser';
import { SERVER_URL, authHeaders } from './config.ts';
import { askConsent, browserStore } from './consent.ts';
import { Device } from './device.ts';
import { Panel, type Shortcut } from './panel.ts';
import { onLog, summary, type LogEntry } from './protocol-log.ts';

const shortcuts: Shortcut[] = [
  { label: 'Today', call: () => ({ name: TOOL.todayView, args: {} }) },
  { label: 'Since I left', call: (d) => ({ name: TOOL.handoffBrief, args: { memberId: d.memberId ?? 'nora' } }) },
  {
    label: 'Log metformin',
    call: (d) => ({
      name: TOOL.logCareEvent,
      args: { memberId: d.memberId ?? 'sam', items: ['metformin'], heardText: 'I gave Mom her metformin', requestId: crypto.randomUUID() },
    }),
  },
  { label: 'Did Mom get her metformin?', call: () => ({ name: TOOL.checkMed, args: { medId: 'metformin' } }) },
  { label: 'Visit timeline', call: () => ({ name: TOOL.visitBrief, args: { from: '2026-10-13', to: '2026-10-20' } }) },
];

// ---- clock ----
let now: string | undefined;
const nowEl = document.getElementById('now')!;

function showNow(iso: string): void {
  now = iso;
  const [date, time] = iso.split('T');
  const [h, m] = time!.split(':').map(Number);
  nowEl.textContent = `${date} ${h}:${String(m).padStart(2, '0')}`;
  nowEl.dataset.iso = iso;
}

async function clock(body?: { set?: string; advanceMinutes?: number }): Promise<void> {
  const r = await fetch(`${SERVER_URL}/clock`, body
    ? { method: 'POST', headers: { 'Content-Type': 'application/json', ...authHeaders() }, body: JSON.stringify(body) }
    : { headers: authHeaders() });
  if (r.ok) showNow(((await r.json()) as { now: string }).now);
}

for (const b of document.querySelectorAll<HTMLButtonElement>('.clock-buttons button')) {
  b.onclick = () => {
    if (b.dataset.advance) void clock({ advanceMinutes: Number(b.dataset.advance) });
    else if (b.dataset.set && now) void clock({ set: `${now.slice(0, 10)}T${b.dataset.set.padStart(5, '0')}:00` });
  };
}

// ---- protocol panel ----
const logEl = document.getElementById('log')!;
function addLog(e: LogEntry): void {
  const li = document.createElement('li');
  li.className = e.dir;
  const m = e.msg as { method?: string };
  if (m.method) li.dataset.method = m.method;
  li.textContent = `${e.device} ${e.dir === 'out' ? '->' : '<-'} ${summary(e)}`;
  li.title = JSON.stringify(e.msg, null, 2);
  logEl.append(li);
  while (logEl.children.length > 300) logEl.firstElementChild!.remove();
  logEl.scrollTop = logEl.scrollHeight;
}
onLog(addLog);

// ---- devices ----
async function start(): Promise<void> {
  await clock().catch(() => undefined);
  const devices = document.getElementById('devices')!;
  const kitchen = new Device('a', 'Kitchen device');
  const phone = new Device('b', "Nora's phone");
  phone.memberId = 'nora';
  const pa = new Panel(kitchen, 'Kitchen device', shortcuts, { briefOnShift: true });
  const pb = new Panel(phone, "Nora's phone", shortcuts);
  pb.setWho('Nora');
  for (const p of [pa, pb]) {
    p.getNow = () => now;
    devices.append(p.root);
  }
  try {
    await Promise.all([kitchen.connect(), phone.connect()]);
  } catch (e) {
    pa.line('system', `Cannot reach the Baton server at ${SERVER_URL}: ${(e as Error).message}`);
    return;
  }
  await pa.watchShifts();
  document.body.dataset.ready = 'true';
  // The kitchen device is shared, so it asks who is speaking before anything is logged.
  await pa.run({ name: TOOL.whoIsHere, args: { defaultMemberId: 'sam' } }, 'Who is here?');
}

/** Nothing reaches the server before the permission prompt is answered with Continue. */
async function boot(): Promise<void> {
  if (!(await askConsent(document, browserStore(), SERVER_URL))) {
    const devices = document.getElementById('devices')!;
    const note = document.createElement('div');
    note.className = 'offline';
    note.dataset.testid = 'offline';
    const p = document.createElement('p');
    p.textContent = 'Not connected. Nothing was sent to the Baton server.';
    const again = document.createElement('button');
    again.type = 'button';
    again.textContent = 'Show the question again';
    again.onclick = () => {
      note.remove();
      void boot();
    };
    note.append(p, again);
    devices.replaceChildren(note);
    return;
  }
  // Clock changes made elsewhere (the other device, a test) show up here too.
  setInterval(() => void clock().catch(() => undefined), 5000);
  await start();
}
void boot();
