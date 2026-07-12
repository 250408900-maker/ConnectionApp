import { useEffect, useRef, useState } from "react";

import {
  Alert,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";

import * as Clipboard from "expo-clipboard";
import { io } from "socket.io-client";

const socket = io("http://192.168.1.54:3000", {
  transports: ["websocket"],
  reconnection: true,
  reconnectionAttempts: 15,
  reconnectionDelay: 1000,
  reconnectionDelayMax: 6000,
});

type MessageStatus = "sending" | "delivered" | "failed";

type ChatMessage = {
  id: string;
  text: string;
  sender: "me" | "other";
  timestamp: string;
  status?: MessageStatus;
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

// 🟢 good, 🟡 in-progress, 🔴 bad
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

const mono = Platform.select({ ios: "Menlo", android: "monospace", default: "monospace" });

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

  const scrollViewRef = useRef<ScrollView>(null);
  const logScrollRef = useRef<ScrollView>(null);
  const typingTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const copyFeedbackTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isTypingRef = useRef(false);
  const roleRef = useRef<"host" | "guest" | null>(null);
  const sessionCodeRef = useRef("");
  const pairedAtRef = useRef<number | null>(null);

  useEffect(() => {
    sessionCodeRef.current = sessionCode;
  }, [sessionCode]);

  function logActivity(text: string, kind: ActivityEntry["kind"] = "info") {
    setActivityLog((current) => {
      const next = [
        ...current,
        { id: makeMessageId(), text, time: timeNowPrecise(), kind },
      ];
      return next.length > MAX_LOG_ENTRIES ? next.slice(next.length - MAX_LOG_ENTRIES) : next;
    });
  }

  // Connection timer: counts up while the channel is paired with the peer online.
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
    function resetSessionState() {
      setSessionCode("");
      setMessages([]);
      setPeerOnline(false);
      setPeerTyping(false);
      roleRef.current = null;
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
      logActivity(`Channel opened: ${code}`, "good");
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
        text: receivedMessage,
        sender: "other",
        timestamp: timeNow(),
      };

      setPeerTyping(false);
      setMessages((current) => [...current, newMessage]);
    }

    function handleSessionEnded() {
      resetSessionState();
      setLinkState("closed");
      logActivity("Channel closed", "bad");
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
      socket.off("session-ended", handleSessionEnded);
      socket.off("peer-typing", handlePeerTyping);
      socket.off("peer-stop-typing", handlePeerStopTyping);

      if (typingTimeoutRef.current) {
        clearTimeout(typingTimeoutRef.current);
      }
      if (copyFeedbackTimeoutRef.current) {
        clearTimeout(copyFeedbackTimeoutRef.current);
      }
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
    if (copyFeedbackTimeoutRef.current) {
      clearTimeout(copyFeedbackTimeoutRef.current);
    }
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

    if (typingTimeoutRef.current) {
      clearTimeout(typingTimeoutRef.current);
    }

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
    setMessages((current) =>
      current.map((m) => (m.id === id ? { ...m, status: "sending" } : m))
    );

    let settled = false;

    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      setMessages((current) =>
        current.map((m) => (m.id === id ? { ...m, status: "failed" } : m))
      );
    }, SEND_ACK_TIMEOUT_MS);

    socket.emit(
      "send-message",
      { sessionCode, message: text, messageId: id },
      (response: { ok: boolean; messageId: string; error?: string }) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);

        setMessages((current) =>
          current.map((m) =>
            m.id === id ? { ...m, status: response.ok ? "delivered" : "failed" } : m
          )
        );
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
    dispatchMessage(chatMessage.text, chatMessage.id);
  }

  const signalLevel = SIGNAL_LEVEL[linkState];
  const canSend = sessionCode !== "" && peerOnline;

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
          <Pressable style={styles.primaryButton} onPress={createSession}>
            <Text style={styles.primaryButtonText}>Open a Channel</Text>
          </Pressable>

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
              autoCapitalize="characters"
              maxLength={6}
            />
          </View>

          <Pressable style={styles.secondaryButton} onPress={joinSession}>
            <Text style={styles.secondaryButtonText}>Tune In</Text>
          </Pressable>
        </View>
      ) : (
        <View style={styles.session}>
          <View style={styles.readout}>
            <View style={styles.readoutHeader}>
              <Text style={styles.readoutLabel}>CHANNEL</Text>
              <View style={styles.peerDotRow}>
                <View
                  style={[
                    styles.peerDot,
                    { backgroundColor: peerOnline ? "#5DCAA5" : "#4B5344" },
                  ]}
                />
                <Text style={styles.peerDotLabel}>
                  {peerOnline ? "PEER ONLINE" : "PEER OFFLINE"}
                </Text>
                {peerOnline ? (
                  <Text style={styles.timerText}>· {formatElapsed(elapsedSeconds)}</Text>
                ) : null}
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
              <Pressable style={styles.copyButton} onPress={copySessionCode}>
                <Text style={styles.copyButtonText}>
                  {copyFeedback ? "COPIED ✓" : "COPY CODE"}
                </Text>
              </Pressable>
              <Pressable style={styles.clearButton} onPress={clearChat}>
                <Text style={styles.clearButtonText}>CLEAR CHAT</Text>
              </Pressable>
              <Pressable style={styles.endButton} onPress={endChannel}>
                <Text style={styles.endButtonText}>END CHANNEL</Text>
              </Pressable>
            </View>
          </View>

          <ScrollView
            ref={scrollViewRef}
            style={styles.log}
            contentContainerStyle={styles.logContent}
            onContentSizeChange={() =>
              scrollViewRef.current?.scrollToEnd({ animated: true })
            }
          >
            {messages.length === 0 ? (
              <Text style={styles.emptyText}>
                Channel is quiet. Send the first transmission.
              </Text>
            ) : (
              messages.map((chatMessage) => (
                <View
                  key={chatMessage.id}
                  style={[
                    styles.bubbleRow,
                    chatMessage.sender === "me"
                      ? styles.bubbleRowMe
                      : styles.bubbleRowOther,
                  ]}
                >
                  <Pressable
                    disabled={chatMessage.status !== "failed"}
                    onPress={() => retryMessage(chatMessage)}
                    style={[
                      styles.bubble,
                      chatMessage.sender === "me" ? styles.bubbleMe : styles.bubbleOther,
                    ]}
                  >
                    <Text style={styles.logText}>{chatMessage.text}</Text>
                    <View style={styles.bubbleFooter}>
                      <Text style={styles.timeText}>{chatMessage.timestamp}</Text>
                      {chatMessage.sender === "me" && chatMessage.status ? (
                        <Text
                          style={[
                            styles.statusText2,
                            chatMessage.status === "failed" && styles.statusFailed,
                          ]}
                        >
                          {chatMessage.status === "sending" && "sending…"}
                          {chatMessage.status === "delivered" && "delivered"}
                          {chatMessage.status === "failed" && "failed — tap to retry"}
                        </Text>
                      ) : null}
                    </View>
                  </Pressable>
                </View>
              ))
            )}

            {peerTyping ? (
              <Text style={styles.typingText}>Peer is transmitting...</Text>
            ) : null}
          </ScrollView>

          <View style={styles.sendRow}>
            <TextInput
              style={[styles.messageInput, !canSend && styles.messageInputDisabled]}
              placeholder={canSend ? "transmit..." : "waiting for peer..."}
              placeholderTextColor="#4B5344"
              value={message}
              onChangeText={handleMessageChange}
              onSubmitEditing={sendMessage}
              returnKeyType="send"
              editable={canSend}
            />

            <Pressable
              style={[styles.sendButton, !canSend && styles.sendButtonDisabled]}
              onPress={sendMessage}
              disabled={!canSend}
            >
              <Text style={styles.sendButtonText}>SEND</Text>
            </Pressable>
          </View>
        </View>
      )}
    </View>
  );
}

