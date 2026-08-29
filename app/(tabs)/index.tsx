import { useEffect, useRef, useState } from "react";

import {
  Alert,
  Animated,
  Image,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";

import { Feather } from "@expo/vector-icons";
import { Audio } from "expo-av";
import * as Clipboard from "expo-clipboard";
import * as DocumentPicker from "expo-document-picker";
import * as FileSystem from "expo-file-system/legacy";
import * as ImagePicker from "expo-image-picker";
import { useLocalSearchParams } from "expo-router";
import * as Sharing from "expo-sharing";

import {
  DashboardColors as C,
  DashboardRadii as R,
} from "@/constants/dashboard-theme";
import { socket } from "@/constants/socket";
import { useWideLayout } from "@/hooks/use-wide-layout";
import {
  bumpFileCount,
  bumpMessageCount,
  patchSession,
  resetChannelState,
} from "@/lib/session-store";
// ---- WebRTC platform shim ----
// react-native-webrtc is a native module and cannot run on web. On web we
// use the browser's built-in WebRTC globals instead. On native we lazily
// require react-native-webrtc so the web bundler never tries to load it.
const isWeb = Platform.OS === "web";

const RTCPeerConnection: any = isWeb
  ? (globalThis as any).RTCPeerConnection
  : require("react-native-webrtc").RTCPeerConnection;

const RTCSessionDescription: any = isWeb
  ? (globalThis as any).RTCSessionDescription
  : require("react-native-webrtc").RTCSessionDescription;

const RTCIceCandidate: any = isWeb
  ? (globalThis as any).RTCIceCandidate
  : require("react-native-webrtc").RTCIceCandidate;

async function getMicStream(): Promise<any> {
  if (isWeb) {
    return navigator.mediaDevices.getUserMedia({ audio: true, video: false });
  }
  const { mediaDevices } = require("react-native-webrtc");
  return mediaDevices.getUserMedia({ audio: true, video: false });
}

const ICE_SERVERS = {
  iceServers: [
    { urls: "stun:stun.l.google.com:19302" },
    // Add a TURN server here for reliability off local wifi, e.g.:
    // { urls: "turn:your.turn.host:3478", username: "user", credential: "pass" },
  ],
};

type CallState = "idle" | "calling" | "ringing" | "connected";

type MessageStatus = "sending" | "delivered" | "failed";
type MessageKind = "text" | "image" | "file" | "voice";

type ChatMessage = {
  id: string;
  kind: MessageKind;
  sender: "me" | "other";
  timestamp: string;
  status?: MessageStatus;

  // text
  text?: string;

  // image / file
  fileName?: string;
  fileSize?: number;
  mimeType?: string;
  data?: string; // base64 payload, used to render images inline
  localUri?: string; // on-disk path once a file/voice message has been saved
  durationMs?: number; // voice-message duration
  progress?: number; // 0-100, used while a transfer is in flight
};

type LinkState =
  | "connecting"
  | "online"
  | "opening"
  | "waiting"
  | "tuning"
  | "paired"
  | "reconnecting"
  | "lost"
  | "closed"
  | "error";

type ActivityEntry = {
  id: string;
  text: string;
  time: string;
  kind: "info" | "good" | "bad";
};

const STATUS_COPY: Record<LinkState, string> = {
  connecting: "REACHING SERVER",
  online: "SERVER LINKED",
  opening: "OPENING CHANNEL",
  waiting: "CHANNEL OPEN — WAITING FOR PEER",
  tuning: "JOINING CHANNEL",
  paired: "CHANNEL PAIRED",
  reconnecting: "RECONNECTING...",
  lost: "CONNECTION LOST",
  closed: "PEER SIGNED OFF",
  error: "COULD NOT JOIN",
};

const SIGNAL_LEVEL: Record<LinkState, number> = {
  connecting: 1,
  online: 2,
  opening: 2,
  waiting: 2,
  tuning: 2,
  paired: 4,
  reconnecting: 1,
  lost: 0,
  closed: 0,
  error: 0,
};

const DOT_COLOR: Record<LinkState, string> = {
  connecting: "#D9A441",
  online: "#5DCAA5",
  opening: "#D9A441",
  waiting: "#D9A441",
  tuning: "#D9A441",
  paired: "#5DCAA5",
  reconnecting: "#D9A441",
  lost: "#E0645A",
  closed: "#E0645A",
  error: "#E0645A",
};

const TYPING_TIMEOUT_MS = 1500;
const SEND_ACK_TIMEOUT_MS = 5000;
const MAX_LOG_ENTRIES = 60;
const MESSAGE_PREVIEW_LENGTH = 28;

// Transfer tuning: base64 chars per chunk (~48KB of real bytes) and a hard
// ceiling on file size so a huge pick doesn't wedge the app or the socket.
const CHUNK_SIZE = 64000;
const MAX_FILE_BYTES = 25 * 1024 * 1024; // 25MB

const mono = Platform.select({ ios: "Menlo", android: "monospace", default: "monospace" });

// ⚠️ Paste your ORIGINAL long notification-sound base64 string back in here
// (or use require("./assets/notification.mp3")) — this is a shortened
// placeholder and will not decode correctly as-is.
const NOTIFICATION_SOUND_URI = "data:audio/wav;base64,UklGRkIYAABXQVZFZm10IBAAAAABAAEAIlYAAESsAAACABAAZGF0YR4YAAAA";

function makeMessageId() {
  return `${Date.now()}-${Math.random()}`;
}

function timeNow() {
  return new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function timeNowPrecise() {
  return new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function formatElapsed(totalSeconds: number) {
  const m = Math.floor(totalSeconds / 60)
    .toString()
    .padStart(2, "0");
  const s = Math.floor(totalSeconds % 60)
    .toString()
    .padStart(2, "0");
  return `${m}:${s}`;
}

function truncatePreview(text: string) {
  const trimmed = text.trim();
  if (trimmed.length <= MESSAGE_PREVIEW_LENGTH) return trimmed;
  return `${trimmed.slice(0, MESSAGE_PREVIEW_LENGTH)}…`;
}

function formatFileSize(bytes?: number) {
  if (!bytes && bytes !== 0) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function fileGlyph(mimeType?: string) {
  if (!mimeType) return "📄";
  if (mimeType.includes("pdf")) return "📕";
  if (mimeType.includes("zip") || mimeType.includes("compressed")) return "🗜️";
  if (mimeType.startsWith("audio")) return "🎵";
  if (mimeType.startsWith("video")) return "🎞️";
  return "📄";
}

// A Pressable wrapper that adds a small, snappy scale animation on press.
function AnimatedPressable({
  onPress,
  style,
  children,
  disabled,
}: {
  onPress?: () => void;
  style?: any;
  children: React.ReactNode;
  disabled?: boolean;
}) {
  const scale = useRef(new Animated.Value(1)).current;

  function pressIn() {
    Animated.spring(scale, { toValue: 0.95, useNativeDriver: true, speed: 60, bounciness: 0 }).start();
  }

  function pressOut() {
    Animated.spring(scale, { toValue: 1, useNativeDriver: true, speed: 20, bounciness: 8 }).start();
  }

  return (
    <Pressable onPress={onPress} onPressIn={pressIn} onPressOut={pressOut} disabled={disabled}>
      <Animated.View style={[style, { transform: [{ scale }] }]}>{children}</Animated.View>
    </Pressable>
  );
}

function emitAck<T>(event: string, payload: object, timeoutMs = 20000): Promise<T | undefined> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(undefined), timeoutMs);
    socket.emit(event, payload, (response: T) => {
      clearTimeout(timer);
      resolve(response);
    });
  });
}

