import { z } from 'zod';

export const idSchema = z.number().int().positive();
const name = z.string().trim().min(1, 'Name is required');
const parentId = idSchema.nullable();
export const subnetSchema = z.object({
  name, cidr: z.string(), parentId, vlanId: z.number().int().min(1).max(4094).nullable(), notes: z.string(),
}).strict();
export const deviceSchema = z.object({
  name, type: z.enum(['physical', 'vm', 'lxc', 'iot', 'container', 'other']), parentId, notes: z.string(),
}).strict();
export const addressSchema = z.object({
  subnetId: idSchema, address: z.string(), deviceId: idSchema.nullable(), label: z.string().trim(),
  notes: z.string(), device: deviceSchema.optional(),
}).strict();
export const rangeSchema = z.object({
  subnetId: idSchema, start: z.string(), end: z.string(), kind: z.enum(['dhcp', 'reserved']), label: z.string(),
}).strict();
export const endpointSchema = z.object({
  protocol: z.enum(['tcp', 'udp']), port: z.number().int().min(1).max(65535),
  bindAddress: z.string().nullable(), containerPort: z.number().int().min(1).max(65535).nullable(),
}).strict();
export const serviceSchema = z.object({
  deviceId: idSchema, name, notes: z.string(), endpoints: z.array(endpointSchema),
  url: z.string().refine(value => {
    if (value === '') return true;
    try { const url = new URL(value); return url.protocol === 'http:' || url.protocol === 'https:'; }
    catch { return false; }
  }, 'Service URL must be empty or an http/https URL'),
}).strict();
export const splitSchema = z.object({ prefixLength: z.number().int().min(0).max(128) }).strict();