function SignalBars({ level }: { level: number }) {
  const heights = [6, 10, 14, 18];
  return (
    <View style={styles.bars}>
      {heights.map((h, i) => (
        <View
          key={i}
          style={[
            styles.bar,
            {
              height: h,
              backgroundColor: i < level ? "#C9A227" : "#3A4033",
            },
          ]}
        />
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    padding: 24,
    paddingTop: 64,
    backgroundColor: "#14170F",
  },
  header: { marginBottom: 22 },
  eyebrow: {
    color: "#7C8570",
    fontSize: 11,
    letterSpacing: 2,
    fontFamily: mono,
    marginBottom: 6,
  },
  title: {
    color: "#EDE9DC",
    fontSize: 30,
    fontWeight: "700",
    letterSpacing: 0.5,
  },
  statusRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    backgroundColor: "#1B2016",
    borderWidth: 1,
    borderColor: "#2B3122",
    borderRadius: 6,
    paddingVertical: 12,
    paddingHorizontal: 14,
    marginBottom: 12,
  },
  statusRowLeft: { flexDirection: "row", alignItems: "center" },
  statusDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    marginRight: 10,
  },
  bars: { flexDirection: "row", alignItems: "flex-end", gap: 3, marginRight: 12 },
  bar: { width: 4, borderRadius: 1 },
  statusText: { color: "#B9C0AC", fontSize: 12, fontFamily: mono, letterSpacing: 0.5 },
  logToggle: { color: "#7C8570", fontSize: 10, fontFamily: mono, letterSpacing: 1 },
  logPanel: {
    backgroundColor: "#171B12",
    borderWidth: 1,
    borderColor: "#2B3122",
    borderRadius: 6,
    marginBottom: 16,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  logPanelEmpty: {
    color: "#5F6653",
    fontFamily: mono,
    fontSize: 12,
    textAlign: "center",
    paddingVertical: 8,
  },
  logPanelScroll: { maxHeight: 150 },
  logEntryRow: { flexDirection: "row", alignItems: "center", paddingVertical: 3, gap: 8 },
  logEntryDot: { color: "#7C8570", fontSize: 8 },
  logEntryDotGood: { color: "#5DCAA5" },
  logEntryDotBad: { color: "#E0645A" },
  logEntryTime: { color: "#5F6653", fontFamily: mono, fontSize: 10, width: 62 },
  logEntryText: { color: "#B9C0AC", fontFamily: mono, fontSize: 11, flexShrink: 1 },
  lobby: { flex: 1, justifyContent: "center" },
  primaryButton: {
    backgroundColor: "#C9A227",
    paddingVertical: 16,
    borderRadius: 6,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.25,
    shadowRadius: 4,
    elevation: 3,
  },
  primaryButtonText: {
    color: "#14170F",
    textAlign: "center",
    fontSize: 16,
    fontWeight: "700",
    letterSpacing: 0.3,
  },
  dividerRow: { flexDirection: "row", alignItems: "center", marginVertical: 28 },
  dividerLine: { flex: 1, height: 1, backgroundColor: "#2B3122" },
  dividerText: {
    color: "#5F6653",
    fontSize: 11,
    fontFamily: mono,
    letterSpacing: 1.5,
    marginHorizontal: 12,
  },
  dial: { marginBottom: 16 },
  dialLabel: {
    color: "#7C8570",
    fontSize: 11,
    fontFamily: mono,
    letterSpacing: 1.5,
    marginBottom: 8,
  },
  dialInput: {
    backgroundColor: "#1B2016",
    borderWidth: 1,
    borderColor: "#2B3122",
    borderRadius: 6,
    color: "#EDE9DC",
    padding: 16,
    fontSize: 22,
    fontFamily: mono,
    textAlign: "center",
    letterSpacing: 6,
  },
  secondaryButton: {
    borderWidth: 1,
    borderColor: "#C9A227",
    paddingVertical: 15,
    borderRadius: 6,
  },
  secondaryButtonText: {
    color: "#C9A227",
    textAlign: "center",
    fontSize: 16,
    fontWeight: "600",
    letterSpacing: 0.3,
  },
  session: { flex: 1 },
  readout: {
    backgroundColor: "#1B2016",
    borderWidth: 1,
    borderColor: "#2B3122",
    borderRadius: 6,
    paddingVertical: 14,
    paddingHorizontal: 16,
    alignItems: "center",
    marginBottom: 16,
  },
  readoutHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    width: "100%",
    marginBottom: 10,
  },
  readoutLabel: { color: "#7C8570", fontSize: 10, fontFamily: mono, letterSpacing: 2 },
  peerDotRow: { flexDirection: "row", alignItems: "center", gap: 6 },
  peerDot: { width: 6, height: 6, borderRadius: 3 },
  peerDotLabel: { color: "#7C8570", fontSize: 10, fontFamily: mono, letterSpacing: 1 },
  timerText: { color: "#5F6653", fontFamily: mono, fontSize: 10 },
  readoutDigits: { flexDirection: "row", gap: 6, marginBottom: 14 },
  digitCell: {
    backgroundColor: "#14170F",
    borderWidth: 1,
    borderColor: "#3A4033",
    borderRadius: 4,
    width: 30,
    paddingVertical: 6,
    alignItems: "center",
  },
  digitText: { color: "#C9A227", fontSize: 18, fontFamily: mono, fontWeight: "700" },
  readoutActions: {
    flexDirection: "row",
    flexWrap: "wrap",
    justifyContent: "center",
    gap: 8,
  },
  copyButton: {
    borderWidth: 1,
    borderColor: "#3A4033",
    borderRadius: 5,
    paddingVertical: 8,
    paddingHorizontal: 12,
  },
  copyButtonText: { color: "#B9C0AC", fontSize: 10, fontFamily: mono, letterSpacing: 1 },
  clearButton: {
    borderWidth: 1,
    borderColor: "#3A4033",
    borderRadius: 5,
    paddingVertical: 8,
    paddingHorizontal: 12,
  },
  clearButtonText: { color: "#B9C0AC", fontSize: 10, fontFamily: mono, letterSpacing: 1 },
  endButton: {
    borderWidth: 1,
    borderColor: "#4B2A2A",
    borderRadius: 5,
    paddingVertical: 8,
    paddingHorizontal: 12,
  },
  endButtonText: { color: "#D4877A", fontSize: 10, fontFamily: mono, letterSpacing: 1 },
  log: {
    flex: 1,
    backgroundColor: "#1B2016",
    borderWidth: 1,
    borderColor: "#2B3122",
    borderRadius: 6,
    marginBottom: 12,
  },
  logContent: { padding: 14 },
  emptyText: { color: "#5F6653", fontFamily: mono, fontSize: 13, textAlign: "center", marginTop: 24 },
  bubbleRow: { marginVertical: 6, flexDirection: "row" },
  bubbleRowMe: { justifyContent: "flex-end" },
  bubbleRowOther: { justifyContent: "flex-start" },
  bubble: {
    maxWidth: "78%",
    borderRadius: 8,
    paddingVertical: 8,
    paddingHorizontal: 12,
  },
  bubbleMe: { backgroundColor: "#26301F" },
  bubbleOther: { backgroundColor: "#20241A" },
  logText: { color: "#EDE9DC", fontSize: 15, flexShrink: 1, flexWrap: "wrap" },
  bubbleFooter: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginTop: 4,
    gap: 10,
  },
  timeText: { color: "#5F6653", fontFamily: mono, fontSize: 10 },
  statusText2: { color: "#5F6653", fontFamily: mono, fontSize: 10 },
  statusFailed: { color: "#D4877A" },
  typingText: {
    color: "#7C8570",
    fontFamily: mono,
    fontSize: 12,
    fontStyle: "italic",
    marginTop: 6,
  },
  sendRow: { flexDirection: "row", alignItems: "center" },
  messageInput: {
    flex: 1,
    backgroundColor: "#1B2016",
    borderWidth: 1,
    borderColor: "#2B3122",
    borderRadius: 6,
    color: "#EDE9DC",
    padding: 14,
    fontSize: 15,
    fontFamily: mono,
    marginRight: 8,
  },
  messageInputDisabled: { opacity: 0.5 },
  sendButton: {
    backgroundColor: "#C9A227",
    paddingVertical: 14,
    paddingHorizontal: 18,
    borderRadius: 6,
  },
  sendButtonDisabled: { backgroundColor: "#4B4326" },
  sendButtonText: { color: "#14170F", fontSize: 13, fontFamily: mono, fontWeight: "700", letterSpacing: 0.5 },
});