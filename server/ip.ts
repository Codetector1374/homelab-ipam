import ipaddr from 'ipaddr.js';
import { invalid } from './errors.js';

export interface IP { address: string; value: bigint; version: 4 | 6; bits: number }
export interface Network extends IP { cidr: string; prefix: number; end: bigint }

export function parseAddress(input: string): IP {
  if (typeof input !== 'string' || input.includes('%') || !ipaddr.isValid(input)) invalid('Invalid IP address');
  const parsed = ipaddr.parse(input);
  if (parsed.kind() === 'ipv6' && (parsed as ipaddr.IPv6).isIPv4MappedAddress()) {
    invalid('IPv4-mapped IPv6 addresses are not supported; use an IPv4 address');
  }
  const version = parsed.kind() === 'ipv4' ? 4 : 6;
  const value = parsed.toByteArray().reduce((n, byte) => (n << 8n) | BigInt(byte), 0n);
  return { address: parsed.toString(), value, version, bits: version === 4 ? 32 : 128 };
}

export function formatAddress(value: bigint, version: 4 | 6): string {
  const length = version === 4 ? 4 : 16;
  const bytes = new Array<number>(length);
  for (let i = length - 1; i >= 0; i--) { bytes[i] = Number(value & 255n); value >>= 8n; }
  return ipaddr.fromByteArray(bytes).toString();
}

export function parseNetwork(input: string): Network {
  const parts = input.split('/');
  if (parts.length !== 2 || !/^\d+$/.test(parts[1]!)) invalid('CIDR must include a valid prefix length');
  const ip = parseAddress(parts[0]!);
  const prefix = Number(parts[1]);
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > ip.bits) invalid('Invalid CIDR prefix length');
  const size = 1n << BigInt(ip.bits - prefix);
  const value = (ip.value / size) * size;
  const address = formatAddress(value, ip.version);
  return { ...ip, value, address, prefix, cidr: `${address}/${prefix}`, end: value + size - 1n };
}

export function contains(network: Network, ip: IP): boolean {
  return network.version === ip.version && ip.value >= network.value && ip.value <= network.end;
}
export function overlaps(a: Network, b: Network): boolean {
  return a.version === b.version && a.value <= b.end && b.value <= a.end;
}
export function usable(network: Network, ip: IP): boolean {
  if (!contains(network, ip)) return false;
  if (network.version === 4 && network.prefix < 31) return ip.value > network.value && ip.value < network.end;
  if (network.version === 6 && network.prefix < 127) return ip.value > network.value;
  return true;
}
