// The Baton contract: tool names, input/output schemas, resource URIs and the fixture shape.
// Server, host, proxy and evals all import from here, so a change in one place shows up in every package.
import { z } from 'zod';

export const PROTOCOL_VERSION = '2025-11-25';
export const MCP_APP_MIME = 'text/html;profile=mcp-app';
export const SERVER_NAME = 'baton';

export const NOT_A_MEDICAL_DEVICE =
  "Not a medical device. Baton records your family's plan and who did what. It never suggests a dose.";
export const VISIT_NOTE = 'Dates only. No link is implied.';
export const IDENTITY_NOTE = 'Soft confirmation, not authentication.';

export const TOOL = {
  whoIsHere: 'who_is_here',
  logCareEvent: 'log_care_event',
  checkMed: 'check_med',
  todayView: 'today_view',
  handoffBrief: 'handoff_brief',
  ledgerQuery: 'ledger_query',
  logObservation: 'log_observation',
  visitBrief: 'visit_brief',
  correctEntry: 'correct_entry',
} as const;
export type ToolName = (typeof TOOL)[keyof typeof TOOL];
export const TOOL_NAMES = Object.values(TOOL) as ToolName[];

export const RESOURCE = {
  ledgerToday: 'baton://ledger/today',
  windowsToday: 'baton://windows/today',
  shifts: 'baton://shifts',
  plan: 'baton://plan',
} as const;
/** Resources a client may subscribe to. baton://plan is read-only and never changes during a run. */
export const SUBSCRIBABLE = [RESOURCE.ledgerToday, RESOURCE.windowsToday, RESOURCE.shifts] as const;

export const UI = {
  today: 'ui://baton/today',
  brief: 'ui://baton/brief',
  visit: 'ui://baton/visit',
} as const;

/** Which view each tool declares in its definition (`_meta.ui.resourceUri`). */
export const TOOL_VIEW: Partial<Record<ToolName, string>> = {
  [TOOL.todayView]: UI.today,
  [TOOL.handoffBrief]: UI.brief,
  [TOOL.visitBrief]: UI.visit,
};

/** Fixed replies. The assistant never words these itself. */
export const FIXED = {
  dose: (planLine: string, clinician: string) =>
    `I can't advise on doses. The plan says ${planLine}. Please ask ${clinician}.`,
  symptom: (clinician: string) => `I can't interpret symptoms. I've added it to the timeline for ${clinician}.`,
  emergency: 'If this is an emergency, call your local emergency number now.',
  duplicate: (memberName: string, medName: string, clock: string) =>
    `${memberName} logged ${medName} at ${clock}. Log again anyway?`,
};

// ---------- shared shapes ----------
const isoLocal = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/, 'local ISO time, no zone');
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD');
const hhmm = z.string().regex(/^\d{2}:\d{2}$/, 'HH:MM');
export const IsoLocal = isoLocal;
export const IsoDate = isoDate;

export const Member = z.object({
  id: z.string(),
  name: z.string(),
  role: z.string(),
  shift: z.object({ start: hhmm, end: hhmm }).nullable(),
});
export const DoseWindow = z.object({ id: z.string(), label: z.string(), start: hhmm, end: hhmm });
export const PlanItem = z.object({
  id: z.string(),
  name: z.string(),
  generic: z.string(),
  dose: z.string(),
  looks: z.string(),
  windows: z.array(z.string()).min(1),
  since: isoDate.optional(),
});
export const CareEvent = z.object({
  eventId: z.string(),
  at: isoLocal,
  memberId: z.string(),
  medId: z.string(),
  windowId: z.string().optional(),
  heardText: z.string().optional(),
  note: z.string().optional(),
  deleted: z.boolean().optional(),
});
export const Observation = z.object({ observationId: z.string(), at: isoLocal, memberId: z.string(), text: z.string() });
export const PlanChange = z.object({ changeId: z.string(), date: isoDate, medId: z.string(), text: z.string() });

export const Fixture = z.object({
  label: z.string(),
  household: z.object({ id: z.string(), name: z.string(), age: z.number().int(), fictional: z.literal(true) }),
  clinician: z.object({ name: z.string(), nextVisit: isoDate }),
  members: z.array(Member).min(2),
  windows: z.array(DoseWindow).min(1),
  plan: z.array(PlanItem).min(1),
  today: isoDate,
  events: z.array(CareEvent),
  observations: z.array(Observation),
  planChanges: z.array(PlanChange),
});
export type Fixture = z.infer<typeof Fixture>;
export type Member = z.infer<typeof Member>;
export type PlanItem = z.infer<typeof PlanItem>;
export type CareEvent = z.infer<typeof CareEvent>;
export type DoseWindow = z.infer<typeof DoseWindow>;
export type Observation = z.infer<typeof Observation>;
export type PlanChange = z.infer<typeof PlanChange>;