export default function HomeScreen() {
  const { wide, maxContentWidth } = useWideLayout();
  const params = useLocalSearchParams<{ intent?: string | string[]; t?: string | string[] }>();
  const intent = Array.isArray(params.intent) ? params.intent[0] : params.intent;
  const intentStamp = Array.isArray(params.t) ? params.t[0] : params.t;
  const lastCreateStamp = useRef<string | null>(null);

  const [sessionCode, setSessionCode] = useState("");
  const [joinCode, setJoinCode] = useState("");
  const [linkState, setLinkState] = useState<LinkState>("connecting");
  const [peerOnline, setPeerOnline] = useState(false);
  const [peerTyping, setPeerTyping] = useState(false);
  const [incomingCall, setIncomingCall] = useState(false);

  const [message, setMessage] = useState("");
  const [messages, setMessages] = useState<ChatMessage[]>([]);

  const [activityLog, setActivityLog] = useState<ActivityEntry[]>([]);
  const [showLog, setShowLog] = useState(false);
  const [copyFeedback, setCopyFeedback] = useState(false);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [viewerImage, setViewerImage] = useState<{ uri: string } | null>(null);
  const [recording, setRecording] = useState<Audio.Recording | null>(null);
  const [isRecording, setIsRecording] = useState(false);
  const [recordingSeconds, setRecordingSeconds] = useState(0);
  const [playingVoiceId, setPlayingVoiceId] = useState<string | null>(null);

  // ---- Call state ----
  const [callState, setCallState] = useState<CallState>("idle");
  const [callSeconds, setCallSeconds] = useState(0);
  const [isMuted, setIsMuted] = useState(false);

  const scrollViewRef = useRef<ScrollView>(null);
  const logScrollRef = useRef<ScrollView>(null);
  const typingTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const copyFeedbackTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isTypingRef = useRef(false);
  const roleRef = useRef<"host" | "guest" | null>(null);
  const sessionCodeRef = useRef("");
  const pairedAtRef = useRef<number | null>(null);
  const notificationSoundRef = useRef<Audio.Sound | null>(null);
  const voiceSoundRef = useRef<Audio.Sound | null>(null);
  const recordingTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // ---- Call refs ----
  const peerConnectionRef = useRef<any>(null);
  const localStreamRef = useRef<any>(null);
  const pendingCandidatesRef = useRef<any[]>([]);
  const incomingOfferRef = useRef<any>(null);
  const callTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // Mirrors `callState` so socket handlers (registered in an effect that no
  // longer depends on callState) can always read the latest value without
  // forcing that whole effect to tear down and re-run on every call-state
  // change. See callStateRef sync effect below.
  const callStateRef = useRef<CallState>("idle");

  // Tracks in-progress incoming transfers, keyed by transferId, so chunks
  // that arrive out of order (or interleaved with another transfer) still
  // land in the right slot and update the right chat bubble.
  const incomingTransfersRef = useRef<
    Record<
      string,
      {
        chunks: string[];
        received: number;
        totalChunks: number;
        messageId: string;
        kind: MessageKind;
        fileName: string;
        mimeType: string;
      }
    >
  >({});

  useEffect(() => {
    sessionCodeRef.current = sessionCode;
  }, [sessionCode]);

  useEffect(() => {
    callStateRef.current = callState;
  }, [callState]);

  function logActivity(text: string, kind: ActivityEntry["kind"] = "info") {
    setActivityLog((current) => {
      const next = [...current, { id: makeMessageId(), text, time: timeNowPrecise(), kind }];
      return next.length > MAX_LOG_ENTRIES ? next.slice(next.length - MAX_LOG_ENTRIES) : next;
    });
  }

  useEffect(() => {
    let isMounted = true;

    async function loadSound() {
      try {
        await Audio.setAudioModeAsync({ playsInSilentModeIOS: true });
        const { sound } = await Audio.Sound.createAsync({ uri: NOTIFICATION_SOUND_URI });
        if (isMounted) {
          notificationSoundRef.current = sound;
        } else {
          sound.unloadAsync();
        }
      } catch (error) {
        console.warn("Could not load notification sound", error);
      }
    }

    loadSound();

    return () => {
      isMounted = false;
      notificationSoundRef.current?.unloadAsync();
      notificationSoundRef.current = null;
      voiceSoundRef.current?.unloadAsync();
      voiceSoundRef.current = null;
      if (recordingTimerRef.current) clearInterval(recordingTimerRef.current);
      if (callTimerRef.current) clearInterval(callTimerRef.current);
      cleanupCall();
    };
  }, []);

  async function playNotificationSound() {
    const sound = notificationSoundRef.current;
    if (!sound) return;
    try {
      await sound.setPositionAsync(0);
      await sound.playAsync();
    } catch (error) {
      console.warn("Could not play notification sound", error);
    }
  }

  useEffect(() => {
    if (peerOnline && sessionCode) {
      if (pairedAtRef.current === null) {
        pairedAtRef.current = Date.now();
      }
      const interval = setInterval(() => {
        if (pairedAtRef.current) {
          setElapsedSeconds(Math.floor((Date.now() - pairedAtRef.current) / 1000));
        }
      }, 1000);
      return () => clearInterval(interval);
    } else {
      pairedAtRef.current = null;
      setElapsedSeconds(0);
    }
  }, [peerOnline, sessionCode]);

  // Call duration timer
  useEffect(() => {
    if (callState === "connected") {
      callTimerRef.current = setInterval(() => setCallSeconds((s) => s + 1), 1000);
      return () => {
        if (callTimerRef.current) clearInterval(callTimerRef.current);
      };
    }
  }, [callState]);

  useEffect(() => {
    const timeout = setTimeout(() => {
      scrollViewRef.current?.scrollToEnd({ animated: true });
    }, 50);
    return () => clearTimeout(timeout);
  }, [messages.length, peerTyping]);

  useEffect(() => {
    function resetSessionState() {
      setSessionCode("");
      setMessages([]);
      setPeerOnline(false);
      setPeerTyping(false);
      roleRef.current = null;
      incomingTransfersRef.current = {};
      resetChannelState();
      cleanupCall();
    }

    function handleConnect() {
      logActivity("Connected to server", "good");
      if (sessionCodeRef.current && roleRef.current) {
        setLinkState("reconnecting");
        socket.emit("rejoin-session", {
          sessionCode: sessionCodeRef.current,
          role: roleRef.current,
        });
      } else {
        setLinkState("online");
      }
    }

    function handleDisconnect() {
      logActivity("Disconnected from server", "bad");
      if (sessionCodeRef.current) {
        setLinkState("lost");
        setPeerOnline(false);
      } else {
        setLinkState("lost");
      }
    }

    function handleReconnectAttempt(attempt: number) {
      setLinkState("reconnecting");
      logActivity(`Reconnect attempt #${attempt}`, "info");
    }

    function handleReconnectFailed() {
      setLinkState("error");
      logActivity("Auto-reconnect gave up — try manually", "bad");
    }

    function handleSessionCreated(code: string) {
      roleRef.current = "host";
      setSessionCode(code);
      setLinkState("waiting");
      setMessages([]);
      setPeerOnline(false);
      setPeerTyping(false);
      patchSession({
        sessionCode: code,
        role: "host",
        peerOnline: false,
        messageCount: 0,
        fileCount: 0,
        callState: "idle",
      });
      logActivity(`Channel created: ${code}`, "good");
    }

    function handleJoinSuccess(code: string) {
      roleRef.current = "guest";
      setSessionCode(code);
      setLinkState("paired");
      setMessages([]);
      setPeerTyping(false);
      patchSession({
        sessionCode: code,
        role: "guest",
        messageCount: 0,
        fileCount: 0,
        callState: "idle",
      });
      logActivity(`Joined channel ${code}`, "good");
    }

    function handleJoinError(errorMessage: string) {
      Alert.alert("Could not join", errorMessage);
      setLinkState("error");
      logActivity(`Join failed: ${errorMessage}`, "bad");
    }

    function handleSessionConnected() {
      setLinkState("paired");
      setPeerOnline(true);
      patchSession({ peerOnline: true });
      logActivity("Peer joined the channel", "good");
    }

    function handleRejoinSuccess(payload: { sessionCode: string; peerOnline: boolean }) {
      setSessionCode(payload.sessionCode);
      setLinkState("paired");
      setPeerOnline(payload.peerOnline);
      patchSession({ sessionCode: payload.sessionCode, peerOnline: payload.peerOnline });
      logActivity("Rejoined channel after reconnect", "good");
    }

    function handleRejoinError(errorMessage: string) {
      Alert.alert("Channel expired", errorMessage);
      resetSessionState();
      setLinkState("closed");
      logActivity(`Rejoin failed: ${errorMessage}`, "bad");
    }

    function handlePeerOffline() {
      setPeerOnline(false);
      setPeerTyping(false);
      patchSession({ peerOnline: false });
      logActivity("Peer went offline", "bad");
    }

    function handlePeerReconnected() {
      setPeerOnline(true);
      patchSession({ peerOnline: true });
      logActivity("Peer reconnected", "good");
    }

    function handleReceiveMessage(receivedMessage: string) {
      const newMessage: ChatMessage = {
        id: makeMessageId(),
        kind: "text",
        text: receivedMessage,
        sender: "other",
        timestamp: timeNow(),
      };

      setPeerTyping(false);
      setMessages((current) => [...current, newMessage]);
      bumpMessageCount();
      logActivity(`Received: "${truncatePreview(receivedMessage)}"`, "info");
      playNotificationSound();
    }

    // ---- File transfer: receiving side ----

    function handleFileTransferStart(payload: {
      transferId: string;
      fileName: string;
      fileSize: number;
      mimeType: string;
      kind: MessageKind;
      totalChunks: number;
      durationMs?: number;
    }) {
      const messageId = makeMessageId();

      incomingTransfersRef.current[payload.transferId] = {
        chunks: new Array(payload.totalChunks),
        received: 0,
        totalChunks: payload.totalChunks,
        messageId,
        kind: payload.kind,
        fileName: payload.fileName,
        mimeType: payload.mimeType,
      };

      setPeerTyping(false);
      setMessages((current) => [
        ...current,
        {
          id: messageId,
          kind: payload.kind,
          sender: "other",
          timestamp: timeNow(),
          fileName: payload.fileName,
          fileSize: payload.fileSize,
          mimeType: payload.mimeType,
          durationMs: payload.durationMs,
          progress: 0,
        },
      ]);

      logActivity(`Receiving ${payload.kind}: ${payload.fileName}`, "info");
    }

    function handleFileTransferChunk(
      payload: {
        transferId: string;
        index?: number;
        chunkIndex?: number;
        data: string;
      },
      ack?: (response: { ok: boolean }) => void
    ) {
      const transfer = incomingTransfersRef.current[payload.transferId];
      const chunkIndex = payload.index ?? payload.chunkIndex;
      if (!transfer || chunkIndex === undefined) {
        ack?.({ ok: false });
        return;
      }

      transfer.chunks[chunkIndex] = payload.data;
      transfer.received += 1;

      const progress = Math.round((transfer.received / transfer.totalChunks) * 100);
      setMessages((current) =>
        current.map((m) => (m.id === transfer.messageId ? { ...m, progress } : m))
      );
      ack?.({ ok: true });
    }

    async function handleFileTransferEnd(payload: { transferId: string }) {
      const transfer = incomingTransfersRef.current[payload.transferId];
      if (!transfer) return;
      delete incomingTransfersRef.current[payload.transferId];

      const fullBase64 = transfer.chunks.join("");

      if (transfer.kind === "image") {
        setMessages((current) =>
          current.map((m) =>
            m.id === transfer.messageId ? { ...m, data: fullBase64, progress: 100 } : m
          )
        );
      } else {
        try {
          const path = `${FileSystem.documentDirectory}${Date.now()}-${transfer.fileName}`;
          await FileSystem.writeAsStringAsync(path, fullBase64, {
            encoding: FileSystem.EncodingType.Base64,
          });
          setMessages((current) =>
            current.map((m) =>
              m.id === transfer.messageId ? { ...m, localUri: path, progress: 100 } : m
            )
          );
        } catch (error) {
          console.warn("Could not save incoming file", error);
          logActivity(`Failed to save ${transfer.fileName}`, "bad");
        }
      }

      logActivity(`Received ${transfer.kind}: ${transfer.fileName}`, "good");
      bumpFileCount();
      playNotificationSound();
    }

    function handleSessionEnded() {
      cleanupCall();
      resetSessionState();
      setLinkState("closed");
      logActivity("Channel ended", "bad");
      Alert.alert("Channel closed", "The channel is no longer active.");
    }

    function handlePeerTyping() {
      setPeerTyping(true);
    }

    function handlePeerStopTyping() {
      setPeerTyping(false);
    }

    // ---- Call signaling ----

    function handleIncomingCall(payload: { offer: any }) {
      if (callStateRef.current !== "idle") {
        socket.emit("call-declined", { sessionCode: sessionCodeRef.current });
        return;
      }
      incomingOfferRef.current = payload.offer;
      setCallState("ringing");
      patchSession({ callState: "ringing" });
      setIncomingCall(true);
      logActivity("Incoming call", "info");
      playNotificationSound();
    }

    async function handleCallAccepted(payload: { answer: any }) {
      const pc = peerConnectionRef.current;
      if (!pc) return;
      await pc.setRemoteDescription(new RTCSessionDescription(payload.answer));
      await flushPendingCandidates(pc);
      setCallState("connected");
      patchSession({ callState: "connected" });
      logActivity("Call connected", "good");
    }

    function handleCallDeclined() {
      Alert.alert("Call declined", "The peer declined the call.");
      cleanupCall();
    }

    function handleCallEndedRemote() {
      cleanupCall();
      logActivity("Call ended", "info");
    }

    async function handleCallIceCandidate(payload: { candidate: any }) {
      const pc = peerConnectionRef.current;
      const candidate = new RTCIceCandidate(payload.candidate);
      if (pc && pc.remoteDescription) {
        await pc.addIceCandidate(candidate);
      } else {
        pendingCandidatesRef.current.push(candidate);
      }
    }

    socket.on("connect", handleConnect);
    socket.on("disconnect", handleDisconnect);
    socket.on("reconnect_attempt", handleReconnectAttempt);
    socket.on("reconnect_failed", handleReconnectFailed);
    socket.on("session-created", handleSessionCreated);
    socket.on("join-success", handleJoinSuccess);
    socket.on("join-error", handleJoinError);
    socket.on("session-connected", handleSessionConnected);
    socket.on("rejoin-success", handleRejoinSuccess);
    socket.on("rejoin-error", handleRejoinError);
    socket.on("peer-offline", handlePeerOffline);
    socket.on("peer-reconnected", handlePeerReconnected);
    socket.on("receive-message", handleReceiveMessage);
    socket.on("file-transfer-start", handleFileTransferStart);
    socket.on("file-transfer-chunk", handleFileTransferChunk);
    socket.on("file-transfer-end", handleFileTransferEnd);
    socket.on("session-ended", handleSessionEnded);
    socket.on("peer-typing", handlePeerTyping);
    socket.on("peer-stop-typing", handlePeerStopTyping);

    socket.on("incoming-call", handleIncomingCall);
    socket.on("call-accepted", handleCallAccepted);
    socket.on("call-declined", handleCallDeclined);
    socket.on("call-ice-candidate", handleCallIceCandidate);
    socket.on("call-ended", handleCallEndedRemote);

    if (socket.connected) {
      handleConnect();
    }

    return () => {
      socket.off("connect", handleConnect);
      socket.off("disconnect", handleDisconnect);
      socket.off("reconnect_attempt", handleReconnectAttempt);
      socket.off("reconnect_failed", handleReconnectFailed);
      socket.off("session-created", handleSessionCreated);
      socket.off("join-success", handleJoinSuccess);
      socket.off("join-error", handleJoinError);
      socket.off("session-connected", handleSessionConnected);
      socket.off("rejoin-success", handleRejoinSuccess);
      socket.off("rejoin-error", handleRejoinError);
      socket.off("peer-offline", handlePeerOffline);
      socket.off("peer-reconnected", handlePeerReconnected);
      socket.off("receive-message", handleReceiveMessage);
      socket.off("file-transfer-start", handleFileTransferStart);
      socket.off("file-transfer-chunk", handleFileTransferChunk);
      socket.off("file-transfer-end", handleFileTransferEnd);
      socket.off("session-ended", handleSessionEnded);
      socket.off("peer-typing", handlePeerTyping);
      socket.off("peer-stop-typing", handlePeerStopTyping);

      socket.off("incoming-call", handleIncomingCall);
      socket.off("call-accepted", handleCallAccepted);
      socket.off("call-declined", handleCallDeclined);
      socket.off("call-ice-candidate", handleCallIceCandidate);
      socket.off("call-ended", handleCallEndedRemote);

      if (typingTimeoutRef.current) clearTimeout(typingTimeoutRef.current);
      if (copyFeedbackTimeoutRef.current) clearTimeout(copyFeedbackTimeoutRef.current);
      if (recordingTimerRef.current) clearInterval(recordingTimerRef.current);
    };
    // This effect intentionally has no dependencies: it registers the socket
    // listeners exactly once. Call state is read via callStateRef.current
    // inside handleIncomingCall instead, so a call starting/ending no longer
    // tears down and re-creates every socket listener (which previously
    // re-ran handleConnect() -> emitted a spurious "rejoin-session" ->
    // server replied "Host slot already active" -> channel got reset).
  }, []);

  function createSession() {
    socket.emit("create-session");
    setLinkState("opening");
  }

  useEffect(() => {
    if (intent !== "create" || !intentStamp) return;
    if (lastCreateStamp.current === intentStamp) return;
    lastCreateStamp.current = intentStamp;
    createSession();
  }, [intent, intentStamp]);

  function joinSession() {
    const cleanedCode = joinCode.trim().toUpperCase();

    if (!cleanedCode) {
      Alert.alert("Missing code", "Enter a channel code first.");
      return;
    }

    socket.emit("join-session", cleanedCode);
    setLinkState("tuning");
  }

  function endChannel() {
    if (!sessionCode) return;

    Alert.alert("End channel?", "This closes the channel for both devices.", [
      { text: "Cancel", style: "cancel" },
      {
        text: "End channel",
        style: "destructive",
        onPress: () => {
          socket.emit("end-session", { sessionCode });
        },
      },
    ]);
  }

  async function copySessionCode() {
    if (!sessionCode) return;
    await Clipboard.setStringAsync(sessionCode);
    setCopyFeedback(true);
    logActivity("Channel code copied to clipboard", "info");
    if (copyFeedbackTimeoutRef.current) clearTimeout(copyFeedbackTimeoutRef.current);
    copyFeedbackTimeoutRef.current = setTimeout(() => setCopyFeedback(false), 1800);
  }

  function clearChat() {
    if (messages.length === 0) return;

    Alert.alert("Clear chat?", "This clears messages on this device only.", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Clear",
        style: "destructive",
        onPress: () => {
          setMessages([]);
          logActivity("Chat cleared", "info");
        },
      },
    ]);
  }

  // ---- Call handling ----

  function createPeerConnection() {
    const pc = new RTCPeerConnection(ICE_SERVERS);

    pc.addEventListener("icecandidate", (event: any) => {
      if (event.candidate) {
        socket.emit("call-ice-candidate", { sessionCode: sessionCodeRef.current, candidate: event.candidate });
      }
    });

    pc.addEventListener("connectionstatechange", () => {
      if (pc.connectionState === "connected") {
        setCallState("connected");
      }
      if (["failed", "disconnected", "closed"].includes(pc.connectionState)) {
        cleanupCall();
      }
    });

    if (isWeb) {
      pc.addEventListener("track", (event: any) => {
        const [remoteStream] = event.streams;
        let audioEl = document.getElementById("call-audio") as HTMLAudioElement | null;
        if (!audioEl) {
          audioEl = document.createElement("audio");
          audioEl.id = "call-audio";
          audioEl.autoplay = true;
          document.body.appendChild(audioEl);
        }
        audioEl.srcObject = remoteStream;
      });
    }

    peerConnectionRef.current = pc;
    return pc;
  }

  async function flushPendingCandidates(pc: any) {
    for (const candidate of pendingCandidatesRef.current) {
      await pc.addIceCandidate(candidate);
    }
    pendingCandidatesRef.current = [];
  }

  function cleanupCall() {
    localStreamRef.current?.getTracks().forEach((track: any) => track.stop());
    localStreamRef.current = null;

    peerConnectionRef.current?.close();
    peerConnectionRef.current = null;

    pendingCandidatesRef.current = [];
    incomingOfferRef.current = null;

    if (callTimerRef.current) {
      clearInterval(callTimerRef.current);
      callTimerRef.current = null;
    }

    setCallState("idle");
    patchSession({ callState: "idle" });
    setCallSeconds(0);
    setIsMuted(false);
    setIncomingCall(false);
  }

  async function startCall() {
    if (!canSendComputed()) {
      Alert.alert("No peer connected", "Wait for the other device before calling.");
      return;
    }
    if (callState !== "idle") return;

    try {
      const stream = await getMicStream();
      localStreamRef.current = stream;

      const pc = createPeerConnection();
      stream.getTracks().forEach((track: any) => pc.addTrack(track, stream));

      const offer = await pc.createOffer({});
      await pc.setLocalDescription(offer);

      setCallState("calling");
      patchSession({ callState: "calling" });
      socket.emit("call-user", { sessionCode, offer });
      logActivity("Calling peer...", "info");
    } catch (error) {
      console.warn("startCall failed", error);
      Alert.alert("Call failed", "Could not access the microphone.");
      cleanupCall();
    }
  }

  async function acceptCall() {
    const offer = incomingOfferRef.current;
    if (!offer) return;

    try {
      const stream = await getMicStream();
      localStreamRef.current = stream;

      const pc = createPeerConnection();
      stream.getTracks().forEach((track: any) => pc.addTrack(track, stream));

      await pc.setRemoteDescription(new RTCSessionDescription(offer));
      await flushPendingCandidates(pc);

      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);

      socket.emit("call-accepted", { sessionCode, answer });
      setIncomingCall(false);
      setCallState("connected");
      patchSession({ callState: "connected" });
      logActivity("Call connected", "good");
    } catch (error) {
      console.warn("acceptCall failed", error);
      Alert.alert("Call failed", "Could not access the microphone.");
      declineCall();
    }
  }

  function declineCall() {
    socket.emit("call-declined", { sessionCode });
    cleanupCall();
  }

  function endCall() {
    if (sessionCode && callState !== "idle") {
      socket.emit("call-ended", { sessionCode });
    }
    cleanupCall();
  }

  function toggleMute() {
    const stream = localStreamRef.current;
    if (!stream) return;
    const nextEnabled = isMuted; // currently muted -> re-enable
    stream.getAudioTracks().forEach((track: any) => {
      track.enabled = nextEnabled;
    });
    setIsMuted((m) => !m);
  }

  function handleMessageChange(text: string) {
    setMessage(text);

    if (!sessionCode) return;

    if (text.trim().length === 0) {
      stopTyping();
      return;
    }

    if (!isTypingRef.current) {
      isTypingRef.current = true;
      socket.emit("typing", { sessionCode });
    }

    if (typingTimeoutRef.current) clearTimeout(typingTimeoutRef.current);

    typingTimeoutRef.current = setTimeout(() => {
      stopTyping();
    }, TYPING_TIMEOUT_MS);
  }

  function stopTyping() {
    if (typingTimeoutRef.current) {
      clearTimeout(typingTimeoutRef.current);
      typingTimeoutRef.current = null;
    }

    if (isTypingRef.current) {
      isTypingRef.current = false;
      if (sessionCode) {
        socket.emit("stop-typing", { sessionCode });
      }
    }
  }

  function dispatchMessage(text: string, id: string) {
    setMessages((current) => current.map((m) => (m.id === id ? { ...m, status: "sending" } : m)));

    let settled = false;

    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      setMessages((current) => current.map((m) => (m.id === id ? { ...m, status: "failed" } : m)));
      logActivity(`Message timed out: "${truncatePreview(text)}"`, "bad");
    }, SEND_ACK_TIMEOUT_MS);

    socket.emit(
      "send-message",
      { sessionCode, message: text, messageId: id },
      (response: { ok: boolean; messageId: string; error?: string }) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);

        setMessages((current) =>
          current.map((m) => (m.id === id ? { ...m, status: response.ok ? "delivered" : "failed" } : m))
        );

        if (response.ok) {
          bumpMessageCount();
          logActivity(`Sent: "${truncatePreview(text)}"`, "good");
        } else {
          logActivity(`Message failed to send: "${truncatePreview(text)}"`, "bad");
        }
      }
    );
  }

  function sendMessage() {
    const cleanedMessage = message.trim();

    if (!cleanedMessage) return;

    if (!sessionCode || !peerOnline) {
      Alert.alert("No peer connected", "Wait for the other device before sending.");
      return;
    }

    stopTyping();

    const id = makeMessageId();
    const newMessage: ChatMessage = {
      id,
      kind: "text",
      text: cleanedMessage,
      sender: "me",
      timestamp: timeNow(),
      status: "sending",
    };

    setMessages((current) => [...current, newMessage]);
    setMessage("");
    dispatchMessage(cleanedMessage, id);
  }

  function retryMessage(chatMessage: ChatMessage) {
    if (!peerOnline) {
      Alert.alert("No peer connected", "Wait for the other device before retrying.");
      return;
    }
    if (chatMessage.kind === "text" && chatMessage.text) {
      dispatchMessage(chatMessage.text, chatMessage.id);
    }
    // Failed file/image transfers are simplest to re-send from the picker
    // again rather than resume — chunk-level resume isn't implemented yet.
  }

  // ---- File transfer: sending side ----

  async function sendAttachment(
    uri: string,
    fileName: string,
    mimeType: string,
    kind: MessageKind,
    durationMs?: number
  ) {
    if (!sessionCode || !peerOnline) {
      Alert.alert("No peer connected", "Wait for the other device before sending.");
      return;
    }

    try {
      let fileSize = 0;
      let base64 = "";

      if (Platform.OS === "web") {
        const response = await fetch(uri);
        const blob = await response.blob();

        fileSize = blob.size;

        base64 = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader();

          reader.onloadend = () => {
            if (typeof reader.result !== "string") {
              reject(new Error("Failed to read file"));
              return;
            }

            resolve(reader.result.split(",")[1]);
          };

          reader.onerror = reject;
          reader.readAsDataURL(blob);
        });
      } else {
        const info = await FileSystem.getInfoAsync(uri);
        fileSize = info.exists && "size" in info ? info.size ?? 0 : 0;

        base64 = await FileSystem.readAsStringAsync(uri, {
          encoding: FileSystem.EncodingType.Base64,
        });
      }

      if (fileSize > MAX_FILE_BYTES) {
        Alert.alert(
          "File too large",
          `Files are limited to ${formatFileSize(MAX_FILE_BYTES)} for now.`
        );
        return;
      }

      const totalChunks = Math.max(1, Math.ceil(base64.length / CHUNK_SIZE));

      const transferId = makeMessageId();

      const localMessage: ChatMessage = {
        id: transferId,
        kind,
        sender: "me",
        timestamp: timeNow(),
        fileName,
        fileSize,
        mimeType,
        data: kind === "image" ? base64 : undefined,
        localUri: uri,
        status: "sending",
        progress: 0,
        durationMs,
      };

      setMessages((current) => [...current, localMessage]);
      logActivity(`Sending ${kind}: ${fileName}`, "info");

      const start = await emitAck<{ ok: boolean; error?: string }>("file-transfer-start", {
        transferId,
        sessionCode,
        name: fileName,
        size: fileSize,
        mimeType,
        totalChunks,
        kind,
        durationMs,
      });

      if (!start?.ok) {
        setMessages((current) =>
          current.map((m) => (m.id === transferId ? { ...m, status: "failed" } : m))
        );
        logActivity(`Failed to start transfer: ${fileName}`, "bad");
        return;
      }

      for (let chunkIndex = 0; chunkIndex < totalChunks; chunkIndex++) {
        const chunk = base64.slice(chunkIndex * CHUNK_SIZE, (chunkIndex + 1) * CHUNK_SIZE);

        const chunkAck = await emitAck<{ ok: boolean }>("file-transfer-chunk", {
          transferId,
          sessionCode,
          index: chunkIndex,
          data: chunk,
        });

        if (!chunkAck?.ok) {
          setMessages((current) =>
            current.map((m) => (m.id === transferId ? { ...m, status: "failed", progress: Math.round(((chunkIndex + 1) / totalChunks) * 100) } : m))
          );
          logActivity(`Failed to send ${fileName}`, "bad");
          return;
        }

        const progress = Math.round(((chunkIndex + 1) / totalChunks) * 100);
        setMessages((current) => current.map((m) => (m.id === transferId ? { ...m, progress } : m)));
      }

      const end = await emitAck<{ ok: boolean; error?: string }>("file-transfer-end", {
        transferId,
        sessionCode,
      });

      setMessages((current) =>
        current.map((m) =>
          m.id === transferId
            ? {
                ...m,
                status: end?.ok ? "delivered" : "failed",
                progress: 100,
              }
            : m
        )
      );

      if (end?.ok) {
        bumpFileCount();
        logActivity(`Sent ${kind}: ${fileName}`, "good");
      } else {
        logActivity(`Failed to send ${fileName}`, "bad");
      }
    } catch (error) {
      console.warn("sendAttachment failed", error);
      Alert.alert("Couldn't send that", "Something went wrong reading the file.");
    }
  }

  async function startRecording() {
    if (!canSendComputed()) {
      Alert.alert("No peer connected", "Wait for the other device before recording.");
      return;
    }

    try {
      const permission = await Audio.requestPermissionsAsync();
      if (!permission.granted) {
        Alert.alert("Permission needed", "Microphone access is required to record voice messages.");
        return;
      }

      await Audio.setAudioModeAsync({ allowsRecordingIOS: true, playsInSilentModeIOS: true });
      const { recording: newRecording } = await Audio.Recording.createAsync(
        Audio.RecordingOptionsPresets.HIGH_QUALITY
      );

      setRecording(newRecording);
      setIsRecording(true);
      setRecordingSeconds(0);
      recordingTimerRef.current = setInterval(() => {
        setRecordingSeconds((current) => current + 1);
      }, 1000);
      logActivity("Voice recording started", "info");
    } catch (error) {
      console.warn("Could not start recording", error);
      Alert.alert("Recording failed", "The microphone could not be started.");
    }
  }

  async function stopRecording() {
    if (!recording) return;

    try {
      if (recordingTimerRef.current) {
        clearInterval(recordingTimerRef.current);
        recordingTimerRef.current = null;
      }

      const statusBeforeStop = await recording.getStatusAsync();
      await recording.stopAndUnloadAsync();
      const uri = recording.getURI();

      const durationMs = statusBeforeStop.durationMillis ?? recordingSeconds * 1000;
      setRecording(null);
      setIsRecording(false);
      setRecordingSeconds(0);
      await Audio.setAudioModeAsync({ allowsRecordingIOS: false, playsInSilentModeIOS: true });

      if (!uri) throw new Error("Recording URI missing");
      const extension = Platform.OS === "web" ? "webm" : "m4a";
      const mimeType = Platform.OS === "web" ? "audio/webm" : "audio/m4a";
      await sendAttachment(uri, `voice-${Date.now()}.${extension}`, mimeType, "voice", durationMs);
    } catch (error) {
      console.warn("Could not stop recording", error);
      setRecording(null);
      setIsRecording(false);
      setRecordingSeconds(0);
      Alert.alert("Voice message failed", "The recording could not be sent.");
    }
  }

  async function toggleVoicePlayback(chatMessage: ChatMessage) {
    if (!chatMessage.localUri) return;

    try {
      if (playingVoiceId === chatMessage.id && voiceSoundRef.current) {
        const status = await voiceSoundRef.current.getStatusAsync();
        if (status.isLoaded && status.isPlaying) {
          await voiceSoundRef.current.pauseAsync();
          setPlayingVoiceId(null);
          return;
        }
      }

      if (voiceSoundRef.current) {
        await voiceSoundRef.current.unloadAsync();
        voiceSoundRef.current = null;
      }

      const { sound } = await Audio.Sound.createAsync(
        { uri: chatMessage.localUri },
        { shouldPlay: true }
      );
      voiceSoundRef.current = sound;
      setPlayingVoiceId(chatMessage.id);
      sound.setOnPlaybackStatusUpdate((status) => {
        if (status.isLoaded && status.didJustFinish) {
          setPlayingVoiceId(null);
          sound.unloadAsync();
          if (voiceSoundRef.current === sound) voiceSoundRef.current = null;
        }
      });
    } catch (error) {
      console.warn("Could not play voice message", error);
      Alert.alert("Playback failed", "This voice message could not be played.");
    }
  }

  async function pickImage() {
    const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!permission.granted) {
      Alert.alert("Permission needed", "Photo library access is required to send images.");
      return;
    }

    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ["images"],
      quality: 0.7,
    });

    if (result.canceled || !result.assets?.[0]) return;

    const asset = result.assets[0];
    const fileName = asset.fileName ?? `photo-${Date.now()}.jpg`;
    const mimeType = asset.mimeType ?? "image/jpeg";
    sendAttachment(asset.uri, fileName, mimeType, "image");
  }

  async function pickDocument() {
    const result = await DocumentPicker.getDocumentAsync({
      type: "*/*",
      copyToCacheDirectory: true,
    });

    if (result.canceled || !result.assets?.[0]) return;

    const asset = result.assets[0];
    sendAttachment(asset.uri, asset.name, asset.mimeType ?? "application/octet-stream", "file");
  }

  function openAttachmentPicker() {
    if (!canSendComputed()) {
      Alert.alert("No peer connected", "Wait for the other device before sending.");
      return;
    }

    Alert.alert("Send attachment", undefined, [
      { text: "Photo", onPress: pickImage },
      { text: "File", onPress: pickDocument },
      { text: "Cancel", style: "cancel" },
    ]);
  }

  async function openReceivedFile(chatMessage: ChatMessage) {
    if (!chatMessage.localUri) return;
    const canShare = await Sharing.isAvailableAsync();
    if (canShare) {
      Sharing.shareAsync(chatMessage.localUri, { mimeType: chatMessage.mimeType });
    } else {
      Alert.alert("Saved", `File saved to app storage as ${chatMessage.fileName}`);
    }
  }

  function canSendComputed() {
    return sessionCode !== "" && peerOnline;
  }

  function handleMessageKeyPress(event: any) {
    const nativeEvent = event?.nativeEvent ?? {};
    if (nativeEvent.key === "Enter" && !nativeEvent.shiftKey) {
      event.preventDefault?.();
      sendMessage();
    }
  }

  const signalLevel = SIGNAL_LEVEL[linkState];
  const canSend = canSendComputed();

  return (
    <View style={styles.container}>
      <View style={[styles.inner, wide && { maxWidth: maxContentWidth, width: "100%", alignSelf: "center" }]}>
      {incomingCall && (
        <View style={styles.callOverlay}>
          <View style={styles.callCard}>
            <Feather name="phone-incoming" size={28} color={C.accent} />
            <Text style={styles.callTitle}>Incoming call</Text>
            <Text style={styles.callSubtitle}>Your peer wants to talk</Text>
            <View style={styles.callActions}>
              <Pressable onPress={acceptCall} style={styles.callAccept}>
                <Text style={styles.callAcceptText}>Answer</Text>
              </Pressable>
              <Pressable onPress={declineCall} style={styles.callDecline}>
                <Text style={styles.callDeclineText}>Decline</Text>
              </Pressable>
            </View>
          </View>
        </View>
      )}

      <View style={styles.header}>
        <Text style={styles.eyebrow}>CONNECTIONAPP</Text>

        <View
          style={{
            flexDirection: "row",
            alignItems: "center",
            justifyContent: "space-between",
          }}
        >
          <Text style={styles.title}>Connect</Text>

          <Pressable onPress={startCall} disabled={callState !== "idle"} style={styles.headerCallButton}>
            <Feather name="phone" size={20} color={callState !== "idle" ? C.textFaint : C.accent} />
          </Pressable>
        </View>
      </View>

      <Pressable style={styles.statusRow} onPress={() => setShowLog((v) => !v)}>
        <View style={styles.statusRowLeft}>
          <View style={[styles.statusDot, { backgroundColor: DOT_COLOR[linkState] }]} />
          <SignalBars level={signalLevel} />
          <Text style={styles.statusText}>{STATUS_COPY[linkState]}</Text>
        </View>
        <Text style={styles.logToggle}>{showLog ? "HIDE LOG ▲" : "LOG ▼"}</Text>
      </Pressable>

      {showLog ? (
        <View style={styles.logPanel}>
          {activityLog.length === 0 ? (
            <Text style={styles.logPanelEmpty}>No activity yet.</Text>
          ) : (
            <ScrollView
              ref={logScrollRef}
              style={styles.logPanelScroll}
              onContentSizeChange={() => logScrollRef.current?.scrollToEnd({ animated: true })}
            >
              {activityLog.map((entry) => (
                <View key={entry.id} style={styles.logEntryRow}>
                  <Text
                    style={[
                      styles.logEntryDot,
                      entry.kind === "good" && styles.logEntryDotGood,
                      entry.kind === "bad" && styles.logEntryDotBad,
                    ]}
                  >
                    ●
                  </Text>
                  <Text style={styles.logEntryTime}>{entry.time}</Text>
                  <Text style={styles.logEntryText}>{entry.text}</Text>
                </View>
              ))}
            </ScrollView>
          )}
        </View>
      ) : null}

      {sessionCode === "" ? (
        <View style={styles.lobby}>
          <AnimatedPressable style={styles.primaryButton} onPress={createSession}>
            <Text style={styles.primaryButtonText}>Open a Channel</Text>
          </AnimatedPressable>

          <View style={styles.dividerRow}>
            <View style={styles.dividerLine} />
            <Text style={styles.dividerText}>OR JOIN</Text>
            <View style={styles.dividerLine} />
          </View>

          <View style={styles.dial}>
            <Text style={styles.dialLabel}>CHANNEL CODE</Text>
            <TextInput
              style={styles.dialInput}
              placeholder="000000"
              placeholderTextColor="#4B5344"
              value={joinCode}
              onChangeText={setJoinCode}
              onKeyPress={(e) => {
                const nativeEvent = e?.nativeEvent ?? ({} as any);
                if ((nativeEvent as any).key === "Enter") {
                  joinSession();
                }
              }}
              autoCapitalize="characters"
              maxLength={6}
            />
          </View>

          <AnimatedPressable style={styles.secondaryButton} onPress={joinSession}>
            <Text style={styles.secondaryButtonText}>Join Channel</Text>
          </AnimatedPressable>
        </View>
      ) : (
        <View style={styles.session}>
          <View style={styles.readout}>
            <View style={styles.readoutHeader}>
              <Text style={styles.readoutLabel}>CHANNEL</Text>
              <View style={styles.peerDotRow}>
                <View style={[styles.peerDot, { backgroundColor: peerOnline ? "#5DCAA5" : "#4B5344" }]} />
                <Text style={styles.peerDotLabel}>{peerOnline ? "PEER ONLINE" : "PEER OFFLINE"}</Text>
                {peerOnline ? <Text style={styles.timerText}>· {formatElapsed(elapsedSeconds)}</Text> : null}
              </View>
            </View>

            <View style={styles.readoutDigits}>
              {sessionCode.split("").map((char, index) => (
                <View key={`${char}-${index}`} style={styles.digitCell}>
                  <Text style={styles.digitText}>{char}</Text>
                </View>
              ))}
            </View>

            <View style={styles.readoutActions}>
              <AnimatedPressable style={styles.copyButton} onPress={copySessionCode}>
                <Text style={styles.copyButtonText}>{copyFeedback ? "COPIED ✓" : "COPY CODE"}</Text>
              </AnimatedPressable>
              <AnimatedPressable style={styles.clearButton} onPress={clearChat}>
                <Text style={styles.clearButtonText}>CLEAR CHAT</Text>
              </AnimatedPressable>
              <AnimatedPressable style={styles.endButton} onPress={endChannel}>
                <Text style={styles.endButtonText}>END CHANNEL</Text>
              </AnimatedPressable>
            </View>
          </View>

          {callState === "calling" || callState === "connected" ? (
            <View style={styles.recordingBanner}>
              <Text style={styles.recordingText}>
                {callState === "calling" ? "Calling…" : `On call ${formatElapsed(callSeconds)}`}
              </Text>
              <Pressable onPress={toggleMute} style={{ paddingHorizontal: 8 }}>
                <Feather name={isMuted ? "mic-off" : "mic"} size={16} color={C.text} />
              </Pressable>
              <Pressable onPress={endCall} style={{ paddingHorizontal: 8 }}>
                <Text style={{ color: C.danger, fontFamily: mono, fontSize: 12 }}>End</Text>
              </Pressable>
            </View>
          ) : null}

          <ScrollView
            ref={scrollViewRef}
            style={styles.log}
            contentContainerStyle={styles.logContent}
            onContentSizeChange={() => scrollViewRef.current?.scrollToEnd({ animated: true })}
          >
            {messages.length === 0 ? (
              <View style={styles.emptyState}>
                <Text style={styles.emptyStateIcon}>📡</Text>
                <Text style={styles.emptyText}>Channel is quiet.</Text>
                <Text style={styles.emptySubtext}>Send the first transmission.</Text>
              </View>
            ) : (
              messages.map((chatMessage) => (
                <View
                  key={chatMessage.id}
                  style={[
                    styles.bubbleRow,
                    chatMessage.sender === "me" ? styles.bubbleRowMe : styles.bubbleRowOther,
                  ]}
                >
                  <Pressable
                    disabled={chatMessage.status !== "failed" && chatMessage.kind !== "file"}
                    onPress={() => {
                      if (chatMessage.status === "failed") retryMessage(chatMessage);
                      else if (chatMessage.kind === "file" && chatMessage.localUri) openReceivedFile(chatMessage);
                    }}
                    style={[
                      styles.bubble,
                      chatMessage.sender === "me" ? styles.bubbleMe : styles.bubbleOther,
                    ]}
                  >
                    {chatMessage.kind === "text" ? (
                      <Text style={styles.logText}>{chatMessage.text}</Text>
                    ) : chatMessage.kind === "image" ? (
                      <Pressable
                        onPress={() =>
                          chatMessage.data &&
                          setViewerImage({
                            uri: `data:${chatMessage.mimeType || "image/jpeg"};base64,${chatMessage.data}`,
                          })
                        }
                      >
                        {chatMessage.data ? (
                          <Image
                            source={{ uri: `data:${chatMessage.mimeType || "image/jpeg"};base64,${chatMessage.data}` }}
                            style={styles.imageThumb}
                            resizeMode="cover"
                          />
                        ) : (
                          <View style={styles.imagePlaceholder}>
                            <Text style={styles.imagePlaceholderText}>🖼️ receiving…</Text>
                          </View>
                        )}
                      </Pressable>
                    ) : chatMessage.kind === "voice" ? (
                      <Pressable style={styles.voiceCard} onPress={() => toggleVoicePlayback(chatMessage)}>
                        <Text style={styles.voicePlayButton}>
                          {playingVoiceId === chatMessage.id ? "❚❚" : "▶"}
                        </Text>
                        <View style={styles.voiceInfo}>
                          <Text style={styles.voiceLabel}>VOICE MESSAGE</Text>
                          <Text style={styles.voiceDuration}>
                            {formatElapsed(Math.round((chatMessage.durationMs ?? 0) / 1000))}
                          </Text>
                        </View>
                      </Pressable>
                    ) : (
                      <View style={styles.fileCard}>
                        <Text style={styles.fileGlyph}>{fileGlyph(chatMessage.mimeType)}</Text>
                        <View style={styles.fileCardInfo}>
                          <Text style={styles.fileCardName} numberOfLines={1}>
                            {chatMessage.fileName}
                          </Text>
                          <Text style={styles.fileCardSize}>{formatFileSize(chatMessage.fileSize)}</Text>
                        </View>
                      </View>
                    )}

                    {chatMessage.progress !== undefined && chatMessage.progress < 100 ? (
                      <View style={styles.progressTrack}>
                        <View style={[styles.progressFill, { width: `${chatMessage.progress}%` }]} />
                      </View>
                    ) : null}

                    <View style={styles.bubbleFooter}>
                      <Text style={styles.timeText}>{chatMessage.timestamp}</Text>
                      {chatMessage.sender === "me" && chatMessage.status ? (
                        <Text
                          style={[styles.statusText2, chatMessage.status === "failed" && styles.statusFailed]}
                        >
                          {chatMessage.status === "sending" &&
                            (chatMessage.progress !== undefined && chatMessage.progress < 100
                              ? `○ ${chatMessage.progress}%`
                              : "○ sending…")}
                          {chatMessage.status === "delivered" && "✓✓ delivered"}
                          {chatMessage.status === "failed" && "⚠ failed — tap to retry"}
                        </Text>
                      ) : null}
                      {chatMessage.sender === "other" && chatMessage.kind === "file" && chatMessage.localUri ? (
                        <Text style={styles.statusText2}>tap to open</Text>
                      ) : null}
                    </View>
                  </Pressable>
                </View>
              ))
            )}

            {peerTyping ? <Text style={styles.typingText}>Peer is transmitting...</Text> : null}
          </ScrollView>

          {isRecording ? (
            <View style={styles.recordingBanner}>
              <Text style={styles.recordingDot}>●</Text>
              <Text style={styles.recordingText}>RECORDING {formatElapsed(recordingSeconds)}</Text>
              <Text style={styles.recordingHint}>tap stop to send</Text>
            </View>
          ) : null}

          <View style={styles.sendRow}>
            <AnimatedPressable
              style={[styles.attachButton, !canSend && styles.attachButtonDisabled]}
              onPress={openAttachmentPicker}
              disabled={!canSend}
            >
              <Text style={styles.attachButtonText}>📎</Text>
            </AnimatedPressable>

            <AnimatedPressable
              style={[
                styles.micButton,
                !canSend && styles.attachButtonDisabled,
                isRecording && styles.micButtonRecording,
              ]}
              onPress={isRecording ? stopRecording : startRecording}
              disabled={!canSend}
            >
              <Text style={styles.micButtonText}>{isRecording ? "■" : "🎤"}</Text>
            </AnimatedPressable>

            <TextInput
              style={[styles.messageInput, !canSend && styles.messageInputDisabled]}
              placeholder={canSend ? "transmit..." : "waiting for peer..."}
              placeholderTextColor="#4B5344"
              value={message}
              onChangeText={handleMessageChange}
              onSubmitEditing={sendMessage}
              onKeyPress={handleMessageKeyPress}
              returnKeyType="send"
              editable={canSend}
              blurOnSubmit={false}
            />

            <AnimatedPressable
              style={[styles.sendButton, !canSend && styles.sendButtonDisabled]}
              onPress={sendMessage}
              disabled={!canSend}
            >
              <Text style={styles.sendButtonText}>SEND</Text>
            </AnimatedPressable>
          </View>
        </View>
      )}

      <Modal visible={!!viewerImage} transparent animationType="fade" onRequestClose={() => setViewerImage(null)}>
        <Pressable style={styles.viewerBackdrop} onPress={() => setViewerImage(null)}>
          {viewerImage ? (
            <Image source={{ uri: viewerImage.uri }} style={styles.viewerImage} resizeMode="contain" />
          ) : null}
        </Pressable>
      </Modal>
      </View>
    </View>
  );
}

