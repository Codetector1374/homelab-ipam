import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import type { AddressInput, DeviceInput, EndpointInput, ServiceInput, SubnetInput } from '../shared/types.js';
import { openDatabase } from './db.js';
import { createStore } from './domain.js';
import { DomainError } from './errors.js';

function fixture(t: TestContext) {
  const db = openDatabase(':memory:');
  t.after(() => db.close());
  return createStore(db);
}
const network = (cidr = '10.0.0.0/24', parentId: number | null = null): SubnetInput => ({ name: cidr, cidr, parentId, vlanId: null, notes: '' });
const host = (name = 'host', parentId: number | null = null): DeviceInput => ({ name, type: 'physical', parentId, notes: '' });
const reservation = (subnetId: number, address: string): AddressInput => ({ subnetId, address, deviceId: null, label: 'reserved', notes: '' });
const endpoint = (port: number, bindAddress: string | null = null, protocol: 'tcp' | 'udp' = 'tcp'): EndpointInput => ({ port, bindAddress, protocol, containerPort: null });
const app = (deviceId: number, endpoints: EndpointInput[]): ServiceInput => ({ deviceId, endpoints, name: 'service', url: '', notes: '' });
function rejects(status: number, message?: RegExp) {
  return (error: unknown) => error instanceof DomainError && error.status === status && (!message || message.test(error.message));
}

test('canonical networks, root/sibling overlap, and strict child containment', t => {
  const s = fixture(t);
  const root = s.createSubnet(network('10.0.0.42/24')).id;
  assert.equal(s.state().subnets[0]!.cidr, '10.0.0.0/24');
  assert.throws(() => s.createSubnet(network('10.0.0.0/23')), rejects(409));
  s.createSubnet(network('10.0.0.0/25', root));
  assert.throws(() => s.createSubnet(network('10.0.0.64/26', root)), rejects(409));
  assert.throws(() => s.createSubnet(network('10.0.1.0/25', root)), rejects(400));
  assert.throws(() => s.createSubnet(network('10.0.0.0/24', root)), rejects(400));
  assert.throws(() => s.createSubnet(network('2001:db8::/64', root)), rejects(400));
  assert.throws(() => s.createSubnet(network('::ffff:10.0.0.0/120')), rejects(400, /mapped/));
});

test('IPv4 /31 and /32 use all addresses, larger subnets reserve both boundaries', t => {
  const s = fixture(t);
  const point = s.createSubnet(network('10.0.0.0/31')).id;
  assert.equal(s.suggestAddress(point).address, '10.0.0.0');
  s.createAddress(reservation(point, '10.0.0.0'));
  s.createAddress(reservation(point, '10.0.0.1'));
  assert.equal(s.suggestAddress(point).address, null);
  const single = s.createSubnet(network('10.0.0.2/32')).id;
  s.createAddress(reservation(single, '10.0.0.2'));
  assert.equal(s.suggestAddress(single).address, null);
  const lan = s.createSubnet(network('10.0.1.0/30')).id;
  assert.throws(() => s.createAddress(reservation(lan, '10.0.1.0')), rejects(409, /boundary/));
  assert.throws(() => s.createAddress(reservation(lan, '10.0.1.3')), rejects(409, /boundary/));
  assert.throws(() => s.createAddress(reservation(lan, '10.0.2.1')), rejects(400));
});

test('IPv6 has no broadcast, reserves router anycast, and canonicalizes aliases', t => {
  const s = fixture(t);
  const root = s.createSubnet(network('2001:db8::/126')).id;
  assert.throws(() => s.createAddress(reservation(root, '2001:db8::')), rejects(409));
  s.createAddress(reservation(root, '2001:0db8:0:0:0:0:0:3'));
  assert.equal(s.state().addresses[0]!.address, '2001:db8::3');
  assert.throws(() => s.createAddress(reservation(root, '2001:db8::3')), rejects(409));
  const pair = s.createSubnet(network('2001:db8:1::/127')).id;
  s.createAddress(reservation(pair, '2001:db8:1::'));
  s.createAddress(reservation(pair, '2001:db8:1::1'));
  assert.equal(s.suggestAddress(pair).address, null);
  const single = s.createSubnet(network('2001:db8:2::/128')).id;
  assert.equal(s.suggestAddress(single).address, '2001:db8:2::');
});

test('suggestions skip huge IPv6 ranges and complete delegated intervals', t => {
  const s = fixture(t);
  const root = s.createSubnet(network('2001:db8::/64')).id;
  s.createRange({ subnetId: root, start: '2001:db8::1', end: '2001:db8::ffff:ffff:ffff:fff0', kind: 'dhcp', label: 'large pool' });
  assert.equal(s.suggestAddress(root).address, '2001:db8::ffff:ffff:ffff:fff1');
  const lan = s.createSubnet(network()).id;
  s.createSubnet(network('10.0.0.0/25', lan));
  s.createRange({ subnetId: lan, start: '10.0.0.128', end: '10.0.0.253', kind: 'reserved', label: '' });
  assert.equal(s.suggestAddress(lan).address, '10.0.0.254');
  s.createAddress(reservation(lan, '10.0.0.254'));
  assert.equal(s.suggestAddress(lan).address, null);
});

