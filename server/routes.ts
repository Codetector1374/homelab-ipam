import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { createStore } from './domain.js';
import { DomainError } from './errors.js';
import { addressSchema, deviceSchema, rangeSchema, serviceSchema, splitSchema, subnetSchema } from './schemas.js';

const paramsSchema = z.object({ id: z.coerce.number().int().positive() });
const addressQuery = z.object({ subnetId: z.coerce.number().int().positive() });
const portQuery = z.object({
  deviceId: z.coerce.number().int().positive(), protocol: z.enum(['tcp', 'udp']),
  start: z.coerce.number().int().min(1).max(65535).default(8000),
  end: z.coerce.number().int().min(1).max(65535).default(8999), bindAddress: z.string().optional(),
});

export function registerApi(app: FastifyInstance, store: ReturnType<typeof createStore>): void {
  app.register(async api => {
    api.setErrorHandler((error, request, reply) => {
      if (error instanceof DomainError) return reply.code(error.status).send({ error: error.message });
      if (error instanceof z.ZodError) {
        return reply.code(400).send({ error: error.issues.map(issue => `${issue.path.join('.') || 'Input'}: ${issue.message}`).join('; ') });
      }
      if (error instanceof Error && 'statusCode' in error && error.statusCode === 400) return reply.code(400).send({ error: 'Invalid request body' });
      request.log.error(error, 'API request failed');
      return reply.code(500).send({ error: 'An internal server error occurred' });
    });
    api.get('/api/state', () => store.state());
    api.get('/api/export', (_request, reply) => reply
      .header('Content-Disposition', 'attachment; filename="homelab-ipam.json"')
      .type('application/json').send(store.state()));
    api.post('/api/subnets/preview', request => store.previewSubnet(subnetSchema.parse(request.body)));
    api.post('/api/subnets/:id/split-preview', request => store.splitPreview(paramsSchema.parse(request.params).id, splitSchema.parse(request.body).prefixLength));
    api.post('/api/subnets/:id/split', request => store.splitSubnet(paramsSchema.parse(request.params).id, splitSchema.parse(request.body).prefixLength));
    api.get('/api/suggestions/address', request => store.suggestAddress(addressQuery.parse(request.query).subnetId));
    api.get('/api/suggestions/port', request => {
      const query = portQuery.parse(request.query);
      return store.suggestPort(query.deviceId, query.protocol, query.start, query.end, query.bindAddress ?? null);
    });
    api.post('/api/subnets', (request, reply) => reply.code(201).send(store.createSubnet(subnetSchema.parse(request.body))));
    api.post('/api/devices', (request, reply) => reply.code(201).send(store.createDevice(deviceSchema.parse(request.body))));
    api.post('/api/addresses', (request, reply) => reply.code(201).send(store.createAddress(addressSchema.parse(request.body))));
    api.post('/api/ranges', (request, reply) => reply.code(201).send(store.createRange(rangeSchema.parse(request.body))));
    api.post('/api/services', (request, reply) => reply.code(201).send(store.createService(serviceSchema.parse(request.body))));
    api.patch('/api/subnets/:id', request => store.updateSubnet(paramsSchema.parse(request.params).id, subnetSchema.parse(request.body)));
    api.patch('/api/devices/:id', request => store.updateDevice(paramsSchema.parse(request.params).id, deviceSchema.parse(request.body)));
    api.patch('/api/addresses/:id', request => store.updateAddress(paramsSchema.parse(request.params).id, addressSchema.parse(request.body)));
    api.patch('/api/services/:id', request => store.updateService(paramsSchema.parse(request.params).id, serviceSchema.parse(request.body)));
    api.delete('/api/subnets/:id', request => store.deleteSubnet(paramsSchema.parse(request.params).id));
    api.delete('/api/devices/:id', request => store.deleteDevice(paramsSchema.parse(request.params).id));
    api.delete('/api/addresses/:id', request => store.deleteAddress(paramsSchema.parse(request.params).id));
    api.delete('/api/ranges/:id', request => store.deleteRange(paramsSchema.parse(request.params).id));
    api.delete('/api/services/:id', request => store.deleteService(paramsSchema.parse(request.params).id));
  });
}
