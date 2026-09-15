/**
 * SuperOps.ai Tickets Domain
 *
 * Tools for managing service tickets in SuperOps.ai PSA.
 *
 * The `Ticket` type exposes `client`, `site`, `requester`, `techGroup`,
 * `technician`, `sla` and `customFields` through the `JSON` scalar. They must
 * be selected bare — a subselection on a scalar is rejected outright by the
 * API. `category` is a plain `String`, not an object, and there is no
 * `description` field on `Ticket`: description is write-only on
 * `CreateTicketInput` and is read back through the ticket conversation.
 *
 * `getTicketList` only returns rows when `ticketId` is part of the `tickets`
 * selection set. Omit it and the API answers with an empty `tickets` array
 * alongside a correct, filter-aware `listInfo.totalCount` — no error, just
 * silently no data. Keep `ticketId` in LIST_TICKETS_QUERY.
 *
 * Filter conditions are built with `utils/conditions.ts`, which documents the
 * operator vocabulary and the uppercase-`joinOperator` trap.
 */

import { getClient } from "../client.js";
import type {
  DomainTools,
  Ticket,
  Note,
  WorklogEntry,
  ListInfo,
  ListInfoInput,
} from "../types.js";
import { elicitText } from "../utils/elicitation.js";
import { and, clause } from "../utils/conditions.js";
import { paging, PAGE_PROPERTIES } from "../utils/paging.js";
import { buildTicketCard, TICKET_CARD_META } from "../card.builder.js";

const LIST_TICKETS_QUERY = `
  query getTicketList($input: ListInfoInput!) {
    getTicketList(input: $input) {
      tickets {
        ticketId
        displayId
        subject
        status
        priority
        ticketType
        source
        createdTime
        updatedTime
        client
        site
        requester
        techGroup
        technician
      }
      listInfo {
        page
        pageSize
        totalCount
        hasMore
      }
    }
  }
`;

const GET_TICKET_QUERY = `
  query getTicket($input: TicketIdentifierInput!) {
    getTicket(input: $input) {
      ticketId
      displayId
      subject
      ticketType
      requestType
      source
      status
      priority
      impact
      urgency
      category
      subcategory
      createdTime
      updatedTime
      firstResponseDueTime
      firstResponseTime
      firstResponseViolated
      resolutionDueTime
      resolutionTime
      resolutionViolated
      worklogTimespent
      client
      site
      requester
      techGroup
      technician
      sla
      customFields
    }
  }
`;

const CREATE_TICKET_MUTATION = `
  mutation createTicket($input: CreateTicketInput!) {
    createTicket(input: $input) {
      ticketId
      displayId
      subject
      status
      priority
      category
      source
      createdTime
      client
      site
      requester
      techGroup
      technician
    }
  }
`;

const UPDATE_TICKET_MUTATION = `
  mutation updateTicket($input: UpdateTicketInput!) {
    updateTicket(input: $input) {
      ticketId
      displayId
      subject
      status
      priority
      category
      resolutionCode
      updatedTime
      techGroup
      technician
    }
  }
`;

/**
 * Notes are created through `createNote`. The older
 * `createTicketNote(input: CreateTicketNoteInput!)` still exists and still
 * works, but the live API marks it deprecated with `reason: "Use createNote"` —
 * which is why plain introspection hides it and only
 * `__type { fields(includeDeprecated: true) }` reports it. `createNote`
 * addresses its target the same way worklog entries do, through
 * `workItem { workId module }`, rather than a ticket-specific
 * `ticket { ticketId }`.
 */
const CREATE_NOTE_MUTATION = `
  mutation createNote($input: CreateNoteInput!) {
    createNote(input: $input) {
      noteId
      content
      addedOn
      addedBy
      privacyType
      attachments {
        fileName
        originalFileName
        fileSize
      }
    }
  }
`;

const CREATE_WORKLOG_ENTRIES_MUTATION = `
  mutation createWorklogEntries($input: [CreateWorklogEntryInput!]!) {
    createWorklogEntries(input: $input) {
      itemId
      status
      qty
      unitPrice
      billable
      afterHours
      billDateTime
      notes
      serviceItem
      technician
      workItem
    }
  }
`;

interface ListTicketsResponse {
  getTicketList: {
    tickets: Ticket[];
    listInfo: ListInfo;
  };
}

interface GetTicketResponse {
  getTicket: Ticket;
}

