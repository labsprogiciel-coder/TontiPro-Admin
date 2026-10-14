// convex/users.ts — current staff member, and role administration
import { getAuthUserId } from "@convex-dev/auth/server";
import { v } from "convex/values";
import { internalMutation, query, QueryCtx } from "./_generated/server";
import { authz } from "./authz";

const ROLE = v.union(
  v.literal("field_agent"),
  v.literal("supervisor"),
  v.literal("accountant"),
  v.literal("it_admin"),
);

// The signed-in, active staff member. Authz user IDs are users._id.
export async function requireUser(ctx: QueryCtx) {
  const userId = await getAuthUserId(ctx);
  if (!userId) throw new Error("Unauthenticated");
  const user = await ctx.db.get(userId);
  if (!user) throw new Error("User not found");
  if (user.status !== "active") throw new Error("Account suspended");
  return user;
}

export const me = query({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return null;
    const user = await ctx.db.get(userId);
    if (!user) return null;
    const [branch, roles] = await Promise.all([
      ctx.db.get(user.branchId),
      authz.getUserRoles(ctx, user._id).catch(() => []),
    ]);
    return {
      id: user._id,
      name: user.fullName,
      email: user.email,
      branch: branch?.name ?? null,
      roles: roles.map((r) => r.role),
    };
  },
});

// Bootstrap / admin tool: npx convex run users:assignRole '{"email":"…","role":"it_admin"}'
export const assignRole = internalMutation({
  args: { email: v.string(), role: ROLE },
  handler: async (ctx, args) => {
    const user = await ctx.db
      .query("users")
      .withIndex("email", (q) => q.eq("email", args.email.trim().toLowerCase()))
      .unique();
    if (!user) throw new Error("No staff account for this email");
    await authz.assignRole(ctx, user._id, args.role);
    return user._id;
  },
});
