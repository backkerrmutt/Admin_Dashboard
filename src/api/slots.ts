// src/api/slots.ts
import { supabase } from "../supabaseClient";

/** แถวจริงจากตาราง slots (snake_case) */
type SlotRow = {
  slot_id: string;
  cupboard_id: string;
  teacher_id: string | null;
  capacity: number | null; // 0–250 (raw mm)
  connection_status: "active" | "inactive" | string;
  is_open: boolean | null;
  sensor_status: "ok" | "error" | "unknown" | string | null;
  wifi_status: "online" | "offline" | "unknown" | string | null;
  wifi_rssi: number | null;
  ip_addr: string | null; // inet -> string จาก PostgREST
  last_seen_at: string | null;
};

/** รูปแบบที่การ์ดใน UI ใช้ (camelCase + ค่าที่ map แล้ว) */
export type Slot = {
  slotId: string;
  cupboardId: string;
  teacherId: string | null;
  capacity: number; // 0–250 (ถ้า null จะเป็น 0)
  capacityPct: number; // 0–100  (คำนวณจาก 250)
  connectionStatus: "online" | "offline" | "unknown";
  isOpen: boolean;
  sensorStatus: "ok" | "error" | "unknown";
  wifiStatus: "online" | "offline" | "unknown";
  wifiRssi: number | null;
  ipAddr: string | null;
  lastSeenAt: string | null;
};

const MAX_RAW = 250;
const toPct = (v: number | null) =>
  Math.max(0, Math.min(100, Math.round(((v ?? 0) / MAX_RAW) * 100)));

const mapConn = (
  v: string | null | undefined
): "online" | "offline" | "unknown" => {
  if (v === "active") return "online";
  if (v === "inactive") return "offline";
  if (v === "online" || v === "offline") return v as any;
  return "unknown";
};

const mapTri = (v: string | null | undefined): "ok" | "error" | "unknown" => {
  if (v === "ok" || v === "error") return v;
  return "unknown";
};

function mapRow(r: SlotRow): Slot {
  const capacity = r.capacity ?? 0;
  return {
    slotId: r.slot_id,
    cupboardId: r.cupboard_id,
    teacherId: r.teacher_id ?? null,
    capacity,
    capacityPct: toPct(capacity),
    connectionStatus: mapConn(r.connection_status),
    isOpen: !!r.is_open,
    sensorStatus: mapTri(r.sensor_status ?? "unknown"),
    wifiStatus:
      r.wifi_status === "online" || r.wifi_status === "offline"
        ? (r.wifi_status as any)
        : "unknown",
    wifiRssi: r.wifi_rssi,
    ipAddr: r.ip_addr,
    lastSeenAt: r.last_seen_at,
  };
}

/** ดึงรายการสล็อตทั้งหมดจาก Supabase จัดเรียงตาม cupboard_id แล้ว slot_id */
export async function fetchSlots(): Promise<Slot[]> {
  const { data, error } = await supabase
    .from("slots")
    .select(
      "slot_id,cupboard_id,teacher_id,connection_status,capacity,is_open,sensor_status,wifi_status,wifi_rssi,ip_addr,last_sensor_at,last_seen_at"
    )
    .order("cupboard_id", { ascending: true })
    .order("slot_id", { ascending: true });

  if (error) {
    console.error("[fetchSlots] error:", error);
    throw error;
  }
  return (data as SlotRow[]).map(mapRow);
}

/** ดึงรายละเอียดสล็อตเดียว */
export async function fetchSlotById(slotId: string): Promise<Slot | null> {
  const { data, error } = await supabase
    .from("slots")
    .select(
      "slot_id,cupboard_id,teacher_id,connection_status,capacity,is_open,sensor_status,wifi_status,wifi_rssi,ip_addr,last_sensor_at,last_seen_at"
    )
    .eq("slot_id", slotId)
    .maybeSingle();

  if (error) {
    console.error("[fetchSlotById] error:", error);
    throw error;
  }
  return data ? mapRow(data as SlotRow) : null;
}
