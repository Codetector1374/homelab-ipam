import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Alert, Box, Button, Checkbox, Dialog, DialogActions, DialogContent, DialogTitle, Divider, FormControlLabel, MenuItem, Stack, TextField, Typography } from '@mui/material';
import type { Address, AddressInput, Device, DeviceInput, DeviceType, EndpointInput, Service, ServiceInput, SplitPreview, State, Subnet, SubnetInput, SubnetPreview } from '../shared/types';
import { api, errorMessage } from './api';

export type Modal =
  | { kind: 'subnet'; subnet?: Subnet; parentId?: number }
  | { kind: 'device'; device?: Device; parentId?: number }
  | { kind: 'address'; subnetId?: number; deviceId?: number; address?: Address; convert?: boolean }
  | { kind: 'range'; subnetId: number }
  | { kind: 'split'; subnet: Subnet }
  | { kind: 'service'; deviceId: number; service?: Service }
  | { kind: 'delete'; resource: string; id: number; name: string };
interface Common { state: State; close: () => void; saved: (kind?: string, id?: number) => void }
const deviceTypes: DeviceType[] = ['physical', 'vm', 'lxc', 'iot', 'container', 'other'];
const typeLabels: Record<DeviceType, string> = { physical: 'Physical server', vm: 'Virtual machine', lxc: 'LXC', iot: 'IoT', container: 'Container', other: 'Other' };
export { typeLabels };

