import { hexToBytes } from "@noble/hashes/utils";
import { QRCodeSVG } from "qrcode.react";
import {
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import {
  type NdkConnectHandle,
  NdkNostrSigner,
  startNdkConnect,
} from "./lib/ndk-signer";

// ── NIP-46 relay config ──
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

function shortPubkey(pk: string): string {
  if (pk.length < 16) return pk;
  return `${pk.slice(0, 8)}…${pk.slice(-8)}`;
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

// ── Log capture: intercept [NIP-46] console messages ──

type LogEntry = { id: number; text: string };

function useNip46Logs() {
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const idRef = useRef(0);

  const clearLogs = useCallback(() => setLogs([]), []);

  useEffect(() => {
    const origLog = console.log;
    const origErr = console.error;
    const origWarn = console.warn;

    const addLog = (prefix: string, args: unknown[]) => {
      const text = args
        .map((a) => (typeof a === "string" ? a : JSON.stringify(a)))
        .join(" ");
      // Ignore React's own warnings — capturing them would create a
      // feedback loop (the warning text can contain "[NIP-46]" when the
      // offending key happens to be a log string, which then triggers
      // another setLogs → another render → another warning …)
      if (
        text.includes("Encountered two children") ||
        text.includes("Maximum update depth")
      )
        return;
      if (
        text.includes("[NIP-46") ||
        text.includes("nostrconnect") ||
        text.includes("bunker")
      ) {
        setLogs((prev) => [
          ...prev.slice(-80),
          {
            id: idRef.current++,
            text: `${new Date().toLocaleTimeString().slice(0, 8)} ${prefix} ${text}`,
          },
        ]);
      }
    };

    console.log = (...args: unknown[]) => {
      origLog(...args);
      addLog("LOG", args);
    };
    console.error = (...args: unknown[]) => {
      origErr(...args);
      addLog("ERR", args);
    };
    console.warn = (...args: unknown[]) => {
      origWarn(...args);
      addLog("WRN", args);
    };

    return () => {
      console.log = origLog;
      console.error = origErr;
      console.warn = origWarn;
    };
  }, []);

  return { logs, clearLogs };
}

// ── Pairing progress stepper ──
const PAIR_STEPS = [
  {
    label: "Waiting for scan",
    sub: "Scan the QR with your signer app",
  },
  {
    label: "Pairing handshake",
    sub: "Signer responded over the relay",
  },
  {
    label: "Fetching public key",
    sub: "Opening an encrypted channel",
  },
] as const;

// Derive the most advanced pairing phase from captured logs.
// These strings come from ndk-signer.ts' console output at each phase.
function derivePairStep(logs: LogEntry[]): number {
  const all = logs.map((e) => e.text).join(" ");
  if (all.includes("creating NdkNostrSigner") || all.includes("getPublicKey")) {
    return 2;
  }
  if (all.includes("PAIRED") || all.includes("pair response")) {
    return 1;
  }
  return 0;
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
  const [connectHandle, setConnectHandle] = useState<NdkConnectHandle | null>(
    null,
  );
  const [elapsed, setElapsed] = useState(0);

  // Test operation results
  const [testResult, setTestResult] = useState("");
  const [testLoading, setTestLoading] = useState(false);

  // Log panel + pairing progress
  const { logs, clearLogs } = useNip46Logs();
  const logEndRef = useRef<HTMLDivElement>(null);
  const logScrollRef = useRef<HTMLDivElement>(null);

  const [pairStep, setPairStep] = useState(0);
  const [showHowItWorks, setShowHowItWorks] = useState(false);
  const [tab, setTab] = useState<"app" | "log">("app");
  const [hasNewLogs, setHasNewLogs] = useState(false);

  // Flag new logs while on the App tab
  useEffect(() => {
    if (logs.length > 0 && tab !== "log") setHasNewLogs(true);
  }, [logs, tab]);

  // Smooth-scroll to the latest log when switching TO the Log tab
  useEffect(() => {
    if (tab !== "log") return;
    const el = logScrollRef.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  }, [tab]);

  // Stick to the bottom as new logs arrive — but only if the user is
  // already near the bottom, so we don't yank them away from older entries
  // they're reading. Uses instant scroll to avoid the smooth-animation
  // restart loop that happened when logs stream in faster than the
  // animation can complete.
  useEffect(() => {
    if (tab !== "log" || logs.length === 0) return;
    const el = logScrollRef.current;
    if (!el) return;
    const distFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    if (distFromBottom < 100) el.scrollTop = el.scrollHeight;
  }, [logs, tab]);

  // Advance pairing stepper from real protocol events (never goes backwards)
  useEffect(() => {
    if (screen !== "qr") return;
    const next = derivePairStep(logs);
    setPairStep((prev) => Math.max(prev, next));
  }, [logs, screen]);

  // ── Restore session from localStorage ──
  useEffect(() => {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (!saved) return;
    try {
      const parsed = JSON.parse(saved);
      if (
        parsed.type === "ndk-bunker" &&
        parsed.clientSecKey &&
        parsed.bunkerPubkey
      ) {
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
    } catch (e) {
      console.warn("[NIP-46] failed to restore session:", errMsg(e));
      localStorage.removeItem(STORAGE_KEY);
    }
  }, []);

  // ── Start NIP-46 nostrconnect:// pairing flow ──
  const handleStartConnect = useCallback(() => {
    setError("");
    clearLogs();
    setPairStep(0);
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
    } catch (e) {
      console.error("[NIP-46] init failed:", errMsg(e));
      setError(`NIP-46 init failed: ${errMsg(e)}`);
      return;
    }

    console.log("[NIP-46] nostrconnect URI:", handle.uri);
    (window as unknown as Record<string, unknown>).__nip46Handle = handle;
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
        } catch (e) {
          console.warn("[NIP-46] getPublicKey failed:", errMsg(e));
          userPk = s.userPubkey || null;
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
      .catch((e) => {
        console.error("[NIP-46] pairing failed:", e);
        setError(errMsg(e) || "Pairing failed");
        setScreen("start");
        setConnectHandle(null);
        setConnectUri("");
      });
  }, [clearLogs]);

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
        content: `Hello from NIP-46 demo! ${new Date().toISOString()}`,
        tags: [],
        created_at: Math.floor(Date.now() / 1000),
      });
      setTestResult(`Signed event:\n${JSON.stringify(event, null, 2)}`);
    } catch (e) {
      setTestResult(`Error: ${errMsg(e)}`);
    }
    setTestLoading(false);
  }, [signer]);

  // ── Test: encrypt/decrypt ──
  const handleTestEncrypt = useCallback(async () => {
    if (!signer || !pubkey) return;
    setTestLoading(true);
    setTestResult("");
    try {
      const plaintext = `Secret message ${Date.now()}`;
      const ciphertext = await signer.nip44Encrypt(pubkey, plaintext);
      const decrypted = await signer.nip44Decrypt(pubkey, ciphertext);
      setTestResult(
        `Encrypt/Decrypt test:\n` +
          `  Plaintext:  ${plaintext}\n` +
          `  Ciphertext: ${ciphertext.slice(0, 40)}...\n` +
          `  Decrypted:  ${decrypted}\n` +
          `  Match: ${plaintext === decrypted ? "YES" : "NO"}`,
      );
    } catch (e) {
      setTestResult(`Error: ${errMsg(e)}`);
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
      setTestResult(`Ping response: ${result}`);
    } catch (e) {
      setTestResult(`Error: ${errMsg(e)}`);
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

  const isErrorResult = testResult.startsWith("Error");

  // ═══════════════════════════════════════════════════════════════════
  // Render
  // ═══════════════════════════════════════════════════════════════════
  return (
    <div className="relative min-h-dvh w-full overflow-hidden">
      {/* Ambient background glow */}
      <div className="pointer-events-none absolute inset-0 -z-10">
        <div className="absolute left-1/2 top-0 h-105 w-105 -translate-x-1/2 rounded-full bg-accent/10 blur-[120px]" />
        <div className="absolute bottom-0 left-0 h-80 w-80 rounded-full bg-accent/5 blur-[120px]" />
      </div>

      <div
        className={`mx-auto flex min-h-dvh w-full flex-col px-5 pb-24 pt-8 ${
          tab === "log" ? "max-w-3xl" : "max-w-120"
        }`}
      >
        {tab === "app" ? (
          <>
            {/* ── Header ── */}
            <header className="mb-8 flex flex-col items-center text-center">
              <div className="relative mb-4 flex h-16 w-16 items-center justify-center rounded-2xl border border-border bg-surface shadow-lg shadow-accent/5">
                <span className="text-3xl">🔐</span>
                <div className="absolute inset-0 rounded-2xl ring-1 ring-inset ring-white/5" />
              </div>
              <h1 className="text-xl font-bold tracking-tight text-text">
                NIP-46 NostrConnect
              </h1>
              <p className="mt-1.5 text-sm text-muted">
                Pair with Clave, Primal, or any bunker signer
              </p>
            </header>

            {/* ── Error bar ── */}
            {error && (
              <div className="mb-4 flex items-start gap-2.5 rounded-xl border border-error/20 bg-error/10 px-3.5 py-3 text-sm text-error">
                <span className="mt-0.5 shrink-0">⚠️</span>
                <span className="leading-relaxed">{error}</span>
              </div>
            )}

            {/* ════════ START SCREEN ════════ */}
            {screen === "start" && (
              <div className="flex flex-1 flex-col items-center justify-center">
                <div className="mb-3 flex h-24 w-24 items-center justify-center rounded-3xl border border-border bg-surface/50">
                  <span className="text-5xl">📡</span>
                </div>
                <p className="mb-8 max-w-70 text-center text-sm leading-relaxed text-muted">
                  Generate a one-time pairing code and scan it with your signer
                  to delegate keys securely.
                </p>
                <button
                  type="button"
                  onClick={handleStartConnect}
                  className="group w-full rounded-2xl bg-accent py-4 text-[15px] font-semibold text-black transition-all hover:bg-accent-dim hover:shadow-lg hover:shadow-accent/20 active:scale-[0.98]"
                >
                  Connect Signer
                </button>

                {/* How it works */}
                <button
                  type="button"
                  onClick={() => setShowHowItWorks((v) => !v)}
                  className="mt-4 flex items-center gap-1.5 text-[13px] text-muted transition-colors hover:text-text"
                >
                  {showHowItWorks ? "Hide" : "How does this work?"}
                  <span
                    className={`text-[10px] transition-transform ${showHowItWorks ? "rotate-180" : ""}`}
                  >
                    ▾
                  </span>
                </button>

                {showHowItWorks && (
                  <div className="mt-4 w-full rounded-2xl border border-border bg-surface p-5">
                    <p className="mb-4 text-sm font-semibold text-text">
                      How NIP-46 works
                    </p>

                    {/* Flow diagram */}
                    <div className="mb-5 flex items-center justify-center gap-1.5">
                      <FlowNode icon="🖥️" label="This app" />
                      <FlowArrow />
                      <FlowNode icon="📡" label="Relays" />
                      <FlowArrow />
                      <FlowNode icon="📱" label="Signer" />
                    </div>

                    <ol className="space-y-2.5 text-[13px] leading-relaxed text-muted">
                      <li className="flex gap-2.5">
                        <span className="font-mono text-accent">1</span>
                        <span>
                          This app generates a throwaway keypair —{" "}
                          <span className="text-text">
                            no secret keys touch the browser
                          </span>
                          .
                        </span>
                      </li>
                      <li className="flex gap-2.5">
                        <span className="font-mono text-accent">2</span>
                        <span>
                          It builds a{" "}
                          <code className="font-mono text-[12px] text-text">
                            nostrconnect://
                          </code>{" "}
                          URI and shows it as a QR code.
                        </span>
                      </li>
                      <li className="flex gap-2.5">
                        <span className="font-mono text-accent">3</span>
                        <span>
                          You scan it with your signer. It publishes an
                          encrypted{" "}
                          <code className="font-mono text-[12px] text-text">
                            kind 24133
                          </code>{" "}
                          event back.
                        </span>
                      </li>
                      <li className="flex gap-2.5">
                        <span className="font-mono text-accent">4</span>
                        <span>
                          From then on, every sign and encrypt call is delegated
                          to the signer over the relay.
                        </span>
                      </li>
                    </ol>
                  </div>
                )}
              </div>
            )}

            {/* ════════ QR SCREEN ════════ */}
            {screen === "qr" && (
              <div className="flex flex-1 flex-col items-center">
                {/* Status */}
                <div className="mb-6 text-center">
                  <div className="mb-2 text-2xl">📱</div>
                  <p className="text-base font-semibold text-text">
                    Scan with your signer app
                  </p>
                  <p className="mt-1 text-[13px] text-muted">
                    {elapsed > 0 ? `Waiting… (${elapsed}s)` : "Preparing QR…"}
                  </p>
                </div>

                {/* QR Code */}
                <div className="relative mb-6 rounded-3xl bg-white p-4 shadow-2xl shadow-accent/10 ring-1 ring-white/10">
                  <QRCodeSVG
                    value={connectUri}
                    size={220}
                    className="rounded-lg"
                  />
                  {/* Corner accents */}
                  <div className="absolute -left-1 -top-1 h-5 w-5 rounded-tl-xl border-l-2 border-t-2 border-accent/50" />
                  <div className="absolute -right-1 -top-1 h-5 w-5 rounded-tr-xl border-r-2 border-t-2 border-accent/50" />
                  <div className="absolute -bottom-1 -left-1 h-5 w-5 rounded-bl-xl border-b-2 border-l-2 border-accent/50" />
                  <div className="absolute -bottom-1 -right-1 h-5 w-5 rounded-br-xl border-b-2 border-r-2 border-accent/50" />
                </div>

                {/* Pairing progress stepper */}
                <div className="mb-6 w-full rounded-2xl border border-border bg-surface/50 p-4">
                  <PairStepper current={pairStep} />
                </div>

                {/* Actions */}
                <div className="mb-4 flex w-full gap-2">
                  <button
                    type="button"
                    onClick={() => copyText(connectUri)}
                    className="flex-1 rounded-xl border border-border bg-surface py-2.5 text-[13px] font-medium text-text transition-colors hover:bg-surface-2"
                  >
                    Copy URI
                  </button>
                  {isMobile() && (
                    <button
                      type="button"
                      onClick={() => {
                        window.location.href = connectUri;
                      }}
                      className="flex-1 rounded-xl bg-accent py-2.5 text-[13px] font-medium text-black transition-colors hover:bg-accent-dim"
                    >
                      Open Signer
                    </button>
                  )}
                </div>

                <button
                  type="button"
                  onClick={handleCancel}
                  className="w-full py-2.5 text-[13px] text-muted transition-colors hover:text-text"
                >
                  Cancel
                </button>
              </div>
            )}

            {/* ════════ CONNECTED SCREEN ════════ */}
            {screen === "connected" && (
              <div className="flex-1">
                {/* Status card */}
                <div className="mb-5 flex items-center gap-3 rounded-2xl border border-border bg-surface p-4">
                  <span className="relative flex h-2.5 w-2.5 shrink-0">
                    <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-accent opacity-75" />
                    <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-accent" />
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="text-[11px] uppercase tracking-wide text-muted">
                      Connected as
                    </p>
                    <p
                      className="mt-0.5 font-mono text-[13px] text-text"
                      title={pubkey}
                    >
                      {shortPubkey(pubkey)}
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => copyText(pubkey)}
                    className="shrink-0 rounded-lg border border-border px-2 py-1.5 text-xs text-muted transition-colors hover:bg-surface-2 hover:text-text"
                    title="Copy full pubkey"
                  >
                    Copy
                  </button>
                </div>

                {/* Test RPC Methods */}
                <p className="mb-2.5 px-1 text-[11px] font-semibold uppercase tracking-wider text-muted">
                  Test RPC Methods
                </p>
                <div className="mb-4 flex flex-col gap-2">
                  <RpcButton
                    icon="🏓"
                    label="ping"
                    desc="Round-trip: your bunker echoes back over an encrypted kind 24133 event"
                    disabled={testLoading}
                    onClick={handleTestPing}
                  />
                  <RpcButton
                    icon="✍️"
                    label="sign_event"
                    sub="kind 1"
                    desc="Asks the signer to sign a note on your behalf — it never sees the key"
                    disabled={testLoading}
                    onClick={handleTestSignEvent}
                  />
                  <RpcButton
                    icon="🔒"
                    label="nip44_encrypt"
                    sub="/ nip44_decrypt"
                    desc="Encrypts a message to yourself, then decrypts it to verify the round-trip"
                    disabled={testLoading}
                    onClick={handleTestEncrypt}
                  />
                </div>

                {/* Test result */}
                {testResult && (
                  <pre
                    className={`mb-4 max-h-60 overflow-auto whitespace-pre-wrap break-all rounded-xl border p-3.5 font-mono text-xs leading-relaxed ${
                      isErrorResult
                        ? "border-error/20 bg-error/5 text-error"
                        : "border-border bg-surface text-text"
                    }`}
                  >
                    {testResult}
                  </pre>
                )}

                {/* Disconnect */}
                <button
                  type="button"
                  onClick={handleDisconnect}
                  className="w-full rounded-xl border border-border py-2.5 text-[13px] font-medium text-error transition-colors hover:bg-error/5"
                >
                  Disconnect
                </button>
              </div>
            )}
          </>
        ) : (
          /* ════════ LOG TAB ════════ */
          <div className="flex flex-1 flex-col">
            {/* Log header */}
            <div className="mb-3 flex items-center justify-between">
              <div className="flex items-center gap-2.5">
                <span className="text-xl">📋</span>
                <div>
                  <p className="text-sm font-semibold text-text">
                    Activity Log
                  </p>
                  <p className="text-[11px] text-muted">
                    {logs.length} event{logs.length === 1 ? "" : "s"} captured
                  </p>
                </div>
              </div>
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={clearLogs}
                  className="rounded-lg border border-border px-3 py-1.5 text-xs text-muted transition-colors hover:bg-surface-2 hover:text-text"
                >
                  Clear
                </button>
                <button
                  type="button"
                  onClick={() => copyText(logs.map((e) => e.text).join("\n"))}
                  className="rounded-lg border border-border px-3 py-1.5 text-xs text-muted transition-colors hover:bg-surface-2 hover:text-text"
                >
                  Copy
                </button>
              </div>
            </div>

            {/* Full-height log terminal */}
            <div
              ref={logScrollRef}
              className="flex-1 overflow-y-auto rounded-xl border border-border bg-black/50 p-4 font-mono text-[11px] leading-relaxed"
            >
              {logs.length === 0 ? (
                <p className="text-muted">
                  No activity yet. Start a pairing flow to see NIP-46 events.
                </p>
              ) : (
                logs.map((entry) => (
                  <div
                    key={entry.id}
                    className={`break-all ${
                      entry.text.includes("ERR")
                        ? "text-error"
                        : entry.text.includes("WRN")
                          ? "text-yellow-300"
                          : "text-[#b4b4bd]"
                    }`}
                  >
                    {entry.text}
                  </div>
                ))
              )}
              <div ref={logEndRef} />
            </div>
          </div>
        )}
      </div>

      {/* ════════ BOTTOM TAB BAR ════════ */}
      <nav className="fixed bottom-0 left-0 right-0 z-50 border-t border-border bg-bg/80 backdrop-blur-lg">
        <div
          className={`mx-auto flex ${tab === "log" ? "max-w-3xl" : "max-w-120"}`}
        >
          <TabButton
            active={tab === "app"}
            onClick={() => setTab("app")}
            label="App"
            icon={
              <svg
                width="20"
                height="20"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                role="img"
                aria-label="App"
              >
                <rect x="3" y="3" width="7" height="7" rx="1.5" />
                <rect x="14" y="3" width="7" height="7" rx="1.5" />
                <rect x="3" y="14" width="7" height="7" rx="1.5" />
                <rect x="14" y="14" width="7" height="7" rx="1.5" />
              </svg>
            }
          />
          <TabButton
            active={tab === "log"}
            onClick={() => {
              setTab("log");
              setHasNewLogs(false);
            }}
            label="Log"
            badge={hasNewLogs && logs.length > 0}
            icon={
              <svg
                width="20"
                height="20"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                role="img"
                aria-label="Log"
              >
                <rect x="3" y="4" width="18" height="16" rx="2" />
                <path d="M7 9l3 3-3 3" />
                <line x1="13" y1="15" x2="17" y2="15" />
              </svg>
            }
          />
        </div>
      </nav>
    </div>
  );
}

// ── RPC test button ──
function RpcButton({
  icon,
  label,
  sub,
  desc,
  disabled,
  onClick,
}: {
  icon: string;
  label: string;
  sub?: string;
  desc?: string;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="group flex w-full items-center gap-3 rounded-xl border border-border bg-surface px-4 py-3 text-left transition-colors hover:bg-surface-2 disabled:opacity-50"
    >
      <span className="shrink-0 text-base">{icon}</span>
      <span className="min-w-0">
        <span className="flex items-baseline gap-1.5">
          <span className="text-[13px] font-medium text-text">{label}</span>
          {sub && <span className="text-[11px] text-muted">{sub}</span>}
        </span>
        {desc && (
          <span className="mt-0.5 block text-[11px] leading-snug text-muted">
            {desc}
          </span>
        )}
      </span>
    </button>
  );
}

// ── Bottom tab bar button ──
function TabButton({
  active,
  onClick,
  label,
  icon,
  badge,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  icon: ReactNode;
  badge?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`relative flex flex-1 flex-col items-center gap-1 py-2.5 transition-colors ${
        active ? "text-accent" : "text-muted"
      }`}
    >
      {active && (
        <span className="absolute top-0 h-0.5 w-8 rounded-full bg-accent" />
      )}
      <span className="relative">
        {icon}
        {badge && (
          <span className="absolute -right-1.5 -top-1 h-2 w-2 rounded-full bg-accent ring-2 ring-bg" />
        )}
      </span>
      <span className="text-[10px] font-medium">{label}</span>
    </button>
  );
}