test('child preview has no writes; creation preserves address and range identities and service links', t => {
  const s = fixture(t);
  const root = s.createSubnet(network()).id;
  const deviceId = s.createDevice(host()).id;
  const addressId = s.createAddress({ ...reservation(root, '10.0.0.10'), deviceId }).id;
  const rangeId = s.createRange({ subnetId: root, start: '10.0.0.20', end: '10.0.0.30', kind: 'dhcp', label: 'pool' }).id;
  const serviceId = s.createService(app(deviceId, [endpoint(443, '10.0.0.10')])).id;
  const before = s.state();
  const preview = s.previewSubnet(network('10.0.0.0/25', root));
  assert.deepEqual(preview.addresses.map(item => item.id), [addressId]);
  assert.deepEqual(preview.ranges.map(item => item.id), [rangeId]);
  assert.deepEqual(s.state(), before);
  const child = s.createSubnet(network('10.0.0.0/25', root)).id;
  assert.equal(s.state().addresses.find(item => item.id === addressId)!.subnetId, child);
  assert.equal(s.state().ranges.find(item => item.id === rangeId)!.subnetId, child);
  assert.deepEqual(s.state().services.find(item => item.id === serviceId), before.services[0]);
  assert.throws(() => s.createAddress(reservation(root, '10.0.0.11')), rejects(409, /delegated/));
});

test('child creation rejects crossing ranges and newly unusable assigned boundaries atomically', t => {
  const s = fixture(t);
  const root = s.createSubnet(network()).id;
  const rangeId = s.createRange({ subnetId: root, start: '10.0.0.100', end: '10.0.0.150', kind: 'reserved', label: '' }).id;
  const before = s.state();
  assert.throws(() => s.previewSubnet(network('10.0.0.0/25', root)), rejects(409, /crosses/));
  assert.throws(() => s.createSubnet(network('10.0.0.0/25', root)), rejects(409, /crosses/));
  assert.deepEqual(s.state(), before);
  s.deleteRange(rangeId);
  s.createAddress(reservation(root, '10.0.0.127'));
  assert.throws(() => s.createSubnet(network('10.0.0.0/25', root)), rejects(409, /boundary/));
  assert.equal(s.state().subnets.length, 1);
});

test('split moves records atomically and preserves services, ranges and device links', t => {
  const s = fixture(t);
  const root = s.createSubnet(network()).id;
  const deviceId = s.createDevice(host()).id;
  const addressId = s.createAddress({ ...reservation(root, '10.0.0.130'), deviceId }).id;
  const rangeId = s.createRange({ subnetId: root, start: '10.0.0.70', end: '10.0.0.80', kind: 'dhcp', label: 'pool' }).id;
  s.createService(app(deviceId, [endpoint(8080, '10.0.0.130')]));
  const before = s.state();
  const preview = s.splitPreview(root, 26);
  assert.deepEqual(preview.children.map(item => [item.addressCount, item.rangeCount]), [[0, 0], [0, 1], [1, 0], [0, 0]]);
  assert.deepEqual(s.state(), before);
  assert.deepEqual(s.splitSubnet(root, 26), preview);
  const after = s.state();
  const address = after.addresses.find(item => item.id === addressId)!;
  const range = after.ranges.find(item => item.id === rangeId)!;
  assert.equal(after.subnets.find(item => item.id === address.subnetId)!.cidr, '10.0.0.128/26');
  assert.equal(after.subnets.find(item => item.id === range.subnetId)!.cidr, '10.0.0.64/26');
  assert.equal(address.deviceId, deviceId);
  assert.deepEqual(after.services, before.services);
  assert.equal(s.suggestAddress(root).address, null);
});

test('split rejects boundary assignments, crossing ranges and over 256 children without writes', t => {
  const s = fixture(t);
  const root = s.createSubnet(network()).id;
  const addressId = s.createAddress(reservation(root, '10.0.0.128')).id;
  const before = s.state();
  assert.throws(() => s.splitSubnet(root, 25), rejects(409, /boundary/));
  assert.deepEqual(s.state(), before);
  s.deleteAddress(addressId);
  s.createRange({ subnetId: root, start: '10.0.0.126', end: '10.0.0.129', kind: 'dhcp', label: '' });
  assert.throws(() => s.splitSubnet(root, 25), rejects(409, /crosses/));
  assert.equal(s.state().subnets.length, 1);
  const ipv6 = s.createSubnet(network('2001:db8::/32')).id;
  assert.throws(() => s.splitPreview(ipv6, 64), rejects(400, /256/));
  assert.throws(() => s.splitSubnet(ipv6, 31), rejects(400));
});