interface CreateTicketResponse {
  createTicket: Ticket;
}

interface UpdateTicketResponse {
  updateTicket: Ticket;
}

interface CreateNoteResponse {
  createNote: Note;
}

interface CreateWorklogEntriesResponse {
  createWorklogEntries: WorklogEntry[];
}

/**
 * Status, priority, impact, urgency, category and resolution code are all
 * per-tenant lookup lists, not GraphQL enums — every one of them is typed as a
 * plain `String` on the ticket inputs. The values below are what SuperOps ships
 * with out of the box, confirmed against a live tenant.
 *
 * They are documented in descriptions rather than pinned as JSON Schema `enum`
 * constraints on purpose: a tenant can rename or extend any of these lists, and
 * an `enum` would then reject values the API accepts — silently, as an empty
 * result rather than an error.
 *
 * To read a tenant's authoritative lists, run this through
 * `superops_custom_query`. It returns every option list for the module in one
 * call, with `parentField` linking subcategory to category and subcause to
 * cause:
 *
 *     query { getAllFields(input: "TICKET") {
 *       columnName options { value } parentField { columnName }
 *     } }
 */
const STOCK_STATUSES = "Open, On Hold, Resolved, Closed, Waiting on third party";
const STOCK_PRIORITIES = "Critical, High, Medium, Low, Very Low";
const STOCK_SEVERITIES = "High, Medium, Low";
const STOCK_RESOLUTION_CODES =
  "Permanent Fix, Workaround, Resolved by Requester, Exception";
const STOCK_CATEGORIES = "Database, Hardware, Help, Network, Software";

/** Appended to any description naming a stock list, to flag it as per-tenant. */
const TENANT_CAVEAT = "Your tenant may rename or extend this list.";

