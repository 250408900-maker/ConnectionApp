import { useEffect, useRef, useState } from "react";

import {
    Platform,
    Pressable,
    ScrollView,
    StyleSheet,
    Text,
    View,
} from "react-native";

import { Feather } from "@expo/vector-icons";
import Constants from "expo-constants";
import { useRouter } from "expo-router";

import { DashboardColors as C, DashboardRadii as R, mono } from "@/constants/dashboard-theme";
import { socket } from "@/constants/socket";

// ---- Types -----------------------------------------------------------

type FeedEntry = {
  id: string;
  text: string;
  time: string;
  kind: "good" | "info" | "bad";
};

type FeatureTile = {
  key: string;
  label: string;
  icon: keyof typeof Feather.glyphMap;
  status: "Active" | "Web Only" | "Not Implemented";
};

// Real capabilities of this app today. Screen sharing is web-only (native
// deferred), and there's no end-to-end encryption implemented anywhere in
// the codebase — messages/files go through the relay server over an
// unencrypted (http://) connection, and calls rely on WebRTC's own
// transport security rather than anything the app adds. Don't flip these
// to "Active" without actually building the feature first.
const FEATURES: FeatureTile[] = [
  { key: "chat", label: "Chat", icon: "message-circle", status: "Active" },
  { key: "voice-msg", label: "Voice Messages", icon: "mic", status: "Active" },
  { key: "voice-call", label: "Voice Calls", icon: "phone", status: "Active" },
  { key: "files", label: "File Sharing", icon: "file", status: "Active" },
  { key: "screen", label: "Screen Sharing", icon: "monitor", status: "Web Only" },
  { key: "e2e", label: "End-to-End Encryption", icon: "shield", status: "Not Implemented" },
];

const MAX_FEED_ENTRIES = 12;

