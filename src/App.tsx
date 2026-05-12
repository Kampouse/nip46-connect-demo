import { useState, useEffect, useCallback, useRef } from "react";
import { QRCodeSVG } from "qrcode.react";
import { hexToBytes } from "@noble/hashes/utils";
import {
  startNdkConnect,
  NdkNostrSigner,
  type NdkConnectHandle,
} from "./lib/ndk-signer";

// ── NIP-46 relay config ──
// relay.powr.build — Clave signer's pinned relay
// relay.primal.net — Primal's relay, their server monitors it
// relay.nip46.com — dedicated NIP-46 relay
// nos.lol — reliable public relay
const NIP46_RELAYS = [
  "wss://relay.powr.build",
  "wss://relay.primal.net",
  "wss://relay.nip46.com",
  "wss://nos.lol",
];

const STORAGE_KEY = "nip46-demo:session";

type Screen = "start" | "qr" | "connected";

function isMobile(): boolean {
  return /Mobi|Android/i.test(navigator.userAgent);
}

// ── Log capture: intercept [NIP-46] console messages ──
function useNip46Logs() {
  const [logs, setLogs] = useState<string[]>([]);

  useEffect(() => {
    const origLog = console.log;
    const origErr = console.error;
    const origWarn = console.warn;

    const addLog = (prefix: string, args: any[]) => {
      const text = args
        .map((a: any) => (typeof a === "string" ? a : JSON.stringify(a)))
        .join(" ");
      if (
        text.includes("[NIP-46") ||
        text.includes("nostrconnect") ||
        text.includes("bunker")
      ) {
        setLogs((prev) => [
          ...prev.slice(-80),
          `${new Date().toLocaleTimeString().slice(0, 8)} ${prefix} ${text}`,
        ]);
      }
    };

    console.log = (...args: any[]) => {
      origLog(...args);
      addLog("LOG", args);
    };
    console.error = (...args: any[]) => {
      origErr(...args);
      addLog("ERR", args);
    };
    console.warn = (...args: any[]) => {
      origWarn(...args);
      addLog("WRN", args);
    };

    return () => {
      console.log = origLog;
      console.error = origErr;
      console.warn = origWarn;
    };
  }, []);

  return logs;
}