function useOperation() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const run = async (action: () => Promise<void>) => {
    setBusy(true); setError('');
    try { await action(); } catch (e) { setError(errorMessage(e)); } finally { setBusy(false); }
  };
  return { busy, error, run, setError };
}
function useSave(saved: Common['saved']) {
  const client = useQueryClient();
  return async (path: string, method: string, body?: unknown, kind?: string) => {
    const result = await api<{ id?: number }>(path, method, body);
    await client.invalidateQueries({ queryKey: ['state'] });
    saved(kind, result.id);
  };
}
function FormDialog({ title, children, onSubmit, close, busy, error, action = 'Save', actions }: { title: string; children: ReactNode; onSubmit: () => void; close: () => void; busy: boolean; error: string; action?: string; actions?: ReactNode }) {
  const submit = (event: FormEvent) => { event.preventDefault(); if (!busy) onSubmit(); };
  return <Dialog open onClose={busy ? undefined : close} aria-labelledby="form-dialog-title"><Box component="form" onSubmit={submit}><DialogTitle id="form-dialog-title">{title}</DialogTitle><DialogContent><Stack spacing={2.5} sx={{ pt: 1 }}>{children}{error && <Alert severity="error" role="alert">{error}</Alert>}</Stack></DialogContent><DialogActions sx={{ px: 3, pb: 2.5 }}><Button onClick={close} disabled={busy}>Cancel</Button>{actions}<Button variant="contained" type="submit" disabled={busy}>{busy ? 'Working…' : action}</Button></DialogActions></Box></Dialog>;
}
function descendants<T extends { id: number; parentId: number | null }>(items: T[], id: number): Set<number> {
  const result = new Set([id]);
  let added = true;
  while (added) { added = false; for (const item of items) if (item.parentId !== null && result.has(item.parentId) && !result.has(item.id)) { result.add(item.id); added = true; } }
  return result;
}
function DeviceFields({ value, change, devices, excluded }: { value: DeviceInput; change: (value: DeviceInput) => void; devices: Device[]; excluded?: Set<number> }) {
  return <><TextField label="Device name" required value={value.name} onChange={e => change({ ...value, name: e.target.value })} autoFocus /><TextField select label="Device type" value={value.type} onChange={e => change({ ...value, type: e.target.value as DeviceType })}>{deviceTypes.map(type => <MenuItem key={type} value={type}>{typeLabels[type]}</MenuItem>)}</TextField><TextField select label="Hosted on" value={value.parentId ?? ''} onChange={e => change({ ...value, parentId: e.target.value === '' ? null : Number(e.target.value) })}><MenuItem value="">No parent / standalone</MenuItem>{devices.filter(d => !excluded?.has(d.id)).map(d => <MenuItem key={d.id} value={d.id}>{d.name}</MenuItem>)}</TextField><TextField label="Notes" multiline minRows={2} value={value.notes} onChange={e => change({ ...value, notes: e.target.value })} /></>;
}
function SubnetDialog({ state, close, saved, subnet, parentId }: Common & { subnet?: Subnet; parentId?: number }) {
  const [value, setValue] = useState<SubnetInput>(subnet ? { name: subnet.name, cidr: subnet.cidr, parentId: subnet.parentId, vlanId: subnet.vlanId, notes: subnet.notes } : { name: '', cidr: '', parentId: parentId ?? null, vlanId: null, notes: '' });
  const [preview, setPreview] = useState<SubnetPreview | null>(null);
  const op = useOperation(); const save = useSave(saved);
  const change = (next: SubnetInput) => { setValue(next); setPreview(null); };
  const submit = () => op.run(async () => {
    if (subnet) await save(`/api/subnets/${subnet.id}`, 'PATCH', value, 'subnet');
    else if (!preview) setPreview(await api<SubnetPreview>('/api/subnets/preview', 'POST', value));
    else await save('/api/subnets', 'POST', value, 'subnet');
  });
  const excluded = subnet ? descendants(state.subnets, subnet.id) : new Set<number>();
  return <FormDialog title={subnet ? 'Edit network' : 'Add network'} close={close} {...op} onSubmit={submit} action={subnet ? 'Save changes' : preview ? 'Confirm & create' : 'Preview network'}><TextField label="Network name" required autoFocus value={value.name} onChange={e => change({ ...value, name: e.target.value })} /><TextField label="CIDR" required value={value.cidr} helperText="IPv4 or IPv6, e.g. 192.168.10.0/24 or fd00::/64" onChange={e => change({ ...value, cidr: e.target.value })} /><TextField select label="Parent network" value={value.parentId ?? ''} onChange={e => change({ ...value, parentId: e.target.value === '' ? null : Number(e.target.value) })}><MenuItem value="">Root network</MenuItem>{state.subnets.filter(s => !excluded.has(s.id)).map(s => <MenuItem value={s.id} key={s.id}>{s.name} · {s.cidr}</MenuItem>)}</TextField><TextField label="VLAN ID (optional)" type="number" value={value.vlanId ?? ''} slotProps={{ htmlInput: { min: 1, max: 4094 } }} onChange={e => change({ ...value, vlanId: e.target.value === '' ? null : Number(e.target.value) })} /><TextField label="Notes" multiline minRows={2} value={value.notes} onChange={e => change({ ...value, notes: e.target.value })} />{preview && <Alert severity={preview.addresses.length || preview.ranges.length ? 'warning' : 'info'}><strong>{preview.cidr}</strong><br />{preview.addresses.length} address assignment(s) and {preview.ranges.length} range(s) will move into this network.{preview.addresses.map(a => <div key={a.id}>{a.address}{a.label ? ` — ${a.label}` : ''}</div>)}{preview.ranges.map(r => <div key={r.id}>{r.start} – {r.end} ({r.kind})</div>)}<br />Confirm to create this network.</Alert>}</FormDialog>;
}
function DeviceDialog({ state, close, saved, device, parentId }: Common & { device?: Device; parentId?: number }) {
  const [value, setValue] = useState<DeviceInput>(device ? { name: device.name, type: device.type, parentId: device.parentId, notes: device.notes } : { name: '', type: 'physical', parentId: parentId ?? null, notes: '' });
  const op = useOperation(); const save = useSave(saved);
  return <FormDialog title={device ? 'Edit device' : 'Add device'} close={close} {...op} onSubmit={() => op.run(() => save(device ? `/api/devices/${device.id}` : '/api/devices', device ? 'PATCH' : 'POST', value, 'device'))}><DeviceFields value={value} change={setValue} devices={state.devices} excluded={device ? descendants(state.devices, device.id) : undefined} /></FormDialog>;
}
function AddressDialog({ state, close, saved, subnetId, deviceId, address: existing, convert }: Common & { subnetId?: number; deviceId?: number; address?: Address; convert?: boolean }) {
  const [network, setNetwork] = useState(String(existing?.subnetId ?? subnetId ?? ''));
  const [address, setAddress] = useState(existing?.address ?? ''); const [label, setLabel] = useState(existing?.label ?? ''); const [notes, setNotes] = useState(existing?.notes ?? '');
  const [mode, setMode] = useState<'device' | 'reservation'>(existing && existing.deviceId === null && !convert ? 'reservation' : 'device');
  const [device, setDevice] = useState(String(existing?.deviceId ?? deviceId ?? ''));
  const [newDevice, setNewDevice] = useState<DeviceInput>({ name: '', type: 'physical', parentId: null, notes: '' });
  const [suggestion, setSuggestion] = useState(''); const op = useOperation(); const save = useSave(saved);
  const suggestionVersion = useRef(0);
  const [autoSuggesting, setAutoSuggesting] = useState(false);
  useEffect(() => {
    const version = ++suggestionVersion.current;
    if (existing || !network) return;
    setAutoSuggesting(true);
    op.setError('');
    void api<{ address: string | null }>(`/api/suggestions/address?subnetId=${network}`)
      .then(result => {
        if (version !== suggestionVersion.current) return;
        if (!result.address) {
          setSuggestion('No address could be suggested in the remaining direct space. You can enter an IP manually.');
          return;
        }
        setAddress(result.address);
        setSuggestion('Suggested address filled in. Review or override it, then save to allocate.');
      })
      .catch(error => {
        if (version === suggestionVersion.current) op.setError(errorMessage(error));
      })
      .finally(() => {
        if (version === suggestionVersion.current) setAutoSuggesting(false);
      });
    return () => { suggestionVersion.current++; };
  }, [network, existing?.id]);
  const submit = () => op.run(async () => {
    if (!network) throw new Error('Choose a network.');
    if (mode === 'device' && !device) throw new Error('Choose a device or create one inline.');
    const input: AddressInput = { subnetId: Number(network), address, deviceId: mode === 'reservation' || device === 'new' ? null : Number(device), label, notes, ...(mode === 'device' && device === 'new' ? { device: newDevice } : {}) };
    await save(existing ? `/api/addresses/${existing.id}` : '/api/addresses', existing ? 'PATCH' : 'POST', input);
  });
  const suggest = () => op.run(async () => {
    if (!network) throw new Error('Choose a network first.');
    const version = ++suggestionVersion.current;
    setAutoSuggesting(false);
    let result: { address: string | null };
    try {
      result = await api<{ address: string | null }>(`/api/suggestions/address?subnetId=${network}`);
    } catch (error) {
      if (version !== suggestionVersion.current) return;
      throw error;
    }
    if (version !== suggestionVersion.current) return;
    if (!result.address) throw new Error('No available address could be suggested in the remaining direct space.');
    setAddress(result.address); setSuggestion('Suggestion filled in. Review and save to allocate it.');
  });
  return (
    <FormDialog title={convert ? 'Assign reserved IP to a device' : existing ? 'Edit IP assignment' : 'Assign or reserve an IP'} close={close} {...op} onSubmit={submit} action={existing ? 'Save assignment' : mode === 'reservation' ? 'Reserve address' : 'Assign address'}>
      <TextField select required disabled={!!existing} label="Network / allocation space" value={network} onChange={e => { suggestionVersion.current++; setNetwork(e.target.value); setAddress(''); setSuggestion(''); setAutoSuggesting(false); op.setError(''); }}>
        {state.subnets.map(s => <MenuItem key={s.id} value={s.id}>{s.name} · {s.cidr}{state.subnets.some(c => c.parentId === s.id) ? ' — remaining parent space' : ''}</MenuItem>)}
      </TextField>
      <Typography variant="caption" color="text.secondary">A parent allocates only its remaining space. To allocate inside a child network, select that child explicitly.</Typography>
      <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1}>
        <TextField required disabled={!!existing} label="IP address" value={address} helperText={autoSuggesting ? 'Finding an unassigned address… You can also type one manually.' : undefined} onChange={e => { suggestionVersion.current++; setAutoSuggesting(false); setAddress(e.target.value); setSuggestion(''); }} />
        {!existing && <Button variant="outlined" sx={{ flexShrink: 0 }} onClick={suggest} disabled={op.busy || !network}>Suggest IP</Button>}
      </Stack>
      {suggestion && <Alert severity="info">{suggestion}</Alert>}
      <TextField select label="Allocation mode" value={mode} onChange={e => setMode(e.target.value as 'device' | 'reservation')}>
        <MenuItem value="device">Assign to device</MenuItem>
        <MenuItem value="reservation">Reserve without a device</MenuItem>
      </TextField>
      {mode === 'device' && <>
        <TextField select required label="Device" value={device} onChange={e => setDevice(e.target.value)}>
          <MenuItem value="" disabled>Choose a device</MenuItem>
          <MenuItem value="new">+ Create a new device inline</MenuItem>
          {state.devices.map(d => <MenuItem key={d.id} value={d.id}>{d.name}</MenuItem>)}
        </TextField>
        {device === 'new' && <Box sx={{ p: 2, bgcolor: 'background.default', borderRadius: 2 }}><Stack spacing={2}><Typography variant="subtitle2">New device</Typography><DeviceFields value={newDevice} change={setNewDevice} devices={state.devices} /></Stack></Box>}
      </>}
      <TextField label={mode === 'reservation' ? 'Reservation label' : 'Address label (optional)'} required={mode === 'reservation'} value={label} onChange={e => setLabel(e.target.value)} />
      <TextField label="Notes" multiline minRows={2} value={notes} onChange={e => setNotes(e.target.value)} />
    </FormDialog>
  );
}
function RangeDialog({ close, saved, subnetId }: Common & { subnetId: number }) {
  const [kind, setKind] = useState<'dhcp' | 'reserved'>('dhcp'); const [start, setStart] = useState(''); const [end, setEnd] = useState(''); const [label, setLabel] = useState('');
  const op = useOperation(); const save = useSave(saved);
  return <FormDialog title="Add address range" close={close} {...op} onSubmit={() => op.run(() => save('/api/ranges', 'POST', { subnetId, kind, start, end, label }))}><TextField select label="Range type" value={kind} onChange={e => setKind(e.target.value as 'dhcp' | 'reserved')}><MenuItem value="dhcp">DHCP pool</MenuItem><MenuItem value="reserved">Reserved range</MenuItem></TextField><TextField label="Start address" required autoFocus value={start} onChange={e => setStart(e.target.value)} /><TextField label="End address" required value={end} onChange={e => setEnd(e.target.value)} /><TextField label="Label" value={label} onChange={e => setLabel(e.target.value)} /><Alert severity="info">Both endpoints are inclusive. Ranges must fit the network's remaining direct space.</Alert></FormDialog>;
}
function SplitDialog({ close, saved, subnet }: Common & { subnet: Subnet }) {
  const original = Number(subnet.cidr.split('/')[1]);
  const [prefix, setPrefix] = useState(String(original + 1)); const [preview, setPreview] = useState<SplitPreview | null>(null);
  const op = useOperation(); const save = useSave(saved);
  return <FormDialog title={`Split ${subnet.name}`} close={close} {...op} action={preview ? 'Confirm split' : 'Preview split'} onSubmit={() => op.run(async () => { const body = { prefixLength: Number(prefix) }; if (!preview) setPreview(await api<SplitPreview>(`/api/subnets/${subnet.id}/split-preview`, 'POST', body)); else await save(`/api/subnets/${subnet.id}/split`, 'POST', body); })}><Typography color="text.secondary">Create equal-sized child networks under {subnet.cidr}. Existing assignments and ranges move to their matching child.</Typography><TextField label="New child prefix length" type="number" required value={prefix} slotProps={{ htmlInput: { min: original + 1, max: subnet.cidr.includes(':') ? 128 : 32 } }} onChange={e => { setPrefix(e.target.value); setPreview(null); }} />{preview && <><Alert severity="warning">Review {preview.children.length} child network(s), then confirm the split.</Alert><Box sx={{ maxHeight: 280, overflow: 'auto' }}>{preview.children.map(child => <Box key={child.cidr} sx={{ py: 1, borderBottom: '1px solid', borderColor: 'divider' }}><Typography className="mono">{child.cidr}</Typography><Typography variant="caption" color="text.secondary">{child.addressCount} addresses · {child.rangeCount} ranges</Typography></Box>)}</Box></>}</FormDialog>;
}
function ServiceDialog({ state, close, saved, deviceId, service }: Common & { deviceId: number; service?: Service }) {
  const [name, setName] = useState(service?.name ?? ''); const [url, setUrl] = useState(service?.url ?? ''); const [notes, setNotes] = useState(service?.notes ?? '');
  const [endpoints, setEndpoints] = useState<EndpointInput[]>(service?.endpoints.map(({ protocol, port, bindAddress, containerPort }) => ({ protocol, port, bindAddress, containerPort })) ?? [{ protocol: 'tcp', port: 8000, bindAddress: null, containerPort: null }]);
  const [start, setStart] = useState('8000'); const [end, setEnd] = useState('8999'); const [notice, setNotice] = useState('');
  const op = useOperation(); const save = useSave(saved);
  const update = (index: number, patch: Partial<EndpointInput>) => { setEndpoints(rows => rows.map((row, i) => i === index ? { ...row, ...patch } : row)); setNotice(''); };
  const suggest = (index: number) => op.run(async () => {
    const row = endpoints[index]; const minimum = Number(start); const maximum = Number(end);
    if (!Number.isInteger(minimum) || !Number.isInteger(maximum) || minimum < 1 || maximum > 65535 || minimum > maximum) throw new Error('Choose a valid suggestion range between 1 and 65535.');
    let cursor = minimum;
    while (cursor <= maximum) {
      const params = new URLSearchParams({ deviceId: String(deviceId), protocol: row.protocol, start: String(cursor), end: String(maximum) });
      if (row.bindAddress) params.set('bindAddress', row.bindAddress);
      const { port } = await api<{ port: number | null }>(`/api/suggestions/port?${params}`);
      if (port === null) throw new Error('No available port in this range. Try another range or enter a port manually.');
      const blocked = endpoints.some((other, i) => i !== index && other.protocol === row.protocol && other.port === port && (!other.bindAddress || !row.bindAddress || other.bindAddress === row.bindAddress));
      if (!blocked) { update(index, { port }); setNotice(`Suggested ${row.protocol.toUpperCase()} ${port} for endpoint ${index + 1}. Save to allocate it.`); return; }
      cursor = port + 1;
    }
    throw new Error('All suggested ports conflict with other endpoint rows. Try another range.');
  });
  const submit = () => op.run(async () => {
    if (!endpoints.length) throw new Error('Add at least one endpoint for this service.');
    for (let i = 0; i < endpoints.length; i++) for (let j = 0; j < i; j++) {
      const a = endpoints[i], b = endpoints[j];
      if (a.protocol === b.protocol && a.port === b.port && (!a.bindAddress || !b.bindAddress || a.bindAddress === b.bindAddress)) throw new Error(`Endpoint ${i + 1} conflicts with endpoint ${j + 1}. Change its port or bind address.`);
    }
    const body: ServiceInput = { deviceId, name, url, notes, endpoints };
    await save(service ? `/api/services/${service.id}` : '/api/services', service ? 'PATCH' : 'POST', body);
  });
  const owner = state.devices.find(d => d.id === deviceId);
  return <FormDialog title={service ? 'Edit service' : 'Add service'} close={close} {...op} onSubmit={submit}><Typography variant="body2" color="text.secondary">Runs on {owner?.name ?? 'selected device'}</Typography><TextField label="Service name" required autoFocus value={name} onChange={e => setName(e.target.value)} /><TextField label="URL (optional)" value={url} onChange={e => setUrl(e.target.value)} helperText="Only http:// and https:// URLs become clickable links." /><TextField label="Notes" multiline minRows={2} value={notes} onChange={e => setNotes(e.target.value)} /><Divider /><Typography variant="subtitle2">Port suggestions</Typography><Stack direction="row" spacing={2}><TextField label="Range start" type="number" required value={start} onChange={e => setStart(e.target.value)} slotProps={{ htmlInput: { min: 1, max: 65535 } }} /><TextField label="Range end" type="number" required value={end} onChange={e => setEnd(e.target.value)} slotProps={{ htmlInput: { min: 1, max: 65535 } }} /></Stack>{endpoints.map((row, index) => <Box key={index} sx={{ border: '1px solid', borderColor: 'divider', borderRadius: 2, p: 2 }}><Stack spacing={2}><Stack direction="row" justifyContent="space-between" alignItems="center"><Typography variant="subtitle2">Endpoint {index + 1}</Typography><Button size="small" color="error" onClick={() => setEndpoints(rows => rows.filter((_, i) => i !== index))}>Remove</Button></Stack><Stack direction="row" spacing={2}><TextField select label={`Protocol ${index + 1}`} value={row.protocol} onChange={e => update(index, { protocol: e.target.value as 'tcp' | 'udp' })}><MenuItem value="tcp">TCP</MenuItem><MenuItem value="udp">UDP</MenuItem></TextField><TextField type="number" required label={`Port ${index + 1}`} value={row.port || ''} slotProps={{ htmlInput: { min: 1, max: 65535 } }} onChange={e => update(index, { port: Number(e.target.value) })} /></Stack><TextField label={`Bind address ${index + 1} (optional)`} value={row.bindAddress ?? ''} onChange={e => update(index, { bindAddress: e.target.value || null })} helperText="Empty means all interfaces. Enter an IPv4 or IPv6 address to bind specifically." /><TextField type="number" label={`Container port ${index + 1} (optional)`} value={row.containerPort ?? ''} slotProps={{ htmlInput: { min: 1, max: 65535 } }} onChange={e => update(index, { containerPort: e.target.value === '' ? null : Number(e.target.value) })} /><Button variant="outlined" onClick={() => suggest(index)} disabled={op.busy}>Suggest port for endpoint {index + 1}</Button></Stack></Box>)}{notice && <Alert severity="info">{notice}</Alert>}<Button variant="outlined" onClick={() => setEndpoints(rows => [...rows, { protocol: 'tcp', port: 8000, bindAddress: null, containerPort: null }])}>Add endpoint</Button></FormDialog>;
}
function DeleteDialog({ close, saved, resource, id, name }: Common & { resource: string; id: number; name: string }) {
  const op = useOperation(); const save = useSave(saved); const [confirmed, setConfirmed] = useState(false);
  return <FormDialog title="Confirm deletion" close={close} {...op} action="Delete permanently" onSubmit={() => { if (confirmed) void op.run(() => save(`/api/${resource}/${id}`, 'DELETE')); else op.setError('Confirm the checkbox before deleting.'); }}><Typography>Delete <strong>{name}</strong>?</Typography><Alert severity="warning">This cannot be undone. Networks or devices with dependencies cannot be deleted; remove or move their contents first. Any backend conflict will be shown here.</Alert><FormControlLabel control={<Checkbox checked={confirmed} onChange={e => setConfirmed(e.target.checked)} />} label="I understand and want to delete this item" /></FormDialog>;
}
export function ResourceDialog({ modal, ...common }: Common & { modal: Modal }) {
  switch (modal.kind) {
    case 'subnet': return <SubnetDialog {...common} {...modal} />;
    case 'device': return <DeviceDialog {...common} {...modal} />;
    case 'address': return <AddressDialog {...common} {...modal} />;
    case 'range': return <RangeDialog {...common} {...modal} />;
    case 'split': return <SplitDialog {...common} {...modal} />;
    case 'service': return <ServiceDialog {...common} {...modal} />;
    case 'delete': return <DeleteDialog {...common} {...modal} />;
  }
}
