/**
 * SuperOps.ai Assets Domain
 *
 * Tools for managing assets (endpoints) in SuperOps.ai RMM.
 *
 * Every document here is validated against schema/superops.graphql by
 * graphql-schema.test.ts. Several SuperOps traits shape the queries below:
 *
 *  - `client`, `site`, `requester`, `assetClass`, `deviceCategory`,
 *    `customFields` and `software` are the `JSON` scalar. They are selected
 *    bare; a subselection makes the API reject the whole request.
 *  - Pagination is page/pageSize offsets, not Relay cursors. There is no
 *    `first`/`after`/`hasNextPage`/`endCursor`.
 *  - `listInfo.hasMore` is tri-state in practice: `true` when a further page
 *    exists and `null` — never `false` — when one does not. This holds for the
 *    asset list and the nested software/patch lists alike, so treat a nullish
 *    `hasMore` as "no more", or page off `totalCount` instead.
 *  - Every value-bearing asset field (`status`, `platform`, `severity`,
 *    `installationStatus`) is `String` in the schema, not an enum, and the
 *    field-metadata API that serves authoritative option lists for other
 *    modules does not cover assets: `getAllFields("ASSET")` errors where
 *    `getAllFields("CLIENT")` and `("TICKET")` return real option sets. These
 *    values are agent telemetry, not admin-configured picklists, so no tool
 *    below advertises an `enum` — and a wrong one would fail *silently*, since
 *    an out-of-range value returns zero rows rather than an error.
 *
 * Filters are built with `clause`/`and` from `../utils/conditions.js`, which
 * owns the operator vocabulary, the uppercase-`"AND"` trap and the two ways a
 * filter silently matches nothing; `RuleConditionInput` in `../types.js` is the
 * recursive shape they produce.
 */

import { getClient } from "../client.js";
import type { DomainTools, Asset, AssetSoftware, ListInfo, PatchData } from "../types.js";
import { clause, and } from "../utils/conditions.js";
import { paging, PAGE_PROPERTIES } from "../utils/paging.js";

const LIST_ASSETS_QUERY = `
  query getAssetList($input: ListInfoInput!) {
    getAssetList(input: $input) {
      assets {
        assetId
        name
        hostName
        status
        platform
        platformFamily
        platformVersion
        publicIp
        primaryMac
        loggedInUser
        patchStatus
        lastCommunicatedTime
        client
        site
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

const GET_ASSET_QUERY = `
  query getAsset($input: AssetIdentifierInput!) {
    getAsset(input: $input) {
      assetId
      name
      hostName
      status
      platform
      platformFamily
      platformCategory
      platformVersion
      manufacturer
      model
      serialNumber
      primaryMac
      publicIp
      gateway
      domain
      loggedInUser
      sysUptime
      agentVersion
      patchStatus
      warrantyExpiryDate
      purchasedDate
      lastCommunicatedTime
      lastReportedTime
      client
      site
      requester
      assetClass
      deviceCategory
      customFields
    }
  }
