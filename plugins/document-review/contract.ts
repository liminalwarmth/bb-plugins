import { defineRpcContract } from '@get-bb/plugin-sdk';
import { z } from 'zod';
import { sessionSchema, textSchema, anchorSchema, historySchema, commentSchema } from './model';
export const sourceSchema = z.object({ kind: z.enum(['host', 'workspace', 'thread-storage']), threadId: z.string().nullable(), environmentId: z.string().nullable(), projectId: z.string().nullable(), experimental_hostId: z.string().optional() });
const version = { id: z.string().min(1), revision: z.number().int().positive() };
export const rpcContract = defineRpcContract({
  list: { input: z.null(), output: z.array(z.object({ id: z.string(), path: z.string(), title: z.string(), hostId: z.string(), pending: z.number(), comments: z.number(), saved: z.boolean(), updatedAt: z.string() })) },
  feedback: { input: z.object({ path: z.string().min(1).optional(), hostId: z.string().optional(), threadId: z.string().optional(), offset: z.number().int().nonnegative().optional() }), output: z.object({ reviews: z.array(z.object({ id: z.string(), path: z.string(), hostId: z.string(), title: z.string(), revision: z.number(), pendingChanges: z.number(), unresolvedComments: z.number(), comments: z.array(commentSchema), nextCommentOffset: z.number().nullable(), detailsTruncated: z.boolean(), notice: z.string().nullable() })), nextReviewOffset: z.number().nullable() }) },
  get: { input: z.object({ id: z.string() }), output: sessionSchema },
  open: { input: z.object({ path: z.string().min(1).max(16_384), hostId: z.string().optional(), threadId: z.string().optional(), source: sourceSchema.optional() }), output: sessionSchema },
  edit: { input: z.object({ ...version, content: textSchema, baseContent: textSchema, trackChanges: z.boolean().optional() }), output: sessionSchema },
  tracking: { input: z.object({ ...version, enabled: z.boolean() }), output: sessionSchema },
  acceptAll: { input: z.object(version), output: sessionSchema },
  decide: { input: z.object({ ...version, changeId: z.string(), decision: z.enum(['accepted', 'rejected']) }), output: sessionSchema },
  comment: { input: z.object({ ...version, body: z.string().trim().min(1).max(20_000), anchor: anchorSchema.nullable(), selector: z.string().min(1).max(2000).optional() }), output: sessionSchema },
  reply: { input: z.object({ ...version, commentId: z.string(), body: z.string().trim().min(1).max(20_000) }), output: sessionSchema },
  deleteComment: { input: z.object({ ...version, commentId: z.string() }), output: sessionSchema },
  commentStatus: { input: z.object({ ...version, commentId: z.string(), status: z.enum(['open', 'resolved']) }), output: sessionSchema },
  propose: { input: z.object({ ...version, content: textSchema, withdrawUserSuggestions: z.boolean().optional() }), output: sessionSchema },
  save: { input: z.object(version), output: sessionSchema },
  history: { input: z.object({ id: z.string(), offset: z.number().int().nonnegative().optional() }), output: z.array(historySchema.omit({ changes: true, snapshot: true, comment: true })) },
  clearHistory: { input: z.object(version), output: sessionSchema },
  historyEntry: { input: z.object({ id: z.string(), eventId: z.string() }), output: historySchema },
  activate: { input: z.null(), output: z.object({ pruned: z.number() }) },
  prompt: { input: z.object({ id: z.string() }), output: z.object({ text: z.string() }) },
});