function timeNow() {
  return new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function deviceLabel() {
  const os = Platform.OS === "ios" ? "iOS" : Platform.OS === "android" ? "Android" : "Web";
  const version = Platform.Version ? ` ${Platform.Version}` : "";
  return `${os}${version}`;
}

// ---- Screen ------------------------------------------------------------

export default function DashboardScreen() {
  const router = useRouter();

  const [connected, setConnected] = useState(socket.connected);
  const [feed, setFeed] = useState<FeedEntry[]>([]);
  const [sessionCode, setSessionCode] = useState<string | null>(null);
  const [peerConnected, setPeerConnected] = useState(false);
  const startedAt = useRef(Date.now());
  const [uptimeLabel, setUptimeLabel] = useState("0m");

  function pushFeed(text: string, kind: FeedEntry["kind"] = "info") {
    setFeed((prev) => [{ id: `${Date.now()}-${Math.random()}`, text, time: timeNow(), kind }, ...prev].slice(0, MAX_FEED_ENTRIES));
  }

  useEffect(() => {
    // Reflects the real shared socket — the same connection the Connect
    // screen uses — rather than a separate, disconnected "demo" status.
    function onConnect() {
      setConnected(true);
      pushFeed("Connected to server", "good");
    }
    function onDisconnect() {
      setConnected(false);
      pushFeed("Disconnected from server", "bad");
    }
    function onSessionCreated(code: string) {
      setSessionCode(code);
      pushFeed(`Channel ${code} created`, "good");
    }
    function onJoinSuccess(code: string) {
      setSessionCode(code);
      pushFeed(`Joined channel ${code}`, "good");
    }
    function onSessionConnected() {
      setPeerConnected(true);
      pushFeed("Peer connected", "good");
    }
    function onReceiveMessage() {
      pushFeed("Message received", "info");
    }
    function onCallAccepted() {
      pushFeed("Voice call started", "info");
    }
    function onCallEnded() {
      pushFeed("Voice call ended", "info");
    }

    socket.on("connect", onConnect);
    socket.on("disconnect", onDisconnect);
    socket.on("session-created", onSessionCreated);
    socket.on("join-success", onJoinSuccess);
    socket.on("session-connected", onSessionConnected);
    socket.on("receive-message", onReceiveMessage);
    socket.on("call-accepted", onCallAccepted);
    socket.on("call-ended", onCallEnded);

    return () => {
      socket.off("connect", onConnect);
      socket.off("disconnect", onDisconnect);
      socket.off("session-created", onSessionCreated);
      socket.off("join-success", onJoinSuccess);
      socket.off("session-connected", onSessionConnected);
      socket.off("receive-message", onReceiveMessage);
      socket.off("call-accepted", onCallAccepted);
      socket.off("call-ended", onCallEnded);
    };
  }, []);

  useEffect(() => {
    const id = setInterval(() => {
      const mins = Math.floor((Date.now() - startedAt.current) / 60000);
      const h = Math.floor(mins / 60);
      const m = mins % 60;
      setUptimeLabel(h > 0 ? `${h}h ${m}m` : `${m}m`);
    }, 30000);
    return () => clearInterval(id);
  }, []);

  const statusText = connected ? "SERVER LINKED" : "REACHING SERVER";
  const statusColor = connected ? C.accent : C.warning;

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
      {/* Header */}
      <View style={styles.header}>
        <View style={styles.brandRow}>
          <Feather name="activity" size={18} color={C.accent} />
          <View style={{ marginLeft: 10 }}>
            <Text style={styles.brandTitle}>FIELD LINK</Text>
            <Text style={styles.brandSubtitle}>CONTROL CENTER</Text>
          </View>
        </View>
        <View style={styles.headerRight}>
          <Feather name="bell" size={18} color={C.textMuted} style={{ marginRight: 16 }} />
          <View style={[styles.onlineDot, { backgroundColor: connected ? C.accent : C.danger }]} />
          <Text style={styles.onlineText}>{connected ? "ONLINE" : "OFFLINE"}</Text>
        </View>
      </View>

      {/* Quick Connect */}
      <View style={styles.card}>
        <Text style={styles.eyebrow}>QUICK CONNECT</Text>
        <Text style={styles.cardTitle}>Create or Join a Channel</Text>
        <Text style={styles.cardSubtitle}>
          Peer-to-peer chat, voice, and file transfer between two devices.
        </Text>

        <View style={styles.radarWrap}>
          <View style={styles.radarRingOuter} />
          <View style={styles.radarRingInner} />
          <View style={styles.radarCore}>
            <Feather name="shield" size={20} color={C.accent} />
          </View>
        </View>

        <Pressable style={styles.primaryButton} onPress={() => router.push("/")}>
          <Feather name="plus" size={16} color={C.bg} />
          <View style={{ marginLeft: 10 }}>
            <Text style={styles.primaryButtonText}>CREATE CHANNEL</Text>
            <Text style={styles.primaryButtonSubtext}>Generate a new 6-character code</Text>
          </View>
        </Pressable>

        <Pressable style={styles.secondaryButton} onPress={() => router.push("/")}>
          <Feather name="users" size={16} color={C.text} />
          <View style={{ marginLeft: 10 }}>
            <Text style={styles.secondaryButtonText}>JOIN CHANNEL</Text>
            <Text style={styles.secondaryButtonSubtext}>Enter a code to connect</Text>
          </View>
        </Pressable>

        <View style={styles.deviceRow}>
          <View style={styles.deviceInfo}>
            <Text style={styles.smallLabel}>YOUR DEVICE</Text>
            <Text style={styles.deviceValue}>{deviceLabel()}</Text>
          </View>
          <View style={styles.deviceInfo}>
            <Text style={styles.smallLabel}>STATUS</Text>
            <View style={styles.deviceStatusRow}>
              <View style={[styles.dot, { backgroundColor: statusColor }]} />
              <Text style={styles.deviceValue}>{sessionCode ? `Channel ${sessionCode}` : "Ready to Connect"}</Text>
            </View>
          </View>
        </View>
      </View>

      {/* Stat cards — this app doesn't persist analytics yet, so these
          intentionally show live/known values only, not invented totals. */}
      <View style={styles.statGrid}>
        <View style={styles.statCard}>
          <Text style={styles.statLabel}>SERVER STATUS</Text>
          <Text style={[styles.statValue, { color: statusColor }]}>{connected ? "Online" : "Offline"}</Text>
          <Text style={styles.statSub}>{statusText}</Text>
        </View>
        <View style={styles.statCard}>
          <Text style={styles.statLabel}>ACTIVE CHANNEL</Text>
          <Text style={styles.statValue}>{peerConnected ? "Paired" : sessionCode ? "Waiting" : "None"}</Text>
          <Text style={styles.statSub}>{sessionCode ?? "Not connected"}</Text>
        </View>
        <View style={styles.statCard}>
          <Text style={styles.statLabel}>SESSION UPTIME</Text>
          <Text style={styles.statValue}>{uptimeLabel}</Text>
          <Text style={styles.statSub}>Since app opened</Text>
        </View>
        <View style={styles.statCard}>
          <Text style={styles.statLabel}>TRANSPORT</Text>
          <Text style={styles.statValue}>WebSocket</Text>
          <Text style={styles.statSub}>socket.io</Text>
        </View>
      </View>

      {/* Live system feed, driven by real socket events */}
      <View style={styles.card}>
        <View style={styles.rowBetween}>
          <Text style={styles.eyebrow}>SYSTEM FEED</Text>
          <Text style={styles.smallLabelFaint}>LIVE</Text>
        </View>
        {feed.length === 0 ? (
          <View style={styles.emptyFeed}>
            <Feather name="radio" size={18} color={C.textFaint} />
            <Text style={styles.emptyFeedText}>No activity yet — events will appear here as they happen.</Text>
          </View>
        ) : (
          feed.map((entry) => (
            <View key={entry.id} style={styles.feedRow}>
              <View
                style={[
                  styles.feedDot,
                  { backgroundColor: entry.kind === "good" ? C.accent : entry.kind === "bad" ? C.danger : C.info },
                ]}
              />
              <Text style={styles.feedText}>{entry.text}</Text>
              <Text style={styles.feedTime}>{entry.time}</Text>
            </View>
          ))
        )}
      </View>

      {/* Features */}
      <View style={styles.card}>
        <Text style={styles.eyebrow}>FEATURES</Text>
        <View style={styles.featureGrid}>
          {FEATURES.map((f) => (
            <View key={f.key} style={styles.featureTile}>
              <Feather
                name={f.icon}
                size={16}
                color={f.status === "Active" ? C.accent : f.status === "Web Only" ? C.warning : C.textFaint}
              />
              <Text style={styles.featureLabel}>{f.label}</Text>
              <Text
                style={[
                  styles.featureStatus,
                  f.status === "Active" && { color: C.accent },
                  f.status === "Web Only" && { color: C.warning },
                  f.status === "Not Implemented" && { color: C.textFaint },
                ]}
              >
                {f.status}
              </Text>
            </View>
          ))}
        </View>
      </View>

      {/* Bottom status banner — reflects real connection, no unverified
          "secure" claim (the relay connection is plain http://, not TLS). */}
      <View
        style={[
          styles.bottomBanner,
          { borderColor: connected ? C.accentDim : "#3A2323", backgroundColor: connected ? C.accentSoft : "rgba(224,100,90,0.08)" },
        ]}
      >
        <Feather name={connected ? "check-circle" : "alert-circle"} size={14} color={connected ? C.accent : C.danger} />
        <Text style={[styles.bottomBannerText, { color: connected ? C.accent : C.danger }]}>
          {connected ? "SERVER CONNECTED" : "SERVER UNREACHABLE"}
        </Text>
        <Text style={styles.bottomBannerMeta}>v{Constants.expoConfig?.version ?? "1.0.0"}</Text>
      </View>
    </ScrollView>
  );
}