// ═══════════════════════════════════════════════════════════════════
// App
// ═══════════════════════════════════════════════════════════════════
export default function App() {
  const [screen, setScreen] = useState<Screen>("start");
  const [error, setError] = useState("");
  const [signer, setSigner] = useState<NdkNostrSigner | null>(null);
  const [pubkey, setPubkey] = useState("");
  const [connectUri, setConnectUri] = useState("");
  const [connectHandle, setConnectHandle] =
    useState<NdkConnectHandle | null>(null);
  const [elapsed, setElapsed] = useState(0);

  // Test operation results
  const [testResult, setTestResult] = useState("");
  const [testLoading, setTestLoading] = useState(false);

  // Log panel
  const logs = useNip46Logs();
  const logEndRef = useRef<HTMLDivElement>(null);

  // Auto-scroll logs
  useEffect(() => {
    logEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [logs]);

  // ── Restore session from localStorage ──
  useEffect(() => {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (!saved) return;
    try {
      const parsed = JSON.parse(saved);
      if (parsed.type === "ndk-bunker" && parsed.clientSecKey && parsed.bunkerPubkey) {
        const s = new NdkNostrSigner({
          clientSecretKey: hexToBytes(parsed.clientSecKey),
          bunkerPubkey: parsed.bunkerPubkey,
          relays: parsed.relays || NIP46_RELAYS,
          userPubkey: parsed.userPubkey,
        });
        console.log("[NIP-46] restored session from localStorage");
        setSigner(s);
        setPubkey(parsed.userPubkey || parsed.bunkerPubkey);
        setScreen("connected");
      }
    } catch (e: any) {
      console.warn("[NIP-46] failed to restore session:", e.message);
      localStorage.removeItem(STORAGE_KEY);
    }
  }, []);

  // ── Start NIP-46 nostrconnect:// pairing flow ──
  const handleStartConnect = useCallback(() => {
    setError("");
    console.log("[NIP-46] starting connect flow...");

    let handle: NdkConnectHandle;
    try {
      handle = startNdkConnect({
        relays: NIP46_RELAYS,
        perms:
          "get_public_key,nip44_encrypt,nip44_decrypt,sign_event:0,sign_event:1,sign_event:4,sign_event:42",
        metadata: {
          name: "NIP-46 Demo",
          url: "https://github.com/nip46-connect-demo",
        },
      });
    } catch (e: any) {
      console.error("[NIP-46] init failed:", e.message);
      setError("NIP-46 init failed: " + e.message);
      return;
    }

    console.log("[NIP-46] nostrconnect URI:", handle.uri);
    (window as any).__nip46Handle = handle;
    setConnectHandle(handle);
    setConnectUri(handle.uri);
    setScreen("qr");

    // Wait for pairing to complete
    handle.ready
      .then(async (s) => {
        console.log("[NIP-46] paired! bunker pubkey:", s.bunker);

        let userPk: string | null = null;
        try {
          userPk = await s.getPublicKey();
        } catch (e: any) {
          console.warn("[NIP-46] getPublicKey failed:", e.message);
          userPk = (s as any)._userPubkey || null;
        }

        if (!userPk) {
          setError("Bunker did not return a public key.");
          setScreen("start");
          return;
        }

        console.log("[NIP-46] got pubkey:", userPk);

        // Persist session
        const serialized = s.serialize();
        localStorage.setItem(
          STORAGE_KEY,
          JSON.stringify({
            type: "ndk-bunker",
            clientSecKey: serialized.clientSecretKey,
            bunkerPubkey: serialized.bunkerPubkey,
            relays: serialized.relays,
            userPubkey: serialized.userPubkey,
          }),
        );

        setSigner(s);
        setPubkey(userPk);
        setScreen("connected");
      })
      .catch((e: any) => {
        console.error("[NIP-46] pairing failed:", e);
        setError(e.message || "Pairing failed");
        setScreen("start");
        setConnectHandle(null);
        setConnectUri("");
      });
  }, []);

  // ── Cancel pairing ──
  const handleCancel = useCallback(() => {
    connectHandle?.cancel();
    setConnectHandle(null);
    setConnectUri("");
    setScreen("start");
    setError("");
  }, [connectHandle]);

  // ── Disconnect ──
  const handleDisconnect = useCallback(() => {
    signer?.close();
    setSigner(null);
    setPubkey("");
    setTestResult("");
    setError("");
    localStorage.removeItem(STORAGE_KEY);
    setScreen("start");
  }, [signer]);

  // ── Test: sign event ──
  const handleTestSignEvent = useCallback(async () => {
    if (!signer) return;
    setTestLoading(true);
    setTestResult("");
    try {
      const event = await signer.signEvent({
        kind: 1,
        content: "Hello from NIP-46 demo! " + new Date().toISOString(),
        tags: [],
        created_at: Math.floor(Date.now() / 1000),
      });
      setTestResult("Signed event:\n" + JSON.stringify(event, null, 2));
    } catch (e: any) {
      setTestResult("Error: " + e.message);
    }
    setTestLoading(false);
  }, [signer]);

  // ── Test: encrypt/decrypt ──
  const handleTestEncrypt = useCallback(async () => {
    if (!signer || !pubkey) return;
    setTestLoading(true);
    setTestResult("");
    try {
      const plaintext = "Secret message " + Date.now();
      const ciphertext = await signer.nip44Encrypt(pubkey, plaintext);
      const decrypted = await signer.nip44Decrypt(pubkey, ciphertext);
      setTestResult(
        `Encrypt/Decrypt test:\n` +
          `  Plaintext:  ${plaintext}\n` +
          `  Ciphertext: ${ciphertext.slice(0, 40)}...\n` +
          `  Decrypted:  ${decrypted}\n` +
          `  Match: ${plaintext === decrypted ? "YES" : "NO"}`,
      );
    } catch (e: any) {
      setTestResult("Error: " + e.message);
    }
    setTestLoading(false);
  }, [signer, pubkey]);

  // ── Test: ping ──
  const handleTestPing = useCallback(async () => {
    if (!signer) return;
    setTestLoading(true);
    setTestResult("");
    try {
      const result = await signer.ping();
      setTestResult("Ping response: " + result);
    } catch (e: any) {
      setTestResult("Error: " + e.message);
    }
    setTestLoading(false);
  }, [signer]);

  // ── Timer for QR screen ──
  useEffect(() => {
    if (screen !== "qr") return;
    const start = Date.now();
    const iv = setInterval(
      () => setElapsed(Math.floor((Date.now() - start) / 1000)),
      1000,
    );
    return () => clearInterval(iv);
  }, [screen]);

  // ── Copy helper ──
  const copyText = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
    } catch {}
  };

  // ═══════════════════════════════════════════════════════════════════
  // Render
  // ═══════════════════════════════════════════════════════════════════
  return (
    <div
      style={{
        maxWidth: 480,
        margin: "0 auto",
        padding: "24px 16px",
        minHeight: "100dvh",
        display: "flex",
        flexDirection: "column",
      }}
    >
      {/* ── Header ── */}
      <div style={{ textAlign: "center", marginBottom: 24 }}>
        <div style={{ fontSize: 32, marginBottom: 8 }}>🔐</div>
        <h1 style={{ fontSize: 20, fontWeight: 700 }}>
          NIP-46 NostrConnect Demo
        </h1>
        <p style={{ fontSize: 13, color: "var(--muted)", marginTop: 4 }}>
          Pair with Clave, Primal, or any bunker signer
        </p>
      </div>

      {/* ── Error bar ── */}
      {error && (
        <div
          style={{
            background: "rgba(239,68,68,0.15)",
            color: "var(--error)",
            padding: "8px 12px",
            borderRadius: 8,
            fontSize: 13,
            marginBottom: 16,
          }}
        >
          {error}
        </div>
      )}

      {/* ════════ START SCREEN ════════ */}
      {screen === "start" && (
        <div style={{ textAlign: "center", flex: 1 }}>
          <div style={{ marginTop: 40 }}>
            <button
              onClick={handleStartConnect}
              style={{
                width: "100%",
                padding: "14px 0",
                borderRadius: 12,
                fontWeight: 600,
                fontSize: 15,
                color: "#000",
                background: "var(--accent)",
              }}
            >
              Connect Signer
            </button>
            <p
              style={{
                fontSize: 12,
                color: "var(--muted)",
                marginTop: 12,
              }}
            >
              Generates a nostrconnect:// URI as a QR code.
              <br />
              Scan with Clave, Amber, Primal, or any NIP-46 signer app.
            </p>
          </div>
        </div>
      )}

      {/* ════════ QR SCREEN ════════ */}
      {screen === "qr" && (
        <div style={{ textAlign: "center", flex: 1 }}>
          <div style={{ textAlign: "center", marginBottom: 16 }}>
            <div
              style={{
                animation: "pulse 2s infinite",
                fontSize: 28,
                marginBottom: 8,
              }}
            >
              📱
            </div>
            <p style={{ fontSize: 16, fontWeight: 600 }}>
              Scan with your signer app
            </p>
            <p style={{ fontSize: 13, color: "var(--muted)" }}>
              {elapsed > 0 ? `Waiting... (${elapsed}s)` : "Preparing QR..."}
            </p>
          </div>

          {/* QR Code */}
          <div
            style={{
              background: "#fff",
              padding: 16,
              borderRadius: 16,
              display: "inline-block",
              marginBottom: 16,
            }}
          >
            <QRCodeSVG value={connectUri} size={200} />
          </div>

          {/* Actions */}
          <div
            style={{
              display: "flex",
              gap: 8,
              justifyContent: "center",
              marginBottom: 16,
            }}
          >
            <button
              onClick={() => copyText(connectUri)}
              style={{
                padding: "8px 16px",
                borderRadius: 8,
                fontSize: 13,
                fontWeight: 500,
                border: "1px solid var(--border)",
              }}
            >
              Copy URI
            </button>
            {isMobile() && (
              <button
                onClick={() => {
                  window.location.href = connectUri;
                }}
                style={{
                  padding: "8px 16px",
                  borderRadius: 8,
                  fontSize: 13,
                  fontWeight: 500,
                  background: "var(--accent)",
                  color: "#000",
                }}
              >
                Open Signer
              </button>
            )}
          </div>

          <button
            onClick={handleCancel}
            style={{
              width: "100%",
              padding: "10px 0",
              fontSize: 13,
              color: "var(--muted)",
            }}
          >
            Cancel
          </button>
        </div>
      )}

      {/* ════════ CONNECTED SCREEN ════════ */}
      {screen === "connected" && (
        <div style={{ flex: 1 }}>
          {/* Status */}
          <div
            style={{
              background: "var(--surface)",
              borderRadius: 12,
              padding: 16,
              marginBottom: 16,
              display: "flex",
              alignItems: "center",
              gap: 12,
            }}
          >
            <div
              style={{
                width: 10,
                height: 10,
                borderRadius: "50%",
                background: "var(--accent)",
                flexShrink: 0,
              }}
            />
            <div style={{ flex: 1, minWidth: 0 }}>
              <p style={{ fontSize: 12, color: "var(--muted)" }}>
                Connected as
              </p>
              <p
                style={{
                  fontSize: 14,
                  fontFamily: "monospace",
                  wordBreak: "break-all",
                }}
              >
                {pubkey}
              </p>
            </div>
            <button
              onClick={() => copyText(pubkey)}
              style={{ fontSize: 12, color: "var(--muted)" }}
              title="Copy pubkey"
            >
              📋
            </button>
          </div>

          {/* Test buttons */}
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              gap: 8,
              marginBottom: 16,
            }}
          >
            <p
              style={{
                fontSize: 12,
                fontWeight: 600,
                color: "var(--muted)",
                textTransform: "uppercase",
                letterSpacing: 1,
              }}
            >
              Test RPC Methods
            </p>
            <button
              onClick={handleTestPing}
              disabled={testLoading}
              style={{
                padding: "10px 16px",
                borderRadius: 8,
                fontSize: 13,
                fontWeight: 500,
                border: "1px solid var(--border)",
                textAlign: "left",
                opacity: testLoading ? 0.5 : 1,
              }}
            >
              🏓 ping
            </button>
            <button
              onClick={handleTestSignEvent}
              disabled={testLoading}
              style={{
                padding: "10px 16px",
                borderRadius: 8,
                fontSize: 13,
                fontWeight: 500,
                border: "1px solid var(--border)",
                textAlign: "left",
                opacity: testLoading ? 0.5 : 1,
              }}
            >
              ✍️ sign_event (kind 1)
            </button>
            <button
              onClick={handleTestEncrypt}
              disabled={testLoading}
              style={{
                padding: "10px 16px",
                borderRadius: 8,
                fontSize: 13,
                fontWeight: 500,
                border: "1px solid var(--border)",
                textAlign: "left",
                opacity: testLoading ? 0.5 : 1,
              }}
            >
              🔒 nip44_encrypt / nip44_decrypt
            </button>
          </div>

          {/* Test result */}
          {testResult && (
            <pre
              style={{
                background: "var(--surface)",
                borderRadius: 8,
                padding: 12,
                fontSize: 12,
                fontFamily: "monospace",
                whiteSpace: "pre-wrap",
                wordBreak: "break-all",
                marginBottom: 16,
                color: testResult.startsWith("Error")
                  ? "var(--error)"
                  : "var(--text)",
              }}
            >
              {testResult}
            </pre>
          )}

          {/* Disconnect */}
          <button
            onClick={handleDisconnect}
            style={{
              width: "100%",
              padding: "10px 0",
              borderRadius: 8,
              fontSize: 13,
              fontWeight: 500,
              border: "1px solid var(--border)",
              color: "var(--error)",
              marginBottom: 16,
            }}
          >
            Disconnect
          </button>
        </div>
      )}

      {/* ════════ LOG PANEL ════════ */}
      {logs.length > 0 && (
        <div style={{ marginTop: "auto" }}>
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              marginBottom: 4,
            }}
          >
            <p
              style={{
                fontSize: 10,
                fontWeight: 700,
                color: "var(--muted)",
                textTransform: "uppercase",
              }}
            >
              NIP-46 Log
            </p>
            <button
              onClick={() => copyText(logs.join("\n"))}
              style={{
                fontSize: 10,
                color: "var(--muted)",
                padding: "2px 8px",
                border: "1px solid var(--border)",
                borderRadius: 4,
              }}
            >
              Copy
            </button>
          </div>
          <div
            style={{
              maxHeight: 180,
              overflowY: "auto",
              borderRadius: 8,
              padding: 8,
              background: "rgba(0,0,0,0.5)",
              fontSize: 10,
              fontFamily: "monospace",
            }}
          >
            {logs.map((l, i) => (
              <div
                key={i}
                style={{
                  color: l.includes("ERR")
                    ? "#f87171"
                    : l.includes("WRN")
                      ? "#facc15"
                      : "#9ca3af",
                }}
              >
                {l}
              </div>
            ))}
            <div ref={logEndRef} />
          </div>
        </div>
      )}
    </div>
  );
}
