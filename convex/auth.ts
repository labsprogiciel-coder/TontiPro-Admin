// convex/auth.ts — staff sign-in (email + password, invite-only)
import { Password } from "@convex-dev/auth/providers/Password";
import { convexAuth } from "@convex-dev/auth/server";

export const { auth, signIn, signOut, store, isAuthenticated } = convexAuth({
  providers: [Password],
  callbacks: {
    // Staff are created by an administrator (or the seed), never by sign-up.
    // The first "signUp" for an email links a password to the existing staff
    // record; unknown emails and suspended staff are refused.
    async createOrUpdateUser(ctx, args) {
      if (args.existingUserId) return args.existingUserId;

      const email = args.profile.email?.trim().toLowerCase();
      if (!email) throw new Error("Email required");
      const staff = await ctx.db
        .query("users")
        .withIndex("email", (q) => q.eq("email", email))
        .unique();
      if (!staff) throw new Error("No staff account for this email");
      if (staff.status !== "active") throw new Error("Account suspended");
      return staff._id;
    },
  },
});
