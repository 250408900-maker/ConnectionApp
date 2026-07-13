import { useEffect, useRef, useState } from "react";

import {
  Alert,
  Animated,
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
import { io } from "socket.io-client";

const socket = io("http://192.168.1.32:3000", {
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
const MESSAGE_PREVIEW_LENGTH = 28;

const mono = Platform.select({ ios: "Menlo", android: "monospace", default: "monospace" });

// Short synthesized "blip" tone, embedded as a data URI so no extra asset
// file needs to ship with the app. Swap this out for require("./assets/notification.mp3")
// if you'd rather bundle a real sound file.
const NOTIFICATION_SOUND_URI = "data:audio/wav;base64,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";

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

// A Pressable wrapper that adds a small, snappy scale animation on press.
// Drop-in replacement for Pressable anywhere a button-like tap target is used.
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
    Animated.spring(scale, {
      toValue: 0.95,
      useNativeDriver: true,
      speed: 60,
      bounciness: 0,
    }).start();
  }

  function pressOut() {
    Animated.spring(scale, {
      toValue: 1,
      useNativeDriver: true,
      speed: 20,
      bounciness: 8,
    }).start();
  }

  return (
    <Pressable
      onPress={onPress}
      onPressIn={pressIn}
      onPressOut={pressOut}
      disabled={disabled}
    >
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

  const scrollViewRef = useRef<ScrollView>(null);
  const logScrollRef = useRef<ScrollView>(null);
  const typingTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const copyFeedbackTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isTypingRef = useRef(false);
  const roleRef = useRef<"host" | "guest" | null>(null);
  const sessionCodeRef = useRef("");
  const pairedAtRef = useRef<number | null>(null);
  const notificationSoundRef = useRef<Audio.Sound | null>(null);

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

  // Load the notification sound once on mount, and make sure it can play
  // even when the device's silent switch is on (iOS).
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
      // Playback failures shouldn't interrupt the chat experience.
      console.warn("Could not play notification sound", error);
    }
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

  // Belt-and-suspenders auto-scroll: onContentSizeChange below already scrolls
  // the chat log to the bottom whenever its content grows, but this effect
  // guarantees it also happens right after messages/typing-state changes.
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
        text: receivedMessage,
        sender: "other",
        timestamp: timeNow(),
      };

      setPeerTyping(false);
      setMessages((current) => [...current, newMessage]);
      logActivity(`Received: "${truncatePreview(receivedMessage)}"`, "info");
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
          current.map((m) =>
            m.id === id ? { ...m, status: response.ok ? "delivered" : "failed" } : m
          )
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

  // Enter-to-send on physical keyboards (desktop web / RN-web / hardware
  // keyboards on tablets). Shift+Enter still falls through so multi-line
  // input isn't blocked if the input is ever made multiline later.
  function handleMessageKeyPress(event: any) {
    const nativeEvent = event?.nativeEvent ?? {};
    if (nativeEvent.key === "Enter" && !nativeEvent.shiftKey) {
      event.preventDefault?.();
      sendMessage();
    }
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
              <AnimatedPressable style={styles.copyButton} onPress={copySessionCode}>
                <Text style={styles.copyButtonText}>
                  {copyFeedback ? "COPIED ✓" : "COPY CODE"}
                </Text>
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
            onContentSizeChange={() =>
              scrollViewRef.current?.scrollToEnd({ animated: true })
            }
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
                          {chatMessage.status === "sending" && "○ sending…"}
                          {chatMessage.status === "delivered" && "✓✓ delivered"}
                          {chatMessage.status === "failed" && "⚠ failed — tap to retry"}
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
  header: { marginBottom: 24 },
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
    borderRadius: 8,
    paddingVertical: 13,
    paddingHorizontal: 16,
    marginBottom: 14,
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
    borderRadius: 8,
    marginBottom: 18,
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
  logPanelEmpty: {
    color: "#5F6653",
    fontFamily: mono,
    fontSize: 12,
    textAlign: "center",
    paddingVertical: 8,
  },
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
  primaryButtonText: {
    color: "#14170F",
    textAlign: "center",
    fontSize: 16,
    fontWeight: "700",
    letterSpacing: 0.3,
  },
  dividerRow: { flexDirection: "row", alignItems: "center", marginVertical: 30 },
  dividerLine: { flex: 1, height: 1, backgroundColor: "#2B3122" },
  dividerText: {
    color: "#5F6653",
    fontSize: 11,
    fontFamily: mono,
    letterSpacing: 1.5,
    marginHorizontal: 12,
  },
  dial: { marginBottom: 18 },
  dialLabel: {
    color: "#7C8570",
    fontSize: 11,
    fontFamily: mono,
    letterSpacing: 1.5,
    marginBottom: 9,
  },
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
  secondaryButton: {
    borderWidth: 1,
    borderColor: "#C9A227",
    paddingVertical: 16,
    borderRadius: 8,
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
  readoutActions: {
    flexDirection: "row",
    flexWrap: "wrap",
    justifyContent: "center",
    gap: 9,
  },
  copyButton: {
    borderWidth: 1,
    borderColor: "#3A4033",
    borderRadius: 6,
    paddingVertical: 9,
    paddingHorizontal: 13,
  },
  copyButtonText: { color: "#B9C0AC", fontSize: 10, fontFamily: mono, letterSpacing: 1 },
  clearButton: {
    borderWidth: 1,
    borderColor: "#3A4033",
    borderRadius: 6,
    paddingVertical: 9,
    paddingHorizontal: 13,
  },
  clearButtonText: { color: "#B9C0AC", fontSize: 10, fontFamily: mono, letterSpacing: 1 },
  endButton: {
    borderWidth: 1,
    borderColor: "#4B2A2A",
    borderRadius: 6,
    paddingVertical: 9,
    paddingHorizontal: 13,
  },
  endButtonText: { color: "#D4877A", fontSize: 10, fontFamily: mono, letterSpacing: 1 },
  log: {
    flex: 1,
    backgroundColor: "#1B2016",
    borderWidth: 1,
    borderColor: "#2B3122",
    borderRadius: 8,
    marginBottom: 14,
  },
  logContent: { padding: 16, flexGrow: 1 },
  emptyState: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: 40,
  },
  emptyStateIcon: { fontSize: 28, marginBottom: 10, opacity: 0.6 },
  emptyText: {
    color: "#8A9280",
    fontFamily: mono,
    fontSize: 14,
    textAlign: "center",
    fontWeight: "600",
  },
  emptySubtext: {
    color: "#5F6653",
    fontFamily: mono,
    fontSize: 12,
    textAlign: "center",
    marginTop: 4,
  },
  bubbleRow: { marginVertical: 6, flexDirection: "row" },
  bubbleRowMe: { justifyContent: "flex-end" },
  bubbleRowOther: { justifyContent: "flex-start" },
  bubble: {
    maxWidth: "78%",
    borderRadius: 10,
    paddingVertical: 9,
    paddingHorizontal: 13,
  },
  bubbleMe: { backgroundColor: "#26301F" },
  bubbleOther: { backgroundColor: "#20241A" },
  logText: { color: "#EDE9DC", fontSize: 15, flexShrink: 1, flexWrap: "wrap" },
  bubbleFooter: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginTop: 5,
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
  sendRow: { flexDirection: "row", alignItems: "center", gap: 10 },
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
  sendButton: {
    backgroundColor: "#C9A227",
    paddingVertical: 15,
    paddingHorizontal: 19,
    borderRadius: 8,
  },
  sendButtonDisabled: { backgroundColor: "#4B4326" },
  sendButtonText: { color: "#14170F", fontSize: 13, fontFamily: mono, fontWeight: "700", letterSpacing: 0.5 },
});
