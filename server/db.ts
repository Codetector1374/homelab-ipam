import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export function openDatabase(path: string): Database.Database {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma('foreign_keys = ON');
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
  const version = db.pragma('user_version', { simple: true }) as number;
  if (version > 1) { db.close(); throw new Error('Database schema is newer than this application'); }
  if (version === 0) {
    db.transaction(() => {
      db.exec(`
        CREATE TABLE subnets (
          id INTEGER PRIMARY KEY, name TEXT NOT NULL, cidr TEXT NOT NULL UNIQUE,
          parentId INTEGER REFERENCES subnets(id) ON DELETE RESTRICT,
          vlanId INTEGER, notes TEXT NOT NULL DEFAULT ''
        );
        CREATE INDEX subnets_parent ON subnets(parentId);
        CREATE TABLE devices (
          id INTEGER PRIMARY KEY, name TEXT NOT NULL, type TEXT NOT NULL,
          parentId INTEGER REFERENCES devices(id) ON DELETE RESTRICT,
          notes TEXT NOT NULL DEFAULT ''
        );
        CREATE INDEX devices_parent ON devices(parentId);
        CREATE TABLE addresses (
          id INTEGER PRIMARY KEY, subnetId INTEGER NOT NULL REFERENCES subnets(id) ON DELETE RESTRICT,
          address TEXT NOT NULL UNIQUE, deviceId INTEGER REFERENCES devices(id) ON DELETE RESTRICT,
          label TEXT NOT NULL DEFAULT '', notes TEXT NOT NULL DEFAULT ''
        );
        CREATE INDEX addresses_subnet ON addresses(subnetId);
        CREATE INDEX addresses_device ON addresses(deviceId);
        CREATE TABLE ranges (
          id INTEGER PRIMARY KEY, subnetId INTEGER NOT NULL REFERENCES subnets(id) ON DELETE RESTRICT,
          start TEXT NOT NULL, end TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('dhcp', 'reserved')),
          label TEXT NOT NULL DEFAULT ''
        );
        CREATE INDEX ranges_subnet ON ranges(subnetId);
        CREATE TABLE services (
          id INTEGER PRIMARY KEY, deviceId INTEGER NOT NULL REFERENCES devices(id) ON DELETE RESTRICT,
          name TEXT NOT NULL, url TEXT NOT NULL DEFAULT '', notes TEXT NOT NULL DEFAULT ''
        );
        CREATE INDEX services_device ON services(deviceId);
        CREATE TABLE endpoints (
          id INTEGER PRIMARY KEY, serviceId INTEGER NOT NULL REFERENCES services(id) ON DELETE CASCADE,
          protocol TEXT NOT NULL CHECK(protocol IN ('tcp', 'udp')),
          port INTEGER NOT NULL CHECK(port BETWEEN 1 AND 65535), bindAddress TEXT,
          containerPort INTEGER CHECK(containerPort BETWEEN 1 AND 65535)
        );
        CREATE INDEX endpoints_service ON endpoints(serviceId);
        PRAGMA user_version = 1;
      `);
    }).immediate();
  }
  return db;
}
