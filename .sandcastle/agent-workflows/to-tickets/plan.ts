import { asArray, asRecord, asString, standardSchema } from "../shared/common";

/**
 * Pure model of a to-tickets plan: the ticket shape the agent proposes,
 * the whole-plan validation rules (index range, no self-reference, acyclic
 * blocking graph), and the tracker texts a valid plan turns into. No I/O —
 * `to-tickets.ts` owns that.
 */

export const SPEC_LABEL = "spec";
export const READY_LABEL = "ready-for-agent";

export interface PlanTicket {
  readonly title: string;
  readonly body: string;
  /** 0-based indices into the plan: tickets that must close first. */
  readonly blockedBy: readonly number[];
}

const asIndex = (value: unknown, label: string, size: number): number => {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new Error(`${label} must be an integer index`);
  }
  if (value < 0 || value >= size) {
    throw new Error(`${label} is out of range (0..${size - 1})`);
  }
  return value;
};

const asPlanTicket = (value: unknown, label: string, size: number): PlanTicket => {
  const record = asRecord(value, label);
  const blockedBy = asArray(record.blockedBy ?? [], `${label}.blockedBy`).map(
    (entry, index) => asIndex(entry, `${label}.blockedBy[${index}]`, size),
  );
  return {
    title: asString(record.title, `${label}.title`),
    body: asString(record.body, `${label}.body`),
    blockedBy: [...new Set(blockedBy)].sort((a, b) => a - b),
  };
};

/**
 * Validate the agent's plan — the object emitted inside the output tag
 * (`{"tickets": [...]}`). A plan with zero tickets throws: a Spec marked
 * for decomposition must decompose (the caller turns that into a blocked
 * run instead of looping). Self-references and cycles are rejected so the
 * frontier machinery never deadlocks.
 */
export const asTicketPlan = (value: unknown): readonly PlanTicket[] => {
  const raw = asArray(asRecord(value, "output").tickets ?? [], "tickets");
  if (raw.length === 0) {
    throw new Error("plan must decompose the Spec into at least one Ticket");
  }
  const tickets = raw.map((entry, index) =>
    asPlanTicket(entry, `tickets[${index}]`, raw.length),
  );
  for (let index = 0; index < tickets.length; index += 1) {
    if (tickets[index]!.blockedBy.includes(index)) {
      throw new Error(`tickets[${index}].blockedBy must not self-reference`);
    }
  }
  assertAcyclic(tickets);
  return tickets;
};

export const planSchema = standardSchema<readonly PlanTicket[]>(asTicketPlan);

/** DFS cycle check over the blocking edges. */
const assertAcyclic = (tickets: readonly PlanTicket[]): void => {
  const state = new Array<number>(tickets.length).fill(0); // 0 new, 1 visiting, 2 done
  const visit = (index: number): void => {
    if (state[index] === 1) {
      throw new Error("plan has a cycle in blockedBy edges");
    }
    if (state[index] === 2) return;
    state[index] = 1;
    for (const blocker of tickets[index]!.blockedBy) visit(blocker);
    state[index] = 2;
  };
  for (let index = 0; index < tickets.length; index += 1) visit(index);
};

/** The ticket issue body: parent pointer first, then the agent's text. */
export const renderTicketBody = (specNumber: number, ticket: PlanTicket): string =>
  `Part of #${specNumber}\n\n${ticket.body}`;

/**
 * The list comment posted on the Spec: the full AFK audit trail — what was
 * created, what blocks what, and where the brakes are.
 */
export const renderListComment = (
  specNumber: number,
  created: readonly { readonly number: number; readonly title: string; readonly blockedBy: readonly number[] }[],
): string => {
  const rows = created
    .map((ticket) => {
      const blockers =
        ticket.blockedBy.length > 0
          ? ticket.blockedBy.map((i) => `#${created[i]!.number}`).join(", ")
          : "—";
      return `| #${ticket.number} | ${ticket.title} | ${blockers} |`;
    })
    .join("\n");
  return [
    `To-tickets run: decomposed this Spec into ${created.length} Ticket(s).`,
    "",
    "| Ticket | Title | Blocked by |",
    "|---|---|---|",
    rows,
    "",
    "Every Ticket got `ready-for-agent` — the converter cascade starts immediately (`agent-convert.yml`): Tickets become `agent:implement` as their blockers close.",
    "Audit here at your leisure; the brakes are the tracker's own: close a Ticket, or remove its `ready-for-agent` label to stop it.",
    `Exploration notes and frontier waves follow on the next \`agent:implement\` event for this Spec (ADR 0019). Part of #${specNumber}.`,
  ].join("\n");
};
