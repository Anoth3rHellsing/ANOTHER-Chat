/** Permission bit flags — mirrors server-side PERM object */
export const PERM = {
  MANAGE_CHANNELS: 1,
  KICK_MEMBERS: 2,
  BAN_MEMBERS: 4,
  MANAGE_MESSAGES: 8,
} as const;

export const PERM_LABELS: Record<number, string> = {
  [PERM.MANAGE_CHANNELS]: 'Gestionar canales',
  [PERM.KICK_MEMBERS]: 'Expulsar miembros',
  [PERM.BAN_MEMBERS]: 'Banear miembros',
  [PERM.MANAGE_MESSAGES]: 'Eliminar mensajes ajenos',
};

export function hasPerm(perms: number, flag: number): boolean {
  return (perms & flag) === flag;
}

/** Compute effective permissions for a member given their membership role and custom roles */
export function getEffectivePermissions(
  membershipRole: string,
  customRoles: Array<{ permissions: number }>
): number {
  if (membershipRole === 'owner' || membershipRole === 'admin') return 0xffffffff;
  return customRoles.reduce((acc, r) => acc | r.permissions, 0);
}
