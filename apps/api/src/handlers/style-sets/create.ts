import { Result } from "better-result";
import { t } from "elysia";

import { createStoredStyleSet } from "@/api/handlers/style-sets/storage";
import { createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { tDefaultVarchar } from "@/api/lib/custom-schema";
import { FILE_SIZE_LIMITS } from "@/api/lib/limits";
import {
  extractStyleSetBuffer,
  normalizeStyleSetName,
} from "@/api/lib/style-sets";

const bodySchema = t.Object({
  name: tDefaultVarchar,
  styleSource: t.File({ maxSize: FILE_SIZE_LIMITS.document }),
});

const config = {
  permissions: { styleSet: ["create"] },
  mcp: { type: "capability", reason: "template_authoring_ui" },
  body: bodySchema,
} satisfies HandlerConfig;

export default createSafeRootHandler(
  config,
  async function* ({ safeDb, session, user, body, recordAuditEvent }) {
    const name = yield* normalizeStyleSetName(body.name);
    const buffer = yield* Result.await(
      extractStyleSetBuffer(body.styleSource, name),
    );

    const row = yield* Result.await(
      createStoredStyleSet({
        safeDb,
        organizationId: session.activeOrganizationId,
        userId: user.id,
        name,
        buffer,
        recordAuditEvent,
      }),
    );
    return Result.ok({ id: row.id, name: row.name, updatedAt: row.updatedAt });
  },
);