export function getTicketsTools(): DomainTools {
  return {
    tools: [
      {
        name: "superops_tickets_list",
        description:
          "List tickets in SuperOps.ai. Results are paginated with page/pageSize. " +
          "All supplied filters are combined: a ticket must match every one of " +
          "status, priority, clientId and technicianId that you provide, and " +
          "within status and priority it may match any of the listed values.",
        inputSchema: {
          type: "object",
          properties: {
            status: {
              type: "array",
              items: { type: "string" },
              description:
                `Filter by status(es). SuperOps ships with: ${STOCK_STATUSES}. ` +
                `${TENANT_CAVEAT} Values must match it exactly.`,
            },
            priority: {
              type: "array",
              items: { type: "string" },
              description:
                `Filter by priority(ies). SuperOps ships with: ${STOCK_PRIORITIES}. ` +
                `${TENANT_CAVEAT}`,
            },
            clientId: {
              type: "string",
              description: "Filter by client account ID",
            },
            technicianId: {
              type: "string",
              description: "Filter by assigned technician user ID",
            },
            ...PAGE_PROPERTIES,
          },
        },
      },
      {
        name: "superops_tickets_get",
        description: "Get detailed information for a specific ticket by its ID.",
        _meta: TICKET_CARD_META,
        inputSchema: {
          type: "object",
          properties: {
            ticketId: {
              type: "string",
              description: "The unique ticket ID",
            },
          },
          required: ["ticketId"],
        },
      },
      {
        name: "superops_tickets_create",
        description:
          "Create a new ticket in SuperOps.ai. Status, priority, category and subcategory are " +
          "free-text strings that must match the values configured in your SuperOps tenant.",
        inputSchema: {
          type: "object",
          properties: {
            subject: {
              type: "string",
              description: "Ticket subject/title",
            },
            description: {
              type: "string",
              description: "Detailed description of the issue",
            },
            clientId: {
              type: "string",
              description: "Client account ID",
            },
            source: {
              type: "string",
              description: "How the ticket originated (default: INTEGRATION)",
              // The full TicketSource enum as the live API declares it.
              enum: [
                "FORM",
                "AGENT",
                "EMAIL",
                "AI",
                "PHONE",
                "INTEGRATION",
                "SCHEDULE",
                "CONTRACT_REMINDER",
                "CONTRACT",
                "INSTANT_MESSAGING",
              ],
              default: "INTEGRATION",
            },
            status: {
              type: "string",
              description:
                `Initial status; defaults to the tenant's default status. ` +
                `SuperOps ships with: ${STOCK_STATUSES}. ${TENANT_CAVEAT}`,
            },
            priority: {
              type: "string",
              description: `Ticket priority. SuperOps ships with: ${STOCK_PRIORITIES}. ${TENANT_CAVEAT}`,
            },
            impact: {
              type: "string",
              description: `Ticket impact. SuperOps ships with: ${STOCK_SEVERITIES}. ${TENANT_CAVEAT}`,
            },
            urgency: {
              type: "string",
              description: `Ticket urgency. SuperOps ships with: ${STOCK_SEVERITIES}. ${TENANT_CAVEAT}`,
            },
            category: {
              type: "string",
              description: `Service category name. SuperOps ships with: ${STOCK_CATEGORIES}. ${TENANT_CAVEAT}`,
            },
            subcategory: {
              type: "string",
              description:
                "Service subcategory name; must be one of the subcategories defined under the chosen category.",
            },
            requestType: {
              type: "string",
              description: "Request type, e.g. Incident or Service Request",
            },
            siteId: {
              type: "string",
              description: "Client site ID",
            },
            requesterId: {
              type: "string",
              description: "User ID of the client user reporting the issue",
            },
            techGroupId: {
              type: "string",
              description: "Group ID of the technician group to assign",
            },
            technicianId: {
              type: "string",
              description: "User ID of the technician to assign",
            },
          },
          required: ["subject", "clientId"],
        },
      },
      {
        name: "superops_tickets_update",
        description:
          "Update an existing ticket - change status, priority, assignment, or category. " +
          "Free-text resolution notes belong in superops_tickets_add_note; only the tenant's " +
          "configured resolutionCode can be set here.",
        inputSchema: {
          type: "object",
          properties: {
            ticketId: {
              type: "string",
              description: "The ticket ID to update",
            },
            subject: {
              type: "string",
              description: "New subject/title",
            },
            status: {
              type: "string",
              description: `New status. SuperOps ships with: ${STOCK_STATUSES}. ${TENANT_CAVEAT}`,
            },
            priority: {
              type: "string",
              description: `New priority. SuperOps ships with: ${STOCK_PRIORITIES}. ${TENANT_CAVEAT}`,
            },
            impact: {
              type: "string",
              description: `New impact. SuperOps ships with: ${STOCK_SEVERITIES}. ${TENANT_CAVEAT}`,
            },
            urgency: {
              type: "string",
              description: `New urgency. SuperOps ships with: ${STOCK_SEVERITIES}. ${TENANT_CAVEAT}`,
            },
            category: {
              type: "string",
              description: `New service category name. SuperOps ships with: ${STOCK_CATEGORIES}. ${TENANT_CAVEAT}`,
            },
            subcategory: {
              type: "string",
              description:
                "New service subcategory name; must be one of the subcategories defined under the chosen category.",
            },
            requestType: {
              type: "string",
              description: "New request type, e.g. Incident or Service Request",
            },
            resolutionCode: {
              type: "string",
              description:
                `Resolution code, for resolving/closing tickets. SuperOps ships with: ` +
                `${STOCK_RESOLUTION_CODES}. ${TENANT_CAVEAT}`,
            },
            technicianId: {
              type: "string",
              description: "User ID of the technician to assign",
            },
            techGroupId: {
              type: "string",
              description: "Group ID of the technician group to assign",
            },
          },
          required: ["ticketId"],
        },
      },
      {
        name: "superops_tickets_add_note",
        description: "Add a note to a ticket. Can be internal or public (visible to client).",
        _meta: TICKET_CARD_META,
        inputSchema: {
          type: "object",
          properties: {
            ticketId: {
              type: "string",
              description: "The ticket ID",
            },
            content: {
              type: "string",
              description: "Note content",
            },
            isPublic: {
              type: "boolean",
              description:
                "Whether the note is visible to the client — maps to SuperOps' PUBLIC/PRIVATE note privacy (default: false, i.e. PRIVATE)",
              default: false,
            },
          },
          required: ["ticketId", "content"],
        },
      },
      {
        name: "superops_tickets_log_time",
        description:
          "Log a worklog entry against a ticket. SuperOps records quantity (not a raw minute " +
          "count) against the service item's unit — typically hours.",
        inputSchema: {
          type: "object",
          properties: {
            ticketId: {
              type: "string",
              description: "The ticket ID to log the work against",
            },
            qty: {
              type: "string",
              description:
                'Quantity of work in the service item\'s unit, typically hours, e.g. "1.5"',
            },
            billDateTime: {
              type: "string",
              description: "When the work was performed, ISO 8601 (default: now)",
            },
            notes: {
              type: "string",
              description: "Description of work performed",
            },
            billable: {
              type: "boolean",
              description: "Whether the time is billable (default: true)",
              default: true,
            },
            afterHours: {
              type: "boolean",
              description: "Whether the work was performed after hours (default: false)",
              default: false,
            },
            technicianId: {
              type: "string",
              description:
                "User ID of the technician who performed the work (defaults to the API token's user)",
            },
            serviceItemId: {
              type: "string",
              description: "Service catalog item ID to bill the work against",
            },
            unitPrice: {
              type: "string",
              description: "Override the service item's unit price",
            },
          },
          required: ["ticketId", "qty"],
        },
      },
    ],

    async handleCall(name, args) {
      const client = getClient();

      try {
        switch (name) {
          case "superops_tickets_list": {
            const params = args as {
              status?: string[];
              priority?: string[];
              clientId?: string;
              technicianId?: string;
              page?: number;
              pageSize?: number;
            };

            // If no filters provided, elicit a status from the user.
            const hasFilters = Boolean(
              params.status?.length ||
                params.priority?.length ||
                params.clientId ||
                params.technicianId
            );

            if (!hasFilters && params.page === undefined) {
              const statusChoice = await elicitText(
                "No filters specified. Would you like to narrow by ticket status?",
                "status",
                `Enter status (${STOCK_STATUSES}) or leave blank for all`
              );
              if (statusChoice) {
                params.status = statusChoice
                  .split(",")
                  .map((s) => s.trim())
                  .filter(Boolean);
              }
            }

            // Every supplied filter is applied: values within one filter are
            // OR'd by `includes`, then the filters are AND'd together. All four
            // attributes are flat names, confirmed live against getTicketList —
            // NOT the nested `client.accountId` / `technician.userId` paths the
            // ticket reads those objects back under.
            const condition = and([
              params.status?.length ? clause("status", "includes", params.status) : undefined,
              params.priority?.length
                ? clause("priority", "includes", params.priority)
                : undefined,
              params.clientId ? clause("client", "includes", [params.clientId]) : undefined,
              params.technicianId
                ? clause("technician", "includes", [params.technicianId])
                : undefined,
            ]);

            const input: ListInfoInput = {
              ...paging(params),
              ...(condition && { condition }),
              sort: [{ attribute: "createdTime", order: "DESC" }],
            };

            const response = await client.query<ListTicketsResponse>(LIST_TICKETS_QUERY, {
              input,
            });

            return {
              content: [
                {
                  type: "text",
                  text: JSON.stringify(response.getTicketList, null, 2),
                },
              ],
            };
          }

          case "superops_tickets_get": {
            const { ticketId } = args as { ticketId: string };

            const response = await client.query<GetTicketResponse>(GET_TICKET_QUERY, {
              input: { ticketId },
            });

            // MCP Apps: attach the normalized card payload the ui:// ticket
            // card renders from. Best-effort — a null card just means no UI
            // surface; the model-visible JSON is otherwise unchanged.
            const payload: Record<string, unknown> = { ...response.getTicket };
            const card = buildTicketCard(payload);
            if (card) payload._card = card;

            const ticket = response.getTicket;
            const summary = `Ticket ${ticket.ticketId ?? ticketId} (${
              ticket.status ?? "unknown status"
            }): ${ticket.subject ?? "no subject"}`;

            return {
              content: [{ type: "text", text: summary }],
              structuredContent: payload,
            };
          }

          case "superops_tickets_create": {
            const params = args as {
              subject: string;
              description?: string;
              clientId: string;
              source?: string;
              status?: string;
              priority?: string;
              impact?: string;
              urgency?: string;
              category?: string;
              subcategory?: string;
              requestType?: string;
              siteId?: string;
              requesterId?: string;
              techGroupId?: string;
              technicianId?: string;
            };

            // `source` is non-null on CreateTicketInput, so always send one.
            const input: Record<string, unknown> = {
              subject: params.subject,
              client: { accountId: params.clientId },
              source: params.source ?? "INTEGRATION",
            };
            if (params.description) input.description = params.description;
            if (params.status) input.status = params.status;
            if (params.priority) input.priority = params.priority;
            if (params.impact) input.impact = params.impact;
            if (params.urgency) input.urgency = params.urgency;
            if (params.category) input.category = params.category;
            if (params.subcategory) input.subcategory = params.subcategory;
            if (params.requestType) input.requestType = params.requestType;
            if (params.siteId) input.site = { id: params.siteId };
            if (params.requesterId) input.requester = { userId: params.requesterId };
            if (params.techGroupId) input.techGroup = { groupId: params.techGroupId };
            if (params.technicianId) input.technician = { userId: params.technicianId };

            const response = await client.mutate<CreateTicketResponse>(
              CREATE_TICKET_MUTATION,
              { input }
            );

            return {
              content: [
                {
                  type: "text",
                  text: JSON.stringify(response.createTicket, null, 2),
                },
              ],
            };
          }

          case "superops_tickets_update": {
            const params = args as {
              ticketId: string;
              subject?: string;
              status?: string;
              priority?: string;
              impact?: string;
              urgency?: string;
              category?: string;
              subcategory?: string;
              requestType?: string;
              resolutionCode?: string;
              technicianId?: string;
              techGroupId?: string;
            };

            const input: Record<string, unknown> = { ticketId: params.ticketId };
            if (params.subject) input.subject = params.subject;
            if (params.status) input.status = params.status;
            if (params.priority) input.priority = params.priority;
            if (params.impact) input.impact = params.impact;
            if (params.urgency) input.urgency = params.urgency;
            if (params.category) input.category = params.category;
            if (params.subcategory) input.subcategory = params.subcategory;
            if (params.requestType) input.requestType = params.requestType;
            if (params.resolutionCode) input.resolutionCode = params.resolutionCode;
            if (params.technicianId) input.technician = { userId: params.technicianId };
            if (params.techGroupId) input.techGroup = { groupId: params.techGroupId };

            const response = await client.mutate<UpdateTicketResponse>(
              UPDATE_TICKET_MUTATION,
              { input }
            );

            return {
              content: [
                {
                  type: "text",
                  text: JSON.stringify(response.updateTicket, null, 2),
                },
              ],
            };
          }

          case "superops_tickets_add_note": {
            const params = args as {
              ticketId: string;
              content: string;
              isPublic?: boolean;
            };

            // Default to PRIVATE: an internal note can be made public later,
            // but a note sent to the client cannot be unsent.
            const response = await client.mutate<CreateNoteResponse>(CREATE_NOTE_MUTATION, {
              input: {
                workItem: { workId: params.ticketId, module: "TICKET" },
                content: params.content,
                privacyType: params.isPublic ? "PUBLIC" : "PRIVATE",
              },
            });

            return {
              content: [
                {
                  type: "text",
                  text: JSON.stringify(response.createNote, null, 2),
                },
              ],
            };
          }

          case "superops_tickets_log_time": {
            const params = args as {
              ticketId: string;
              qty: string | number;
              billDateTime?: string;
              notes?: string;
              billable?: boolean;
              afterHours?: boolean;
              technicianId?: string;
              serviceItemId?: string;
              unitPrice?: string | number;
            };

            const entry: Record<string, unknown> = {
              workItem: { workId: params.ticketId, module: "TICKET" },
              qty: String(params.qty),
              billDateTime: params.billDateTime ?? new Date().toISOString(),
              billable: params.billable ?? true,
              afterHours: params.afterHours ?? false,
            };
            if (params.notes) entry.notes = params.notes;
            if (params.technicianId) entry.technician = { userId: params.technicianId };
            if (params.serviceItemId) entry.serviceItem = { itemId: params.serviceItemId };
            if (params.unitPrice !== undefined) entry.unitPrice = String(params.unitPrice);

            // createWorklogEntries takes a LIST of entries.
            const response = await client.mutate<CreateWorklogEntriesResponse>(
              CREATE_WORKLOG_ENTRIES_MUTATION,
              { input: [entry] }
            );

            return {
              content: [
                {
                  type: "text",
                  text: JSON.stringify(response.createWorklogEntries, null, 2),
                },
              ],
            };
          }

          default:
            return {
              content: [{ type: "text", text: `Unknown tickets tool: ${name}` }],
              isError: true,
            };
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: "text", text: `Error: ${message}` }],
          isError: true,
        };
      }
    },
  };
}
