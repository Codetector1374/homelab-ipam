import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, AppBar, Autocomplete, Avatar, Box, Breadcrumbs, Button, Card, CardContent, Chip, CircularProgress, Container, Divider, LinearProgress, Link, List, ListItemButton, ListItemText, Paper, Stack, Table, TableBody, TableCell, TableContainer, TableHead, TableRow, TextField, Toolbar, Typography } from '@mui/material';
import type { Device, Service, Session, State, Subnet } from '../shared/types';
import { api, errorMessage } from './api';
import { ResourceDialog, type Modal, typeLabels } from './dialogs';

type View = 'networks' | 'devices';
type Selection = { view: View; id?: number };
type SearchResult = { key: string; label: string; detail: string; text: string; view: View; id: number };
function readSelection(): Selection {
  const [view, id] = window.location.hash.replace(/^#\/?/, '').split('/');
  const value = Number(id);
  return { view: view === 'devices' ? 'devices' : 'networks', ...(id && Number.isInteger(value) && value > 0 ? { id: value } : {}) };
}
function lineage<T extends { id: number; parentId: number | null }>(items: T[], selected: T): T[] {
  const chain = [selected]; const visited = new Set([selected.id]); let current = selected;
  while (current.parentId !== null) {
    const parent = items.find(item => item.id === current.parentId);
    if (!parent || visited.has(parent.id)) break;
    visited.add(parent.id); chain.unshift(parent); current = parent;
  }
  return chain;
}
function treeRows<T extends { id: number; parentId: number | null; name: string }>(items: T[]): { item: T; depth: number }[] {
  const output: { item: T; depth: number }[] = []; const visited = new Set<number>();
  const visit = (item: T, depth: number) => { if (visited.has(item.id)) return; visited.add(item.id); output.push({ item, depth }); items.filter(child => child.parentId === item.id).sort((a, b) => a.name.localeCompare(b.name)).forEach(child => visit(child, depth + 1)); };
  items.filter(item => item.parentId === null || !items.some(parent => parent.id === item.parentId)).sort((a, b) => a.name.localeCompare(b.name)).forEach(item => visit(item, 0));
  items.forEach(item => visit(item, 0));
  return output;
}
function isSafeUrl(value: string) { try { return ['http:', 'https:'].includes(new URL(value).protocol); } catch { return false; } }
function Empty({ title, detail, action }: { title: string; detail: string; action?: ReactNode }) {
  return <Box sx={{ p: { xs: 3, md: 5 }, textAlign: 'center' }}><Box className="empty-symbol" aria-hidden="true">—</Box><Typography variant="h6" sx={{ mt: 2, mb: 1 }}>{title}</Typography><Typography color="text.secondary" sx={{ maxWidth: 420, mx: 'auto', mb: action ? 3 : 0 }}>{detail}</Typography>{action}</Box>;
}
function Section({ title, description, action, children }: { title: string; description?: string; action?: ReactNode; children: ReactNode }) {
  return <Card><Box sx={{ p: 2.5, display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 1 }}><Box><Typography variant="h6" sx={{ fontSize: '1rem' }}>{title}</Typography>{description && <Typography variant="body2" color="text.secondary" sx={{ mt: .5 }}>{description}</Typography>}</Box>{action}</Box><Divider />{children}</Card>;
}
function Stat({ title, value, detail }: { title: string; value: number; detail: string }) {
  return <Card><CardContent sx={{ '&:last-child': { pb: 2.5 } }}><Typography variant="body2" color="text.secondary">{title}</Typography><Typography variant="h4" sx={{ mt: .5, mb: .5 }}>{value.toLocaleString()}</Typography><Typography variant="caption" color="text.secondary">{detail}</Typography></CardContent></Card>;
}

export default function App() {
  const client = useQueryClient();
  const session = useQuery({ queryKey: ['session'], queryFn: () => api<Session>('/api/session') });
  const stateQuery = useQuery({ queryKey: ['state'], queryFn: () => api<State>('/api/state'), enabled: session.data?.authenticated === true });
  const [selection, setSelection] = useState<Selection>(readSelection);
  const [modal, setModal] = useState<Modal | null>(null);
  const [search, setSearch] = useState('');
  const [logoutError, setLogoutError] = useState(''); const [loggingOut, setLoggingOut] = useState(false);
  useEffect(() => { const change = () => { setSelection(readSelection()); setModal(null); }; window.addEventListener('hashchange', change); return () => window.removeEventListener('hashchange', change); }, []);
  const navigate = (view: View, id?: number) => { const next = { view, id }; setSelection(next); window.location.hash = `${view}${id ? `/${id}` : ''}`; setSearch(''); };
  const state = stateQuery.data;
  const results = useMemo<SearchResult[]>(() => {
    if (!state || !search.trim()) return [];
    const needle = search.toLocaleLowerCase().trim(); const output: SearchResult[] = [];
    for (const subnet of state.subnets) output.push({ key: `n${subnet.id}`, label: subnet.name, detail: `Network · ${subnet.cidr}`, text: `${subnet.name} ${subnet.cidr} ${subnet.notes} ${subnet.vlanId ?? ''}`, view: 'networks', id: subnet.id });
    for (const device of state.devices) output.push({ key: `d${device.id}`, label: device.name, detail: `Device · ${typeLabels[device.type]}`, text: `${device.name} ${device.type} ${device.notes}`, view: 'devices', id: device.id });
    for (const address of state.addresses) {
      const subnet = state.subnets.find(s => s.id === address.subnetId); const device = state.devices.find(d => d.id === address.deviceId);
      output.push({ key: `a${address.id}`, label: address.address, detail: `${device?.name ?? 'Reservation'} · ${subnet?.name ?? 'Network'}`, text: `${address.address} ${address.label} ${address.notes} ${device?.name ?? ''} ${subnet?.name ?? ''}`, view: device ? 'devices' : 'networks', id: device?.id ?? address.subnetId });
    }
    for (const range of state.ranges) output.push({ key: `r${range.id}`, label: `${range.start} – ${range.end}`, detail: `${range.kind === 'dhcp' ? 'DHCP' : 'Reserved'} range · ${range.label}`, text: `${range.start} ${range.end} ${range.kind} ${range.label}`, view: 'networks', id: range.subnetId });
    for (const service of state.services) {
      const device = state.devices.find(d => d.id === service.deviceId);
      output.push({ key: `s${service.id}`, label: service.name, detail: `Service · ${device?.name ?? 'Device'} · ${service.endpoints.map(e => `${e.protocol}/${e.port}`).join(', ') || 'No ports'}`, text: `${service.name} ${service.url} ${service.notes} ${device?.name ?? ''} ${service.endpoints.map(e => `${e.port} ${e.protocol} ${e.bindAddress ?? ''} ${e.containerPort ?? ''}`).join(' ')}`, view: 'devices', id: service.deviceId });
    }
    return output.filter(result => result.text.toLocaleLowerCase().includes(needle));
  }, [state, search]);
  const logout = async () => {
    setLoggingOut(true); setLogoutError('');
    try { await api('/auth/logout', 'POST'); client.removeQueries({ queryKey: ['state'] }); await client.invalidateQueries({ queryKey: ['session'] }); setModal(null); } catch (e) { setLogoutError(errorMessage(e)); } finally { setLoggingOut(false); }
  };
  if (session.isPending) return <Box className="center-screen"><CircularProgress /><Typography color="text.secondary" sx={{ mt: 2 }}>Opening your workspace…</Typography></Box>;
  if (session.isError) return <Container maxWidth="sm" sx={{ py: 10 }}><Typography variant="h4" gutterBottom>Homelab IPAM</Typography><Alert severity="error">{errorMessage(session.error)}</Alert><Button onClick={() => void session.refetch()} sx={{ mt: 2 }}>Retry connection</Button></Container>;
  if (!session.data.authenticated) return <Box className="center-screen"><Paper variant="outlined" sx={{ p: { xs: 3, sm: 6 }, maxWidth: 480, mx: 2 }}><Typography className="eyebrow" color="primary">YOUR INFRASTRUCTURE, ORGANIZED</Typography><Typography variant="h4" sx={{ my: 2 }}>Homelab IPAM</Typography><Typography color="text.secondary" sx={{ mb: 4 }}>Keep your networks, devices, and services in one place. Sign in with your homelab identity to continue.</Typography><Button href="/auth/login" variant="contained" size="large" fullWidth>Sign in with Kanidm</Button></Paper></Box>;
  const subnet = state?.subnets.find(s => s.id === selection.id) ?? (selection.id === undefined ? state?.subnets[0] : undefined);
  const device = state?.devices.find(d => d.id === selection.id) ?? (selection.id === undefined ? state?.devices[0] : undefined);
  const open = (value: Modal) => setModal(value);
  return <Box className="app-shell"><Box component="aside" className="sidebar"><Box className="brand"><Box className="brand-mark" aria-hidden="true">H</Box><Box><Typography sx={{ fontWeight: 800, lineHeight: 1.3 }}>Homelab IPAM</Typography><Typography variant="caption" color="text.secondary">A place for every address</Typography></Box></Box><Typography className="nav-label">WORKSPACE</Typography><Box component="nav" aria-label="Main navigation" className="main-nav"><Button className={selection.view === 'networks' ? 'nav-button active' : 'nav-button'} onClick={() => navigate('networks')}><span className="nav-glyph" aria-hidden="true">▤</span>Networks{state && <span className="nav-count">{state.subnets.length}</span>}</Button><Button className={selection.view === 'devices' ? 'nav-button active' : 'nav-button'} onClick={() => navigate('devices')}><span className="nav-glyph" aria-hidden="true">▣</span>Devices{state && <span className="nav-count">{state.devices.length}</span>}</Button></Box><Box className="sidebar-bottom"><Box className="workspace-note"><Box className="status-dot" /><Typography variant="body2" sx={{ fontWeight: 600 }}>Your homelab, connected</Typography><Typography variant="caption" color="text.secondary">IPv4 & IPv6 · One source of truth</Typography></Box><Button component="a" href="/api/export" fullWidth variant="outlined" sx={{ mt: 2 }}>Export inventory JSON</Button></Box></Box><Box className="main-shell"><AppBar position="static" color="transparent" elevation={0} sx={{ borderBottom: '1px solid', borderColor: 'divider', bgcolor: 'background.paper' }}><Toolbar sx={{ gap: 2, flexWrap: { xs: 'wrap', sm: 'nowrap' }, py: 1.5 }}><Autocomplete<SearchResult> sx={{ width: '100%', maxWidth: 540 }} options={results} filterOptions={options => options} inputValue={search} onInputChange={(_, value) => setSearch(value)} value={null} onChange={(_, result) => { if (result) navigate(result.view, result.id); }} getOptionLabel={option => option.label} getOptionKey={option => option.key} noOptionsText={search ? 'No matching networks, devices, addresses, or services' : 'Search names, CIDRs, IPs, ports, or notes'} renderOption={(props, option) => { const { key, ...other } = props; return <li key={key} {...other}><Box><Typography variant="body2" sx={{ fontWeight: 600 }}>{option.label}</Typography><Typography variant="caption" color="text.secondary">{option.detail}</Typography></Box></li>; }} renderInput={params => <TextField {...params} label="Search your homelab" placeholder="Names, IPs, services, ports…" />} /><Box sx={{ flex: 1 }} /><Stack direction="row" spacing={1.5} alignItems="center" sx={{ flexShrink: 0 }}>{session.data.mode === 'development' ? <Chip label="Local development" color="primary" variant="outlined" /> : <><Avatar sx={{ width: 32, height: 32, fontSize: 14, bgcolor: '#e5f3ef', color: 'primary.main' }}>{(session.data.user?.name ?? 'U').slice(0, 1).toUpperCase()}</Avatar><Typography variant="body2">{session.data.user?.name ?? 'Signed in'}</Typography><Button size="small" onClick={logout} disabled={loggingOut}>Sign out</Button></>}</Stack></Toolbar></AppBar>{stateQuery.isFetching && <LinearProgress sx={{ height: 2 }} />}<Box component="main" className="workspace"><Box className="page-heading"><Box><Typography className="eyebrow" color="text.secondary">HOMELAB WORKSPACE</Typography><Typography variant="h4" sx={{ mt: .5 }}>{selection.view === 'networks' ? 'Networks' : 'Devices'}</Typography><Typography color="text.secondary" sx={{ mt: .75 }}>{selection.view === 'networks' ? 'An organized home for every IP address.' : 'Know what runs where, from host to container.'}</Typography></Box><Button variant="contained" size="large" disabled={!state} onClick={() => open(selection.view === 'networks' ? { kind: 'subnet' } : { kind: 'device' })}>+ Add {selection.view === 'networks' ? 'network' : 'device'}</Button></Box>{logoutError && <Alert severity="error" sx={{ mb: 2 }}>{logoutError}</Alert>}{stateQuery.isError && <Alert severity="error" sx={{ mb: 3 }} action={<Button color="inherit" onClick={() => void stateQuery.refetch()}>Retry</Button>}>{errorMessage(stateQuery.error)}</Alert>}{stateQuery.isPending && <Box sx={{ py: 8, textAlign: 'center' }}><CircularProgress /><Typography sx={{ mt: 2 }} color="text.secondary">Loading your infrastructure…</Typography></Box>}{state && <><Box className="stats-grid"><Stat title="Networks" value={state.subnets.length} detail={`${state.subnets.filter(s => s.parentId === null).length} root networks`} /><Stat title="Devices" value={state.devices.length} detail={`${state.devices.filter(d => d.parentId !== null).length} hosted devices`} /><Stat title="IP assignments" value={state.addresses.length} detail={`${state.addresses.filter(a => a.deviceId === null).length} reservations`} /><Stat title="Services" value={state.services.length} detail={`${state.services.reduce((n, s) => n + s.endpoints.length, 0)} allocated endpoints`} /></Box>{selection.view === 'networks' ? <Box className="resource-grid"><Card className="resource-tree"><Box sx={{ p: 2.5 }}><Typography variant="subtitle2">Network directory</Typography><Typography variant="caption" color="text.secondary">Parent networks and child subnets</Typography></Box><Divider />{state.subnets.length ? <List disablePadding>{treeRows(state.subnets).map(({ item, depth }) => <ListItemButton key={item.id} selected={item.id === subnet?.id} onClick={() => navigate('networks', item.id)} sx={{ pl: 2 + Math.min(depth, 6) * 1.75, py: 1.5, borderBottom: '1px solid', borderColor: '#f0f3f6', '&.Mui-selected': { bgcolor: '#e9f4f1', borderRight: '3px solid #087f75' } }}><ListItemText primary={item.name} secondary={item.cidr} primaryTypographyProps={{ fontWeight: item.id === subnet?.id ? 700 : 550, fontSize: 14 }} secondaryTypographyProps={{ className: 'mono', fontSize: 11 }} /><Chip label={item.cidr.includes(':') ? 'v6' : 'v4'} size="small" variant="outlined" sx={{ ml: 1, height: 21, fontSize: 10 }} /></ListItemButton>)}</List> : <Box sx={{ p: 3 }}><Typography variant="body2" color="text.secondary">Your networks will appear here.</Typography></Box>}</Card><Stack spacing={3}>{subnet ? <NetworkDetail subnet={subnet} state={state} open={open} navigate={navigate} /> : <Card><Empty title={state.subnets.length ? 'Select a network' : 'Start with your first network'} detail={state.subnets.length ? 'Choose a network from the directory to manage its addresses and child subnets.' : 'Add an IPv4 or IPv6 network, then organize subnets, assignments, and DHCP pools without losing track of parent space.'} action={<Button variant="contained" onClick={() => open({ kind: 'subnet' })}>+ Add network</Button>} /></Card>}</Stack></Box> : <Box className="resource-grid"><Card className="resource-tree"><Box sx={{ p: 2.5 }}><Typography variant="subtitle2">Device directory</Typography><Typography variant="caption" color="text.secondary">Physical hosts and everything inside</Typography></Box><Divider />{state.devices.length ? <List disablePadding>{treeRows(state.devices).map(({ item, depth }) => <ListItemButton key={item.id} selected={item.id === device?.id} onClick={() => navigate('devices', item.id)} sx={{ pl: 2 + Math.min(depth, 6) * 1.75, py: 1.4, borderBottom: '1px solid', borderColor: '#f0f3f6', '&.Mui-selected': { bgcolor: '#e9f4f1', borderRight: '3px solid #087f75' } }}><Avatar variant="rounded" sx={{ width: 30, height: 30, fontSize: 12, bgcolor: item.type === 'physical' ? '#e7edf4' : '#edf5f1', color: '#536b78', mr: 1.5 }}>{item.type === 'physical' ? 'PH' : item.type.toUpperCase().slice(0, 2)}</Avatar><ListItemText primary={item.name} secondary={typeLabels[item.type]} primaryTypographyProps={{ fontWeight: item.id === device?.id ? 700 : 550, fontSize: 14 }} secondaryTypographyProps={{ fontSize: 11 }} /></ListItemButton>)}</List> : <Box sx={{ p: 3 }}><Typography variant="body2" color="text.secondary">Your devices will appear here.</Typography></Box>}</Card><Stack spacing={3}>{device ? <DeviceDetail device={device} state={state} open={open} navigate={navigate} /> : <Card><Empty title={state.devices.length ? 'Select a device' : 'Meet your infrastructure'} detail={state.devices.length ? 'Choose a device to see its addresses, hosted children, and services.' : 'Add a server, virtual machine, container, or IoT device. Connect hosted devices to see what runs where.'} action={<Button variant="contained" onClick={() => open({ kind: 'device' })}>+ Add device</Button>} /></Card>}</Stack></Box>}<Box className="workspace-footer"><Typography variant="caption" color="text.secondary">Homelab IPAM · Simple infrastructure, clearly mapped.</Typography><Link href="/api/export" variant="caption" underline="hover">Download inventory JSON</Link></Box></> }</Box></Box>{modal && state && <ResourceDialog modal={modal} state={state} close={() => setModal(null)} saved={(kind, id) => { const deleting = modal.kind === 'delete'; setModal(null); if (kind === 'subnet' && id) navigate('networks', id); else if (kind === 'device' && id) navigate('devices', id); else if (deleting && ((modal.resource === 'subnets' && subnet?.id === modal.id) || (modal.resource === 'devices' && device?.id === modal.id))) navigate(selection.view); }} />}</Box>;
}
interface DetailProps { state: State; open: (modal: Modal) => void; navigate: (view: View, id?: number) => void }
function NetworkDetail({ subnet, state, open, navigate }: DetailProps & { subnet: Subnet }) {
  const children = state.subnets.filter(s => s.parentId === subnet.id); const addresses = state.addresses.filter(a => a.subnetId === subnet.id); const ranges = state.ranges.filter(r => r.subnetId === subnet.id);
  return <>
    <Card><CardContent sx={{ p: 3, '&:last-child': { pb: 3 } }}>
      <Breadcrumbs sx={{ mb: 2 }} aria-label="Network hierarchy">{lineage(state.subnets, subnet).map((item, index, chain) => index === chain.length - 1 ? <Typography variant="caption" key={item.id}>{item.name}</Typography> : <Link component="button" variant="caption" key={item.id} onClick={() => navigate('networks', item.id)}>{item.name}</Link>)}</Breadcrumbs>
      <Box className="detail-heading">
        <Box><Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 1 }}><Typography variant="h5">{subnet.name}</Typography><Chip label={subnet.cidr.includes(':') ? 'IPv6' : 'IPv4'} color="primary" variant="outlined" /></Stack><Typography className="mono" color="text.secondary">{subnet.cidr}</Typography></Box>
        <Stack direction="row" spacing={.5}><Button onClick={() => open({ kind: 'subnet', subnet })}>Edit</Button><Button color="error" onClick={() => open({ kind: 'delete', resource: 'subnets', id: subnet.id, name: subnet.name })}>Delete</Button></Stack>
      </Box>
      <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap sx={{ my: 2 }}><Chip label={subnet.vlanId === null ? 'No VLAN' : `VLAN ${subnet.vlanId}`} /><Chip label={`${children.length} child networks`} /><Chip label={`${addresses.length} direct assignments`} /></Stack>
      {subnet.notes && <Typography variant="body2" className="notes">{subnet.notes}</Typography>}
      <Divider sx={{ my: 2.5 }} />
      <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap><Button variant="contained" onClick={() => open({ kind: 'address', subnetId: subnet.id })}>+ Assign / reserve IP</Button><Button variant="outlined" onClick={() => open({ kind: 'subnet', parentId: subnet.id })}>Add child network</Button><Button variant="outlined" onClick={() => open({ kind: 'split', subnet })}>Split network</Button></Stack>
    </CardContent></Card>
    <Section title="Child networks" description="Subdivisions of this network. Each child manages its own address space." action={<Button size="small" onClick={() => open({ kind: 'subnet', parentId: subnet.id })}>+ Add child</Button>}>
      {children.length ? <List disablePadding>{children.map(child => <ListItemButton key={child.id} onClick={() => navigate('networks', child.id)} sx={{ px: 2.5, py: 1.5 }}><ListItemText primary={child.name} secondary={child.cidr} secondaryTypographyProps={{ className: 'mono' }} /><Typography color="text.secondary">View →</Typography></ListItemButton>)}</List> : <Box sx={{ p: 2.5 }}><Typography variant="body2" color="text.secondary">No child networks. Allocate directly here, add a child, or split the network.</Typography></Box>}
    </Section>
    <Section title="Direct IP assignments & reservations" description="Only addresses assigned directly to this network; child assignments live in their own subnet.">
      <TableContainer><Table size="small" aria-label="Direct IP assignments">
        <TableHead><TableRow><TableCell>IP address</TableCell><TableCell>Device / reservation</TableCell><TableCell>Label & notes</TableCell><TableCell align="right">Actions</TableCell></TableRow></TableHead>
        <TableBody>{addresses.map(address => {
          const device = state.devices.find(d => d.id === address.deviceId);
          return <TableRow key={address.id}>
            <TableCell className="mono" sx={{ whiteSpace: 'nowrap' }}>{address.address}</TableCell>
            <TableCell>{device ? <Link component="button" onClick={() => navigate('devices', device.id)}>{device.name}</Link> : <Chip label="Reserved" variant="outlined" />}</TableCell>
            <TableCell><Typography variant="body2">{address.label || '—'}</Typography>{address.notes && <Typography variant="caption" color="text.secondary" className="notes">{address.notes}</Typography>}</TableCell>
            <TableCell align="right">
              <Stack direction="row" justifyContent="flex-end" flexWrap="wrap">
                {!device && <Button size="small" onClick={() => open({ kind: 'address', address, convert: true })}>Assign to device</Button>}
                <Button size="small" aria-label={`Edit address ${address.address}`} onClick={() => open({ kind: 'address', address })}>Edit</Button>
                <Button color="error" size="small" aria-label={`Delete address ${address.address}`} onClick={() => open({ kind: 'delete', resource: 'addresses', id: address.id, name: address.address })}>Delete</Button>
              </Stack>
            </TableCell>
          </TableRow>;
        })}</TableBody>
      </Table></TableContainer>
      {!addresses.length && <Box sx={{ p: 3 }}><Typography variant="body2" color="text.secondary">No direct IP assignments yet. Use “Assign / reserve IP” to add one.</Typography></Box>}
      <Alert severity="info" icon={false} sx={{ m: 2 }}>Unassigned does not mean guaranteed free. Suggestions reflect IPAM records, not live network discovery. Large networks are never enumerated.</Alert>
    </Section>
    <Section title="DHCP & reserved ranges" description="Track pools and reservations without assigning every address individually." action={<Button size="small" onClick={() => open({ kind: 'range', subnetId: subnet.id })}>+ Add range</Button>}>
      {ranges.length ? <TableContainer><Table size="small" aria-label="Address ranges">
        <TableHead><TableRow><TableCell>Range</TableCell><TableCell>Type</TableCell><TableCell>Label</TableCell><TableCell align="right">Action</TableCell></TableRow></TableHead>
        <TableBody>{ranges.map(range => <TableRow key={range.id}><TableCell className="mono">{range.start}<br />– {range.end}</TableCell><TableCell><Chip label={range.kind === 'dhcp' ? 'DHCP' : 'Reserved'} variant="outlined" color={range.kind === 'dhcp' ? 'primary' : 'default'} /></TableCell><TableCell>{range.label || '—'}</TableCell><TableCell align="right"><Button color="error" size="small" onClick={() => open({ kind: 'delete', resource: 'ranges', id: range.id, name: `${range.start} – ${range.end}` })}>Delete</Button></TableCell></TableRow>)}</TableBody>
      </Table></TableContainer> : <Box sx={{ p: 2.5 }}><Typography variant="body2" color="text.secondary">No ranges yet. Add a DHCP pool or mark a block as reserved.</Typography></Box>}
    </Section>
  </>;
}
function DeviceDetail({ device, state, open, navigate }: DetailProps & { device: Device }) {
  const children = state.devices.filter(d => d.parentId === device.id); const addresses = state.addresses.filter(a => a.deviceId === device.id);
  const owners = state.devices.filter(d => lineage(state.devices, d).some(item => item.id === device.id));
  const groups = owners.map(owner => ({ owner, services: state.services.filter(service => service.deviceId === owner.id) })).filter(group => group.services.length);
  const parent = state.devices.find(d => d.id === device.parentId);
  return <>
    <Card><CardContent sx={{ p: 3, '&:last-child': { pb: 3 } }}>
      <Breadcrumbs aria-label="Device hosting hierarchy" sx={{ mb: 2 }}>{lineage(state.devices, device).map((item, index, chain) => index === chain.length - 1 ? <Typography variant="caption" key={item.id}>{item.name}</Typography> : <Link component="button" variant="caption" key={item.id} onClick={() => navigate('devices', item.id)}>{item.name}</Link>)}</Breadcrumbs>
      <Box className="detail-heading">
        <Box><Stack direction="row" spacing={1} alignItems="center"><Typography variant="h5">{device.name}</Typography><Chip label={typeLabels[device.type]} color="primary" variant="outlined" /></Stack><Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>{parent ? <>Hosted on <Link component="button" onClick={() => navigate('devices', parent.id)}>{parent.name}</Link></> : 'Standalone device · No hosting parent'}</Typography></Box>
        <Stack direction="row" spacing={.5}><Button onClick={() => open({ kind: 'device', device })}>Edit</Button><Button color="error" onClick={() => open({ kind: 'delete', resource: 'devices', id: device.id, name: device.name })}>Delete</Button></Stack>
      </Box>
      {device.notes && <Typography variant="body2" className="notes" sx={{ mt: 2 }}>{device.notes}</Typography>}
      <Divider sx={{ my: 2.5 }} />
      <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap><Button variant="contained" onClick={() => open({ kind: 'service', deviceId: device.id })}>+ Add service</Button><Button variant="outlined" disabled={!state.subnets.length} onClick={() => open({ kind: 'address', deviceId: device.id })}>Assign IP</Button><Button variant="outlined" onClick={() => open({ kind: 'device', parentId: device.id })}>Add hosted device</Button></Stack>
      {!state.subnets.length && <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 1 }}>Add a network before assigning IP addresses.</Typography>}
    </CardContent></Card>
    <Section title="IP addresses" description="Addresses assigned to this device.">
      {addresses.length ? <TableContainer><Table size="small" aria-label="Device IP addresses">
        <TableHead><TableRow><TableCell>IP address</TableCell><TableCell>Network</TableCell><TableCell>Label / notes</TableCell><TableCell align="right">Actions</TableCell></TableRow></TableHead>
        <TableBody>{addresses.map(address => {
          const subnet = state.subnets.find(s => s.id === address.subnetId);
          return <TableRow key={address.id}>
            <TableCell className="mono">{address.address}</TableCell>
            <TableCell><Link component="button" onClick={() => navigate('networks', address.subnetId)}>{subnet?.name ?? 'Network'}</Link></TableCell>
            <TableCell><Typography variant="body2">{address.label || '—'}</Typography>{address.notes && <Typography variant="caption" color="text.secondary" className="notes">{address.notes}</Typography>}</TableCell>
            <TableCell align="right"><Stack direction="row" justifyContent="flex-end"><Button size="small" onClick={() => open({ kind: 'address', address })}>Edit</Button><Button size="small" color="error" onClick={() => open({ kind: 'delete', resource: 'addresses', id: address.id, name: address.address })}>Delete</Button></Stack></TableCell>
          </TableRow>;
        })}</TableBody>
      </Table></TableContainer> : <Box sx={{ p: 2.5 }}><Typography variant="body2" color="text.secondary">No IP addresses assigned to this device.</Typography></Box>}
    </Section>
    <Section title="Hosted devices" description="Direct children. Open a child to explore its own devices and services." action={<Button size="small" onClick={() => open({ kind: 'device', parentId: device.id })}>+ Add hosted</Button>}>
      {children.length ? <List disablePadding>{children.map(child => <ListItemButton key={child.id} sx={{ px: 2.5 }} onClick={() => navigate('devices', child.id)}><ListItemText primary={child.name} secondary={typeLabels[child.type]} /><Typography color="text.secondary">View →</Typography></ListItemButton>)}</List> : <Box sx={{ p: 2.5 }}><Typography variant="body2" color="text.secondary">No hosted devices. Connect virtual machines or containers to this host.</Typography></Box>}
    </Section>
    <Section title="Services · What runs where" description="Services on this device and all descendants, grouped by the device that owns them." action={<Button size="small" onClick={() => open({ kind: 'service', deviceId: device.id })}>+ Add service</Button>}>
      {groups.length ? <Stack divider={<Divider />}>{groups.map(({ owner, services }) => <Box key={owner.id} sx={{ p: 2.5 }}>
        <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 2 }}><Link component="button" fontWeight={700} onClick={() => navigate('devices', owner.id)}>{owner.name}</Link><Chip label={owner.id === device.id ? 'This device' : typeLabels[owner.type]} variant="outlined" /><Typography variant="caption" color="text.secondary">{services.length} service{services.length === 1 ? '' : 's'}</Typography></Stack>
        {owner.id !== device.id && <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 1.5 }}>{lineage(state.devices, owner).map(d => d.name).join(' / ')}</Typography>}
        <Stack spacing={1.5}>{services.map(service => <ServiceCard key={service.id} service={service} open={open} />)}</Stack>
      </Box>)}</Stack> : <Empty title="No services yet" detail="Add the apps and daemons running here, with their ports, bind addresses, and container mappings." action={<Button variant="outlined" onClick={() => open({ kind: 'service', deviceId: device.id })}>+ Add service</Button>} />}
    </Section>
  </>;
}
function ServiceCard({ service, open }: { service: Service; open: (modal: Modal) => void }) {
  return <Box sx={{ p: 2, bgcolor: '#f7f9fb', border: '1px solid #e8edf1', borderRadius: 2 }}><Stack direction="row" justifyContent="space-between" alignItems="flex-start" spacing={1}><Box sx={{ minWidth: 0 }}><Typography variant="subtitle2">{service.name}</Typography>{service.url && (isSafeUrl(service.url) ? <Link href={service.url} target="_blank" rel="noopener noreferrer" variant="body2" sx={{ overflowWrap: 'anywhere' }}>{service.url} ↗</Link> : <Typography variant="body2" color="text.secondary" sx={{ overflowWrap: 'anywhere' }}>{service.url}</Typography>)}</Box><Stack direction="row" spacing={0}><Button size="small" onClick={() => open({ kind: 'service', deviceId: service.deviceId, service })}>Edit</Button><Button size="small" color="error" onClick={() => open({ kind: 'delete', resource: 'services', id: service.id, name: service.name })}>Delete</Button></Stack></Stack>{service.notes && <Typography variant="body2" color="text.secondary" className="notes" sx={{ mt: 1 }}>{service.notes}</Typography>}<Stack spacing={.75} sx={{ mt: 1.5 }}>{service.endpoints.length ? service.endpoints.map(endpoint => <Stack key={endpoint.id} direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap><Chip label={`${endpoint.protocol.toUpperCase()} ${endpoint.port}`} sx={{ bgcolor: '#e5efee', color: '#246a62', fontFamily: 'monospace' }} /><Typography variant="caption" className="mono" color="text.secondary">{endpoint.bindAddress ? `bind ${endpoint.bindAddress}` : 'all interfaces'}{endpoint.containerPort === null ? '' : ` → container ${endpoint.containerPort}`}</Typography></Stack>) : <Typography variant="caption" color="text.secondary">No endpoint ports configured.</Typography>}</Stack></Box>;
}
