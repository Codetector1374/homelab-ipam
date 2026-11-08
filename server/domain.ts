import type Database from 'better-sqlite3';
import type { z } from 'zod';
import type { Address, AddressInput, AddressRange, Device, DeviceInput, Endpoint, EndpointInput, RangeInput, Service, ServiceInput, State, Subnet, SubnetInput, SubnetPreview, SplitPreview } from '../shared/types.js';
import { DomainError, conflict, invalid, missing } from './errors.js';
import { contains, formatAddress, overlaps, parseAddress, parseNetwork, usable, type IP, type Network } from './ip.js';
import { addressSchema, deviceSchema, rangeSchema, serviceSchema, subnetSchema } from './schemas.js';

function validate<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success) invalid(result.error.issues.map(issue => `${issue.path.join('.') || 'Input'}: ${issue.message}`).join('; '));
  return result.data;
}

export function createStore(db: Database.Database) {
  const queries = {
    subnets: db.prepare('SELECT * FROM subnets ORDER BY id'),
    devices: db.prepare('SELECT * FROM devices ORDER BY id'),
    addresses: db.prepare('SELECT * FROM addresses ORDER BY id'),
    ranges: db.prepare('SELECT * FROM ranges ORDER BY id'),
    services: db.prepare('SELECT * FROM services ORDER BY id'),
    endpoints: db.prepare('SELECT * FROM endpoints ORDER BY id'),
  };
  function state(): State {
    const endpoints = queries.endpoints.all() as Endpoint[];
    const grouped = new Map<number, Endpoint[]>();
    for (const endpoint of endpoints) {
      const group = grouped.get(endpoint.serviceId) ?? [];
      group.push(endpoint);
      grouped.set(endpoint.serviceId, group);
    }
    return {
      subnets: queries.subnets.all() as Subnet[], devices: queries.devices.all() as Device[],
      addresses: queries.addresses.all() as Address[], ranges: queries.ranges.all() as AddressRange[],
      services: (queries.services.all() as Omit<Service, 'endpoints'>[]).map(service => ({ ...service, endpoints: grouped.get(service.id) ?? [] })),
    };
  }
  function atomic<T>(fn: () => T): T {
    try { return db.transaction(fn).immediate(); }
    catch (error) {
      if (error instanceof DomainError) throw error;
      if (error instanceof Error && 'code' in error && String(error.code).startsWith('SQLITE_CONSTRAINT')) conflict('The operation conflicts with existing records');
      throw error;
    }
  }
  function insert(table: string, values: Record<string, unknown>): number {
    const keys = Object.keys(values);
    return Number(db.prepare(`INSERT INTO ${table} (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`).run(...Object.values(values)).lastInsertRowid);
  }
  function update(table: string, id: number, values: Record<string, unknown>): void {
    db.prepare(`UPDATE ${table} SET ${Object.keys(values).map(key => `${key} = ?`).join(',')} WHERE id = ?`).run(...Object.values(values), id);
  }
  function subnet(s: State, id: number): Subnet { return s.subnets.find(item => item.id === id) ?? missing('Subnet'); }
  function device(s: State, id: number): Device { return s.devices.find(item => item.id === id) ?? missing('Device'); }
  function service(s: State, id: number): Service { return s.services.find(item => item.id === id) ?? missing('Service'); }
  function childNetworks(s: State, id: number): Network[] {
    return s.subnets.filter(item => item.parentId === id).map(item => parseNetwork(item.cidr));
  }
  function ensureDirect(s: State, owner: Subnet, value: IP): void {
    const network = parseNetwork(owner.cidr);
    if (!contains(network, value)) invalid('Address is outside the subnet');
    if (!usable(network, value)) conflict('Address is an unusable subnet boundary');
    if (childNetworks(s, owner.id).some(child => contains(child, value))) conflict('Address belongs to a delegated child subnet');
  }
  function inRange(address: IP, range: AddressRange): boolean {
    const start = parseAddress(range.start);
    return address.version === start.version && address.value >= start.value && address.value <= parseAddress(range.end).value;
  }
  function movement(s: State, parentId: number | null, network: Network): SubnetPreview {
    const addresses: Address[] = [];
    const ranges: AddressRange[] = [];
    for (const address of s.addresses.filter(item => item.subnetId === parentId)) {
      const ip = parseAddress(address.address);
      if (contains(network, ip)) {
        if (!usable(network, ip)) conflict(`Address ${address.address} would become an unusable subnet boundary`);
        addresses.push(address);
      }
    }
    for (const range of s.ranges.filter(item => item.subnetId === parentId)) {
      const start = parseAddress(range.start);
      const end = parseAddress(range.end);
      if (start.version !== network.version || start.value > network.end || end.value < network.value) continue;
      if (!contains(network, start) || !contains(network, end)) conflict(`Range ${range.start}–${range.end} crosses a child subnet boundary`);
      ranges.push(range);
    }
    return { cidr: network.cidr, addresses, ranges };
  }
  function planSubnet(s: State, input: SubnetInput): SubnetPreview {
    const network = parseNetwork(input.cidr);
    if (input.parentId !== null) {
      const parent = parseNetwork(subnet(s, input.parentId).cidr);
      if (!contains(parent, network) || network.end > parent.end || network.prefix <= parent.prefix) invalid('Child subnet must fit strictly inside its parent');
    }
    if (s.subnets.some(item => item.parentId === input.parentId && overlaps(network, parseNetwork(item.cidr)))) conflict('Subnet overlaps an existing root or sibling subnet');
    return movement(s, input.parentId, network);
  }
  function previewSubnet(input: SubnetInput): SubnetPreview {
    return planSubnet(state(), validate(subnetSchema, input));
  }
  function createSubnet(input: SubnetInput): { id: number } {
    return atomic(() => {
      const data = validate(subnetSchema, input);
      const preview = planSubnet(state(), data);
      const id = insert('subnets', { ...data, cidr: preview.cidr });
      for (const item of preview.addresses) update('addresses', item.id, { subnetId: id });
      for (const item of preview.ranges) update('ranges', item.id, { subnetId: id });
      return { id };
    });
  }
  function updateSubnet(id: number, input: SubnetInput): { id: number } {
    return atomic(() => {
      const data = validate(subnetSchema, input);
      const current = subnet(state(), id);
      if (parseNetwork(data.cidr).cidr !== current.cidr || data.parentId !== current.parentId) invalid('Subnet CIDR and parent cannot be changed; use child creation or split to subdivide');
      update('subnets', id, { name: data.name, vlanId: data.vlanId, notes: data.notes });
      return { id };
    });
  }
  function splitPlan(s: State, id: number, prefixLength: number) {
    const owner = subnet(s, id);
    const network = parseNetwork(owner.cidr);
    if (!Number.isInteger(prefixLength) || prefixLength <= network.prefix || prefixLength > network.bits) invalid('Split prefix must be longer than the subnet prefix and valid for its IP version');
    if (prefixLength - network.prefix > 8) invalid('A split may create at most 256 children');
    const count = 2 ** (prefixLength - network.prefix);
    const size = 1n << BigInt(network.bits - prefixLength);
    const directChildren = s.subnets.filter(item => item.parentId === id);
    const plans = Array.from({ length: count }, (_, index) => {
      const child = parseNetwork(`${formatAddress(network.value + BigInt(index) * size, network.version)}/${prefixLength}`);
      const existing = directChildren.find(item => item.cidr === child.cidr);
      return { network: child, existing, movement: movement(s, id, child), children: [] as Subnet[] };
    });
    for (const child of directChildren) {
      const childNetwork = parseNetwork(child.cidr);
      const target = plans.find(plan => contains(plan.network, childNetwork) && childNetwork.end <= plan.network.end);
      if (!target) conflict('An existing child subnet crosses a split boundary');
      if (target.existing?.id !== child.id) target.children.push(child);
    }
    const preview: SplitPreview = { children: plans.map(plan => ({ cidr: plan.network.cidr, addressCount: plan.movement.addresses.length, rangeCount: plan.movement.ranges.length })) };
    return { owner, plans, preview };
  }
  function splitPreview(id: number, prefixLength: number): SplitPreview { return splitPlan(state(), id, prefixLength).preview; }
  function splitSubnet(id: number, prefixLength: number): SplitPreview {
    return atomic(() => {
      const { owner, plans, preview } = splitPlan(state(), id, prefixLength);
      for (const plan of plans) {
        const childId = plan.existing?.id ?? insert('subnets', {
          name: `${owner.name} ${plan.network.cidr}`, cidr: plan.network.cidr, parentId: id, vlanId: owner.vlanId, notes: '',
        });
        for (const item of plan.movement.addresses) update('addresses', item.id, { subnetId: childId });
        for (const item of plan.movement.ranges) update('ranges', item.id, { subnetId: childId });
        for (const item of plan.children) update('subnets', item.id, { parentId: childId });
      }
      return preview;
    });
  }
  function validateHosting(s: State, input: DeviceInput, id?: number): void {
    let parentId = input.parentId;
    const visited = new Set<number>();
    while (parentId !== null) {
      if (parentId === id || visited.has(parentId)) conflict('Device hosting relationships cannot contain cycles');
      visited.add(parentId);
      parentId = device(s, parentId).parentId;
    }
  }
  function addDevice(s: State, input: DeviceInput): number {
    const data = validate(deviceSchema, input);
    validateHosting(s, data);
    return insert('devices', data);
  }
  function createDevice(input: DeviceInput): { id: number } { return atomic(() => ({ id: addDevice(state(), input) })); }
  function updateDevice(id: number, input: DeviceInput): { id: number } {
    return atomic(() => {
      const s = state();
      device(s, id);
      const data = validate(deviceSchema, input);
      validateHosting(s, data, id);
      update('devices', id, data);
      return { id };
    });
  }
  function writeAddress(input: AddressInput, existingId?: number): { id: number } {
    return atomic(() => {
      const data = validate(addressSchema, input);
      const s = state();
      const current = existingId === undefined ? undefined : s.addresses.find(item => item.id === existingId) ?? missing('Address');
      const owner = subnet(s, data.subnetId);
      let deviceId = data.deviceId;
      if (data.device) {
        if (deviceId !== null) invalid('Choose either an existing device or an inline device, not both');
        deviceId = addDevice(s, data.device);
      } else if (deviceId !== null) device(s, deviceId);
      if (deviceId === null && !data.label) invalid('A reservation without a device requires a label');
      const ip = parseAddress(data.address);
      ensureDirect(s, owner, ip);
      if (s.addresses.some(item => item.id !== existingId && item.address === ip.address)) conflict('Address is already assigned or reserved');
      if (s.ranges.some(item => inRange(ip, item))) conflict('Address is inside a DHCP or reserved range');
      if (current && (current.address !== ip.address || current.deviceId !== deviceId) &&
        s.services.some(item => item.deviceId === current.deviceId && item.endpoints.some(endpoint => endpoint.bindAddress === current.address))) {
        conflict('Cannot change an address or its device while a service endpoint is bound to it');
      }
      const values = { subnetId: data.subnetId, address: ip.address, deviceId, label: data.label, notes: data.notes };
      if (existingId !== undefined) {
        update('addresses', existingId, values);
        return { id: existingId };
      }
      return { id: insert('addresses', values) };
    });
  }
  function createAddress(input: AddressInput): { id: number } { return writeAddress(input); }
  function updateAddress(id: number, input: AddressInput): { id: number } { return writeAddress(input, id); }
  function createRange(input: RangeInput): { id: number } {
    return atomic(() => {
      const data = validate(rangeSchema, input);
      const s = state();
      const network = parseNetwork(subnet(s, data.subnetId).cidr);
      const start = parseAddress(data.start);
      const end = parseAddress(data.end);
      if (!contains(network, start) || !contains(network, end) || start.value > end.value) invalid('Range must be ordered and entirely inside its subnet');
      const intersects = (a: bigint, b: bigint) => start.value <= b && a <= end.value;
      if (childNetworks(s, data.subnetId).some(child => intersects(child.value, child.end))) conflict('Range overlaps a delegated child subnet');
      if (s.addresses.some(item => { const ip = parseAddress(item.address); return ip.version === start.version && intersects(ip.value, ip.value); })) conflict('Range overlaps an assigned or reserved address');
      if (s.ranges.some(item => { const a = parseAddress(item.start); return a.version === start.version && intersects(a.value, parseAddress(item.end).value); })) conflict('Range overlaps another range');
      return { id: insert('ranges', { ...data, start: start.address, end: end.address }) };
    });
  }
  function suggestAddress(subnetId: number): { address: string | null } {
    const s = state();
    const network = parseNetwork(subnet(s, subnetId).cidr);
    const blocked: [bigint, bigint][] = childNetworks(s, subnetId).map(child => [child.value, child.end]);
    for (const range of s.ranges.filter(item => item.subnetId === subnetId)) blocked.push([parseAddress(range.start).value, parseAddress(range.end).value]);
    for (const item of s.addresses.filter(item => item.subnetId === subnetId)) { const value = parseAddress(item.address).value; blocked.push([value, value]); }
    let candidate = network.value;
    if ((network.version === 4 && network.prefix < 31) || (network.version === 6 && network.prefix < 127)) candidate++;
    const end = network.end - (network.version === 4 && network.prefix < 31 ? 1n : 0n);
    blocked.sort((a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0);
    for (const [start, finish] of blocked) {
      if (candidate < start) break;
      if (candidate <= finish) candidate = finish + 1n;
    }
    return { address: candidate <= end ? formatAddress(candidate, network.version) : null };
  }
  function binding(s: State, deviceId: number, value: string | null): string | null {
    if (value === null) return null;
    const address = parseAddress(value).address;
    if (!s.addresses.some(item => item.deviceId === deviceId && item.address === address)) invalid('Endpoint bind IP must be assigned to the service device');
    return address;
  }
  function endpointOverlap(a: EndpointInput, b: EndpointInput): boolean {
    return a.protocol === b.protocol && a.port === b.port && (a.bindAddress === null || b.bindAddress === null || a.bindAddress === b.bindAddress);
  }
  function normalizeService(s: State, input: ServiceInput, id?: number): ServiceInput {
    const data = validate(serviceSchema, input);
    device(s, data.deviceId);
    const endpoints = data.endpoints.map(endpoint => ({ ...endpoint, bindAddress: binding(s, data.deviceId, endpoint.bindAddress) }));
    const occupied = s.services.filter(item => item.deviceId === data.deviceId && item.id !== id).flatMap(item => item.endpoints);
    for (let i = 0; i < endpoints.length; i++) {
      const endpoint = endpoints[i]!;
      if (occupied.some(other => endpointOverlap(endpoint, other)) || endpoints.slice(0, i).some(other => endpointOverlap(endpoint, other))) conflict(`Endpoint ${endpoint.protocol}/${endpoint.port} overlaps an existing wildcard or IP binding`);
    }
    return { ...data, endpoints };
  }
  function writeService(id: number, endpoints: EndpointInput[]): void {
    for (const endpoint of endpoints) insert('endpoints', { serviceId: id, ...endpoint });
  }
  function createService(input: ServiceInput): { id: number } {
    return atomic(() => {
      const { endpoints, ...data } = normalizeService(state(), input);
      const id = insert('services', data);
      writeService(id, endpoints);
      return { id };
    });
  }
  function updateService(id: number, input: ServiceInput): { id: number } {
    return atomic(() => {
      const s = state();
      service(s, id);
      const { endpoints, ...data } = normalizeService(s, input, id);
      update('services', id, data);
      db.prepare('DELETE FROM endpoints WHERE serviceId = ?').run(id);
      writeService(id, endpoints);
      return { id };
    });
  }
  function suggestPort(deviceId: number, protocol: 'tcp' | 'udp', start = 8000, end = 8999, bindAddress: string | null = null): { port: number | null } {
    if ((protocol !== 'tcp' && protocol !== 'udp') || !Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end > 65535 || start > end) invalid('Port search requires tcp/udp and an ordered range from 1 to 65535');
    const s = state();
    device(s, deviceId);
    const bind = binding(s, deviceId, bindAddress);
    const used = new Set(s.services.filter(item => item.deviceId === deviceId).flatMap(item => item.endpoints).filter(item => item.protocol === protocol && (bind === null || item.bindAddress === null || item.bindAddress === bind)).map(item => item.port));
    for (let port = start; port <= end; port++) if (!used.has(port)) return { port };
    return { port: null };
  }
  function remove(kind: 'subnets' | 'devices' | 'addresses' | 'ranges' | 'services', id: number): { ok: true } {
    return atomic(() => {
      const s = state();
      if (kind === 'subnets') {
        subnet(s, id);
        if (s.subnets.some(item => item.parentId === id) || s.addresses.some(item => item.subnetId === id) || s.ranges.some(item => item.subnetId === id)) conflict('Cannot delete a non-empty subnet; remove its children, addresses, and ranges first');
      } else if (kind === 'devices') {
        device(s, id);
        if (s.devices.some(item => item.parentId === id) || s.addresses.some(item => item.deviceId === id) || s.services.some(item => item.deviceId === id)) conflict('Cannot delete a device with hosted children, services, or addresses');
      } else if (kind === 'addresses') {
        const address = s.addresses.find(item => item.id === id) ?? missing('Address');
        if (s.services.some(item => item.deviceId === address.deviceId && item.endpoints.some(endpoint => endpoint.bindAddress === address.address))) conflict('Cannot delete an address bound to a service endpoint');
      } else if (kind === 'ranges') {
        if (!s.ranges.some(item => item.id === id)) missing('Range');
      } else service(s, id);
      db.prepare(`DELETE FROM ${kind} WHERE id = ?`).run(id);
      return { ok: true };
    });
  }
  return { state, createSubnet, updateSubnet, previewSubnet, splitPreview, splitSubnet, createDevice, updateDevice, createAddress, updateAddress, createRange, suggestAddress, createService, updateService, suggestPort,
    deleteSubnet: (id: number) => remove('subnets', id), deleteDevice: (id: number) => remove('devices', id),
    deleteAddress: (id: number) => remove('addresses', id), deleteRange: (id: number) => remove('ranges', id), deleteService: (id: number) => remove('services', id),
  };
}
