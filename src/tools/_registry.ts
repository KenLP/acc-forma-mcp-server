import type { AnyToolDef } from './_types.js';

// ---- Account Admin ----------------------------------------------------------
import { adminListProjectsTool } from './admin/list-projects.js';
import { adminGetProjectTool } from './admin/get-project.js';
import { adminListUsersTool } from './admin/list-users.js';
import { adminListCompaniesTool } from './admin/list-companies.js';

// ---- Data Management --------------------------------------------------------
import { listHubsTool } from './dm/list-hubs.js';
import { listProjectsTool } from './dm/list-projects.js';
import { listTopFoldersTool } from './dm/list-top-folders.js';
import { listFolderContentsTool } from './dm/list-folder-contents.js';
import { getItemTool } from './dm/get-item.js';
import { listVersionsTool } from './dm/list-versions.js';

// ---- Issues -----------------------------------------------------------------
import { listIssuesTool } from './issues/list.js';
import { getIssueTool } from './issues/get.js';
import { createIssueTool } from './issues/create.js';
import { addCommentTool } from './issues/add-comment.js';
import { listIssueTypesTool } from './issues/list-types.js';
import { listRootCausesTool } from './issues/list-root-causes.js';

// ---- Reviews ----------------------------------------------------------------
import { listReviewsTool } from './reviews/list.js';
import { getReviewTool } from './reviews/get.js';
import { createReviewTool } from './reviews/create.js';
import { transitionReviewTool } from './reviews/transition.js';

// ---- AEC Data Model (GraphQL) -----------------------------------------------
import { aecdmListHubsTool } from './aecdm/list-hubs.js';
import { aecdmListProjectsTool } from './aecdm/list-projects.js';
import { aecdmListElementGroupsTool } from './aecdm/list-element-groups.js';
import { aecdmQueryElementsTool } from './aecdm/query-elements.js';
import { aecdmListCategoriesTool } from './aecdm/list-categories.js';
import { aecdmAggregateByParameterTool } from './aecdm/aggregate-by-parameter.js';
import { getElementPropertiesTool } from './aecdm/get-element-properties.js';
import { aecdmQueryElementPositionsTool } from './aecdm/query-element-positions.js';

// ---- Model Derivative (geometry + translation) ------------------------------
import { mdGetManifestTool } from './md/get-manifest.js';
import { mdGetPropertiesTool } from './md/get-properties.js';
import { mdCheckClearanceTool } from './md/check-clearance.js';
import { mdTriggerTranslationTool } from './md/trigger-translation.js';

// ---- Meta / Observability ---------------------------------------------------
import { metaListChangelogTool } from './meta/list-changelog.js';
import { metaVerifyAuditChainTool } from './meta/verify-audit-chain.js';

/**
 * Central tool registry — Phase 1 complete.
 * The import itself triggers any registerValidator() side-effects in each tool module.
 */
export const toolRegistry: AnyToolDef[] = [
  // Account Admin (4)
  adminListProjectsTool,
  adminGetProjectTool,
  adminListUsersTool,
  adminListCompaniesTool,

  // Data Management (6)
  listHubsTool,
  listProjectsTool,
  listTopFoldersTool,
  listFolderContentsTool,
  getItemTool,
  listVersionsTool,

  // Issues (6)
  listIssuesTool,
  getIssueTool,
  createIssueTool,
  addCommentTool,
  listIssueTypesTool,
  listRootCausesTool,

  // Reviews (4)
  listReviewsTool,
  getReviewTool,
  createReviewTool,
  transitionReviewTool,

  // AEC Data Model / BIM GraphQL (8)
  aecdmListHubsTool,
  aecdmListProjectsTool,
  aecdmListElementGroupsTool,
  aecdmQueryElementsTool,
  aecdmListCategoriesTool,
  aecdmAggregateByParameterTool,
  getElementPropertiesTool,
  aecdmQueryElementPositionsTool,

  // Model Derivative — geometry extraction + translation (4)
  mdGetManifestTool,
  mdGetPropertiesTool,
  mdCheckClearanceTool,
  mdTriggerTranslationTool,

  // Meta / Observability (2)
  metaListChangelogTool,
  metaVerifyAuditChainTool,
];
