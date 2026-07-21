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

import { Audio } from "expo-av";
import * as Clipboard from "expo-clipboard";
import * as DocumentPicker from "expo-document-picker";
import * as FileSystem from "expo-file-system/legacy";
import * as ImagePicker from "expo-image-picker";
import * as Sharing from "expo-sharing";
import { io } from "socket.io-client";

const socket = io("http://192.168.1.48:3000", {
  transports: ["websocket"],
  reconnection: true,
  reconnectionAttempts: 15,
  reconnectionDelay: 1000,
  reconnectionDelayMax: 6000,
});

type MessageStatus = "sending" | "delivered" | "failed";
type MessageKind = "text" | "image" | "file";

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
  localUri?: string; // on-disk path once a "file" kind has been saved
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
  tuning: "TUNING IN",
  paired: "CHANNEL PAIRED",
  reconnecting: "RECONNECTING...",
  lost: "CONNECTION LOST",
  closed: "PEER SIGNED OFF",
  error: "COULD NOT TUNE IN",
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

export default function HomeScreen() {
  const [sessionCode, setSessionCode] = useState("");
  const [joinCode, setJoinCode] = useState("");
  const [linkState, setLinkState] = useState<LinkState>("connecting");
  const [peerOnline, setPeerOnline] = useState(false);
  const [peerTyping, setPeerTyping] = useState(false);

  const [message, setMessage] = useState("");
  const [messages, setMessages] = useState<ChatMessage[]>([]);

  const [activityLog, setActivityLog] = useState<ActivityEntry[]>([]);
  const [showLog, setShowLog] = useState(false);
  const [copyFeedback, setCopyFeedback] = useState(false);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [viewerImage, setViewerImage] = useState<{ uri: string } | null>(null);

  const scrollViewRef = useRef<ScrollView>(null);
  const logScrollRef = useRef<ScrollView>(null);
  const typingTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const copyFeedbackTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isTypingRef = useRef(false);
  const roleRef = useRef<"host" | "guest" | null>(null);
  const sessionCodeRef = useRef("");
  const pairedAtRef = useRef<number | null>(null);
  const notificationSoundRef = useRef<Audio.Sound | null>(null);

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
      logActivity(`Channel created: ${code}`, "good");
    }

    function handleJoinSuccess(code: string) {
      roleRef.current = "guest";
      setSessionCode(code);
      setLinkState("paired");
      setMessages([]);
      setPeerTyping(false);
      logActivity(`Tuned in to channel ${code}`, "good");
    }

    function handleJoinError(errorMessage: string) {
      Alert.alert("Could not tune in", errorMessage);
      setLinkState("error");
      logActivity(`Join failed: ${errorMessage}`, "bad");
    }

    function handleSessionConnected() {
      setLinkState("paired");
      setPeerOnline(true);
      logActivity("Peer joined the channel", "good");
    }

    function handleRejoinSuccess(payload: { sessionCode: string; peerOnline: boolean }) {
      setSessionCode(payload.sessionCode);
      setLinkState("paired");
      setPeerOnline(payload.peerOnline);
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
      logActivity("Peer went offline", "bad");
    }

    function handlePeerReconnected() {
      setPeerOnline(true);
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
          progress: 0,
        },
      ]);

      logActivity(`Receiving ${payload.kind}: ${payload.fileName}`, "info");
    }

    function handleFileTransferChunk(payload: {
      transferId: string;
      chunkIndex: number;
      data: string;
    }) {
      const transfer = incomingTransfersRef.current[payload.transferId];
      if (!transfer) return;

      transfer.chunks[payload.chunkIndex] = payload.data;
      transfer.received += 1;

      const progress = Math.round((transfer.received / transfer.totalChunks) * 100);
      setMessages((current) =>
        current.map((m) => (m.id === transfer.messageId ? { ...m, progress } : m))
      );
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
      playNotificationSound();
    }

    function handleSessionEnded() {
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

      if (typingTimeoutRef.current) clearTimeout(typingTimeoutRef.current);
      if (copyFeedbackTimeoutRef.current) clearTimeout(copyFeedbackTimeoutRef.current);
    };
  }, []);

  function createSession() {
    socket.emit("create-session");
    setLinkState("opening");
  }

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
    kind: MessageKind
  ) {
    if (!sessionCode || !peerOnline) {
      Alert.alert("No peer connected", "Wait for the other device before sending.");
      return;
    }
  
    try {
      const info = await FileSystem.getInfoAsync(uri);
      const fileSize = info.exists && "size" in info ? info.size ?? 0 : 0;
  
      if (fileSize > MAX_FILE_BYTES) {
        Alert.alert(
          "File too large",
          `Files are limited to ${formatFileSize(MAX_FILE_BYTES)} for now.`
        );
        return;
      }
  
      const base64 = await FileSystem.readAsStringAsync(uri, {
        encoding: FileSystem.EncodingType.Base64,
      });
  
      const totalChunks = Math.max(
        1,
        Math.ceil(base64.length / CHUNK_SIZE)
      );
  
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
      };
  
      setMessages((current) => [...current, localMessage]);
      logActivity(`Sending ${kind}: ${fileName}`, "info");
  
      socket.emit(
        "file-transfer-start",
        {
          transferId,
          sessionCode,
          name: fileName,
          size: fileSize,
          mimeType,
          totalChunks,
        },
        (response: { ok: boolean; error?: string }) => {
          console.log("START ACK:", response);
        }
      );
  
      for (let chunkIndex = 0; chunkIndex < totalChunks; chunkIndex++) {
        const chunk = base64.slice(
          chunkIndex * CHUNK_SIZE,
          (chunkIndex + 1) * CHUNK_SIZE
        );
  
        socket.emit(
          "file-transfer-chunk",
          {
            transferId,
            sessionCode,
            index: chunkIndex,
            data: chunk,
          },
          (response: { ok: boolean }) => {
            console.log("CHUNK ACK:", response);
          }
        );
  
        const progress = Math.round(
          ((chunkIndex + 1) / totalChunks) * 100
        );
  
        setMessages((current) =>
          current.map((m) =>
            m.id === transferId ? { ...m, progress } : m
          )
        );
      }
  
      socket.emit(
        "file-transfer-end",
        { transferId, sessionCode },
        (response: { ok: boolean; error?: string }) => {
          setMessages((current) =>
            current.map((m) =>
              m.id === transferId
                ? {
                    ...m,
                    status: response?.ok ? "delivered" : "failed",
                    progress: 100,
                  }
                : m
            )
          );
  
          if (response?.ok) {
            logActivity(`Sent ${kind}: ${fileName}`, "good");
          } else {
            logActivity(`Failed to send ${fileName}`, "bad");
          }
        }
      );
    } catch (error) {
      console.warn("sendAttachment failed", error);
      Alert.alert(
        "Couldn't send that",
        "Something went wrong reading the file."
      );
    }
  }

  async function pickImage() {
    const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!permission.granted) {
      Alert.alert("Permission needed", "Photo library access is required to send images.");
      return;
    }

    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ImagePicker.MediaTypeOptions.Images,
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
      <View style={styles.header}>
        <Text style={styles.eyebrow}>PEER-TO-PEER · SHORT RANGE</Text>
        <Text style={styles.title}>Field Link</Text>
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
            <Text style={styles.dividerText}>OR TUNE IN</Text>
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
            <Text style={styles.secondaryButtonText}>Tune In</Text>
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

          <View style={styles.sendRow}>
            <AnimatedPressable
              style={[styles.attachButton, !canSend && styles.attachButtonDisabled]}
              onPress={openAttachmentPicker}
              disabled={!canSend}
            >
              <Text style={styles.attachButtonText}>📎</Text>
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
  container: { flex: 1, padding: 24, paddingTop: 64, backgroundColor: "#14170F" },
  header: { marginBottom: 24 },
  eyebrow: { color: "#7C8570", fontSize: 11, letterSpacing: 2, fontFamily: mono, marginBottom: 6 },
  title: { color: "#EDE9DC", fontSize: 30, fontWeight: "700", letterSpacing: 0.5 },
  statusRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    backgroundColor: "#1B2016",
    borderWidth: 1,
    borderColor: "#2B3122",
    borderRadius: 8,
    paddingVertical: 13,
    paddingHorizontal: 16,
    marginBottom: 14,
  },
  statusRowLeft: { flexDirection: "row", alignItems: "center" },
  statusDot: { width: 8, height: 8, borderRadius: 4, marginRight: 10 },
  bars: { flexDirection: "row", alignItems: "flex-end", gap: 3, marginRight: 12 },
  bar: { width: 4, borderRadius: 1 },
  statusText: { color: "#B9C0AC", fontSize: 12, fontFamily: mono, letterSpacing: 0.5 },
  logToggle: { color: "#7C8570", fontSize: 10, fontFamily: mono, letterSpacing: 1 },
  logPanel: {
    backgroundColor: "#171B12",
    borderWidth: 1,
    borderColor: "#2B3122",
    borderRadius: 8,
    marginBottom: 18,
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
  logPanelEmpty: { color: "#5F6653", fontFamily: mono, fontSize: 12, textAlign: "center", paddingVertical: 8 },
  logPanelScroll: { maxHeight: 150 },
  logEntryRow: { flexDirection: "row", alignItems: "center", paddingVertical: 4, gap: 8 },
  logEntryDot: { color: "#7C8570", fontSize: 8 },
  logEntryDotGood: { color: "#5DCAA5" },
  logEntryDotBad: { color: "#E0645A" },
  logEntryTime: { color: "#5F6653", fontFamily: mono, fontSize: 10, width: 62 },
  logEntryText: { color: "#B9C0AC", fontFamily: mono, fontSize: 11, flexShrink: 1 },
  lobby: { flex: 1, justifyContent: "center" },
  primaryButton: {
    backgroundColor: "#C9A227",
    paddingVertical: 17,
    borderRadius: 8,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.25,
    shadowRadius: 4,
    elevation: 3,
  },
  primaryButtonText: { color: "#14170F", textAlign: "center", fontSize: 16, fontWeight: "700", letterSpacing: 0.3 },
  dividerRow: { flexDirection: "row", alignItems: "center", marginVertical: 30 },
  dividerLine: { flex: 1, height: 1, backgroundColor: "#2B3122" },
  dividerText: { color: "#5F6653", fontSize: 11, fontFamily: mono, letterSpacing: 1.5, marginHorizontal: 12 },
  dial: { marginBottom: 18 },
  dialLabel: { color: "#7C8570", fontSize: 11, fontFamily: mono, letterSpacing: 1.5, marginBottom: 9 },
  dialInput: {
    backgroundColor: "#1B2016",
    borderWidth: 1,
    borderColor: "#2B3122",
    borderRadius: 8,
    color: "#EDE9DC",
    padding: 16,
    fontSize: 22,
    fontFamily: mono,
    textAlign: "center",
    letterSpacing: 6,
  },
  secondaryButton: { borderWidth: 1, borderColor: "#C9A227", paddingVertical: 16, borderRadius: 8 },
  secondaryButtonText: { color: "#C9A227", textAlign: "center", fontSize: 16, fontWeight: "600", letterSpacing: 0.3 },
  session: { flex: 1 },
  readout: {
    backgroundColor: "#1B2016",
    borderWidth: 1,
    borderColor: "#2B3122",
    borderRadius: 8,
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
  readoutLabel: { color: "#7C8570", fontSize: 10, fontFamily: mono, letterSpacing: 2 },
  peerDotRow: { flexDirection: "row", alignItems: "center", gap: 6 },
  peerDot: { width: 6, height: 6, borderRadius: 3 },
  peerDotLabel: { color: "#7C8570", fontSize: 10, fontFamily: mono, letterSpacing: 1 },
  timerText: { color: "#5F6653", fontFamily: mono, fontSize: 10 },
  readoutDigits: { flexDirection: "row", gap: 6, marginBottom: 16 },
  digitCell: {
    backgroundColor: "#14170F",
    borderWidth: 1,
    borderColor: "#3A4033",
    borderRadius: 5,
    width: 30,
    paddingVertical: 6,
    alignItems: "center",
  },
  digitText: { color: "#C9A227", fontSize: 18, fontFamily: mono, fontWeight: "700" },
  readoutActions: { flexDirection: "row", flexWrap: "wrap", justifyContent: "center", gap: 9 },
  copyButton: { borderWidth: 1, borderColor: "#3A4033", borderRadius: 6, paddingVertical: 9, paddingHorizontal: 13 },
  copyButtonText: { color: "#B9C0AC", fontSize: 10, fontFamily: mono, letterSpacing: 1 },
  clearButton: { borderWidth: 1, borderColor: "#3A4033", borderRadius: 6, paddingVertical: 9, paddingHorizontal: 13 },
  clearButtonText: { color: "#B9C0AC", fontSize: 10, fontFamily: mono, letterSpacing: 1 },
  endButton: { borderWidth: 1, borderColor: "#4B2A2A", borderRadius: 6, paddingVertical: 9, paddingHorizontal: 13 },
  endButtonText: { color: "#D4877A", fontSize: 10, fontFamily: mono, letterSpacing: 1 },
  log: { flex: 1, backgroundColor: "#1B2016", borderWidth: 1, borderColor: "#2B3122", borderRadius: 8, marginBottom: 14 },
  logContent: { padding: 16, flexGrow: 1 },
  emptyState: { flex: 1, alignItems: "center", justifyContent: "center", paddingVertical: 40 },
  emptyStateIcon: { fontSize: 28, marginBottom: 10, opacity: 0.6 },
  emptyText: { color: "#8A9280", fontFamily: mono, fontSize: 14, textAlign: "center", fontWeight: "600" },
  emptySubtext: { color: "#5F6653", fontFamily: mono, fontSize: 12, textAlign: "center", marginTop: 4 },
  bubbleRow: { marginVertical: 6, flexDirection: "row" },
  bubbleRowMe: { justifyContent: "flex-end" },
  bubbleRowOther: { justifyContent: "flex-start" },
  bubble: { maxWidth: "78%", borderRadius: 10, paddingVertical: 9, paddingHorizontal: 13 },
  bubbleMe: { backgroundColor: "#26301F" },
  bubbleOther: { backgroundColor: "#20241A" },
  logText: { color: "#EDE9DC", fontSize: 15, flexShrink: 1, flexWrap: "wrap" },
  imageThumb: { width: 200, height: 200, borderRadius: 8, backgroundColor: "#14170F" },
  imagePlaceholder: {
    width: 200,
    height: 200,
    borderRadius: 8,
    backgroundColor: "#14170F",
    alignItems: "center",
    justifyContent: "center",
  },
  imagePlaceholderText: { color: "#7C8570", fontFamily: mono, fontSize: 12 },
  fileCard: { flexDirection: "row", alignItems: "center", gap: 10, minWidth: 180 },
  fileGlyph: { fontSize: 26 },
  fileCardInfo: { flexShrink: 1 },
  fileCardName: { color: "#EDE9DC", fontSize: 14, fontFamily: mono },
  fileCardSize: { color: "#7C8570", fontSize: 11, fontFamily: mono, marginTop: 2 },
  progressTrack: {
    height: 4,
    borderRadius: 2,
    backgroundColor: "#14170F",
    marginTop: 8,
    overflow: "hidden",
  },
  progressFill: { height: 4, backgroundColor: "#C9A227" },
  bubbleFooter: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginTop: 5, gap: 10 },
  timeText: { color: "#5F6653", fontFamily: mono, fontSize: 10 },
  statusText2: { color: "#5F6653", fontFamily: mono, fontSize: 10 },
  statusFailed: { color: "#D4877A" },
  typingText: { color: "#7C8570", fontFamily: mono, fontSize: 12, fontStyle: "italic", marginTop: 6 },
  sendRow: { flexDirection: "row", alignItems: "center", gap: 10 },
  attachButton: {
    width: 48,
    height: 48,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: "#2B3122",
    backgroundColor: "#1B2016",
    alignItems: "center",
    justifyContent: "center",
  },
  attachButtonDisabled: { opacity: 0.5 },
  attachButtonText: { fontSize: 20 },
  messageInput: {
    flex: 1,
    backgroundColor: "#1B2016",
    borderWidth: 1,
    borderColor: "#2B3122",
    borderRadius: 8,
    color: "#EDE9DC",
    padding: 15,
    fontSize: 15,
    fontFamily: mono,
  },
  messageInputDisabled: { opacity: 0.5 },
  sendButton: { backgroundColor: "#C9A227", paddingVertical: 15, paddingHorizontal: 19, borderRadius: 8 },
  sendButtonDisabled: { backgroundColor: "#4B4326" },
  sendButtonText: { color: "#14170F", fontSize: 13, fontFamily: mono, fontWeight: "700", letterSpacing: 0.5 },
  viewerBackdrop: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.92)",
    alignItems: "center",
    justifyContent: "center",
  },
  viewerImage: { width: "100%", height: "80%" },
});