/**
 * SuperOps.ai Clients Domain
 *
 * Tools for managing clients (accounts) in SuperOps.ai PSA.
 *
 * The `Client` type exposes `accountManager`, `primaryContact`,
 * `secondaryContact`, `hqSite`, `technicianGroups` and `customFields` through
 * the `JSON` scalar. They must be selected bare — a subselection on a scalar is
 * rejected outright by the API.
 *
 * `stage` and `status` are plain `String` in the schema, not enums. Their
 * allowed values are tenant configuration, published by
 * `getAllFields(input: "CLIENT")`. `status` is a *child* of `stage`, so each
 * status value belongs to one stage:
 *
 *   Active   → Paid, Unpaid
 *   Prospect → New, Negotiation, Won, Lost
 *   Inactive → (no status options)
 *
 * Those values are named in the tool descriptions rather than pinned as a JSON
 * Schema `enum`: the lists are tenant configuration, so an `enum` would reject
 * at the MCP boundary a value the API would have accepted. Getting a value
 * wrong is recoverable — filtering on an unrecognised one is not an error, it
 * silently matches nothing.
 *
 * Filter conditions come from `../utils/conditions.js`, which documents the
 * operator vocabulary and the uppercase-`joinOperator` trap.
 *
 * `listInfo.hasMore` is `true` when further pages exist and `null` on the last
 * page. SuperOps never returns `false`, so treat any falsy value as "no more".
 */

import { getClient } from "../client.js";
import type { DomainTools, Client, ListInfo, ListInfoInput } from "../types.js";
import { clause, and, or } from "../utils/conditions.js";
import { elicitText } from "../utils/elicitation.js";
import { paging, PAGE_PROPERTIES } from "../utils/paging.js";

const LIST_CLIENTS_QUERY = `
  query getClientList($input: ListInfoInput!) {
    getClientList(input: $input) {
      clients {
        accountId
        name
        stage
        status
        emailDomains
        accountManager
        primaryContact
        hqSite
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

const GET_CLIENT_QUERY = `
  query getClient($input: ClientIdentifierInput!) {
    getClient(input: $input) {
      accountId
      name
      stage
      status
      emailDomains
      accountManager
      primaryContact
      secondaryContact
      hqSite
      technicianGroups
      customFields
    }
  }