`;

const GET_ASSET_SOFTWARE_QUERY = `
  query getAssetSoftwareList($input: AssetDetailsListInput!) {
    getAssetSoftwareList(input: $input) {
      assetSoftwares {
        id
        software
        version
        installedDate
        bitVersion
        installedPath
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

const GET_ASSET_PATCHES_QUERY = `
  query getAssetPatchDetails($input: AssetDetailsListInput!) {
    getAssetPatchDetails(input: $input) {
      assetPatches {
        patchDetail {
          patchId
          patchKey
          title
          publishedDate
          category
          severity
          kbNumbers {
            kbNumber
          }
          restartRequired
        }
        approvalStatus
        installationStatus
        installationTime
        failedMessage
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

interface ListAssetsResponse {
  getAssetList: {
    assets: Asset[];
    listInfo: ListInfo;
  };
}

interface GetAssetResponse {
  getAsset: Asset;
}

interface GetSoftwareResponse {
  getAssetSoftwareList: {
    assetSoftwares: AssetSoftware[];
    listInfo: ListInfo;
  };
}

interface GetPatchesResponse {
  getAssetPatchDetails: {
    assetPatches: PatchData[];
    listInfo: ListInfo;
  };
}

function assetResult(value: unknown) {
  if (value === undefined) {
    return {
      content: [{ type: "text", text: "SuperOps omitted the requested asset result." }],
      isError: true,
    };
  }
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
}

export function getAssetsTools(): DomainTools {
  return {
    tools: [
      {
        name: "superops_assets_list",
        description:
          "List assets (endpoints) in SuperOps.ai RMM. Supply any combination of status, " +
          "platform and clientId; several filters are combined with AND. " +
          "listInfo.hasMore is true when a further page exists and null (never false) when " +
          "it does not, so treat null as the end or page against totalCount.",
        inputSchema: {
          type: "object",
          properties: {
            status: {
              type: "string",
              description:
                "Filter by asset status, matched whole and case-insensitively. Observed " +
                'values are "ONLINE" and "OFFLINE"; SuperOps validates the value at ' +
                "runtime, so a status this tenant uses but the list omits still works.",
            },
            platform: {
              type: "string",
              description:
                "Substring of the platform string, matched case-insensitively. SuperOps " +
                'stores a full OS name ("Microsoft Windows 10 Pro", "darwin"), so pass a ' +
                'fragment such as "Windows" or "darwin" rather than a whole name.',
            },
            clientId: {
              type: "string",
              description:
                "Filter by client account ID — the `accountId` inside an asset's `client` " +
                "object, as returned by superops_clients_list.",
            },
            ...PAGE_PROPERTIES,
          },
        },
      },
      {
        name: "superops_assets_get",
        description:
          "Get detailed information for a specific asset: hardware identity (manufacturer, " +
          "model, serial number), platform and OS version, network details (public IP, " +
          "primary MAC, gateway, domain), agent version and patch status. SuperOps does not " +
          "expose CPU, memory or disk figures on the asset record — use superops_custom_query " +
          "with getAssetSummary or getAssetDiskDetails for those.",
        inputSchema: {
          type: "object",
          properties: {
            assetId: {
              type: "string",
              description: "The unique asset ID",
            },
          },
          required: ["assetId"],
        },
      },
      {
        name: "superops_assets_software",
        description:
          "Get the software inventory for a specific asset: name, version, install date, " +
          "bit version and install path.",
        inputSchema: {
          type: "object",
          properties: {
            assetId: {
              type: "string",
              description: "The unique asset ID",
            },
            search: {
              type: "string",
              description:
                "Substring of the software name, matched case-insensitively. Matches the " +
                "name only, not the manufacturer.",
            },
            ...PAGE_PROPERTIES,
          },
          required: ["assetId"],
        },
      },
      {
        name: "superops_assets_patches",
        description:
          "Get patch status and patch details for a specific asset: title, KB numbers, " +
          "category, severity, approval status and installation status. installationStatus and " +
          "severity may be combined; they are joined with AND. For a one-word roll-up of the asset's overall patch health instead of " +
          "the per-patch list, use superops_custom_query with getAssetPatchStatus.",
        inputSchema: {
          type: "object",
          properties: {
            assetId: {
              type: "string",
              description: "The unique asset ID",
            },
            installationStatus: {
              type: "string",
              description:
                "Filter by patch installation status, matched whole and case-insensitively. " +
                'Observed values are "Installed" and "NewOrMissing" — note this is the ' +
                "install state, not the separate `approvalStatus` (Approved/Pending).",
            },
            severity: {
              type: "array",
              items: { type: "string" },
              description:
                "Filter by one or more patch severities, each matched whole and " +
                'case-insensitively. Observed values are "Others" and "Recommended"; ' +
                "SuperOps validates them at runtime, so other severities may exist.",
            },
            ...PAGE_PROPERTIES,
          },
          required: ["assetId"],
        },
      },
    ],

    async handleCall(name, args) {
      const client = getClient();

      try {
        switch (name) {
          case "superops_assets_list": {
            const params = args as {
              status?: string;
              platform?: string;
              clientId?: string;
              page?: number;
              pageSize?: number;
            };

            const condition = and([
              params.status ? clause("status", "includes", [params.status]) : undefined,
              // `includes` would demand the whole OS string ("Microsoft Windows 10 Pro"),
              // which no caller can guess; `contains` matches the fragment they do know.
              params.platform ? clause("platform", "contains", params.platform) : undefined,
              params.clientId ? clause("client", "includes", [params.clientId]) : undefined,
            ]);

            const response = await client.query<ListAssetsResponse>(LIST_ASSETS_QUERY, {
              input: {
                ...paging(params),
                ...(condition && { condition }),
                sort: [{ attribute: "name", order: "ASC" }],
              },
            });

            return assetResult(response.getAssetList);
          }

          case "superops_assets_get": {
            const { assetId } = args as { assetId: string };

            const response = await client.query<GetAssetResponse>(GET_ASSET_QUERY, {
              input: { assetId },
            });

            return assetResult(response.getAsset);
          }

          case "superops_assets_software": {
            const params = args as {
              assetId: string;
              search?: string;
              page?: number;
              pageSize?: number;
            };

            // `software` is a JSON object; filtering on the bare column matches
            // nothing at all rather than erroring, so the name path is required.
            const condition = params.search
              ? clause("software.name", "contains", params.search)
              : undefined;

            const response = await client.query<GetSoftwareResponse>(GET_ASSET_SOFTWARE_QUERY, {
              input: {
                assetId: params.assetId,
                listInfo: {
                  ...paging(params),
                  ...(condition && { condition }),
                },
              },
            });

            return assetResult(response.getAssetSoftwareList);
          }

          case "superops_assets_patches": {
            const params = args as {
              assetId: string;
              installationStatus?: string;
              severity?: string[];
              page?: number;
              pageSize?: number;
            };

            const condition = and([
              params.installationStatus
                ? clause("installationStatus", "includes", [params.installationStatus])
                : undefined,
              params.severity?.length
                ? clause("severity", "includes", params.severity)
                : undefined,
            ]);

            const response = await client.query<GetPatchesResponse>(GET_ASSET_PATCHES_QUERY, {
              input: {
                assetId: params.assetId,
                listInfo: {
                  ...paging(params),
                  ...(condition && { condition }),
                },
              },
            });

            return assetResult(response.getAssetPatchDetails);
          }

          default:
            return {
              content: [{ type: "text", text: `Unknown assets tool: ${name}` }],
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
