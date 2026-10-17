// convex/apiClients.ts — secret keys for partner apps calling the HTTP API
//
// A partner (Nafa) is set up from the CLI. It gets a service staff member in
// its own branch, which holds the customers it creates, and a secret key its
// backend sends as `Authorization: Bearer <key>` (see channelApi.ts). Only the
// key's SHA-256 is stored. Suspending the service staff member on the
// dashboard, or revoking the key, cuts the partner off at once.
import { ConvexError, v } from "convex/values";
import { internal } from "./_generated/api";
import { Doc } from "./_generated/dataModel";
import { internalAction, internalMutation, QueryCtx } from "./_generated/server";
import { hashActivationCode } from "./users";

const CHANNEL = v.literal("nafa");

/** SHA-256 hex of an API key, the only form in which keys are stored. */
export const hashApiKey = hashActivationCode;

/** A fresh 256-bit key. Called from actions, where randomness isn't replayed. */
function newKey() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return `mzk_${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}`;
}

/**
 * Create a partner: its branch (or reuse one), its service staff member and a
 * key. Prints the key once; store it in the partner backend's secrets.
 *   npx convex run apiClients:create '{"name":"Nafa","channel":"nafa",
 *     "newBranch":{"organizationId":"…","name":"Nafa (canal digital)","code":"NAFA-01","location":"En ligne"}}'
 */
export const create = internalAction({
  args: {
    name: v.string(),
    channel: CHANNEL,
    branchId: v.optional(v.id("branches")),
    newBranch: v.optional(
      v.object({
        organizationId: v.id("organizations"),
        name: v.string(),
        code: v.string(),
        location: v.string(),
      }),
    ),
  },
  handler: async (ctx, args): Promise<{ apiClientId: string; key: string }> => {
    const key = newKey();
    const apiClientId: string = await ctx.runMutation(internal.apiClients.insert, {
      ...args,
      keyHash: await hashApiKey(key),
    });
    return { apiClientId, key };
  },
});

export const insert = internalMutation({
  args: {
    name: v.string(),
    channel: CHANNEL,
    keyHash: v.string(),
    branchId: v.optional(v.id("branches")),
    newBranch: v.optional(
      v.object({
        organizationId: v.id("organizations"),
        name: v.string(),
        code: v.string(),
        location: v.string(),
      }),
    ),
  },
  handler: async (ctx, args) => {
    const name = args.name.trim();
    if (!name || name.length > 80) throw new ConvexError("NAME_REQUIRED");
    if ((args.branchId === undefined) === (args.newBranch === undefined)) {
      throw new ConvexError("BRANCH_REQUIRED"); // exactly one of the two
    }
    let branchId = args.branchId;
    if (args.newBranch) {
      const code = args.newBranch.code.trim().toUpperCase();
      if (!(await ctx.db.get(args.newBranch.organizationId))) throw new ConvexError("INVALID_ORGANIZATION");
      const clash = await ctx.db
        .query("branches")
        .withIndex("by_code", (q) => q.eq("code", code))
        .first();
      if (clash) throw new ConvexError("CODE_TAKEN");
      branchId = await ctx.db.insert("branches", { ...args.newBranch, code });
    } else if (!(await ctx.db.get(branchId!))) {
      throw new ConvexError("INVALID_BRANCH");
    }

    // No password account and no roles: it can't sign in to the dashboard or
    // the app, and only acts through the API
    const userId = await ctx.db.insert("users", {
      fullName: `${name} (API)`,
      email: `api-${args.channel}-${Date.now()}@api.invalid`,
      phoneNumber: "",
      branchId: branchId!,
      status: "active",
    });
    return await ctx.db.insert("apiClients", {
      name,
      channel: args.channel,
      keyHash: args.keyHash,
      userId,
      status: "active",
      createdAt: Date.now(),
    });
  },
});

/**
 * Give a partner a new key, keeping its branch, staff member and customers.
 * The old key stops working at once.
 *   npx convex run apiClients:rotate '{"apiClientId":"…"}'
 */
export const rotate = internalAction({
  args: { apiClientId: v.id("apiClients") },
  handler: async (ctx, args): Promise<{ key: string }> => {
    const key = newKey();
    await ctx.runMutation(internal.apiClients.replaceKey, {
      apiClientId: args.apiClientId,
      keyHash: await hashApiKey(key),
    });
    return { key };
  },
});

export const replaceKey = internalMutation({
  args: { apiClientId: v.id("apiClients"), keyHash: v.string() },
  handler: async (ctx, args) => {
    const client = await ctx.db.get(args.apiClientId);
    if (!client) throw new ConvexError("NOT_FOUND");
    await ctx.db.patch(client._id, { keyHash: args.keyHash, status: "active" });
  },
});

/** Cut a partner off: npx convex run apiClients:revoke '{"apiClientId":"…"}' */
export const revoke = internalMutation({
  args: { apiClientId: v.id("apiClients") },
  handler: async (ctx, args) => {
    const client = await ctx.db.get(args.apiClientId);
    if (!client) throw new ConvexError("NOT_FOUND");
    await ctx.db.patch(client._id, { status: "revoked" });
  },
});

export type ApiCaller = {
  client: Doc<"apiClients">;
  user: Doc<"users">;
  branch: Doc<"branches">;
  organization: Doc<"organizations">;
};

/**
 * The active partner whose key hashes to `keyHash`, with its service staff
 * member, branch and organization. UNAUTHORIZED for an unknown or revoked key,
 * or a suspended staff member.
 */
export async function requireApiClient(ctx: QueryCtx, keyHash: string): Promise<ApiCaller> {
  const client = await ctx.db
    .query("apiClients")
    .withIndex("by_key_hash", (q) => q.eq("keyHash", keyHash))
    .unique();
  if (!client || client.status !== "active") throw new ConvexError("UNAUTHORIZED");
  const user = await ctx.db.get(client.userId);
  if (!user || user.status !== "active") throw new ConvexError("UNAUTHORIZED");
  const branch = await ctx.db.get(user.branchId);
  const organization = branch ? await ctx.db.get(branch.organizationId) : null;
  if (!branch || !organization || organization.status !== "active") throw new ConvexError("UNAUTHORIZED");
  return { client, user, branch, organization };
}
