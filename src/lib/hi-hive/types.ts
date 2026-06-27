// ─── Creds ───────────────────────────────────────────────────────────────────

export interface CredsData {
  // hi-hive fields
  userId: string;
  password: string | null;
  token: string;
  sessionId: string;
  fcmToken: string;
  path: string;
  aes_key: string;
  aes_iv: string;
  deviceId: string;
  tokenDate: string;
  // UTAR web portal fields
  utarStudentId: string | null;
  utarEncryptedData: string | null;
}

// ─── decodeQr ────────────────────────────────────────────────────────────────

export type QrType = "E01" | "Q01" | "Q02" | "LQR" | "CTR";
export type ExpiryVerdict = "in_window" | "expired" | "too_early" | "unknown";

export interface QrInfo {
  courseCode?: string;
  sessionType?: string;
  group?: string;
  datetime?: string;
  hours?: string;
  eventName?: string;
  from?: string;
  to?: string;
  venue?: string;
}

export interface DecodedQr {
  raw: string;
  type: string;
  classId: string | null;
  info: QrInfo;
  expiry: {
    verdict: ExpiryVerdict;
    reason: string;
  };
}

export interface DecodeQrResult {
  ok: true;
  decoded: DecodedQr;
}

export interface DecodeQrError {
  ok: false;
  error: string;
}

// ─── scanQr ──────────────────────────────────────────────────────────────────

export type ScanStatus =
  | "marked"          // success patterns found in HTML
  | "rejected"        // error patterns — wrong datetime / already taken / not enrolled
  | "token_expired"   // session expired / please login patterns
  | "scanner_page"    // server returned the scanner page (QR window passed / too early)
  | "unknown_flag"    // server replied but result unclear
  | "unreadable"      // empty body
  | "invalid_qr"      // qr type not in VALID_QR_TYPES
  | "network_error"   // fetch threw
  | "auth_error";     // could not establish session

export interface ScanQrResult {
  ok: boolean;
  status: ScanStatus;
  message: string;
  courseCode: string | null;
  /** The pre-check expiry prediction made before the network call */
  expiry: DecodedQr["expiry"] | null;
  /** URL of the server's result image (Tick.png = success, Cross.png = failure) */
  imageUrl: string | null;
  /** Stripped server response text */
  serverResponse: string | null;
}

export interface SimpleScanQrResult {
  status?: ScanStatus,
  datetime: Date
}

// ─── refreshToken ────────────────────────────────────────────────────────────

export interface RefreshTokenResult {
  ok: boolean;
  message: string;
  newSessionId?: string;
  newToken?: string;
  tokenChanged?: boolean;
}

// ─── getAttendance ───────────────────────────────────────────────────────────

export interface AttendanceRecord {
  recordedDatetime: string | null;
  recordedByEmail: string | null;
  classDatetime: string | null;
  type: string | null;
  classHours: string | null;
  group: string | null;
  recordedByName: string | null;
  status: string | null;
  statusLabel: string;
}

export interface AttendanceCourse {
  code: string | null;
  name: string | null;
  attended: number | null;
  total: number | null;
  percent: number | null;
  records: AttendanceRecord[];
}

export interface AttendanceProfile {
  studentId: string | null;
  name: string | null;
  session: string | null;
}

export interface GetAttendanceResult {
  ok: boolean;
  no_record: boolean;
  profile: AttendanceProfile | null;
  courses: AttendanceCourse[];
  /** Overall attendance % across all courses, null if no data */
  overallPercent: number | null;
  message: string;
}