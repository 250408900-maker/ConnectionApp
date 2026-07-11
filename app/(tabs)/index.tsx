import { useEffect, useState } from "react";
import {
  Alert,
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

export default function HomeScreen() {
  const [sessionCode, setSessionCode] = useState("");
  const [joinCode, setJoinCode] = useState("");
  const [status, setStatus] = useState("Connecting... 🟡");

  const [message, setMessage] = useState("");
  const [messages, setMessages] = useState<ChatMessage[]>([]);

  useEffect(() => {
    function handleConnect() {
      setStatus("Connected to Server 🟢");
    }

    function handleDisconnect() {
      setStatus("Disconnected 🔴");
    }

    function handleSessionCreated(code: string) {
      setSessionCode(code);
      setStatus("Session Created — Waiting for Device 🟡");
      setMessages([]);
    }

    function handleJoinSuccess(code: string) {
      setSessionCode(code);
      setStatus("Connected to Session 🟢");
      setMessages([]);
    }

    function handleJoinError(errorMessage: string) {
      Alert.alert("Join Error", errorMessage);
      setStatus("Could Not Join 🔴");
    }

    function handleSessionConnected() {
      setStatus("Two Devices Connected 🟢");
    }

    function handleReceiveMessage(receivedMessage: string) {
      const newMessage: ChatMessage = {
        id: `${Date.now()}-${Math.random()}`,
        text: receivedMessage,
        sender: "other",
      };

      setMessages((currentMessages) => [
        ...currentMessages,
        newMessage,
      ]);
    }

    function handleSessionEnded() {
      setSessionCode("");
      setMessages([]);
      setStatus("Session Ended 🔴");

      Alert.alert(
        "Session Ended",
        "The other device disconnected."
      );
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
    setStatus("Creating Session... 🟡");
  }

  function joinSession() {
    const cleanedCode = joinCode.trim().toUpperCase();

    if (!cleanedCode) {
      Alert.alert(
        "Missing Code",
        "Please enter a session code."
      );
      return;
    }

    socket.emit("join-session", cleanedCode);
    setStatus("Joining Session... 🟡");
  }

  function sendMessage() {
    const cleanedMessage = message.trim();

    if (!cleanedMessage) {
      return;
    }

    if (!sessionCode) {
      Alert.alert(
        "No Session",
        "Create or join a session first."
      );
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

    setMessages((currentMessages) => [
      ...currentMessages,
      newMessage,
    ]);

    setMessage("");
  }

  return (
    <View style={styles.container}>
      <Text style={styles.title}>Connection App</Text>

      <Text style={styles.status}>{status}</Text>

      {sessionCode === "" ? (
        <>
          <Pressable
            style={styles.button}
            onPress={createSession}
          >
            <Text style={styles.buttonText}>
              Create Session
            </Text>
          </Pressable>

          <TextInput
            style={styles.input}
            placeholder="Enter session code"
            placeholderTextColor="#888"
            value={joinCode}
            onChangeText={setJoinCode}
            autoCapitalize="characters"
            maxLength={6}
          />

          <Pressable
            style={styles.button}
            onPress={joinSession}
          >
            <Text style={styles.buttonText}>
              Join Session
            </Text>
          </Pressable>
        </>
      ) : (
        <>
          <View style={styles.codeBox}>
            <Text style={styles.codeLabel}>
              Session Code
            </Text>

            <Text style={styles.code}>
              {sessionCode}
            </Text>
          </View>

          <ScrollView
            style={styles.messageArea}
            contentContainerStyle={styles.messageContent}
          >
            {messages.length === 0 ? (
              <Text style={styles.emptyText}>
                No messages yet. Say hello 👋
              </Text>
            ) : (
              messages.map((chatMessage) => (
                <View
                  key={chatMessage.id}
                  style={[
                    styles.messageBubble,
                    chatMessage.sender === "me"
                      ? styles.myMessage
                      : styles.otherMessage,
                  ]}
                >
                  <Text style={styles.messageText}>
                    {chatMessage.text}
                  </Text>
                </View>
              ))
            )}
          </ScrollView>

          <View style={styles.sendRow}>
            <TextInput
              style={styles.messageInput}
              placeholder="Type a message..."
              placeholderTextColor="#888"
              value={message}
              onChangeText={setMessage}
              onSubmitEditing={sendMessage}
              returnKeyType="send"
            />

            <Pressable
              style={styles.sendButton}
              onPress={sendMessage}
            >
              <Text style={styles.sendButtonText}>
                Send
              </Text>
            </Pressable>
          </View>
        </>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    padding: 24,
    paddingTop: 60,
    backgroundColor: "#111827",
  },

  title: {
    color: "white",
    fontSize: 32,
    fontWeight: "bold",
    textAlign: "center",
    marginBottom: 12,
  },

  status: {
    color: "#d1d5db",
    fontSize: 17,
    textAlign: "center",
    marginBottom: 20,
  },

  button: {
    backgroundColor: "#2563eb",
    padding: 16,
    borderRadius: 12,
    marginVertical: 10,
  },

  buttonText: {
    color: "white",
    textAlign: "center",
    fontSize: 17,
    fontWeight: "bold",
  },

  input: {
    backgroundColor: "white",
    padding: 16,
    borderRadius: 12,
    fontSize: 18,
    textAlign: "center",
    marginTop: 25,
  },

  codeBox: {
    backgroundColor: "#1f2937",
    padding: 14,
    borderRadius: 12,
    alignItems: "center",
    marginBottom: 15,
  },

  codeLabel: {
    color: "#9ca3af",
    fontSize: 14,
  },

  code: {
    color: "white",
    fontSize: 27,
    fontWeight: "bold",
    letterSpacing: 5,
    marginTop: 5,
  },

  messageArea: {
    flex: 1,
    backgroundColor: "#1f2937",
    borderRadius: 12,
    marginBottom: 12,
  },

  messageContent: {
    padding: 14,
  },

  emptyText: {
    color: "#9ca3af",
    textAlign: "center",
    marginTop: 30,
    fontSize: 16,
  },

  messageBubble: {
    maxWidth: "80%",
    padding: 12,
    borderRadius: 14,
    marginVertical: 5,
  },

  myMessage: {
    backgroundColor: "#2563eb",
    alignSelf: "flex-end",
  },

  otherMessage: {
    backgroundColor: "#374151",
    alignSelf: "flex-start",
  },

  messageText: {
    color: "white",
    fontSize: 16,
  },

  sendRow: {
    flexDirection: "row",
    alignItems: "center",
  },

  messageInput: {
    flex: 1,
    backgroundColor: "white",
    padding: 14,
    borderRadius: 12,
    fontSize: 16,
    marginRight: 8,
  },

  sendButton: {
    backgroundColor: "#2563eb",
    paddingVertical: 14,
    paddingHorizontal: 18,
    borderRadius: 12,
  },

  sendButtonText: {
    color: "white",
    fontSize: 16,
    fontWeight: "bold",
  },
});