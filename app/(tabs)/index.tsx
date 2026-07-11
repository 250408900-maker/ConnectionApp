import { useEffect, useState } from "react";
import {
  Alert,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { io } from "socket.io-client";

const socket = io("http://192.168.1.39:3000", {
  transports: ["websocket"],
});

export default function HomeScreen() {
  const [sessionCode, setSessionCode] = useState("");
  const [joinCode, setJoinCode] = useState("");
  const [status, setStatus] = useState("Connecting... 🟡");

  useEffect(() => {
    function handleConnect() {
      setStatus("Connected to Server 🟢");
    }

    function handleDisconnect() {
      setStatus("Disconnected 🔴");
    }

    function handleSessionCreated(code: string) {
      setSessionCode(code);
      setStatus("Session Created 🟡");
    }

    function handleJoinSuccess(code: string) {
      setSessionCode(code);
      setStatus("Connected to Session 🟢");
    }

    function handleJoinError(message: string) {
      Alert.alert("Join Error", message);
      setStatus("Could Not Join 🔴");
    }

    function handleSessionConnected() {
      setStatus("Two Devices Connected 🟢");
    }

    function handleSessionEnded() {
      setSessionCode("");
      setStatus("Session Ended 🔴");
      Alert.alert("Session Ended", "The other device disconnected.");
    }

    socket.on("connect", handleConnect);
    socket.on("disconnect", handleDisconnect);
    socket.on("session-created", handleSessionCreated);
    socket.on("join-success", handleJoinSuccess);
    socket.on("join-error", handleJoinError);
    socket.on("session-connected", handleSessionConnected);
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
      Alert.alert("Missing Code", "Please enter a session code.");
      return;
    }

    socket.emit("join-session", cleanedCode);
    setStatus("Joining Session... 🟡");
  }

  return (
    <View style={styles.container}>
      <Text style={styles.title}>Connection App</Text>

      <Text style={styles.status}>{status}</Text>

      <Pressable style={styles.button} onPress={createSession}>
        <Text style={styles.buttonText}>Create Session</Text>
      </Pressable>

      {sessionCode !== "" && (
        <View style={styles.codeBox}>
          <Text style={styles.codeLabel}>Session Code</Text>
          <Text style={styles.code}>{sessionCode}</Text>
        </View>
      )}

      <TextInput
        style={styles.input}
        placeholder="Enter session code"
        placeholderTextColor="#888"
        value={joinCode}
        onChangeText={setJoinCode}
        autoCapitalize="characters"
        maxLength={6}
      />

      <Pressable style={styles.button} onPress={joinSession}>
        <Text style={styles.buttonText}>Join Session</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    padding: 24,
    justifyContent: "center",
    backgroundColor: "#111827",
  },

  title: {
    color: "white",
    fontSize: 32,
    fontWeight: "bold",
    textAlign: "center",
    marginBottom: 16,
  },

  status: {
    color: "#d1d5db",
    fontSize: 17,
    textAlign: "center",
    marginBottom: 30,
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
    padding: 20,
    borderRadius: 12,
    marginTop: 20,
    alignItems: "center",
  },

  codeLabel: {
    color: "#9ca3af",
    fontSize: 15,
  },

  code: {
    color: "white",
    fontSize: 32,
    fontWeight: "bold",
    letterSpacing: 5,
    marginTop: 8,
  },
});