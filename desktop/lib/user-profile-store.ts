/**
 * Simple local user profile store for v2 admin authorization.
 *
 * Stores minimal profile data including the `isAdmin` flag required
 * by the v2 admin authorization model (Spec Section 1.3).
 *
 * In v2, admin status is set during app configuration/setup and stored
 * in the local user profile. The flag is not editable through standard UI.
 */

export interface UserProfile {
  actorId: string;
  displayName?: string;
  isAdmin: boolean;
}

export class UserProfileStore {
  private readonly profiles = new Map<string, UserProfile>();

  constructor(initialProfiles?: UserProfile[]) {
    if (initialProfiles) {
      for (const profile of initialProfiles) {
        this.profiles.set(profile.actorId, profile);
      }
    }
  }

  getProfile(actorId: string): UserProfile | undefined {
    return this.profiles.get(actorId);
  }

  setProfile(profile: UserProfile): void {
    this.profiles.set(profile.actorId, profile);
  }

  /**
   * Ensure the local owner profile exists with admin privileges.
   * Called during app startup to set up the initial admin user.
   */
  ensureLocalOwner(actorId: string, displayName?: string): void {
    if (!this.profiles.has(actorId)) {
      this.profiles.set(actorId, {
        actorId,
        displayName: displayName || 'Local Owner',
        isAdmin: true,
      });
    }
  }

  listProfiles(): UserProfile[] {
    return [...this.profiles.values()];
  }
}
