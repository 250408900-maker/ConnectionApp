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

import { io } from "socket.io-client";

const socket = io("http://192.168.1.51:3000", {
  transports: ["websocket"],
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

const TYPING_TIMEOUT_MS = 1500;
const SEND_ACK_TIMEOUT_MS = 5000;

const mono = Platform.select({ ios: "Menlo", android: "monospace", default: "monospace" });

function makeMessageId() {
  return `${Date.now()}-${Math.random()}`;
}

function timeNow() {
  return new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

export default function HomeScreen() {
  const [sessionCode, setSessionCode] = useState("");
  const [joinCode, setJoinCode] = useState("");
  const [linkState, setLinkState] = useState<LinkState>("connecting");
  const [peerOnline, setPeerOnline] = useState(false);
  const [peerTyping, setPeerTyping] = useState(false);

  const [message, setMessage] = useState("");
  const [messages, setMessages] = useState<ChatMessage[]>([]);

  const scrollViewRef = useRef<ScrollView>(null);
  const typingTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isTypingRef = useRef(false);
  const roleRef = useRef<"host" | "guest" | null>(null);
  const sessionCodeRef = useRef("");

  useEffect(() => {
    sessionCodeRef.current = sessionCode;
  }, [sessionCode]);

  useEffect(() => {
    function resetSessionState() {
      setSessionCode("");
      setMessages([]);
      setPeerOnline(false);
      setPeerTyping(false);
      roleRef.current = null;
    }

    function handleConnect() {
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
      if (sessionCodeRef.current) {
        setLinkState("lost");
        setPeerOnline(false);
      } else {
        setLinkState("lost");
      }
    }

    function handleSessionCreated(code: string) {
      roleRef.current = "host";
      setSessionCode(code);
      setLinkState("waiting");
      setMessages([]);
      setPeerOnline(false);
      setPeerTyping(false);
    }

    function handleJoinSuccess(code: string) {
      roleRef.current = "guest";
      setSessionCode(code);
      setLinkState("paired");
      setMessages([]);
      setPeerTyping(false);
    }

    function handleJoinError(errorMessage: string) {
      Alert.alert("Could not tune in", errorMessage);
      setLinkState("error");
    }

    function handleSessionConnected() {
      setLinkState("paired");
      setPeerOnline(true);
    }

    function handleRejoinSuccess(payload: { sessionCode: string; peerOnline: boolean }) {
      setSessionCode(payload.sessionCode);
      setLinkState("paired");
      setPeerOnline(payload.peerOnline);
    }

    function handleRejoinError(errorMessage: string) {
      Alert.alert("Channel expired", errorMessage);
      resetSessionState();
      setLinkState("closed");
    }

    function handlePeerOffline() {
      setPeerOnline(false);
      setPeerTyping(false);
    }

    function handlePeerReconnected() {
      setPeerOnline(true);
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

      <View style={styles.statusRow}>
        <SignalBars level={signalLevel} />
        <Text style={styles.statusText}>{STATUS_COPY[linkState]}</Text>
      </View>

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
              </View>
            </View>
            <View style={styles.readoutDigits}>
              {sessionCode.split("").map((char, index) => (
                <View key={`${char}-${index}`} style={styles.digitCell}>
                  <Text style={styles.digitText}>{char}</Text>
                </View>
              ))}
            </View>
            <Pressable style={styles.endButton} onPress={endChannel}>
              <Text style={styles.endButtonText}>End Channel</Text>
            </Pressable>
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
    backgroundColor: "#1B2016",
    borderWidth: 1,
    borderColor: "#2B3122",
    borderRadius: 4,
    paddingVertical: 12,
    paddingHorizontal: 14,
    marginBottom: 28,
  },
  bars: { flexDirection: "row", alignItems: "flex-end", gap: 3, marginRight: 12 },
  bar: { width: 4, borderRadius: 1 },
  statusText: { color: "#B9C0AC", fontSize: 12, fontFamily: mono, letterSpacing: 0.5 },
  lobby: { flex: 1, justifyContent: "center" },
  primaryButton: { backgroundColor: "#C9A227", paddingVertical: 16, borderRadius: 4 },
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
    borderRadius: 4,
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
    borderRadius: 4,
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
    borderRadius: 4,
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
    marginBottom: 8,
  },
  readoutLabel: { color: "#7C8570", fontSize: 10, fontFamily: mono, letterSpacing: 2 },
  peerDotRow: { flexDirection: "row", alignItems: "center", gap: 6 },
  peerDot: { width: 6, height: 6, borderRadius: 3 },
  peerDotLabel: { color: "#7C8570", fontSize: 10, fontFamily: mono, letterSpacing: 1 },
  readoutDigits: { flexDirection: "row", gap: 6 },
  digitCell: {
    backgroundColor: "#14170F",
    borderWidth: 1,
    borderColor: "#3A4033",
    borderRadius: 3,
    width: 30,
    paddingVertical: 6,
    alignItems: "center",
  },
  digitText: { color: "#C9A227", fontSize: 18, fontFamily: mono, fontWeight: "700" },
  endButton: {
    marginTop: 12,
    borderWidth: 1,
    borderColor: "#4B2A2A",
    borderRadius: 4,
    paddingVertical: 8,
    paddingHorizontal: 14,
  },
  endButtonText: { color: "#D4877A", fontSize: 11, fontFamily: mono, letterSpacing: 1 },
  log: {
    flex: 1,
    backgroundColor: "#1B2016",
    borderWidth: 1,
    borderColor: "#2B3122",
    borderRadius: 4,
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
    borderRadius: 4,
    color: "#EDE9DC",
    padding: 14,
    fontSize: 15,
    fontFamily: mono,
    marginRight: 8,
  },
  messageInputDisabled: { opacity: 0.5 },
  sendButton: { backgroundColor: "#C9A227", paddingVertical: 14, paddingHorizontal: 18, borderRadius: 4 },
  sendButtonDisabled: { backgroundColor: "#4B4326" },
  sendButtonText: { color: "#14170F", fontSize: 13, fontFamily: mono, fontWeight: "700", letterSpacing: 0.5 },
});