// convex/auth.ts — staff sign-in (email + password, invite-only)
import { Password } from "@convex-dev/auth/providers/Password";
import { convexAuth } from "@convex-dev/auth/server";
import { hashActivationCode } from "./users";

const normalizeEmail = (email: unknown) => String(email ?? "").trim().toLowerCase();

export const { auth, signIn, signOut, store, isAuthenticated } = convexAuth({
  providers: [
    Password({
      // Same lowercase account ID for sign-up and sign-in. The activation code
      // only travels to createOrUpdateUser; it is never stored on the account.
      profile: (params) =>
        ({
          email: normalizeEmail(params.email),
          activationCode: typeof params.code === "string" ? params.code.trim().toUpperCase() : undefined,
        }) as any,
    }),
  ],
  callbacks: {
    // Staff are created by an administrator (or the seed), never by sign-up.
    // "Première connexion" (signUp) links a password to an existing, active
    // staff row, and only with the one-time code an administrator issued for
    // that email: knowing a staff email is not enough to claim the account.
    async createOrUpdateUser(ctx, args) {
      if (args.existingUserId) return args.existingUserId;

      const email = normalizeEmail(args.profile.email);
      const code = args.profile.activationCode;
      const staff = await ctx.db
        .query("users")
        .withIndex("email", (q) => q.eq("email", email))
        .unique();
      if (!staff || staff.status !== "active") throw new Error("Activation refused");
      if (
        typeof code !== "string" ||
        !staff.activationCodeHash ||
        !staff.activationExpiresAt ||
        staff.activationExpiresAt < Date.now() ||
        (await hashActivationCode(code)) !== staff.activationCodeHash
      ) {
        throw new Error("Activation refused");
      }
      // One-time use
      await ctx.db.patch(staff._id, { activationCodeHash: undefined, activationExpiresAt: undefined });
      return staff._id;
    },

    // Every new session, including plain sign-ins that skip createOrUpdateUser
    async beforeSessionCreation(ctx, { userId }) {
      const user = await ctx.db.get(userId);
      if (!user || user.status !== "active") throw new Error("Account suspended");
    },
  },
});