// ── Pairing progress stepper ──
function PairStepper({ current }: { current: number }) {
  return (
    <div className="flex flex-col">
      {PAIR_STEPS.map((step, i) => {
        const done = i < current;
        const active = i === current;
        const isLast = i === PAIR_STEPS.length - 1;
        return (
          <div key={step.label} className="flex gap-3">
            {/* Indicator column */}
            <div className="flex flex-col items-center">
              <div className="relative flex h-6 w-6 shrink-0 items-center justify-center">
                {active && (
                  <span className="absolute inline-flex h-full w-full rounded-full bg-accent opacity-25" />
                )}
                <span
                  className={`relative flex h-6 w-6 items-center justify-center rounded-full border text-[11px] font-bold transition-colors ${
                    done
                      ? "border-accent bg-accent text-black"
                      : active
                        ? "border-accent bg-accent/15 text-accent"
                        : "border-border text-transparent"
                  }`}
                >
                  {done ? "✓" : i + 1}
                </span>
              </div>
              {!isLast && (
                <div
                  className={`my-0.5 w-px flex-1 ${done ? "bg-accent/50" : "bg-border"}`}
                />
              )}
            </div>
            {/* Text */}
            <div className={isLast ? "pb-1" : "pb-4"}>
              <p
                className={`text-[13px] font-medium transition-colors ${
                  done || active ? "text-text" : "text-muted"
                }`}
              >
                {step.label}
              </p>
              <p className="text-[11px] leading-snug text-muted">{step.sub}</p>
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ── Flow diagram nodes (How it works panel) ──
function FlowNode({ icon, label }: { icon: string; label: string }) {
  return (
    <div className="flex flex-col items-center gap-1.5">
      <div className="flex h-11 w-11 items-center justify-center rounded-xl border border-border bg-bg text-lg">
        {icon}
      </div>
      <span className="text-[10px] text-muted">{label}</span>
    </div>
  );
}

function FlowArrow() {
  return (
    <div className="flex flex-col items-center pb-5 text-muted">
      <span className="text-xs leading-none">⇄</span>
      <span className="mt-0.5 text-[8px]">24133</span>
    </div>
  );
}
