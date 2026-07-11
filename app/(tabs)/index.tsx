import { useEffect, useState } from "react";
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

const socket = io("http://192.168.1.45:3000", {
  transports: ["websocket"],
});

type ChatMessage = {
  id: string;
  text: string;
  sender: "me" | "other";
};

type LinkState =
  | "connecting"
  | "online"
  | "opening"
  | "waiting"
  | "tuning"
  | "paired"
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
  lost: "CHANNEL LOST",
  closed: "PEER SIGNED OFF",
  error: "COULD NOT TUNE IN",
};

// bar count per state, used by the signal indicator
const SIGNAL_LEVEL: Record<LinkState, number> = {
  connecting: 1,
  online: 2,
  opening: 2,
  waiting: 2,
  tuning: 2,
  paired: 4,
  lost: 0,
  closed: 0,
  error: 0,
};

const mono = Platform.select({ ios: "Menlo", android: "monospace", default: "monospace" });

export default function HomeScreen() {
  const [sessionCode, setSessionCode] = useState("");
  const [joinCode, setJoinCode] = useState("");
  const [linkState, setLinkState] = useState<LinkState>("connecting");

  const [message, setMessage] = useState("");
  const [messages, setMessages] = useState<ChatMessage[]>([]);

  useEffect(() => {
    function handleConnect() {
      setLinkState("online");
    }

    function handleDisconnect() {
      setLinkState("lost");
    }

    function handleSessionCreated(code: string) {
      setSessionCode(code);
      setLinkState("waiting");
      setMessages([]);
    }

    function handleJoinSuccess(code: string) {
      setSessionCode(code);
      setLinkState("paired");
      setMessages([]);
    }

    function handleJoinError(errorMessage: string) {
      Alert.alert("Could not tune in", errorMessage);
      setLinkState("error");
    }

    function handleSessionConnected() {
      setLinkState("paired");
    }

    function handleReceiveMessage(receivedMessage: string) {
      const newMessage: ChatMessage = {
        id: `${Date.now()}-${Math.random()}`,
        text: receivedMessage,
        sender: "other",
      };

      setMessages((currentMessages) => [...currentMessages, newMessage]);
    }

    function handleSessionEnded() {
      setSessionCode("");
      setMessages([]);
      setLinkState("closed");

      Alert.alert("Channel closed", "The other device signed off.");
    }

    socket.on("connect", handleConnect);
    socket.on("disconnect", handleDisconnect);
    socket.on("session-created", handleSessionCreated);
    socket.on("join-success", handleJoinSuccess);
    socket.on("join-error", handleJoinError);
    socket.on("session-connected", handleSessionConnected);
    socket.on("receive-message", handleReceiveMessage);
    socket.on("session-ended", handleSessionEnded);

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
      socket.off("receive-message", handleReceiveMessage);
      socket.off("session-ended", handleSessionEnded);
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

  function sendMessage() {
    const cleanedMessage = message.trim();

    if (!cleanedMessage) {
      return;
    }

    if (!sessionCode) {
      Alert.alert("No channel", "Open or tune in to a channel first.");
      return;
    }

    socket.emit("send-message", {
      sessionCode,
      message: cleanedMessage,
    });

    const newMessage: ChatMessage = {
      id: `${Date.now()}-${Math.random()}`,
      text: cleanedMessage,
      sender: "me",
    };

    setMessages((currentMessages) => [...currentMessages, newMessage]);
    setMessage("");
  }

  const signalLevel = SIGNAL_LEVEL[linkState];

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
            <Text style={styles.readoutLabel}>CHANNEL</Text>
            <View style={styles.readoutDigits}>
              {sessionCode.split("").map((char, index) => (
                <View key={`${char}-${index}`} style={styles.digitCell}>
                  <Text style={styles.digitText}>{char}</Text>
                </View>
              ))}
            </View>
          </View>

          <ScrollView
            style={styles.log}
            contentContainerStyle={styles.logContent}
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
                    styles.logLine,
                    chatMessage.sender === "me"
                      ? styles.logLineMe
                      : styles.logLineOther,
                  ]}
                >
                  <Text style={styles.logMarker}>
                    {chatMessage.sender === "me" ? ">" : "<"}
                  </Text>
                  <Text style={styles.logText}>{chatMessage.text}</Text>
                </View>
              ))
            )}
          </ScrollView>

          <View style={styles.sendRow}>
            <TextInput
              style={styles.messageInput}
              placeholder="transmit..."
              placeholderTextColor="#4B5344"
              value={message}
              onChangeText={setMessage}
              onSubmitEditing={sendMessage}
              returnKeyType="send"
            />

            <Pressable style={styles.sendButton} onPress={sendMessage}>
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
  readoutLabel: { color: "#7C8570", fontSize: 10, fontFamily: mono, letterSpacing: 2, marginBottom: 8 },
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
  logLine: { flexDirection: "row", marginVertical: 4 },
  logLineMe: { justifyContent: "flex-end" },
  logLineOther: { justifyContent: "flex-start" },
  logMarker: { color: "#7C8570", fontFamily: mono, fontSize: 14, marginHorizontal: 6 },
  logText: { color: "#EDE9DC", fontSize: 15, flexShrink: 1 },
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
  sendButton: { backgroundColor: "#C9A227", paddingVertical: 14, paddingHorizontal: 18, borderRadius: 4 },
  sendButtonText: { color: "#14170F", fontSize: 13, fontFamily: mono, fontWeight: "700", letterSpacing: 0.5 },
});