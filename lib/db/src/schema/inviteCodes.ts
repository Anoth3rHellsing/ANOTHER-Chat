import { inviteCodes } from "./introspected";
export const inviteCodesTable = inviteCodes;
export type InviteCode = typeof inviteCodesTable.$inferSelect;