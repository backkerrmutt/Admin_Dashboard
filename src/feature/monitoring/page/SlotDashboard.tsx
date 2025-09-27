// src/feature/monitoring/page/SlotDashboard.tsx
import { useEffect, useMemo, useState } from "react";
import { useParams, useNavigate, useLocation } from "react-router-dom";
import {
  Box,
  Typography,
  Card,
  CardContent,
  Grid,
  CircularProgress,
  Divider,
  Button,
} from "@mui/material";
import ArrowBackIcon from "../../../assets/icons/arrow-back.svg?react";
import BoxIcon from "../../../assets/icons/box.svg?react";
import InboxIcon from "../../../assets/icons/inbox.svg?react";
//import ErrorIcon from "../../../assets/icons/error.svg?react";
//import CheckIcon from "../../../assets/icons/checkmark.svg?react";
//import WiFiIcon from "../../../assets/icons/wifi.svg?react";
import { supabase } from "../../../supabaseClient";
import {
  useMqtt,
  makeCommandTopic,
  makeStatusTopic,
  makeWarningTopic,
} from "../../../hooks/useMqtt";
import { dbg, dbw, dbe } from "../../../debug";
const TBL = {
  slots: "slots",
  login: null,
  activation: null,
};

type SlotRow = {
  slot_id: string;
  cupboard_id: string;
  connection_status: "online" | "offline" | string;
  capacity: number | null;
  is_open?: boolean;
  sensor_status?: "ok" | "error" | "unknown";
  wifi_status?: "connected" | "disconnected" | "unknown";
  wifi_rssi?: number | null;
  ip_addr?: string | null;
  last_sensor_at?: string | null;
  last_seen_at?: string | null;
};

type LoginLog = {
  id: string | number;
  name: string;
  date: string;
  time: string;
  description: string;
};

type ActivationLog = {
  id: string | number;
  name: string;
  date: string;
  time: string;
  description: string;
};

// ===== DB sync helper (per-slot throttle) =====
const __lastSyncMap: Record<string, number> = {};
// ===== WARNING insert throttle (per slot) =====
const __lastWarnAt: Record<string, number> = {};
const WARN_INTERVAL_MS = 5000; // บันทึกอย่างมากทุก 5 วิ/slot

async function syncSlotStateToDB(
  slotId: string,
  patch: Partial<SlotRow>,
  opts?: { force?: boolean }
) {
  const now = Date.now();
  const last = __lastSyncMap[slotId] ?? 0;
  const force = !!opts?.force;
  if (!force && now - last < 1200) return; // throttle 1.2s ต่อ slot
  __lastSyncMap[slotId] = now;

  try {
    const body: any = {
      is_open: typeof patch.is_open === "boolean" ? patch.is_open : undefined,
      capacity: typeof patch.capacity === "number" ? patch.capacity : undefined,
      sensor_status: patch.sensor_status,
      wifi_status: patch.wifi_status,
      wifi_rssi:
        typeof patch.wifi_rssi === "number" ? patch.wifi_rssi : undefined,
      ip_addr: patch.ip_addr,
      last_seen_at: patch.last_seen_at ?? new Date().toISOString(),
    };
    Object.keys(body).forEach((k) => body[k] === undefined && delete body[k]);
    if (Object.keys(body).length === 0) return;

    const { data, error } = await supabase
      .from("slots")
      .update(body)
      .eq("slot_id", slotId)
      .select("slot_id,is_open,last_seen_at");

    if (error) {
      console.error("[DB] UPDATE slots error:", error, { slotId, body });
      return;
    }
    if (!data?.length) {
      console.warn(
        "[DB] UPDATE OK but 0 rows matched — ตรวจ slot_id ให้ตรง DB",
        { slotId, body }
      );
      return;
    }
    console.log("[DB] slots updated:", data);
  } catch (e) {
    console.error("[DB] UPDATE slots exception:", e, { slotId, patch });
  }
}

function parseIsOpen(v: any): boolean | null {
  if (v === true) return true;
  if (v === false) return false;
  if (typeof v === "number") {
    if (v === 1) return true;
    if (v === 0) return false;
  }
  if (typeof v === "string") {
    const s = v.trim().toLowerCase();
    if (["1", "true", "open", "opened", "unlock"].includes(s)) return true;
    if (["0", "false", "closed", "close", "lock"].includes(s)) return false;
  }
  return null;
}

