// convex/imports.ts — bulk import of customers and past transactions from a
// spreadsheet, for the dashboard's Import page. Rows arrive already parsed
// (the browser reads the .xlsx/.csv); every row is validated here and gets
// its own result, so one bad line never blocks the rest of a batch.
import { ConvexError, v } from "convex/values";
import { Doc, Id } from "./_generated/dataModel";
import { mutation, MutationCtx } from "./_generated/server";
import { authz } from "./authz";
import { cleanIdNumber, cleanName, cleanPhone } from "./customers";
import { requireUser } from "./users";

/** Rows per call; the page sends a file in batches of this size. */
export const IMPORT_BATCH_SIZE = 200;
const MAX_AMOUNT = 100_000_000;
const EARLIEST = Date.UTC(2000, 0, 1);

type RowResult =
  | { row: number; status: "created"; id: string }
  | { row: number; status: "skipped" | "error"; code: string };

/** The importer, who needs data:import; imports land in their own branch. */
async function requireImporter(ctx: MutationCtx, rowCount: number) {
  const user = await requireUser(ctx);
  if (!(await authz.can(ctx, user._id, "data:import"))) throw new ConvexError("FORBIDDEN");
  if (rowCount > IMPORT_BATCH_SIZE) throw new ConvexError("TOO_MANY_ROWS");
  return user;
}

/** The ConvexError code of a validation helper's refusal, else rethrow. */
function refusalCode(error: unknown) {
  if (error instanceof ConvexError && typeof error.data === "string") return error.data;
  throw error;
}

const optionalText = (s: string | undefined) => (s?.trim() ? s.trim() : undefined);

/**
 * Create prospects in the importer's branch, as createProspect would (status
 * `prospect`, onboarded by the importer). A phone already used in the branch,
 * or earlier in the same batch, is `skipped` with PHONE_TAKEN, so importing
 * the same file twice creates nothing new. `row` is echoed back for the
 * page's report.
 */
export const importCustomers = mutation({
  args: {
    rows: v.array(
      v.object({
        row: v.number(),
        fullName: v.string(),
        phoneNumber: v.string(),
        idNumber: v.optional(v.string()),
        address: v.optional(v.string()),
        groupName: v.optional(v.string()),
        accountNumber: v.optional(v.string()),
        email: v.optional(v.string()),
        commitmentAmount: v.optional(v.number()),
      }),
    ),
  },
  handler: async (ctx, { rows }) => {
    const importer = await requireImporter(ctx, rows.length);
    const branchId = importer.branchId;
    const results: RowResult[] = [];
    const seen = new Set<string>();

    for (const r of rows) {
      let fullName: string, phoneNumber: string, idNumber: string;
      try {
        fullName = cleanName(r.fullName);
        phoneNumber = cleanPhone(r.phoneNumber);
        idNumber = cleanIdNumber(r.idNumber ?? "");
      } catch (e) {
        results.push({ row: r.row, status: "error", code: refusalCode(e) });
        continue;
      }
      if (
        r.commitmentAmount !== undefined &&
        (!Number.isFinite(r.commitmentAmount) || r.commitmentAmount < 0)
      ) {
        results.push({ row: r.row, status: "error", code: "INVALID_AMOUNT" });
        continue;
      }
      const taken =
        seen.has(phoneNumber) ||
        (await ctx.db
          .query("customers")
          .withIndex("by_phone", (q) => q.eq("phoneNumber", phoneNumber))
          .filter((q) => q.eq(q.field("branchId"), branchId))
          .first()) !== null;
      if (taken) {
        results.push({ row: r.row, status: "skipped", code: "PHONE_TAKEN" });
        continue;
      }
      seen.add(phoneNumber);

      const metadata = {
        address: optionalText(r.address),
        groupName: optionalText(r.groupName),
        accountNumber: optionalText(r.accountNumber),
        email: optionalText(r.email),
        commitmentAmount: r.commitmentAmount,
      };
      const id = await ctx.db.insert("customers", {
        fullName,
        phoneNumber,
        idNumber,
        branchId,
        onboardedBy: importer._id,
        status: "prospect",
        metadata: Object.values(metadata).some((x) => x !== undefined) ? metadata : undefined,
      });
      results.push({ row: r.row, status: "created", id });
    }
    return results;
  },
});