// ---- Styles --------------------------------------------------------------

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: C.bg },
  content: { padding: 20, paddingTop: 60, paddingBottom: 48 },

  header: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 22 },
  brandRow: { flexDirection: "row", alignItems: "center" },
  brandTitle: { color: C.text, fontSize: 15, fontWeight: "700", letterSpacing: 1 },
  brandSubtitle: { color: C.textFaint, fontSize: 10, fontFamily: mono, letterSpacing: 1, marginTop: 1 },
  headerRight: { flexDirection: "row", alignItems: "center" },
  onlineDot: {
    width: 7,
    height: 7,
    borderRadius: 4,
    marginRight: 6,
  },
  onlineText: { color: C.textMuted, fontSize: 10, fontFamily: mono, letterSpacing: 1 },

  card: {
    backgroundColor: C.surface,
    borderWidth: 1,
    borderColor: C.border,
    borderRadius: R.lg,
    padding: 18,
    marginBottom: 14,
  },
  eyebrow: { color: C.textFaint, fontSize: 10, fontFamily: mono, letterSpacing: 2 },
  cardTitle: { color: C.text, fontSize: 20, fontWeight: "700", marginTop: 8 },
  cardSubtitle: { color: C.textMuted, fontSize: 13, marginTop: 6, lineHeight: 18 },

  radarWrap: { alignItems: "center", justifyContent: "center", marginVertical: 22, height: 90 },
  radarRingOuter: {
    position: "absolute",
    width: 90,
    height: 90,
    borderRadius: 45,
    borderWidth: 1,
    borderColor: C.borderSubtle,
  },
  radarRingInner: {
    position: "absolute",
    width: 58,
    height: 58,
    borderRadius: 29,
    borderWidth: 1,
    borderColor: C.accentDim,
  },
  radarCore: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: C.accentSoft,
    borderWidth: 1,
    borderColor: C.accent,
    alignItems: "center",
    justifyContent: "center",
  },

  primaryButton: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: C.accent,
    borderRadius: R.md,
    paddingVertical: 14,
    paddingHorizontal: 16,
    marginBottom: 10,
  },
  primaryButtonText: { color: C.bg, fontSize: 13, fontWeight: "700", letterSpacing: 0.5 },
  primaryButtonSubtext: { color: "#0C3D22", fontSize: 11, marginTop: 2 },

  secondaryButton: {
    flexDirection: "row",
    alignItems: "center",
    borderWidth: 1,
    borderColor: C.border,
    backgroundColor: C.surfaceAlt,
    borderRadius: R.md,
    paddingVertical: 14,
    paddingHorizontal: 16,
    marginBottom: 4,
  },
  secondaryButtonText: { color: C.text, fontSize: 13, fontWeight: "700", letterSpacing: 0.5 },
  secondaryButtonSubtext: { color: C.textMuted, fontSize: 11, marginTop: 2 },

  deviceRow: { flexDirection: "row", marginTop: 18, gap: 12 },
  deviceInfo: {
    flex: 1,
    backgroundColor: C.surfaceAlt,
    borderWidth: 1,
    borderColor: C.borderSubtle,
    borderRadius: R.sm,
    padding: 12,
  },
  smallLabel: { color: C.textFaint, fontSize: 9, fontFamily: mono, letterSpacing: 1.5, marginBottom: 6 },
  smallLabelFaint: { color: C.accent, fontSize: 9, fontFamily: mono, letterSpacing: 1.5 },
  deviceValue: { color: C.text, fontSize: 13, fontWeight: "600" },
  deviceStatusRow: { flexDirection: "row", alignItems: "center", gap: 6 },
  dot: { width: 6, height: 6, borderRadius: 3 },

  statGrid: { flexDirection: "row", flexWrap: "wrap", gap: 12, marginBottom: 14 },
  statCard: {
    flexBasis: "47%",
    flexGrow: 1,
    backgroundColor: C.surface,
    borderWidth: 1,
    borderColor: C.border,
    borderRadius: R.md,
    padding: 14,
  },
  statLabel: { color: C.textFaint, fontSize: 9, fontFamily: mono, letterSpacing: 1.5, marginBottom: 8 },
  statValue: { color: C.text, fontSize: 20, fontWeight: "700" },
  statSub: { color: C.textMuted, fontSize: 11, marginTop: 4 },

  rowBetween: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 12 },
  emptyFeed: { alignItems: "center", paddingVertical: 22, gap: 8 },
  emptyFeedText: { color: C.textFaint, fontSize: 12, textAlign: "center", paddingHorizontal: 20 },
  feedRow: { flexDirection: "row", alignItems: "center", paddingVertical: 8, borderTopWidth: 1, borderTopColor: C.borderSubtle, gap: 10 },
  feedDot: { width: 6, height: 6, borderRadius: 3 },
  feedText: { color: C.text, fontSize: 12, flex: 1 },
  feedTime: { color: C.textFaint, fontSize: 10, fontFamily: mono },

  featureGrid: { flexDirection: "row", flexWrap: "wrap", gap: 10, marginTop: 12 },
  featureTile: {
    flexBasis: "47%",
    flexGrow: 1,
    backgroundColor: C.surfaceAlt,
    borderWidth: 1,
    borderColor: C.borderSubtle,
    borderRadius: R.sm,
    padding: 12,
    gap: 6,
  },
  featureLabel: { color: C.text, fontSize: 12, fontWeight: "600" },
  featureStatus: { fontSize: 10, fontFamily: mono, letterSpacing: 0.5 },

  bottomBanner: {
    flexDirection: "row",
    alignItems: "center",
    borderWidth: 1,
    borderRadius: R.md,
    paddingVertical: 12,
    paddingHorizontal: 16,
    gap: 8,
  },
  bottomBannerText: { fontSize: 11, fontFamily: mono, letterSpacing: 1, flex: 1 },
  bottomBannerMeta: { color: C.textFaint, fontSize: 10, fontFamily: mono },
});