test('split reparents existing smaller children and reuses matching children', t => {
  const s = fixture(t);
  const root = s.createSubnet(network()).id;
  const nested = s.createSubnet(network('10.0.0.0/26', root)).id;
  const exact = s.createSubnet(network('10.0.0.128/25', root)).id;
  s.splitSubnet(root, 25);
  const subnets = s.state().subnets;
  const firstHalf = subnets.find(item => item.cidr === '10.0.0.0/25')!;
  assert.equal(subnets.find(item => item.id === nested)!.parentId, firstHalf.id);
  assert.equal(subnets.find(item => item.id === exact)!.parentId, root);
  assert.equal(subnets.length, 4);
});

test('manual allocations reject ranges, empty reservations, duplicates and mapped addresses', t => {
  const s = fixture(t);
  const root = s.createSubnet(network()).id;
  s.createRange({ subnetId: root, start: '10.0.0.10', end: '10.0.0.20', kind: 'dhcp', label: '' });
  assert.throws(() => s.createAddress(reservation(root, '10.0.0.15')), rejects(409));
  assert.throws(() => s.createAddress({ ...reservation(root, '10.0.0.1'), label: ' ' }), rejects(400));
  assert.throws(() => s.createAddress(reservation(root, '::ffff:10.0.0.1')), rejects(400));
  s.createAddress(reservation(root, '10.0.0.1'));
  assert.throws(() => s.createAddress(reservation(root, '10.0.0.1')), rejects(409));
  assert.throws(() => s.createRange({ subnetId: root, start: '10.0.0.1', end: '10.0.0.5', kind: 'reserved', label: '' }), rejects(409));
  assert.throws(() => s.createRange({ subnetId: root, start: '10.0.0.19', end: '10.0.0.30', kind: 'reserved', label: '' }), rejects(409));
  s.createSubnet(network('10.0.0.128/25', root));
  assert.throws(() => s.createRange({ subnetId: root, start: '10.0.0.100', end: '10.0.0.130', kind: 'reserved', label: '' }), rejects(409));
});

test('stale suggestions are rechecked across connections and inline device creation rolls back', t => {
  const directory = mkdtempSync(join(tmpdir(), 'ipam-test-'));
  const firstDb = openDatabase(join(directory, 'state.sqlite'));
  const secondDb = openDatabase(join(directory, 'state.sqlite'));
  t.after(() => { secondDb.close(); firstDb.close(); rmSync(directory, { recursive: true, force: true }); });
  const first = createStore(firstDb);
  const second = createStore(secondDb);
  const root = first.createSubnet(network('10.0.0.0/30')).id;
  const proposed = second.suggestAddress(root).address!;
  first.createAddress(reservation(root, proposed));
  const before = second.state();
  assert.throws(() => second.createAddress({ ...reservation(root, proposed), device: host('must roll back') }), rejects(409));
  assert.deepEqual(second.state(), before);
  assert.equal(second.suggestAddress(root).address, '10.0.0.2');
});

test('hosting rejects self and descendant cycles while allowing IP-less devices', t => {
  const s = fixture(t);
  const parent = s.createDevice(host('parent')).id;
  const child = s.createDevice(host('child', parent)).id;
  const leaf = s.createDevice(host('leaf', child)).id;
  assert.throws(() => s.updateDevice(parent, host('parent', parent)), rejects(409, /cycles/));
  assert.throws(() => s.updateDevice(parent, host('parent', leaf)), rejects(409, /cycles/));
  assert.throws(() => s.createDevice(host('missing parent', 999)), rejects(404));
  assert.equal(s.state().devices.find(item => item.id === parent)!.parentId, null);
  assert.equal(s.state().addresses.length, 0);
  assert.throws(() => s.deleteDevice(parent), rejects(409, /children/));
});

test('service endpoints distinguish protocols and IPs but reject wildcard and duplicate overlaps', t => {
  const s = fixture(t);
  const root = s.createSubnet(network()).id;
  const deviceId = s.createDevice(host()).id;
  s.createAddress({ ...reservation(root, '10.0.0.10'), deviceId });
  s.createAddress({ ...reservation(root, '10.0.0.11'), deviceId });
  s.createService(app(deviceId, [endpoint(8080, '10.0.0.10')]));
  s.createService(app(deviceId, [endpoint(8080, '10.0.0.11'), endpoint(8080, null, 'udp')]));
  assert.throws(() => s.createService(app(deviceId, [endpoint(8080)])), rejects(409));
  assert.throws(() => s.createService(app(deviceId, [endpoint(9000), endpoint(9000, '10.0.0.10')])), rejects(409));
  assert.throws(() => s.createService(app(deviceId, [endpoint(9000, '10.0.0.10'), endpoint(9000, '10.0.0.10')])), rejects(409));
  assert.throws(() => s.createService(app(deviceId, [endpoint(9000, '10.0.0.12')])), rejects(400, /assigned/));
  assert.equal(s.suggestPort(deviceId, 'tcp', 8080, 8081).port, 8081);
  assert.equal(s.suggestPort(deviceId, 'udp', 8080, 8080, '10.0.0.10').port, null);
  const other = s.createDevice(host('other')).id;
  s.createService(app(other, [endpoint(8080)]));
  assert.throws(() => s.createService({ ...app(other, []), url: 'javascript:alert(1)' }), rejects(400));
});

