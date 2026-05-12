/**
 * ndk-signer.ts
 *
 * NIP-46 signer for legion-chat.
 * Mirrors the NDK Dart implementation exactly:
 *   - Own relay subscription (SimplePool) to listen for bunker responses
 *   - Pending request map keyed by request ID
 *   - Completer pattern: remoteRequest() returns promise that resolves when
 *     onEvent() matches response ID
 *
 * Uses NDK's NDKNip46Signer ONLY for URI generation and initial pairing detection.
 * All post-pairing RPCs (getPublicKey, signEvent, encrypt, decrypt) go through
 * our own request/response pipeline — bypassing NDK's broken sendRequest entirely.
 */

import {
  generateSecretKey,
  getPublicKey,
  finalizeEvent,
} from "nostr-tools/pure";
import { SimplePool } from "nostr-tools";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils";
import {
  getConversationKey,
  encrypt as nip44Encrypt,
  decrypt as nip44Decrypt,
} from "nostr-tools/nip44";
import type { Event, EventTemplate } from "nostr-tools";

// ── Types ─────────────────────────────────────────────────────────────

export interface NdkConnectHandle {
  uri: string;
  clientPubkey: string;
  cancel: () => void;
  ready: Promise<NdkNostrSigner>;
}

// ── Helpers ───────────────────────────────────────────────────────────

function randomId(len = 16): string {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  let id = "";
  const arr = new Uint8Array(len);
  crypto.getRandomValues(arr);
  for (let i = 0; i < len; i++) id += chars[arr[i] % chars.length];
  return id;
}

function timeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`NIP-46 ${label} timed out (${ms / 1000}s)`)),
      ms,
    );
    promise.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); },
    );
  });
}

// ── Pending request (Completer pattern — mirrors Dart's Completer<String>) ──

interface PendingRequest {
  resolve: (result: string) => void;
  reject: (error: Error) => void;
  method: string;
  createdAt: number;
}

// ── NdkNostrSigner ────────────────────────────────────────────────────
//
// Mirrors NDK Dart's Nip46EventSigner exactly:
//   constructor → listenRelays() → onEvent() matches by response id → completer.complete()
//   remoteRequest() → create completer → encrypt → broadcast → return completer.future

export class NdkNostrSigner {
  // Connection state (mirrors Dart's BunkerConnection)
  private clientSecretKey: Uint8Array;  // local ephemeral secret
  private clientPubkey: string;         // local ephemeral pubkey (hex)
  private bunkerPubkey: string;         // remote bunker pubkey (hex)
  private relays: string[];

  // Pending requests (mirrors Dart's _pendingRequests map)
  private pending: Map<string, PendingRequest> = new Map();

  // Relay subscription (mirrors Dart's subscription field)
  private sub: ReturnType<SimplePool["subscribeMany"]> | null = null;
  private pool: SimplePool;

  // Cached user pubkey (from get_public_key response)
  private _userPubkey: string | null = null;

  constructor(opts: {
    clientSecretKey: Uint8Array;
    bunkerPubkey: string;
    relays: string[];
    userPubkey?: string;
  }) {
    this.clientSecretKey = opts.clientSecretKey;
    this.clientPubkey = getPublicKey(opts.clientSecretKey);
    this.bunkerPubkey = opts.bunkerPubkey;
    this.relays = opts.relays;
    this._userPubkey = opts.userPubkey ?? null;
    this.pool = new SimplePool();

    console.log("[NIP-46] NdkNostrSigner created:", {
      client: this.clientPubkey.slice(0, 12),
      bunker: this.bunkerPubkey.slice(0, 12),
      relays: this.relays,
    });

    // Start listening immediately — mirrors Dart's constructor calling listenRelays()
    this.listenRelays();
  }

  // ── listenRelays — mirrors Dart's listenRelays() exactly ──────────
  // Subscribes to bunker responses: kind 24133, authored by bunker, p-tagged to us
  private listenRelays() {
    console.log("[NIP-46] listenRelays: subscribing to bunker responses");
    this.sub = this.pool.subscribeMany(this.relays, {
      kinds: [24133],
      authors: [this.bunkerPubkey],
      "#p": [this.clientPubkey],
    } as any, {
      onevent: (event) => this.onEvent(event),
      oneose: () => console.log("[NIP-46] listenRelays: EOSE received"),
    });
  }

