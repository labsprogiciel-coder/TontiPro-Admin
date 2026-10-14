// convex/devices.ts — TPE ↔ agent binding (it_admin only, via devices:bind)
import { v } from "convex/values";
import { mutation, MutationCtx } from "./_generated/server";
import { authz } from "./authz";
import { requireUser } from "./users";

/**
 * Return the authenticated user after checking the devices:bind permission.
 * @throws If authentication, permission, or the user's database record is missing.
 */
async function requireBinder(ctx: MutationCtx) {
  const actor = await requireUser(ctx);
  await authz.require(ctx, actor._id, "devices:bind");
  return actor;
}

/**
 * Look up a device by its serial number.
 * @throws If no device has the supplied serial number.
 */
async function getDevice(ctx: MutationCtx, serialNumber: string) {
  const device = await ctx.db
    .query("devices")
    .withIndex("by_serial", (q) => q.eq("serialNumber", serialNumber))
    .unique();
  if (!device) throw new Error("Device not found");
  return device;
}

/**
 * Bind an active device to an active field agent or supervisor who has no
 * terminal, requiring devices:bind permission. Record the actor and time when the binding changes.
 * Return the device ID; an existing binding to the same user is a no-op.
 */
export const bindDevice = mutation({
  args: { serialNumber: v.string(), userId: v.id("users") },
  handler: async (ctx, args) => {
    const actor = await requireBinder(ctx);
    const device = await getDevice(ctx, args.serialNumber);

    if (device.status !== "active") {
      throw new Error(`Device is ${device.status}; only active devices can be bound`);
    }
    if (device.assignedTo === args.userId) return device._id;
    if (device.assignedTo) {
      throw new Error("Device is already bound to another agent; unbind it first");
    }

    const agent = await ctx.db.get(args.userId);
    if (!agent) throw new Error("Agent not found");
    if (agent.status !== "active") throw new Error("Agent is suspended");
    // Only collecting roles (field_agent, supervisor) need a terminal
    if (!(await authz.can(ctx, agent._id, "transactions:collect"))) {
      throw new Error("Only field agents and supervisors can be bound to a TPE");
    }

    // One terminal per agent, so every collection traces to a single device
    const existing = await ctx.db
      .query("devices")
      .withIndex("by_assignee", (q) => q.eq("assignedTo", args.userId))
      .first();
    if (existing) {
      throw new Error(`Agent already has ${existing.serialNumber}; unbind it first`);
    }

    await ctx.db.patch(device._id, {
      assignedTo: args.userId,
      boundBy: actor._id,
      boundAt: Date.now(),
    });
    return device._id;
  },
});

/**
 * Remove a device's assignment with devices:bind permission and record the
 * actor and time. Return the device ID; an unassigned device is a no-op.
 */
export const unbindDevice = mutation({
  args: { serialNumber: v.string() },
  handler: async (ctx, args) => {
    const actor = await requireBinder(ctx);
    const device = await getDevice(ctx, args.serialNumber);
    if (!device.assignedTo) return device._id;

    await ctx.db.patch(device._id, {
      assignedTo: undefined,
      boundBy: actor._id,
      boundAt: Date.now(),
    });
    return device._id;
  },
});