test('service updates replace endpoints atomically and cannot move bindings to another device', t => {
  const s = fixture(t);
  const root = s.createSubnet(network()).id;
  const deviceId = s.createDevice(host()).id;
  const other = s.createDevice(host('other')).id;
  s.createAddress({ ...reservation(root, '10.0.0.10'), deviceId });
  const id = s.createService(app(deviceId, [endpoint(80, '10.0.0.10')])).id;
  s.updateService(id, { ...app(deviceId, [endpoint(443, '10.0.0.10')]), url: 'https://example.test', notes: 'updated' });
  assert.equal(s.state().services[0]!.endpoints[0]!.port, 443);
  const before = s.state();
  assert.throws(() => s.updateService(id, app(other, [endpoint(443, '10.0.0.10')])), rejects(400));
  assert.deepEqual(s.state(), before);
  s.updateService(id, app(other, []));
  assert.equal(s.state().services[0]!.deviceId, other);
});

test('deletions preserve dependent records and subnet patches cannot move networks', t => {
  const s = fixture(t);
  const data = network();
  const root = s.createSubnet(data).id;
  const deviceId = s.createDevice(host()).id;
  const addressId = s.createAddress({ ...reservation(root, '10.0.0.10'), deviceId }).id;
  const serviceId = s.createService(app(deviceId, [endpoint(80, '10.0.0.10')])).id;
  assert.throws(() => s.deleteSubnet(root), rejects(409, /non-empty/));
  assert.throws(() => s.deleteDevice(deviceId), rejects(409));
  assert.throws(() => s.deleteAddress(addressId), rejects(409, /bound/));
  assert.throws(() => s.updateSubnet(root, { ...data, cidr: '10.1.0.0/24' }), rejects(400, /cannot be changed/));
  s.updateSubnet(root, { ...data, name: 'renamed', vlanId: 20, notes: 'metadata' });
  assert.equal(s.state().subnets[0]!.name, 'renamed');
  s.deleteService(serviceId);
  s.deleteAddress(addressId);
  s.deleteDevice(deviceId);
  s.deleteSubnet(root);
  assert.deepEqual(s.state(), { subnets: [], devices: [], addresses: [], ranges: [], services: [] });
  assert.throws(() => s.deleteAddress(addressId), rejects(404));
});

test('reservations become assignments in place; bound updates and inline conflicts roll back', t => {
  const s = fixture(t);
  const root = s.createSubnet(network()).id;
  const id = s.createAddress(reservation(root, '10.0.0.10')).id;
  assert.deepEqual(s.updateAddress(id, { ...reservation(root, '10.0.0.10'), device: host('new host'), notes: 'assigned' }), { id });
  const assigned = s.state().addresses.find(item => item.id === id)!;
  assert.equal(s.state().devices.find(item => item.id === assigned.deviceId)!.name, 'new host');
  assert.equal(assigned.notes, 'assigned');
  const deviceId = assigned.deviceId!;
  s.createService(app(deviceId, [endpoint(443, assigned.address)]));
  s.updateAddress(id, { ...reservation(root, assigned.address), deviceId, label: 'corrected', notes: 'changed notes' });
  assert.equal(s.state().addresses.find(item => item.id === id)!.label, 'corrected');
  const before = s.state();
  assert.throws(() => s.updateAddress(id, { ...reservation(root, '10.0.0.11'), deviceId }), rejects(409, /bound/));
  assert.throws(() => s.updateAddress(id, { ...reservation(root, assigned.address), device: host('rolled back') }), rejects(409, /bound/));
  assert.deepEqual(s.state(), before);
  s.createAddress(reservation(root, '10.0.0.11'));
  const another = s.createAddress(reservation(root, '10.0.0.12')).id;
  const beforeDuplicate = s.state();
  assert.throws(() => s.updateAddress(another, { ...reservation(root, '10.0.0.11'), device: host('also rolled back') }), rejects(409));
  assert.deepEqual(s.state(), beforeDuplicate);
  assert.throws(() => s.updateAddress(999, reservation(root, '10.0.0.20')), rejects(404));
});