  // ── onEvent — mirrors Dart's onEvent() exactly ────────────────────
  // Decrypt response → match by id → resolve/reject pending completer
  private async onEvent(event: Event) {
    try {
      const conversationKey = getConversationKey(this.clientSecretKey, this.bunkerPubkey);
      const decrypted = nip44Decrypt(event.content, conversationKey);
      const response = JSON.parse(decrypted);

      console.log("[NIP-46] onEvent:", {
        id: response.id?.slice(0, 8),
        result: response.result?.slice?.(0, 40),
        error: response.error?.slice?.(0, 60),
        from: event.pubkey.slice(0, 12),
      });

      // Auth URL handling — mirrors Dart
      if (response.result === "auth_url") {
        console.log("[NIP-46] auth_url received, ignoring for now");
        return;
      }

      const entry = this.pending.get(response.id);
      if (!entry) {
      console.log("[NIP-46] no pending request for id:", response.id?.slice(0, 8),
        "pending:", Array.from(this.pending.keys()).map(k => k.slice(0, 8)));
        return;
      }

      this.pending.delete(response.id);

      if (response.error) {
        entry.reject(new Error(response.error));
      } else {
        entry.resolve(response.result);
      }
    } catch (e: any) {
      console.error("[NIP-46] onEvent error:", e.message);
    }
  }

  // ── remoteRequest — mirrors Dart's remoteRequest() exactly ────────
  // Create completer → encrypt request → broadcast → return completer.future
  async remoteRequest(method: string, params: string[] = []): Promise<string> {
    const id = randomId();

    // Build JSON-RPC request — mirrors Dart's BunkerRequest
    const request = { id, method, params };

    // Encrypt with NIP-44
    const conversationKey = getConversationKey(this.clientSecretKey, this.bunkerPubkey);
    const encrypted = nip44Encrypt(JSON.stringify(request), conversationKey);

    // Build kind 24133 event — mirrors Dart's requestEvent
    const template: EventTemplate = {
      kind: 24133,
      content: encrypted,
      tags: [["p", this.bunkerPubkey]],
      created_at: Math.floor(Date.now() / 1000),
    };
    const signed = finalizeEvent(template, this.clientSecretKey);

    console.log("[NIP-46] remoteRequest:", {
      id: id.slice(0, 8),
      method,
      params: params.length,
    });

    // Create completer — mirrors Dart's Completer<String>
    const promise = new Promise<string>((resolve, reject) => {
      this.pending.set(id, {
        resolve,
        reject,
        method,
        createdAt: Date.now(),
      });
    });

    // Broadcast — mirrors Dart's broadcast.broadcast()
    const publishResults = await Promise.allSettled(
      this.relays.map(r => this.pool.publish([r], signed)),
    );
    const published = publishResults.filter(r => r.status === "fulfilled").length;
    console.log("[NIP-46] published to", published + "/" + this.relays.length, "relays");

    // Return completer.future with 30s timeout — mirrors Dart's completer.future
    return timeout(promise, 30_000, method);
  }

  // ── Public API — mirrors Dart's Nip46EventSigner methods exactly ──

  async getPublicKey(): Promise<string> {
    if (this._userPubkey) return this._userPubkey;
    const pubkey = await this.remoteRequest("get_public_key");
    this._userPubkey = pubkey;
    console.log("[NIP-46] getPublicKey:", pubkey.slice(0, 16));
    return pubkey;
  }

  async signEvent(template: EventTemplate): Promise<Event> {
    // Mirrors Dart: send event as JSON, get back signed event JSON
    const eventMap = {
      kind: template.kind,
      content: template.content,
      tags: template.tags,
      created_at: template.created_at,
    };
    const signedJson = await this.remoteRequest("sign_event", [JSON.stringify(eventMap)]);
    return JSON.parse(signedJson) as Event;
  }

  async nip44Encrypt(recipientPubkey: string, plaintext: string): Promise<string> {
    return this.remoteRequest("nip44_encrypt", [recipientPubkey, plaintext]);
  }

  async nip44Decrypt(senderPubkey: string, ciphertext: string): Promise<string> {
    return this.remoteRequest("nip44_decrypt", [senderPubkey, ciphertext]);
  }

  async nip04Encrypt(recipientPubkey: string, plaintext: string): Promise<string> {
    return this.remoteRequest("nip04_encrypt", [recipientPubkey, plaintext]);
  }

  async nip04Decrypt(senderPubkey: string, ciphertext: string): Promise<string> {
    return this.remoteRequest("nip04_decrypt", [senderPubkey, ciphertext]);
  }

  async ping(): Promise<string> {
    return this.remoteRequest("ping");
  }

  get userPubkey(): string | null { return this._userPubkey; }
  get bunker(): string { return this.bunkerPubkey; }

  async getRealPubkey(): Promise<string | null> {
    try { return await this.getPublicKey(); }
    catch { return null; }
  }

  // Serialize session for persistence
  serialize(): { clientSecretKey: string; bunkerPubkey: string; relays: string[]; userPubkey?: string } {
    return {
      clientSecretKey: bytesToHex(this.clientSecretKey),
      bunkerPubkey: this.bunkerPubkey,
      relays: this.relays,
      userPubkey: this._userPubkey ?? undefined,
    };
  }

  close() {
    this.sub?.close();
    // Reject all pending requests
    this.pending.forEach((entry) => {
      entry.reject(new Error("Signer closed"));
    });
    this.pending.clear();
  }
}

