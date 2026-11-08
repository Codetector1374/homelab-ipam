export type DeviceType = 'physical' | 'vm' | 'lxc' | 'iot' | 'container' | 'other';
export interface Subnet { id: number; name: string; cidr: string; parentId: number | null; vlanId: number | null; notes: string }
export interface Device { id: number; name: string; type: DeviceType; parentId: number | null; notes: string }
export interface Address { id: number; subnetId: number; address: string; deviceId: number | null; label: string; notes: string }
export interface AddressRange { id: number; subnetId: number; start: string; end: string; kind: 'dhcp' | 'reserved'; label: string }
export interface Endpoint { id: number; serviceId: number; protocol: 'tcp' | 'udp'; port: number; bindAddress: string | null; containerPort: number | null }
export interface Service { id: number; deviceId: number; name: string; url: string; notes: string; endpoints: Endpoint[] }
export interface State { subnets: Subnet[]; devices: Device[]; addresses: Address[]; ranges: AddressRange[]; services: Service[] }
export type SubnetInput = Omit<Subnet, 'id'>;
export type DeviceInput = Omit<Device, 'id'>;
export type AddressInput = Omit<Address, 'id'> & { device?: DeviceInput };
export type RangeInput = Omit<AddressRange, 'id'>;
export type EndpointInput = Omit<Endpoint, 'id' | 'serviceId'>;
export type ServiceInput = Omit<Service, 'id' | 'endpoints'> & { endpoints: EndpointInput[] };
export interface SubnetPreview { cidr: string; addresses: Address[]; ranges: AddressRange[] }
export interface SplitPreview { children: { cidr: string; addressCount: number; rangeCount: number }[] }
export interface Session { authenticated: boolean; mode: 'development' | 'oidc'; user: { name: string; email?: string } | null }
// API: GET /api/state -> State; GET /api/session -> Session (public).
// POST /api/{subnets,devices,addresses,ranges,services} with corresponding Input -> {id}.
// PATCH /api/{subnets,devices,addresses,services}/:id with FULL corresponding Input -> {id}.
// DELETE /api/{subnets,devices,addresses,ranges,services}/:id -> {ok:true}.
// POST /api/subnets/preview with SubnetInput -> SubnetPreview (no writes).
// POST /api/subnets/:id/split-preview or /split with {prefixLength:number} -> SplitPreview.
// GET /api/suggestions/address?subnetId=N -> {address:string|null}.
// GET /api/suggestions/port?deviceId=N&protocol=tcp&start=8000&end=8999[&bindAddress=IP] -> {port:number|null}.
// GET /api/export -> State as JSON attachment. Errors: {error:string}, status 400/404/409.
// POST /auth/logout; GET /auth/login; GET /auth/callback. All mutations require same-origin Origin.
