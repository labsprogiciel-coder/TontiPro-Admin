// convex/schema.ts
import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  // 1. ORGANIZATIONAL STRUCTURE

  // Top-level tenant — one MFI licence = one organization
  organizations: defineTable({
    name: v.string(),               // "Kauri Finance S.A."
    country: v.string(),            // ISO-3166 alpha-2, e.g. "BF"
    currency: v.string(),           // ISO-4217, e.g. "XOF"
    licenseNumber: v.string(),      // Regulatory / BCEAO licence ref
    status: v.union(v.literal("active"), v.literal("suspended")),
    logoUrl: v.optional(v.string()),
  }).index("by_country", ["country"]),

  branches: defineTable({
    organizationId: v.id("organizations"),
    name: v.string(),
    location: v.string(),
    code: v.string(), // e.g., "OUAGA-01"
  })
    .index("by_code", ["code"])
    .index("by_organization", ["organizationId"]),

  // 2. USER MANAGEMENT (Agents, Supervisors)
  users: defineTable({
    fullName: v.string(),
    email: v.string(),
    phoneNumber: v.string(),
    tokenIdentifier: v.string(), // Clerk/Auth0 ID
    branchId: v.id("branches"),
    status: v.union(v.literal("active"), v.literal("suspended")),
  }).index("by_token", ["tokenIdentifier"]),

  // 3. KYC & CUSTOMERS
  customers: defineTable({
    fullName: v.string(),
    phoneNumber: v.string(),
    idNumber: v.string(), // National ID / Passport
    branchId: v.id("branches"),
    onboardedBy: v.id("users"),
    status: v.union(
      v.literal("prospect"), 
      v.literal("verified"), 
      v.literal("rejected")
    ),
    metadata: v.optional(v.any()), // Extra KYC info
  })
    .index("by_phone", ["phoneNumber"])
    .index("by_status", ["status"]),

  // 4. DEVICE BINDING (TPE Tracking)
  devices: defineTable({
    serialNumber: v.string(), // Hardcoded TPE Serial
    model: v.string(),
    assignedTo: v.optional(v.id("users")),
    boundBy: v.optional(v.id("users")), // Last it_admin to bind/unbind
    boundAt: v.optional(v.number()),
    status: v.union(v.literal("active"), v.literal("maintenance"), v.literal("lost")),
    lastSync: v.number(),
  })
    .index("by_serial", ["serialNumber"])
    .index("by_assignee", ["assignedTo"]),

  // 5. CASH COLLECTIONS (Transactions)
  transactions: defineTable({
    amount: v.number(),
    currency: v.string(), // e.g., "XOF"
    customerId: v.id("customers"),
    agentId: v.id("users"),
    branchId: v.id("branches"),
    tpeId: v.string(), // Serial of the TPE used
    status: v.union(v.literal("completed"), v.literal("reversed")),
    reversalReason: v.optional(v.string()),
    reversedBy: v.optional(v.id("users")), // Supervisor ID
    timestamp: v.number()
  })
    .index("by_agent_date", ["agentId", "_creationTime"])
    .index("by_branch", ["branchId"]),

  // 6. DISBURSEMENTS (Maker-Checker Workflow)
  disbursements: defineTable({
    amount: v.number(),
    customerId: v.id("customers"),
    branchId: v.id("branches"),
    initiatedBy: v.id("users"), // The "Maker"
    approvedBy: v.optional(v.id("users")), // The "Checker"
    status: v.union(
      v.literal("pending"), 
      v.literal("approved"), 
      v.literal("executed"), 
      v.literal("rejected")
    ),
    timestamp: v.number(),
    payoutMethod: v.union(v.literal("cash"), v.literal("mobile_money")),
    transactionId: v.optional(v.string()), // External reference from payment gateway
  }).index("by_status", ["status"]),
  // Add this to your existing schema.ts
reconciliations: defineTable({
    agentId: v.id("users"),
    branchId: v.id("branches"),
    verifiedBy: v.id("users"), // The Accountant/Supervisor
    
    date: v.string(), // YYYY-MM-DD for easy indexing
    systemExpectedAmount: v.number(), // Sum of transactions
    physicalCashReceived: v.number(), // What the agent actually handed over
    variance: v.number(), // physical - expected
    timestamp: v.number(),
    status: v.union(v.literal("pending"), v.literal("settled"), v.literal("discrepancy")),
    notes: v.optional(v.string()),
  })
    .index("by_agent_date", ["agentId", "date"])
    .index("by_branch_status", ["branchId", "status"]),
});