// ── Start nostrconnect:// flow ─────────────────────────────────────────
//
// Two phases — mirrors Dart's Bunkers.connectWithNostrConnect + Accounts.loginWithBunkerConnection:
//   Phase 1: Subscribe for pairing response (secret echo or "ack")
//   Phase 2: Create NdkNostrSigner (which listens for RPC responses)

export function startNdkConnect(opts: {
  relays: string[];
  perms?: string;
  metadata?: {
    name?: string;
    url?: string;
    description?: string;
    image?: string;
  };
  onAuthChallenge?: (url: string) => void;
  pairTimeoutMs?: number;
}): NdkConnectHandle {
  const { relays, perms, metadata, pairTimeoutMs } = opts;

  // ── Generate local keypair + secret — mirrors Dart's NostrConnect ──
  const clientSecretKey = generateSecretKey();
  const clientPubkey = getPublicKey(clientSecretKey);
  const pairingSecret = randomId(16);

  // ── Build nostrconnect:// URI — mirrors Dart's nostrConnectURL ──
  const params: string[] = [];
  for (const relay of relays) {
    params.push(`relay=${encodeURIComponent(relay)}`);
  }
  params.push(`secret=${pairingSecret}`);
  if (perms) params.push(`perms=${encodeURIComponent(perms)}`);
  if (metadata?.name) params.push(`name=${encodeURIComponent(metadata.name)}`);
  if (metadata?.url) params.push(`url=${encodeURIComponent(metadata.url)}`);
  if (metadata?.image) params.push(`image=${encodeURIComponent(metadata.image)}`);

  const uri = `nostrconnect://${clientPubkey}?${params.join("&")}`;

  console.log("[NIP-46] URI:", uri);
  console.log("[NIP-46] client pubkey:", clientPubkey);
  console.log("[NIP-46] pairing secret:", pairingSecret);

  // ── Phase 1: Subscribe for pairing response ──
  // Mirrors Dart's Bunkers.connectWithNostrConnect():
  //   subscription = _requests.subscription(kinds: [24133], pTags: [clientPubkey])
  //   await for event where result === secret
  const pool = new SimplePool();
  let bunkerPubkey: string | null = null;

  const pairPromise = new Promise<string>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`Pairing timed out (${(pairTimeoutMs || 300_000) / 1000}s)`)),
      pairTimeoutMs || 300_000,
    );

    const sub = pool.subscribeMany(relays, {
      kinds: [24133],
      "#p": [clientPubkey],
    } as any, {
      onevent: async (event) => {
        try {
          // We don't know the bunker pubkey yet — try to decrypt from the event author
          const conversationKey = getConversationKey(clientSecretKey, event.pubkey);
          const decrypted = nip44Decrypt(event.content, conversationKey);
          const response = JSON.parse(decrypted);

          console.log("[NIP-46] pair response:", {
            id: response.id?.slice(0, 8),
            result: response.result?.slice?.(0, 30),
            from: event.pubkey.slice(0, 12),
          });

          // Dart: if (response["result"] == secret) → accept
          if (response.result === pairingSecret || response.result === "ack") {
            clearTimeout(timer);
            sub.close();
            bunkerPubkey = event.pubkey;
            console.log("[NIP-46] PAIRED with bunker:", event.pubkey.slice(0, 16));
            resolve(event.pubkey);
          }
        } catch (e: any) {
          // Can't decrypt from this author — not our bunker, ignore
        }
      },
    });
  });

  // ── Phase 2: After pairing, create signer and call getPublicKey ──
  // Mirrors Dart's Accounts.loginWithBunkerConnection():
  //   signer = bunkers.createSigner(connection)
  //   await signer.getPublicKeyAsync()
  //   loginExternalSigner(signer)

  let cancelled = false;
  const readyPromise = (async (): Promise<NdkNostrSigner> => {
    if (cancelled) throw new Error("Cancelled");

    // Wait for pairing
    const bunker = await pairPromise;
    if (cancelled) throw new Error("Cancelled");

    console.log("[NIP-46] creating NdkNostrSigner...");

    // Create signer — this starts listening for RPC responses immediately
    const signer = new NdkNostrSigner({
      clientSecretKey,
      bunkerPubkey: bunker,
      relays,
    });

    // Call getPublicKey — mirrors Dart's getPublicKeyAsync()
    try {
      const pubkey = await signer.getPublicKey();
      console.log("[NIP-46] user pubkey:", pubkey.slice(0, 16));
    } catch (e: any) {
      console.warn("[NIP-46] getPublicKey failed:", e.message);
      // Some signers (Primal with non-Full trust) may reject get_public_key
      // Fall back to bunker pubkey — mirrors our previous fallback behavior
      (signer as any)._userPubkey = bunker;
    }

    return signer;
  })();

  return {
    uri,
    clientPubkey,
    cancel: () => {
      cancelled = true;
    },
    ready: readyPromise,
  };
}