/**
 * Record past deposits and withdrawals of the importer's branch's customers,
 * found by phone or account number. They are history: they keep their own
 * date, count in the customer's balance, and are marked `imported` so they
 * never count in an agent's daily cash, reconciliation or own collections.
 * The agent named in the file is kept as text; the importer is recorded as
 * the agent. No balance check: the file is a record of what happened.
 *
 * Each row's key is its customer, type, amount, date and `occurrence` (how
 * many identical rows came before it in the file), so importing the same
 * file again skips every row with ALREADY_IMPORTED.
 */
export const importTransactions = mutation({
  args: {
    rows: v.array(
      v.object({
        row: v.number(),
        phoneNumber: v.optional(v.string()),
        accountNumber: v.optional(v.string()),
        type: v.union(v.literal("deposit"), v.literal("withdrawal")),
        amount: v.number(),
        date: v.number(),
        agentName: v.optional(v.string()),
        occurrence: v.number(),
      }),
    ),
  },
  handler: async (ctx, { rows }) => {
    const importer = await requireImporter(ctx, rows.length);
    const branchId = importer.branchId;
    const branch = await ctx.db.get(branchId);
    const organization = branch ? await ctx.db.get(branch.organizationId) : null;
    const currency = organization?.currency ?? "XOF";
    const now = Date.now();

    // Account numbers live in metadata, so look them up once per batch
    const byAccount = new Map<string, Id<"customers">>();
    if (rows.some((r) => optionalText(r.accountNumber))) {
      const customers = await ctx.db
        .query("customers")
        .withIndex("by_branch", (q) => q.eq("branchId", branchId))
        .collect();
      for (const c of customers) {
        const account = optionalText(c.metadata?.accountNumber);
        if (account) byAccount.set(account.toUpperCase(), c._id);
      }
    }

    const results: RowResult[] = [];
    for (const r of rows) {
      let customerId: Id<"customers"> | undefined;
      const account = optionalText(r.accountNumber);
      if (account) customerId = byAccount.get(account.toUpperCase());
      if (!customerId && optionalText(r.phoneNumber)) {
        let phone: string | null = null;
        try {
          phone = cleanPhone(r.phoneNumber!);
        } catch {
          // falls through to CUSTOMER_NOT_FOUND
        }
        const found: Doc<"customers"> | null = phone
          ? await ctx.db
              .query("customers")
              .withIndex("by_phone", (q) => q.eq("phoneNumber", phone!))
              .filter((q) => q.eq(q.field("branchId"), branchId))
              .first()
          : null;
        customerId = found?._id;
      }
      if (!customerId) {
        results.push({ row: r.row, status: "error", code: "CUSTOMER_NOT_FOUND" });
        continue;
      }
      if (!Number.isInteger(r.amount) || r.amount <= 0 || r.amount > MAX_AMOUNT) {
        results.push({ row: r.row, status: "error", code: "INVALID_AMOUNT" });
        continue;
      }
      if (!Number.isFinite(r.date) || r.date < EARLIEST || r.date > now) {
        results.push({ row: r.row, status: "error", code: "INVALID_DATE" });
        continue;
      }
      const clientId = `import:${customerId}:${r.type}:${r.amount}:${r.date}:${r.occurrence}`;
      const existing = await ctx.db
        .query("transactions")
        .withIndex("by_client_id", (q) => q.eq("clientId", clientId))
        .first();
      if (existing) {
        results.push({ row: r.row, status: "skipped", code: "ALREADY_IMPORTED" });
        continue;
      }
      const id = await ctx.db.insert("transactions", {
        type: r.type,
        amount: r.amount,
        currency,
        customerId,
        agentId: importer._id,
        branchId,
        tpeId: "IMPORT",
        status: "completed",
        timestamp: r.date,
        clientId,
        imported: true,
        importedAgentName: optionalText(r.agentName)?.slice(0, 120),
      });
      results.push({ row: r.row, status: "created", id });
    }
    return results;
  },
});
