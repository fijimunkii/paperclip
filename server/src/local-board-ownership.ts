import { and, eq, or, sql } from "drizzle-orm";
import {
  activityLog, companies, companySecrets, connectionGrants, issues, routineRevisions,
  routines, toolApplications, toolConnections, type Db,
} from "@paperclipai/db";

export const LOCAL_BOARD_USER_ID = "local-board";
type OwnershipTransaction = Pick<Db, "update" | "insert">;

export async function transferLocalBoardOwnership(
  tx: OwnershipTransaction,
  companyId: string,
  userId: string,
): Promise<void> {
  if (userId === LOCAL_BOARD_USER_ID) return;
  const now = new Date();
  const counts: Record<string, number> = {};

  counts.companyDefaults = (await tx.update(companies)
    .set({ defaultResponsibleUserId: userId, updatedAt: now })
    .where(and(eq(companies.id, companyId), eq(companies.defaultResponsibleUserId, LOCAL_BOARD_USER_ID)))
    .returning({ id: companies.id })).length;
  counts.issues = (await tx.update(issues)
    .set({ responsibleUserId: userId, updatedAt: now })
    .where(and(eq(issues.companyId, companyId), eq(issues.responsibleUserId, LOCAL_BOARD_USER_ID)))
    .returning({ id: issues.id })).length;
  counts.assignments = (await tx.update(issues)
    .set({ assigneeUserId: userId, updatedAt: now })
    .where(and(eq(issues.companyId, companyId), eq(issues.assigneeUserId, LOCAL_BOARD_USER_ID)))
    .returning({ id: issues.id })).length;
  counts.routines = (await tx.update(routines)
    .set({ responsibleUserId: userId, updatedAt: now })
    .where(and(eq(routines.companyId, companyId), eq(routines.responsibleUserId, LOCAL_BOARD_USER_ID)))
    .returning({ id: routines.id })).length;
  counts.routineRevisions = (await tx.update(routineRevisions)
    .set({
      responsibleUserId: sql`case when ${routineRevisions.responsibleUserId} = ${LOCAL_BOARD_USER_ID}
        then ${userId} else ${routineRevisions.responsibleUserId} end`,
      snapshot: sql`case when ${routineRevisions.snapshot} #>> '{routine,responsibleUserId}' = ${LOCAL_BOARD_USER_ID}
        then jsonb_set(${routineRevisions.snapshot}, '{routine,responsibleUserId}', to_jsonb(${userId}::text))
        else ${routineRevisions.snapshot} end`,
    })
    .where(and(eq(routineRevisions.companyId, companyId), or(
      eq(routineRevisions.responsibleUserId, LOCAL_BOARD_USER_ID),
      sql`${routineRevisions.snapshot} #>> '{routine,responsibleUserId}' = ${LOCAL_BOARD_USER_ID}`,
    )))
    .returning({ id: routineRevisions.id })).length;
  counts.secrets = (await tx.update(companySecrets)
    .set({ ownerUserId: userId, updatedAt: now })
    .where(and(eq(companySecrets.companyId, companyId), eq(companySecrets.ownerUserId, LOCAL_BOARD_USER_ID),
      sql`not exists (select 1 from ${companySecrets} as personal_secret
        where personal_secret.company_id = ${companySecrets.companyId}
          and personal_secret.user_secret_definition_id = ${companySecrets.userSecretDefinitionId}
          and personal_secret.owner_user_id = ${userId} and personal_secret.deleted_at is null)`,
    ))
    .returning({ id: companySecrets.id })).length;
  counts.applications = (await tx.update(toolApplications)
    .set({ ownerUserId: userId, updatedAt: now })
    .where(and(eq(toolApplications.companyId, companyId), eq(toolApplications.ownerUserId, LOCAL_BOARD_USER_ID)))
    .returning({ id: toolApplications.id })).length;
  counts.connections = (await tx.update(toolConnections)
    .set({ createdByUserId: userId, updatedAt: now })
    .where(and(eq(toolConnections.companyId, companyId), eq(toolConnections.createdByUserId, LOCAL_BOARD_USER_ID)))
    .returning({ id: toolConnections.id })).length;
  counts.grantOwners = (await tx.update(connectionGrants)
    .set({ createdByUserId: userId, updatedAt: now })
    .where(and(eq(connectionGrants.companyId, companyId), eq(connectionGrants.createdByUserId, LOCAL_BOARD_USER_ID)))
    .returning({ id: connectionGrants.id })).length;
  counts.grantSubjects = (await tx.update(connectionGrants)
    .set({
      subjectUserId: userId,
      status: sql`case when ${connectionGrants.status} = 'active' and exists (
        select 1 from ${companySecrets} as legacy_secret
        where legacy_secret.company_id = ${connectionGrants.companyId}
          and legacy_secret.owner_user_id = ${LOCAL_BOARD_USER_ID}
          and exists (select 1 from jsonb_array_elements(${connectionGrants.credentialSecretRefs}) as ref
            where ref->>'secretId' = legacy_secret.id::text)
      ) then 'needs_reauthorization' else ${connectionGrants.status} end`,
      updatedAt: now,
    })
    .where(and(eq(connectionGrants.companyId, companyId), eq(connectionGrants.kind, "user"),
      eq(connectionGrants.subjectUserId, LOCAL_BOARD_USER_ID),
      sql`not exists (select 1 from ${connectionGrants} as personal_grant
        where personal_grant.company_id = ${connectionGrants.companyId}
          and personal_grant.connection_id = ${connectionGrants.connectionId}
          and personal_grant.subject_user_id = ${userId})`,
    ))
    .returning({ id: connectionGrants.id })).length;

  if (Object.values(counts).some(count => count > 0)) {
    await tx.insert(activityLog).values({
      companyId, actorType: "system", actorId: "local-board-ownership-migration",
      action: "company.local_board_ownership_transferred", entityType: "company", entityId: companyId,
      responsibleUserId: userId, details: { fromUserId: LOCAL_BOARD_USER_ID, toUserId: userId, counts },
    });
  }
}
