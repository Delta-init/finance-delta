# Realtime (Socket.IO)

Realtime is for **live awareness**, not as a replacement for the REST API. The API is
the source of truth; sockets push deltas so open screens stay fresh.

## Connection & auth

- Client connects to the same origin as the API, namespace `/`.
- Auth handshake sends the **access token** (`auth: { token }`); the server verifies the
  JWT, resolves `userId` + `organizationId`, and joins rooms. Unauthenticated sockets are
  disconnected.

## Rooms

```
org:<organizationId>     # all members of an org (broad updates)
user:<userId>            # personal notifications
portal:<customerId>      # a logged-in client (scoped)
portal:<vendorId>        # a logged-in vendor (scoped)
```

Domain services emit **after a successful DB commit** via `lib/realtime/emit.ts` helpers —
never from controllers before the transaction settles.

## Event catalog

Event names: `<resource>:<action>`. Payloads are slim (id + changed fields + version);
clients refetch detail via REST if they need the full record.

```
# Notifications
notification:new            { id, type, title, body, refLink }

# Sales
invoice:created             { id, invoiceNumber, customerId, totalMinor, status }
invoice:updated             { id, status, balanceMinor }
invoice:viewed              { id }                 # client opened it (portal/email pixel)
payment:recorded            { invoiceId, paymentId, balanceMinor, status }
quote:status                { id, status }         # accepted/declined/expired

# Purchasing
bill:approval-requested     { id, vendorId, totalMinor, approverId }
bill:approved               { id }

# Expenses
expense:submitted           { id, submitterId, amountMinor }
expense:approved | :rejected{ id, approverId }

# Inventory (high-value realtime)
stock:changed               { itemId, warehouseId, quantity }
stock:low                   { itemId, sku, quantity, reorderPoint }   # alert

# Banking
bank:import-progress        { batchId, processed, total }
bank:transaction-matched    { id, match }

# Documents
document:created            { id, fileName, inboxStatus }
document:ocr-complete       { id, extracted }

# Reports / long jobs
report:ready                { jobId, reportType, downloadKey }
job:progress                { jobId, percent, label }

# Presence / collaboration (optional, Phase 2+)
presence:editing            { entity:{type,id}, userId }   # "Sara is editing this invoice"
```

## Client integration

- A single shared socket client in `apps/web/src/lib/socket.ts`.
- Hooks subscribe to the events a screen cares about and **invalidate the matching
  TanStack Query keys** (e.g. `invoice:updated` → `queryClient.invalidateQueries(['invoices'])`),
  so the cache and UI converge without bespoke reducers.
- `notification:new` feeds the topbar bell + a toast; persisted in the `notifications`
  collection so the bell survives reloads.

## Delivery guarantees

- Socket events are **best-effort**; the REST data is authoritative. On reconnect, the
  client refetches active queries (TanStack Query `refetchOnReconnect`), closing any gap.
- Critical user-facing notifications are **also** persisted (DB) so nothing is lost if a
  socket was down.

## Scaling

- For multiple API instances, add the **Socket.IO Redis adapter** so room broadcasts fan
  out across nodes. Single instance needs no adapter. (Redis is already in the stack for
  BullMQ.)