function SignalBars({ level }: { level: number }) {
  const heights = [6, 10, 14, 18];
  return (
    <View style={styles.bars}>
      {heights.map((h, i) => (
        <View key={i} style={[styles.bar, { height: h, backgroundColor: i < level ? "#C9A227" : "#3A4033" }]} />
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: C.bg,
  },

  inner: {
    flex: 1,
    padding: 24,
    paddingTop: 64,
  },

  header: {
    marginBottom: 24,
  },

  eyebrow: {
    color: C.textFaint,
    fontSize: 11,
    letterSpacing: 2,
    fontFamily: mono,
    marginBottom: 6,
  },

  title: {
    color: C.text,
    fontSize: 30,
    fontWeight: "700",
    letterSpacing: 0.5,
  },

  statusRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    backgroundColor: C.surface,
    borderWidth: 1,
    borderColor: C.border,
    borderRadius: R.md,
    paddingVertical: 13,
    paddingHorizontal: 16,
    marginBottom: 14,
  },

  statusRowLeft: {
    flexDirection: "row",
    alignItems: "center",
  },

  statusDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    marginRight: 10,
  },

  bars: {
    flexDirection: "row",
    alignItems: "flex-end",
    gap: 3,
    marginRight: 12,
  },

  bar: {
    width: 4,
    borderRadius: 1,
  },

  statusText: {
    color: C.textMuted,
    fontSize: 12,
    fontFamily: mono,
    letterSpacing: 0.5,
  },

  logToggle: {
    color: C.textFaint,
    fontSize: 10,
    fontFamily: mono,
    letterSpacing: 1,
  },

  logPanel: {
    backgroundColor: C.surfaceAlt,
    borderWidth: 1,
    borderColor: C.border,
    borderRadius: R.md,
    marginBottom: 18,
    paddingHorizontal: 14,
    paddingVertical: 12,
  },

  logPanelEmpty: {
    color: C.textFaint,
    fontFamily: mono,
    fontSize: 12,
    textAlign: "center",
    paddingVertical: 8,
  },

  logPanelScroll: {
    maxHeight: 150,
  },

  logEntryRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: 4,
    gap: 8,
  },

  logEntryDot: {
    color: C.textFaint,
    fontSize: 8,
  },

  logEntryDotGood: {
    color: C.accent,
  },

  logEntryDotBad: {
    color: C.danger,
  },

  logEntryTime: {
    color: C.textFaint,
    fontFamily: mono,
    fontSize: 10,
    width: 62,
  },

  logEntryText: {
    color: C.textMuted,
    fontFamily: mono,
    fontSize: 11,
    flexShrink: 1,
  },

  lobby: {
    flex: 1,
    justifyContent: "center",
  },

  primaryButton: {
    backgroundColor: C.accent,
    paddingVertical: 17,
    borderRadius: R.md,
  },

  primaryButtonText: {
    color: C.bg,
    textAlign: "center",
    fontSize: 16,
    fontWeight: "700",
    letterSpacing: 0.3,
  },

  dividerRow: {
    flexDirection: "row",
    alignItems: "center",
    marginVertical: 30,
  },

  dividerLine: {
    flex: 1,
    height: 1,
    backgroundColor: C.border,
  },

  dividerText: {
    color: C.textFaint,
    fontSize: 11,
    fontFamily: mono,
    letterSpacing: 1.5,
    marginHorizontal: 12,
  },

  dial: {
    marginBottom: 18,
  },

  dialLabel: {
    color: C.textMuted,
    fontSize: 11,
    fontFamily: mono,
    letterSpacing: 1.5,
    marginBottom: 9,
  },

  dialInput: {
    backgroundColor: C.surface,
    borderWidth: 1,
    borderColor: C.border,
    borderRadius: R.md,
    color: C.text,
    padding: 16,
    fontSize: 22,
    fontFamily: mono,
    textAlign: "center",
    letterSpacing: 6,
  },

  secondaryButton: {
    borderWidth: 1,
    borderColor: C.accent,
    paddingVertical: 16,
    borderRadius: R.md,
  },

  secondaryButtonText: {
    color: C.accent,
    textAlign: "center",
    fontSize: 16,
    fontWeight: "600",
  },

  session: {
    flex: 1,
  },

  readout: {
    backgroundColor: C.surface,
    borderWidth: 1,
    borderColor: C.border,
    borderRadius: R.md,
    paddingVertical: 16,
    paddingHorizontal: 18,
    alignItems: "center",
    marginBottom: 18,
  },

  readoutHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    width: "100%",
    marginBottom: 12,
  },

  readoutLabel: {
    color: C.textFaint,
    fontSize: 10,
    fontFamily: mono,
    letterSpacing: 2,
  },

  peerDotRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },

  peerDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
  },

  peerDotLabel: {
    color: C.textMuted,
    fontSize: 10,
    fontFamily: mono,
    letterSpacing: 1,
  },

  timerText: {
    color: C.textFaint,
    fontFamily: mono,
    fontSize: 10,
  },

  readoutDigits: {
    flexDirection: "row",
    gap: 6,
    marginBottom: 16,
  },

  digitCell: {
    backgroundColor: C.bgElevated,
    borderWidth: 1,
    borderColor: C.border,
    borderRadius: R.sm,
    width: 30,
    paddingVertical: 6,
    alignItems: "center",
  },

  digitText: {
    color: C.accent,
    fontSize: 18,
    fontFamily: mono,
    fontWeight: "700",
  },

  readoutActions: {
    flexDirection: "row",
    flexWrap: "wrap",
    justifyContent: "center",
    gap: 9,
  },

  copyButton: {
    borderWidth: 1,
    borderColor: C.border,
    borderRadius: R.sm,
    paddingVertical: 9,
    paddingHorizontal: 13,
  },

  copyButtonText: {
    color: C.textMuted,
    fontSize: 10,
    fontFamily: mono,
    letterSpacing: 1,
  },

  clearButton: {
    borderWidth: 1,
    borderColor: C.border,
    borderRadius: R.sm,
    paddingVertical: 9,
    paddingHorizontal: 13,
  },

  clearButtonText: {
    color: C.textMuted,
    fontSize: 10,
    fontFamily: mono,
    letterSpacing: 1,
  },

  endButton: {
    borderWidth: 1,
    borderColor: C.danger,
    borderRadius: R.sm,
    paddingVertical: 9,
    paddingHorizontal: 13,
  },

  endButtonText: {
    color: C.danger,
    fontSize: 10,
    fontFamily: mono,
    letterSpacing: 1,
  },

  log: {
    flex: 1,
    backgroundColor: C.surface,
    borderWidth: 1,
    borderColor: C.border,
    borderRadius: R.md,
    marginBottom: 14,
  },

  logContent: {
    padding: 16,
    flexGrow: 1,
  },

  emptyState: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: 40,
  },

  emptyStateIcon: {
    fontSize: 28,
    marginBottom: 10,
    opacity: 0.6,
  },

  emptyText: {
    color: C.textMuted,
    fontFamily: mono,
    fontSize: 14,
    textAlign: "center",
    fontWeight: "600",
  },

  emptySubtext: {
    color: C.textFaint,
    fontFamily: mono,
    fontSize: 12,
    textAlign: "center",
    marginTop: 4,
  },

  bubbleRow: {
    marginVertical: 6,
    flexDirection: "row",
  },

  bubbleRowMe: {
    justifyContent: "flex-end",
  },

  bubbleRowOther: {
    justifyContent: "flex-start",
  },

  bubble: {
    maxWidth: "78%",
    borderRadius: R.md,
    paddingVertical: 9,
    paddingHorizontal: 13,
  },

  bubbleMe: {
    backgroundColor: C.accentSoft,
    borderWidth: 1,
    borderColor: C.accentDim,
  },

  bubbleOther: {
    backgroundColor: C.surfaceAlt,
    borderWidth: 1,
    borderColor: C.border,
  },

  logText: {
    color: C.text,
    fontSize: 15,
    flexShrink: 1,
    flexWrap: "wrap",
  },

  imageThumb: {
    width: 200,
    height: 200,
    borderRadius: R.md,
    backgroundColor: C.bgElevated,
  },

  imagePlaceholder: {
    width: 200,
    height: 200,
    borderRadius: R.md,
    backgroundColor: C.bgElevated,
    alignItems: "center",
    justifyContent: "center",
  },

  imagePlaceholderText: {
    color: C.textFaint,
    fontFamily: mono,
    fontSize: 12,
  },

  voiceCard: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    minWidth: 190,
    paddingVertical: 4,
  },

  voicePlayButton: {
    color: C.accent,
    fontSize: 22,
    width: 30,
    textAlign: "center",
  },

  voiceInfo: {
    flex: 1,
  },

  voiceLabel: {
    color: C.text,
    fontSize: 12,
    fontFamily: mono,
    letterSpacing: 1,
  },

  voiceDuration: {
    color: C.textFaint,
    fontSize: 11,
    fontFamily: mono,
    marginTop: 3,
  },

  fileCard: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    minWidth: 180,
  },

  fileGlyph: {
    fontSize: 26,
  },

  fileCardInfo: {
    flexShrink: 1,
  },

  fileCardName: {
    color: C.text,
    fontSize: 14,
    fontFamily: mono,
  },

  fileCardSize: {
    color: C.textFaint,
    fontSize: 11,
    fontFamily: mono,
    marginTop: 2,
  },

  progressTrack: {
    height: 4,
    borderRadius: 2,
    backgroundColor: C.bgElevated,
    marginTop: 8,
    overflow: "hidden",
  },

  progressFill: {
    height: 4,
    backgroundColor: C.accent,
  },

  bubbleFooter: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginTop: 5,
    gap: 10,
  },

  timeText: {
    color: C.textFaint,
    fontFamily: mono,
    fontSize: 10,
  },

  statusText2: {
    color: C.textFaint,
    fontFamily: mono,
    fontSize: 10,
  },

  statusFailed: {
    color: C.danger,
  },

  typingText: {
    color: C.accent,
    fontFamily: mono,
    fontSize: 12,
    fontStyle: "italic",
    marginTop: 6,
  },

  recordingBanner: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    marginBottom: 10,
    paddingHorizontal: 12,
    paddingVertical: 9,
    borderRadius: R.md,
    backgroundColor: C.surface,
    borderWidth: 1,
    borderColor: C.danger,
  },

  recordingDot: {
    color: C.danger,
    fontSize: 12,
  },

  recordingText: {
    color: C.text,
    fontFamily: mono,
    fontSize: 12,
    flex: 1,
  },

  recordingHint: {
    color: C.textFaint,
    fontFamily: mono,
    fontSize: 10,
  },

  sendRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
  },

  attachButton: {
    width: 48,
    height: 48,
    borderRadius: R.md,
    borderWidth: 1,
    borderColor: C.border,
    backgroundColor: C.surface,
    alignItems: "center",
    justifyContent: "center",
  },

  micButton: {
    width: 48,
    height: 48,
    borderRadius: R.md,
    borderWidth: 1,
    borderColor: C.border,
    backgroundColor: C.surface,
    alignItems: "center",
    justifyContent: "center",
  },

  micButtonRecording: {
    backgroundColor: C.surface,
    borderColor: C.danger,
  },

  micButtonText: {
    fontSize: 18,
    color: C.text,
  },

  attachButtonDisabled: {
    opacity: 0.5,
  },

  attachButtonText: {
    fontSize: 20,
  },

  messageInput: {
    flex: 1,
    backgroundColor: C.surface,
    borderWidth: 1,
    borderColor: C.border,
    borderRadius: R.md,
    color: C.text,
    padding: 15,
    fontSize: 15,
    fontFamily: mono,
  },

  messageInputDisabled: {
    opacity: 0.5,
  },

  sendButton: {
    backgroundColor: C.accent,
    paddingVertical: 15,
    paddingHorizontal: 19,
    borderRadius: R.md,
  },

  sendButtonDisabled: {
    backgroundColor: C.accentDim,
    opacity: 0.55,
  },

  sendButtonText: {
    color: C.bg,
    fontSize: 13,
    fontFamily: mono,
    fontWeight: "700",
    letterSpacing: 0.5,
  },

  viewerBackdrop: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.95)",
    alignItems: "center",
    justifyContent: "center",
  },

  viewerImage: {
    width: "100%",
    height: "80%",
  },

  headerCallButton: {
    width: 44,
    height: 44,
    borderRadius: R.md,
    borderWidth: 1,
    borderColor: C.border,
    backgroundColor: C.surface,
    alignItems: "center",
    justifyContent: "center",
  },

  callOverlay: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: "rgba(5,7,10,0.92)",
    justifyContent: "center",
    alignItems: "center",
    zIndex: 999,
    padding: 24,
  },

  callCard: {
    width: "100%",
    maxWidth: 360,
    backgroundColor: C.surface,
    borderWidth: 1,
    borderColor: C.border,
    borderRadius: R.lg,
    padding: 24,
    alignItems: "center",
    gap: 8,
  },

  callTitle: {
    color: C.text,
    fontSize: 22,
    fontWeight: "700",
    marginTop: 8,
  },

  callSubtitle: {
    color: C.textMuted,
    marginBottom: 16,
  },

  callActions: {
    width: "100%",
    gap: 10,
  },

  callAccept: {
    backgroundColor: C.accent,
    paddingVertical: 14,
    borderRadius: R.md,
    alignItems: "center",
  },

  callAcceptText: {
    color: C.bg,
    fontWeight: "700",
  },

  callDecline: {
    backgroundColor: C.surfaceAlt,
    borderWidth: 1,
    borderColor: C.danger,
    paddingVertical: 14,
    borderRadius: R.md,
    alignItems: "center",
  },

  callDeclineText: {
    color: C.danger,
    fontWeight: "700",
  },
});