// ---------- tool inputs ----------
export const Input = {
  [TOOL.whoIsHere]: z.object({ defaultMemberId: z.string().optional() }),
  [TOOL.logCareEvent]: z.object({
    memberId: z.string(),
    items: z.array(z.string().min(1)).min(1),
    note: z.string().optional(),
    heardText: z.string(),
    requestId: z.string().min(1),
  }),
  [TOOL.checkMed]: z.object({ medId: z.string().optional(), window: z.string().optional() }),
  [TOOL.todayView]: z.object({ date: isoDate.optional() }),
  [TOOL.handoffBrief]: z.object({ memberId: z.string() }),
  [TOOL.ledgerQuery]: z.object({
    from: isoDate.optional(),
    to: isoDate.optional(),
    memberId: z.string().optional(),
    medId: z.string().optional(),
    kind: z.enum(['dose', 'observation', 'correction']).optional(),
  }),
  [TOOL.logObservation]: z.object({ memberId: z.string(), text: z.string().min(1) }),
  [TOOL.visitBrief]: z.object({ from: isoDate, to: isoDate, observationIds: z.array(z.string()).optional() }),
  [TOOL.correctEntry]: z.object({ eventId: z.string(), reason: z.string().min(1) }),
} satisfies Record<ToolName, z.ZodObject>;

// ---------- tool outputs (structuredContent) ----------
const EventRef = z.object({ eventId: z.string(), medId: z.string(), memberId: z.string(), at: isoLocal });
export const Output = {
  [TOOL.whoIsHere]: z.object({ memberId: z.string(), name: z.string(), note: z.literal(IDENTITY_NOTE) }),
  [TOOL.logCareEvent]: z.object({
    written: z.boolean(),
    events: z.array(EventRef),
    unmatched: z.array(z.string()).optional(),
    reason: z.enum(['declined', 'cancelled', 'duplicate_request', 'no_match']).optional(),
  }),
  [TOOL.checkMed]: z.object({
    status: z.enum(['given', 'not_logged', 'logged_twice']),
    medId: z.string().optional(),
    window: z.string().optional(),
    by: z.string().optional(),
    at: isoLocal.optional(),
    eventIds: z.array(z.string()),
  }),
  [TOOL.todayView]: z.object({
    date: isoDate,
    now: isoLocal,
    grid: z.array(
      z.object({
        windowId: z.string(),
        medId: z.string(),
        status: z.enum(['given', 'not_logged', 'logged_twice', 'upcoming']),
        by: z.string().optional(),
        at: isoLocal.optional(),
      }),
    ),
  }),
  [TOOL.handoffBrief]: z.object({
    memberId: z.string(),
    since: isoLocal,
    facts: z.array(z.object({ eventId: z.string(), text: z.string() })),
  }),
  [TOOL.ledgerQuery]: z.object({
    events: z.array(CareEvent),
    counts: z.record(z.string(), z.number().int()),
  }),
  [TOOL.logObservation]: z.object({ observationId: z.string(), at: isoLocal, text: z.string() }),
  [TOOL.visitBrief]: z.object({
    from: isoDate,
    to: isoDate,
    clinician: z.string(),
    rows: z.array(
      z.object({
        date: isoDate,
        kind: z.enum(['dose', 'plan_change', 'observation']),
        text: z.string(),
        refId: z.string(),
      }),
    ),
    note: z.literal(VISIT_NOTE),
  }),
  [TOOL.correctEntry]: z.object({ corrected: z.boolean(), eventId: z.string(), reason: z.string().optional() }),
} satisfies Record<ToolName, z.ZodObject>;

export type ToolInput<T extends ToolName> = z.infer<(typeof Input)[T]>;
export type ToolOutput<T extends ToolName> = z.infer<(typeof Output)[T]>;

/** Tool annotations (MCP ToolAnnotations). The server copies these into tools/list. */
export const ANNOTATIONS: Record<ToolName, { readOnlyHint?: boolean; destructiveHint?: boolean; idempotentHint?: boolean }> = {
  [TOOL.whoIsHere]: { readOnlyHint: true },
  [TOOL.logCareEvent]: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  [TOOL.checkMed]: { readOnlyHint: true },
  [TOOL.todayView]: { readOnlyHint: true },
  [TOOL.handoffBrief]: { readOnlyHint: true },
  [TOOL.ledgerQuery]: { readOnlyHint: true },
  [TOOL.logObservation]: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  [TOOL.visitBrief]: { readOnlyHint: true },
  [TOOL.correctEntry]: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
};

/**
 * JSON Schema for a zod object, in the shape MCP expects for inputSchema / outputSchema.
 * `io: 'input'` leaves out `additionalProperties: false`, so clients accept the extra fields the contract allows.
 */
export function jsonSchema(schema: z.ZodObject): { type: 'object'; [k: string]: unknown } {
  const js = z.toJSONSchema(schema, { target: 'draft-2020-12', io: 'input' }) as Record<string, unknown>;
  delete js.$schema;
  return { ...js, type: 'object' };
}
