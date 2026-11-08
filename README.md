# Homelab IPAM

A small address and service inventory for a homelab. React + Material UI, a TypeScript/Fastify backend, and SQLite. One application container; no external database.

## Local development

Requires Node.js 24+ and npm. If SQLite has no prebuilt binary for your platform, installation also requires a C++ build toolchain.

```sh
npm ci
npm run dev
```

Open http://localhost:5173. The API listens on 127.0.0.1:3000 and the development database is `data/ipam.db`. Authentication is bypassed in development; keep these listeners local. No sample data is inserted into your inventory.

```sh
npm run typecheck
npm test
npm run build
```

To run the built application locally, including its frontend:

```sh
SERVE_WEB=true npm start
```

Environment variables are read from the process environment. `.env.example` documents them; the app does not automatically load `.env` files. Restart the backend after changing its environment.

## Workflows

- **Networks:** create a root subnet, optionally give it a VLAN label, then create children or split it into equal-sized subnets. Child creation and splitting preview where existing records will move before applying changes.
- **Assign IP:** select a subnet to get an automatic suggestion, or enter an address manually, then select a device or create one inline. Reserve an address with a label if the device does not exist yet; later use **Assign to device** to convert it without recreating the address.
- **Address ranges:** record DHCP pools and reserved blocks. These are excluded from assignment suggestions and manual device assignments.
- **Devices:** record physical hosts, VMs, LXC, IoT, and individually addressed containers. Use “Runs on” to describe hosting. Devices can have multiple addresses or none.
- **Services:** record software directly on a device or in Docker. Allocate TCP/UDP endpoints, optionally with a specific bind IP and a container-side port. A Docker mapping of 8080 → 80 allocates host port 8080.
- **Search:** find networks, devices, addresses, services, and documented ports. Device pages also show services on hosted descendants.
- **Export:** download inventory JSON. This is an inventory export, not a database restore format or a session backup.

### Allocation semantics

IPv4 and IPv6 are supported in one address space. Overlapping root networks and overlapping siblings are rejected; separate routing domains/VRFs are not modeled. A child owns its complete address range, so its parent can only allocate from remaining space. Select the child explicitly to allocate inside it.

IPv4 network/broadcast addresses are excluded for ordinary subnets; /31 and /32 are usable. IPv6 subnet-router anycast is excluded for prefixes shorter than /127. Suggestions skip occupied addresses, reservations, DHCP/reserved ranges, and child subnets without enumerating the whole subnet. IPv4-mapped IPv6 input is not a separate allocation namespace.

A suggestion does not reserve anything. Saving rechecks availability inside a database transaction. “Unassigned” means unrecorded here, not verified unused on your network. The application does not configure DHCP, DNS, interfaces, firewalls, or Docker, and does not scan the network.

Subdivision preserves addresses and device links by moving records into their new child subnet. A range crossing a new boundary, or an address becoming an unusable subnet boundary, must be resolved first. Splits are limited to 256 children per operation. CIDRs and parents are not editable in place; use subdivision for hierarchy changes.

Ports are scoped to device and protocol. Wildcard bindings conflict with specific-IP bindings on the same port/protocol; different specific IPs can reuse that port. Specific bind addresses must belong to that device. All authenticated users have the same inventory permissions.

## Kanidm authentication

Production uses OpenID Connect authorization-code flow with PKCE S256, nonce/state validation, and server-side SQLite sessions. Client secrets and provider tokens are not exposed to the browser. Local logout ends the application's session, not the user's Kanidm session.

Create a confidential Kanidm client and restrict its scope mapping to the people who should access the inventory:

```sh
kanidm system oauth2 create ipam "Homelab IPAM" https://ipam.example.com
kanidm system oauth2 add-redirect-url ipam https://ipam.example.com/auth/callback
kanidm system oauth2 update-scope-map ipam ipam_users openid profile email
kanidm system oauth2 show-basic-secret ipam
```

The `ipam_users` group must already exist and contain the appropriate users. Configure:

```sh
NODE_ENV=production
AUTH_MODE=oidc
PUBLIC_URL=https://ipam.example.com
OIDC_ISSUER=https://idm.example.com/oauth2/openid/ipam
OIDC_CLIENT_ID=ipam
OIDC_CLIENT_SECRET=<the basic secret>
DB_PATH=/data/ipam.db
HOST=0.0.0.0
PORT=3000
```

`OIDC_ISSUER` is the issuer URL, **not** the full `.well-known` discovery URL. Production requires HTTPS public/provider URLs and cannot enable the development bypass. Kanidm's normal ES256 signing and mandatory PKCE remain enabled. See the [Kanidm OAuth2 documentation](https://kanidm.github.io/kanidm/stable/integrations/oauth2.html).

The frontend and API must share one public origin. Unsafe requests require a matching `Origin` header; direct API tools must supply it too. Session cookies are HTTP-only, SameSite=Lax, and secure in production. Health endpoints are public and expose no inventory.

## Container and Kubernetes

See the [GitHub Actions publishing guide](docs/github-actions.md) to automatically build amd64 images, publish to GHCR, and configure Kubernetes pulls.

```sh
docker build -t homelab-ipam:local .
```

Use the manifests in `deploy/` as a starting configuration. Replace example hostnames, registry/image references, and secrets; choose your ingress class, TLS configuration, and storage class. Do not commit real secrets. The deployment expects the image to be pushed to a registry reachable by your cluster.

SQLite deployment invariants:

- One replica, `Recreate` upgrade strategy; brief upgrade downtime is intentional.
- A persistent `/data` volume with reliable POSIX locking, preferably block-backed. Do not use NFS or share the live database across nodes. WAL requires processes accessing a database to be on the same host.
- The pod must be able to write to its volume as its non-root UID/GID. Some storage provisioners need additional ownership configuration.
- Back up using SQLite's online backup API, or stop the application before taking a filesystem copy/snapshot. Copying only a running `.db` file can omit committed WAL data. Keep backups outside the application volume and verify restores.

`/health/live` checks the process and `/health/ready` checks database access. TLS terminates at the ingress. Keep the application's ClusterIP internal; authentication is handled by the application itself.

## Layout

- `web/`: React UI and forms.
- `shared/types.ts`: inventory and API contracts.
- `server/`: HTTP integration, allocation rules, SQLite, OIDC, behavioral tests.
- `deploy/`: Kubernetes examples.

## Changes

### Unreleased

- Publish linux/amd64 container images to GHCR through GitHub Actions; document registry access and Kubernetes configuration.

### 0.1.0

Initial implementation: hierarchical IPv4/IPv6 inventory, address suggestions/reservations and DHCP exclusions, device hosting, service endpoint allocation, search/export, Kanidm OIDC, and single-replica Kubernetes deployment.