export default function SlotDashboard() {
  const { slotId } = useParams<{ slotId: string }>();
  const navigate = useNavigate();
  const location = useLocation();

  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  const [slot, setSlot] = useState<SlotRow | null>(null);
  const [loginHistory, setLoginHistory] = useState<LoginLog[]>([]);
  const [activationHistory, setActivationHistory] = useState<ActivationLog[]>(
    []
  );

  // เปิดได้อย่างเดียว + ล็อกจนปิดประตูจริง
  const [sendingOpen, setSendingOpen] = useState(false);
  const [awaitingClose, setAwaitingClose] = useState(false);

  const isOpen = slot?.is_open ?? false;
  const usageText = isOpen ? "Opened" : "Closed";

  // state จากหน้าก่อน
  const fromState = location.state as
    | Partial<{
        slotId: string;
        nodeId: string;
        connectionStatus: SlotRow["connection_status"];
        wifiStatus: SlotRow["wifi_status"];
        sensorStatus: SlotRow["sensor_status"];
        capacity: number;
      }>
    | undefined;

  const nodeId = slot?.cupboard_id || fromState?.nodeId;

  const [warning, setWarning] = useState<{
    code?: string;
    message?: string;
    ts?: number;
  } | null>(null);

  // MQTT topics
  const statusTopic = nodeId && slotId ? makeStatusTopic(nodeId, slotId) : null;
  const warningTopic =
    nodeId && slotId ? makeWarningTopic(nodeId, slotId) : null;
  // action ให้ตรงกับ hooks/useMqtt.ts
  const commandOpenTopic =
    nodeId && slotId ? makeCommandTopic(nodeId, slotId, "door") : null;

  const {
    status: mqttStatus,
    onMessage,
    publish,
  } = useMqtt([statusTopic, warningTopic].filter(Boolean) as string[]);

  useEffect(() => {
    if (!statusTopic && !warningTopic) return;

    // --- ลดความถี่การอัปเดตหน้าจอ ---
    const lastApplyRef = { current: 0 };
    const APPLY_EVERY_MS = 80; // 80–150ms กำลังดี

    const off = onMessage(
      (topic, payload) => {
        // ----- STATUS -----
        if (topic === statusTopic) {
          const now = Date.now();
          if (now - lastApplyRef.current < APPLY_EVERY_MS) return;
          lastApplyRef.current = now;

          // งานอัปเดต UI ให้เป็น transition เพื่อลื่นขึ้น
          const run = () =>
            setSlot((prev) => {
              const base: SlotRow = prev ?? {
                slot_id: slotId!,
                cupboard_id: nodeId!,
                connection_status: "online",
                capacity: null,
                is_open: false,
                sensor_status: "unknown",
                wifi_status: "unknown",
                wifi_rssi: null,
                ip_addr: null,
                last_sensor_at: null,
                last_seen_at: null,
              };

              const parsed = parseIsOpen(payload?.is_open);

              // next จากค่าเดิม
              const next: SlotRow = {
                ...base,
                // cupboard_id: payload?.cupboard_id ?? payload?.cupboard_id ?? base.cupboard_id,
                cupboard_id: payload?.cupboard_id ?? base.cupboard_id,
                is_open: parsed === null ? base.is_open : parsed,
                capacity:
                  typeof payload?.capacity === "number"
                    ? payload.capacity
                    : base.capacity,
                sensor_status: payload?.sensor_status ?? base.sensor_status,
                wifi_status: payload?.wifi_status ?? base.wifi_status,
                wifi_rssi:
                  typeof payload?.wifi_rssi === "number"
                    ? payload?.wifi_rssi
                    : base.wifi_rssi,
                ip_addr: payload?.ip_addr ?? base.ip_addr,
                // อย่าให้ field เวลาบังคับ re-render ทุกครั้ง: เปลี่ยนได้ แต่เราไม่ใช้เปรียบเทียบ
                last_seen_at: payload?.ts
                  ? new Date(payload.ts).toISOString()
                  : base.last_seen_at ?? new Date().toISOString(),
              };

              // 🔎 shallow equal: ถ้าไม่เปลี่ยน → คืน prev
              if (
                next.is_open === base.is_open &&
                next.capacity === base.capacity &&
                next.sensor_status === base.sensor_status &&
                next.wifi_status === base.wifi_status &&
                next.wifi_rssi === base.wifi_rssi &&
                next.ip_addr === base.ip_addr &&
                next.cupboard_id === base.cupboard_id
              ) {
                return prev;
              }

              // อัปเดต state ปุ่ม
              if (next.is_open) {
                setSendingOpen(false);
                setAwaitingClose(true);
              } else {
                setSendingOpen(false);
                setAwaitingClose(false);
              }

              // sync DB เฉพาะตอน edge เปลี่ยนจริง
              const edgeChanged = base.is_open !== next.is_open;
              if (edgeChanged) {
                syncSlotStateToDB(
                  next.slot_id,
                  {
                    is_open: next.is_open,
                    capacity: next.capacity ?? undefined,
                    sensor_status: next.sensor_status,
                    wifi_status: next.wifi_status,
                    wifi_rssi: next.wifi_rssi ?? undefined,
                    ip_addr: next.ip_addr ?? undefined,
                    last_seen_at: next.last_seen_at ?? undefined,
                  },
                  { force: true }
                );
              }

              return next;
            });

          // ใช้ startTransition ถ้ามี (React 18)
          run();
        }

        // ----- WARNING -----
        if (topic === warningTopic) {
          const msg = {
            code: payload?.code,
            message:
              payload?.message ??
              (typeof payload === "string" ? payload : JSON.stringify(payload)),
            ts: payload?.ts,
          };
          setWarning(msg);

          // throttle ต่อ slot (กัน insert รัว ๆ)
          const now = Date.now();
          const key = slotId!;
          if ((__lastWarnAt[key] ?? 0) + WARN_INTERVAL_MS > now) {
            return;
          }
          __lastWarnAt[key] = now;

          // fire-and-forget และ "เงียบ" ถ้า 404 (ตารางยังไม่มี)
          supabase
            .from("warnings")
            .insert({
              slot_id: slotId!,
              code: msg.code ?? null,
              message: msg.message ?? null,
              raw: payload ?? null,
              created_at: new Date().toISOString(),
            })
            .then(
              () => {},
              (err: any) => {
                const status = err?.status ?? err?.code;
                if (status !== 404) {
                  console.error("insert warnings error:", err);
                }
              }
            );
        }
      },
      { replayLast: true }
    );

    return off;
  }, [statusTopic, warningTopic, onMessage, slotId, nodeId]);

  // โหลดข้อมูลจาก DB (ครั้งแรก/เปลี่ยน slot)
  useEffect(() => {
    let active = true;
    async function run() {
      if (!slotId) return;
      setLoading(true);
      setErr(null);
      try {
        const { data, error } = await supabase
          .from(TBL.slots)
          .select(
            "slot_id,cupboard_id,connection_status,capacity,is_open,sensor_status,wifi_status,wifi_rssi,ip_addr,last_sensor_at,last_seen_at"
          )
          .eq("slot_id", slotId)
          .maybeSingle();
        if (error) throw error;
        if (!active) return;

        const s = (data || null) as SlotRow | null;

        setSlot(s);
        if (s?.is_open === true) {
          setAwaitingClose(true); // เปิดอยู่ → รอปิด
          setSendingOpen(false);
        } else {
          setAwaitingClose(false);
          setSendingOpen(false);
        }
      } catch (e: any) {
        if (!active) return;
        console.error("slot dashboard error:", e);
        setErr(e?.message || "Failed to load data");
      } finally {
        if (active) setLoading(false);
      }
    }
    run();
    return () => {
      active = false;
    };
  }, [slotId]);

  // กันปุ่มค้าง ถ้า 12 วินาทีแล้วยังไม่เห็น STATUS กลับมา ให้คลายสถานะส่ง
  useEffect(() => {
    if (!sendingOpen) return;
    const t = setTimeout(() => {
      setSendingOpen(false);
    }, 10000);
    return () => clearTimeout(t);
  }, [sendingOpen]);

  // reset เมื่อเข้าหน้าใหม่/เปลี่ยน slot
  useEffect(() => {
    setAwaitingClose(false);
    setSendingOpen(false);
  }, [slotId]);

  useEffect(() => {
    if (slot?.is_open === false && awaitingClose) {
      setAwaitingClose(false);
    }
  }, [slot?.is_open, awaitingClose]);

  // raw capacity (0–250) → %
  const raw = Number(slot?.capacity);
  const MAX_RAW = 250;

  const progress = useMemo(() => {
    if (!Number.isFinite(raw)) return 0;
    const percent = (raw / MAX_RAW) * 100;
    return Math.max(0, Math.min(100, Math.round(percent)));
  }, [raw]);

  // capacity → "xx / 100"
  const capacityText = Number.isFinite(raw) ? `${progress} / 100` : "—";

  // ===== ACTION: OPEN (จริง ๆ คือ UNLOCK ตามสเปค) =====
  async function openSlot() {
    if (!slot || !nodeId || !slotId || !commandOpenTopic) return;
    if (sendingOpen || awaitingClose || slot.is_open === true) return;

    setSendingOpen(true);

    const cmdId =
      typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
        ? crypto.randomUUID()
        : `cmd_${Date.now()}_${Math.random().toString(16).slice(2)}`;

    const payload = {
      role: "admin",
      cmd_id: cmdId,
      slot_id: slotId,
      ts: Date.now(),
    };

    console.log("[publish unlock]", { topic: commandOpenTopic, payload });
    publish(commandOpenTopic, payload);

    try {
      supabase
        .from("activation_logs")
        .insert({
          slot_id: slot.slot_id,
          action: "unlock",
          cause: "manual",
          metadata: { via: "web-ui", cmd_id: cmdId },
        })
        .throwOnError();
    } catch (e) {
      console.error("insert activation_logs error:", e);
    }
  }

  const doorOpen = slot?.is_open === true;

  const openDisabled =
    mqttStatus === "error" ||
    mqttStatus === "idle" ||
    sendingOpen ||
    doorOpen ||
    !nodeId ||
    !slot ||
    !commandOpenTopic;

  return (
    <Box sx={{ display: "flex", flexDirection: "column", width: "100%" }}>
      <Box sx={{ flex: 1, width: "100%" }}>
        {/* Header */}
        <Box sx={{ display: "flex", alignItems: "center", gap: 2, mb: 1 }}>
          <ArrowBackIcon
            onClick={() => navigate(-1)}
            style={{ width: 28, height: 28, cursor: "pointer" }}
          />
          <Typography
            fontSize="40px"
            fontWeight={900}
            fontStyle="italic"
            color="#133E87"
          >
            Monitoring
          </Typography>
        </Box>

        {warning?.message && (
          <Box sx={{ mx: 2, mb: 2 }}>
            <Box
              role="alert"
              aria-live="polite"
              style={{
                border: "1px solid #F5C0C0",
                background: "#FFF5F5",
                color: "#B21B1B",
                padding: "10px 14px",
                borderRadius: 8,
                fontWeight: 600,
              }}
            >
              {warning.code ? `[${warning.code}] ` : ""}
              {warning.message}
            </Box>
          </Box>
        )}

        <Divider
          sx={{
            mt: 1,
            mb: 3,
            mx: 2,
            borderBottomWidth: 2,
            borderColor: "#CBDCEB",
          }}
        />

        {/* Slot name */}
        <Box mt={1} mb={2} display="flex" justifyContent="center">
          <Typography variant="h5" fontWeight={800} color="#133E87">
            {`Slot ${slotId ?? ""}`}
          </Typography>
        </Box>

        {loading ? (
          <Box display="flex" alignItems="center" gap={1} py={3}>
            <CircularProgress size={20} />
            <Typography color="text.secondary" fontStyle="italic">
              Loading...
            </Typography>
          </Box>
        ) : err ? (
          <Typography color="error" fontStyle="italic" py={2}>
            {err}
          </Typography>
        ) : (
          <>
            {/* แถวบน: Usage / Sensor */}
            <Grid container spacing={5} mb={3} sx={{ px: { xs: 0, md: 10 } }}>
              <Grid item xs={12} md={12}>
                <Card sx={{ borderRadius: 15, border: "1px solid #D6E4EF" }}>
                  <CardContent
                    sx={{
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "space-between",
                      py: 2.5,
                    }}
                  >
                    <Box display="flex" alignItems="center" gap={2}>
                      <Box
                        sx={{
                          width: 55,
                          height: 55,
                          borderRadius: "50%",
                          background: isOpen ? "#ffffff" : "#D6E4EF",
                          display: "grid",
                          placeItems: "center",
                        }}
                      >
                        <BoxIcon height={30} width={30} color="#133E87" />
                      </Box>
                      <Box>
                        <Typography
                          fontWeight={700}
                          fontSize={20}
                          fontStyle="italic"
                          color="#133E87"
                        >
                          Cupboard Door Status
                        </Typography>
                        <Typography color="#133E87">
                          Status : {usageText}
                        </Typography>
                        <Typography
                          sx={{ fontSize: 12 }}
                          color="text.secondary"
                        >
                          MQTT: {mqttStatus}{" "}
                          {nodeId ? `• cupboard_id: ${nodeId}` : ""}
                        </Typography>
                      </Box>
                    </Box>

                    {/* ปุ่ม OPEN (สั่ง UNLOCK) */}
                    <Button
                      onClick={openSlot}
                      disabled={openDisabled}
                      variant="contained"
                      sx={{
                        minWidth: 160,
                        height: 40,
                        fontWeight: 800,
                        borderRadius: 2,
                        px: 2,
                        py: 0.75,
                        bgcolor:
                          sendingOpen || awaitingClose ? "#4EA1FF" : undefined,
                        color:
                          sendingOpen || awaitingClose ? "#fff" : undefined,
                        "&:hover":
                          sendingOpen || awaitingClose
                            ? { bgcolor: "#4EA1FF" }
                            : undefined,
                        "&.Mui-disabled": {
                          bgcolor:
                            sendingOpen || awaitingClose
                              ? "#4EA1FF"
                              : "#E0E0E0",
                          color:
                            sendingOpen || awaitingClose ? "#fff" : "#9E9E9E",
                        },
                      }}
                      startIcon={
                        sendingOpen ? (
                          <CircularProgress size={18} thickness={5} />
                        ) : undefined
                      }
                      title={
                        openDisabled
                          ? awaitingClose
                            ? "Door is open—waiting for it to close"
                            : "MQTT not ready or already open"
                          : "Send unlock command to this slot"
                      }
                    >
                      {sendingOpen
                        ? "OPENING..."
                        : awaitingClose
                        ? "WAITING FOR CLOSE"
                        : "OPEN"}
                    </Button>
                  </CardContent>
                </Card>
              </Grid>
            </Grid>

            {/* แถวสอง: Capacity + History */}
            <Grid container spacing={10} sx={{ px: { xs: 0, md: 10 } }}>
              <Grid item xs={12} md={4}>
                <Card sx={{ borderRadius: 6, background: "#D8E6F3" }}>
                  <CardContent>
                    <Box
                      sx={{
                        pt: 5,
                        height: 200,
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        position: "relative",
                      }}
                    >
                      <Box
                        sx={{
                          width: 48,
                          height: 48,
                          borderRadius: "20px",
                          background: "#fff",
                          display: "grid",
                          placeItems: "center",
                          fontSize: 22,
                          position: "absolute",
                          top: 5,
                          right: 5,
                        }}
                      >
                        <InboxIcon height={25} width={25} color="#608BC1" />
                      </Box>
                      <Box position="relative" display="inline-flex">
                        <CircularProgress
                          variant="determinate"
                          value={100}
                          size={140}
                          thickness={2}
                          sx={{ color: "#EEF3F8", position: "absolute" }}
                        />
                        <CircularProgress
                          variant="determinate"
                          value={progress}
                          size={140}
                          thickness={2}
                          sx={{
                            color: "#1E3E74",
                            "svg circle": { strokeLinecap: "round" },
                          }}
                        />
                        <Box
                          sx={{
                            top: 0,
                            left: 0,
                            bottom: 0,
                            right: 0,
                            position: "absolute",
                            display: "flex",
                            alignItems: "center",
                            justifyContent: "center",
                          }}
                        >
                          <Typography fontWeight={400} color="#608BC1">
                            {capacityText}
                          </Typography>
                        </Box>
                      </Box>
                    </Box>
                    <Typography
                      fontStyle="italic"
                      fontWeight="300"
                      fontSize="18px"
                      color="#133E87"
                    >
                      Capacity
                    </Typography>
                  </CardContent>
                </Card>
              </Grid>

              {/* Login & Activation History */}
              <Grid item xs={12} md={8}>
                <Typography
                  fontStyle="italic"
                  fontWeight="300"
                  fontSize="18px"
                  color="#133E87"
                  mb={1}
                >
                  Login History
                </Typography>
                <Card
                  sx={{
                    borderRadius: 6,
                    overflow: "hidden",
                    border: "1px solid #CBDCEB",
                  }}
                >
                  <Box
                    sx={{
                      display: "grid",
                      gridTemplateColumns: "1.5fr 0.8fr 0.8fr 1.2fr",
                      bgcolor: "#E3EDF7",
                      px: 2,
                      py: 1,
                      fontWeight: 700,
                      color: "#133E87",
                    }}
                  >
                    <Box>Name</Box>
                    <Box>Date</Box>
                    <Box>Time</Box>
                    <Box>Description</Box>
                  </Box>
                  <Box sx={{ maxHeight: 240, overflowY: "auto" }}>
                    {loginHistory.length === 0 ? (
                      <Typography px={2} py={1.5} color="text.secondary">
                        — ไม่มีข้อมูล —
                      </Typography>
                    ) : (
                      loginHistory.map((row) => (
                        <Box
                          key={row.id}
                          sx={{
                            display: "grid",
                            gridTemplateColumns: "1.5fr 0.8fr 0.8fr 1.2fr",
                            px: 2,
                            py: 1,
                            borderTop: "1px solid #EFF4F9",
                          }}
                        >
                          <Box>{row.name}</Box>
                          <Box>{row.date}</Box>
                          <Box>{row.time}</Box>
                          <Box>{row.description}</Box>
                        </Box>
                      ))
                    )}
                  </Box>
                </Card>

                <Typography
                  fontStyle="italic"
                  fontWeight="300"
                  fontSize="18px"
                  color="#133E87"
                  mt={3}
                  mb={1}
                >
                  Cupboard Activation History
                </Typography>
                <Card
                  sx={{
                    borderRadius: 6,
                    overflow: "hidden",
                    border: "1px solid #CBDCEB",
                  }}
                >
                  <Box
                    sx={{
                      display: "grid",
                      gridTemplateColumns: "1.5fr 0.8fr 0.8fr 1.2fr",
                      bgcolor: "#E3EDF7",
                      px: 2,
                      py: 1,
                      fontWeight: 700,
                      color: "#133E87",
                    }}
                  >
                    <Box>Name</Box>
                    <Box>Date</Box>
                    <Box>Time</Box>
                    <Box>Description</Box>
                  </Box>
                  <Box sx={{ maxHeight: 240, overflowY: "auto" }}>
                    {activationHistory.length === 0 ? (
                      <Typography px={2} py={1.5} color="text.secondary">
                        — ไม่มีข้อมูล —
                      </Typography>
                    ) : (
                      activationHistory.map((row) => (
                        <Box
                          key={row.id}
                          sx={{
                            display: "grid",
                            gridTemplateColumns: "1.5fr 0.8fr 0.8fr 1.2fr",
                            px: 2,
                            py: 1,
                            borderTop: "1px solid #EFF4F9",
                          }}
                        >
                          <Box>{row.name}</Box>
                          <Box>{row.date}</Box>
                          <Box>{row.time}</Box>
                          <Box>{row.description}</Box>
                        </Box>
                      ))
                    )}
                  </Box>
                </Card>
              </Grid>
            </Grid>
          </>
        )}
      </Box>
    </Box>
  );
}
