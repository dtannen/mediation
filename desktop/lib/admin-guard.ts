/**
 * Pluggable admin authorization guard (v2 Section 1.3).
 *
 * Enforces admin-only actions such as template management.
 * The guard resolves the `actorId` to a local profile record and checks
 * the `isAdmin` boolean flag.  The guard is designed as a pluggable
 * function so it can be swapped for a role-based check when multi-user
 * admin support is added.
 */

export interface AdminGuardContext {
  actorId: string;
  isAdmin?: boolean;
  isLocalOwner?: boolean;
}

/**
 * Asserts that the actor has admin privileges.
 * Throws DomainError-compatible error if the actor is not authorized.
 */
export function assertAdmin(context: AdminGuardContext): void {
  // Check explicit isAdmin flag from user profile
  if (context.isAdmin === true) {
    return;
  }

  // Deny by default — isLocalOwner alone is NOT sufficient.
  // The profile must explicitly carry isAdmin === true.
  throw Object.assign(new Error('admin access required'), {
    code: 'unauthorized_admin_action',
  });
}

/**
 * Returns true if the actor has admin privileges, false otherwise.
 */
export function isAdmin(context: AdminGuardContext): boolean {
  try {
    assertAdmin(context);
    return true;
  } catch {
    return false;
  }
}

/**
 * Create an admin check function bound to a profile store.
 * Returns a function that resolves actorId → profile and checks isAdmin.
 */
export function createAdminChecker(
  getProfile: (actorId: string) => { isAdmin?: boolean } | undefined,
): (actorId: string) => boolean {
  return (actorId: string): boolean => {
    if (!actorId) return false;
    const profile = getProfile(actorId);
    return profile?.isAdmin === true;
  };
}