`;

const SEARCH_CLIENTS_QUERY = `
  query searchClients($input: ListInfoInput!) {
    getClientList(input: $input) {
      clients {
        accountId
        name
        stage
        status
        emailDomains
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

const LIST_CLIENT_USERS_QUERY = `
  query getClientUserList($input: GetClientUserListInput!) {
    getClientUserList(input: $input) {
      userList {
        userId
        firstName
        lastName
        name
        email
        contactNumber
        role
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

const CREATE_CLIENT_USER_MUTATION = `
  mutation createClientUser($input: CreateClientUserInput!) {
    createClientUser(input: $input) {
      userId
      firstName
      lastName
      name
      email
      contactNumber
      role
    }
  }
`;

const UPDATE_CLIENT_USER_MUTATION = `
  mutation updateClientUser($input: UpdateClientUserInput!) {
    updateClientUser(input: $input) {
      userId
      firstName
      lastName
      name
      email
      contactNumber
      role
    }
  }
`;

const LIST_INVOICES_QUERY = `
  query getInvoiceList($input: ListInfoInput!) {
    getInvoiceList(input: $input) {
      invoices {
        invoiceId
        displayId
        client
        invoiceDate
        dueDate
        statusEnum
        totalAmount
        amountDue
        paymentDate
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

const GET_INVOICE_QUERY = `
  query getInvoice($input: InvoiceIdentifierInput!) {
    getInvoice(input: $input) {
      invoiceId
      displayId
      client
      billTo
      invoiceDate
      dueDate
      statusEnum
      sentToClient
      items {
        itemId
        billedDate
        details
        quantity
        unitPrice
        amount
        taxAmount
        totalAmount
      }
      discountAmount
      totalAmount
      amountDue
      notes
      paymentDate
      paymentReference
    }
  }
`;

interface ListClientsResponse {
  getClientList: {
    clients: Client[];
    listInfo: ListInfo;
  };
}

interface GetClientResponse {
  getClient: Client;
}

/** Appended to the stage/status descriptions, to flag the lists as per-tenant. */
const TENANT_CAVEAT = "Your tenant may rename or extend this list.";

/**
 * Match a search term against the client name or any of its email domains.
 *
 * Both operands are always present, so `or()` never returns `undefined` here.
 */
function nameOrEmailDomain(query: string) {
  return or([
    clause("name", "contains", query),
    clause("emailDomains", "contains", query),
  ]);
}

export function getClientsTools(): DomainTools {
  return {
    tools: [
      {
        name: "superops_clients_list",
        description:
          "List clients (accounts) in SuperOps.ai. Results are paginated with page/pageSize. " +
          "Supplying both stage and status narrows to clients matching both.",
        inputSchema: {
          type: "object",
          properties: {
            status: {
              type: "string",
              description:
                "Filter by status. Status is a sub-state of stage: Paid and Unpaid belong to " +
                "stage Active; New, Negotiation, Won and Lost belong to stage Prospect. " +
                "Stage Inactive has no statuses. Pairing a status with a stage it does not " +
                `belong to matches nothing. ${TENANT_CAVEAT}`,
            },
            stage: {
              type: "string",
              description:
                "Filter by stage: Active, Inactive, or Prospect. Combined with status if both " +
                `are given. ${TENANT_CAVEAT}`,
            },
            ...PAGE_PROPERTIES,
          },
        },
      },
      {
        name: "superops_clients_get",
        description: "Get detailed information for a specific client by their account ID.",
        inputSchema: {
          type: "object",
          properties: {
            accountId: {
              type: "string",
              description: "The unique account ID of the client",
            },
          },
          required: ["accountId"],
        },
      },
      {
        name: "superops_clients_search",
        description:
          "Search for clients by name or email domain. A client matches if the term appears " +
          "in either, so searching a domain fragment finds the account that owns it.",
        inputSchema: {
          type: "object",
          properties: {
            query: {
              type: "string",
              description: "Substring to match against the client name or any of its email domains",
            },
            ...PAGE_PROPERTIES,
          },
          required: ["query"],
        },
      },
      {
        name: "superops_clients_list_users",
        description:
          "List client users (contacts, end users) in SuperOps.ai, optionally for one client. " +
          "Check this before creating a user to avoid duplicates.",
        inputSchema: {
          type: "object",
          properties: {
            clientId: {
              type: "string",
              description: "Only users of this client (accountId)",
            },
            ...PAGE_PROPERTIES,
          },
        },
      },
      {
        name: "superops_clients_create_user",
        description:
          "Create a client user (contact) for onboarding a new end user. Needs firstName, email " +
          "and a roleId (client roles are tenant configuration).",
        inputSchema: {
          type: "object",
          properties: {
            firstName: { type: "string", description: "First name (required)" },
            lastName: { type: "string" },
            email: { type: "string", description: "Email address (required)" },
            roleId: { type: "string", description: "Client user role ID (required)" },
            clientId: { type: "string", description: "Client accountId to attach the user to" },
            siteId: { type: "string", description: "Client site ID" },
            contactNumber: { type: "string" },
          },
          required: ["firstName", "email", "roleId"],
        },
      },
      {
        name: "superops_clients_update_user",
        description:
          "Update a client user (contact): name, email, phone, site or role. Only the fields " +
          "you pass change.",
        inputSchema: {
          type: "object",
          properties: {
            userId: { type: "string", description: "Client user ID (required)" },
            firstName: { type: "string" },
            lastName: { type: "string" },
            email: { type: "string" },
            roleId: { type: "string" },
            siteId: { type: "string" },
            contactNumber: { type: "string" },
          },
          required: ["userId"],
        },
      },
      {
        name: "superops_clients_list_invoices",
        description:
          "List invoices (number, client, dates, status, total, amount due). Use it for billing " +
          "follow-up. Results are paginated with page/pageSize.",
        inputSchema: {
          type: "object",
          properties: { ...PAGE_PROPERTIES },
        },
      },
      {
        name: "superops_clients_get_invoice",
        description: "Get one invoice by ID, including its line items, totals and payment state.",
        inputSchema: {
          type: "object",
          properties: {
            invoiceId: { type: "string", description: "The invoice ID (required)" },
          },
          required: ["invoiceId"],
        },
      },
    ],

    async handleCall(name, args) {
      const client = getClient();

      try {
        switch (name) {
          case "superops_clients_list": {
            const params = args as {
              status?: string;
              stage?: string;
              page?: number;
              pageSize?: number;
            };

            const { page, pageSize } = paging(params);

            // If no filters provided, elicit a search term from the user.
            const hasFilters = Boolean(params.status || params.stage);
            if (!hasFilters && params.page === undefined) {
              const searchTerm = await elicitText(
                "No filters specified. Would you like to search for a specific client?",
                "search",
                "Enter a client name to search for, or leave blank to list all"
              );
              if (searchTerm) {
                // Redirect to the search handler which supports name filtering
                const searchInput: ListInfoInput = {
                  page,
                  pageSize,
                  condition: nameOrEmailDomain(searchTerm),
                  sort: [{ attribute: "name", order: "ASC" }],
                };
                const searchResponse = await client.query<ListClientsResponse>(
                  SEARCH_CLIENTS_QUERY,
                  { input: searchInput }
                );
                return {
                  content: [
                    {
                      type: "text",
                      text: JSON.stringify(searchResponse.getClientList, null, 2),
                    },
                  ],
                };
              }
            }

            const input: ListInfoInput = {
              page,
              pageSize,
              sort: [{ attribute: "name", order: "ASC" }],
            };
            const filter = and([
              params.stage ? clause("stage", "includes", [params.stage]) : undefined,
              params.status ? clause("status", "includes", [params.status]) : undefined,
            ]);
            if (filter) {
              input.condition = filter;
            }

            const response = await client.query<ListClientsResponse>(LIST_CLIENTS_QUERY, {
              input,
            });

            return {
              content: [
                {
                  type: "text",
                  text: JSON.stringify(response.getClientList, null, 2),
                },
              ],
            };
          }

          case "superops_clients_get": {
            const { accountId } = args as { accountId: string };

            const response = await client.query<GetClientResponse>(GET_CLIENT_QUERY, {
              input: { accountId },
            });

            return {
              content: [
                {
                  type: "text",
                  text: JSON.stringify(response.getClient, null, 2),
                },
              ],
            };
          }

          case "superops_clients_search": {
            const params = args as { query: string; page?: number; pageSize?: number };

            const input: ListInfoInput = {
              ...paging(params),
              condition: nameOrEmailDomain(params.query),
              sort: [{ attribute: "name", order: "ASC" }],
            };

            const response = await client.query<ListClientsResponse>(SEARCH_CLIENTS_QUERY, {
              input,
            });

            return {
              content: [
                {
                  type: "text",
                  text: JSON.stringify(response.getClientList, null, 2),
                },
              ],
            };
          }

          case "superops_clients_list_users": {
            const params = args as { clientId?: string; page?: number; pageSize?: number };
            const input: { listInfo: ListInfoInput; clientId?: string } = {
              listInfo: { ...paging(params) },
            };
            if (params.clientId) input.clientId = params.clientId;
            const response = await client.query<{
              getClientUserList: { userList: unknown[]; listInfo: ListInfo };
            }>(LIST_CLIENT_USERS_QUERY, { input });
            return {
              content: [
                { type: "text", text: JSON.stringify(response.getClientUserList, null, 2) },
              ],
            };
          }

          case "superops_clients_create_user": {
            const params = args as {
              firstName?: string;
              lastName?: string;
              email?: string;
              roleId?: string;
              clientId?: string;
              siteId?: string;
              contactNumber?: string;
            };
            if (!params.firstName || !params.email || !params.roleId) {
              return {
                content: [{ type: "text", text: "firstName, email and roleId are required" }],
                isError: true,
              };
            }
            const input: Record<string, unknown> = {
              firstName: params.firstName,
              email: params.email,
              role: { roleId: params.roleId },
            };
            if (params.lastName) input.lastName = params.lastName;
            if (params.contactNumber) input.contactNumber = params.contactNumber;
            if (params.clientId) input.client = { accountId: params.clientId };
            if (params.siteId) input.site = { id: params.siteId };
            const response = await client.mutate<{ createClientUser: unknown }>(
              CREATE_CLIENT_USER_MUTATION,
              { input }
            );
            return {
              content: [
                { type: "text", text: JSON.stringify(response.createClientUser, null, 2) },
              ],
            };
          }

          case "superops_clients_update_user": {
            const params = args as {
              userId?: string;
              firstName?: string;
              lastName?: string;
              email?: string;
              roleId?: string;
              siteId?: string;
              contactNumber?: string;
            };
            if (!params.userId) {
              return {
                content: [{ type: "text", text: "userId is required" }],
                isError: true,
              };
            }
            const input: Record<string, unknown> = { userId: params.userId };
            if (params.firstName) input.firstName = params.firstName;
            if (params.lastName) input.lastName = params.lastName;
            if (params.email) input.email = params.email;
            if (params.contactNumber) input.contactNumber = params.contactNumber;
            if (params.roleId) input.role = { roleId: params.roleId };
            if (params.siteId) input.site = { id: params.siteId };
            if (Object.keys(input).length === 1) {
              return {
                content: [{ type: "text", text: "provide at least one field to update" }],
                isError: true,
              };
            }
            const response = await client.mutate<{ updateClientUser: unknown }>(
              UPDATE_CLIENT_USER_MUTATION,
              { input }
            );
            return {
              content: [
                { type: "text", text: JSON.stringify(response.updateClientUser, null, 2) },
              ],
            };
          }

          case "superops_clients_list_invoices": {
            const params = args as { page?: number; pageSize?: number };
            const input: ListInfoInput = { ...paging(params) };
            const response = await client.query<{
              getInvoiceList: { invoices: unknown[]; listInfo: ListInfo };
            }>(LIST_INVOICES_QUERY, { input });
            return {
              content: [{ type: "text", text: JSON.stringify(response.getInvoiceList, null, 2) }],
            };
          }

          case "superops_clients_get_invoice": {
            const { invoiceId } = args as { invoiceId?: string };
            if (!invoiceId) {
              return {
                content: [{ type: "text", text: "invoiceId is required" }],
                isError: true,
              };
            }
            const response = await client.query<{ getInvoice: unknown }>(GET_INVOICE_QUERY, {
              input: { invoiceId },
            });
            return {
              content: [{ type: "text", text: JSON.stringify(response.getInvoice, null, 2) }],
            };
          }

          default:
            return {
              content: [{ type: "text", text: `Unknown clients tool: ${name}` }],
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
