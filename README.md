# NIP-46 NostrConnect Demo

A minimal, standalone reference implementation of [NIP-46](https://github.com/nostr-protocol/nips/blob/master/46.md) (Nostr Connect) — the protocol for pairing with remote signers like Clave, Amber, Primal, or any bunker-compatible app.



## What is NIP-46?

NIP-46 defines a protocol for remote signing. Instead of managing private keys in the browser, your app generates an ephemeral keypair and delegates all cryptographic operations (signing, encryption, decryption) to a remote "bunker" — a signer app running on your phone or server.

The flow is:

1. **App generates an ephemeral keypair** (client secret + client pubkey)
2. **App builds a `nostrconnect://` URI** containing the client pubkey, relay URLs, a random pairing secret, and requested permissions
3. **App shows the URI as a QR code** (or deep link on mobile)
4. **User scans with their signer app** (Clave, Amber, Primal, etc.)
5. **Signer responds** by publishing an encrypted kind 24133 event to the relay, echoing the secret
6. **App detects the response**, decrypts it, and the pairing is complete
7. **All subsequent RPCs** (get_public_key, sign_event, nip44_encrypt, nip44_decrypt) go through encrypted kind 24133 events over the relay

## Architecture

```
┌─────────────────┐        relay         ┌─────────────────┐
│   Your App       │ ◄── kind 24133 ──► │  Signer (Bunker) │
│  (this code)     │   encrypted NIP-44   │  (Clave/Primal) │
└─────────────────┘                      └─────────────────┘
     │
     ├── startNdkConnect()   → generates URI, waits for pairing
     ├── NdkNostrSigner      → handles all post-pairing RPCs
     ├── remoteRequest()     → send encrypted JSON-RPC over kind 24133
     └── Session persistence → save/restore to localStorage
```

## The NDK sendRequest Bug (and Our Fix)

The official `@nostr-dev-kit/ndk` library has a bug in its `NDKNip46Signer.sendRequest()` method: it uses an incorrect filter to subscribe for bunker responses, causing responses to be silently dropped. The subscription filters on `authors: [undefined]` instead of the actual bunker pubkey.

**Our fix:** We bypass NDK's `sendRequest` entirely. The `NdkNostrSigner` class uses `nostr-tools`' `SimplePool` directly to:

1. Subscribe with the correct filter: `kinds: [24133], authors: [bunkerPubkey], #p: [clientPubkey]`
2. Maintain a pending request map keyed by request ID
3. Use a completer pattern: `remoteRequest()` returns a promise that resolves when `onEvent()` matches the response ID

This mirrors the NDK Dart implementation exactly and works reliably with all signer implementations.

## Quick Start

```bash
# Install dependencies
bun install

# Run dev server
bun run dev

# Build for production
bun run build
```

Open the app, click "Connect Signer", and scan the QR code with your signer app.

## Using NdkNostrSigner in Your Own App

### 1. Install dependencies

```bash
bun add nostr-tools @noble/hashes
```

### 2. Copy `src/lib/ndk-signer.ts` into your project

This file is fully self-contained — no other dependencies beyond `nostr-tools` and `@noble/hashes`.

### 3. Start a pairing flow

```typescript
import { startNdkConnect } from "./lib/ndk-signer";

const handle = startNdkConnect({
  relays: [
    "wss://relay.powr.build",
    "wss://relay.primal.net",
    "wss://relay.nip46.com",
    "wss://nos.lol",
  ],
  perms: "get_public_key,nip44_encrypt,nip44_decrypt,sign_event:0,sign_event:1",
  metadata: {
    name: "My App",
    url: "https://myapp.example.com",
  },
});

// Show this URI as a QR code for the user to scan
console.log("Pairing URI:", handle.uri);

// Wait for pairing to complete
const signer = await handle.ready;
const pubkey = await signer.getPublicKey();
console.log("Connected as:", pubkey);
```

### 4. Use the signer

```typescript
// Sign an event
const signed = await signer.signEvent({
  kind: 1,
  content: "Hello Nostr!",
  tags: [],
  created_at: Math.floor(Date.now() / 1000),
});

// Encrypt/decrypt (NIP-44)
const ciphertext = await signer.nip44Encrypt(recipientPubkey, "secret message");
const plaintext = await signer.nip44Decrypt(recipientPubkey, ciphertext);

// Ping the bunker
const result = await signer.ping();
```

### 5. Session persistence

Save the session to restore without re-pairing:

```typescript
// Save
const data = signer.serialize();
localStorage.setItem("my-session", JSON.stringify(data));

// Restore
import { hexToBytes } from "@noble/hashes/utils";
import { NdkNostrSigner } from "./lib/ndk-signer";

const saved = JSON.parse(localStorage.getItem("my-session")!);
const signer = new NdkNostrSigner({
  clientSecretKey: hexToBytes(saved.clientSecretKey),
  bunkerPubkey: saved.bunkerPubkey,
  relays: saved.relays,
  userPubkey: saved.userPubkey,
});
// signer starts listening for RPC responses immediately
```

## API Reference

### `startNdkConnect(opts)`

Starts the client-initiated nostrconnect:// pairing flow.

- `opts.relays` — Array of relay URLs to use
- `opts.perms` — Comma-separated permissions to request
- `opts.metadata` — App metadata shown in the signer app
- `opts.pairTimeoutMs` — Timeout for pairing (default: 300000ms = 5 min)

Returns a `NdkConnectHandle`:
- `handle.uri` — The `nostrconnect://` URI to show as QR
- `handle.clientPubkey` — The ephemeral client public key
- `handle.cancel()` — Cancel the pairing
- `handle.ready` — Promise that resolves with `NdkNostrSigner` on success

### `NdkNostrSigner`

The post-pairing signer. Handles all RPCs.

- `getPublicKey()` → user's Nostr public key
- `signEvent(template)` → signed event
- `nip44Encrypt(pubkey, plaintext)` → ciphertext
- `nip44Decrypt(pubkey, ciphertext)` → plaintext
- `nip04Encrypt(pubkey, plaintext)` → ciphertext (NIP-04)
- `nip04Decrypt(pubkey, ciphertext)` → plaintext (NIP-04)
- `ping()` → "pong"
- `serialize()` → JSON-serializable session data
- `close()` → cleanup subscriptions and reject pending requests

## Relay Selection

The default relays cover all major signer implementations:

| Relay | Notes |
|-------|-------|
| `wss://relay.powr.build` | Clave signer's pinned relay |
| `wss://relay.primal.net` | Primal's relay (server monitors it) |
| `wss://relay.nip46.com` | Dedicated NIP-46 relay |
| `wss://nos.lol` | Reliable public relay |

For production, include multiple relays for redundancy. The app subscribes to all of them simultaneously.

## License

MIT
