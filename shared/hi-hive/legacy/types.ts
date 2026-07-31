// Creds

export interface CredsData {
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
}

// decodeQr
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

// scanQr

export type ScanStatus =
  | "marked"          // flag === "0" => attendance marked
  | "rejected"        // flag === "1" => server said no (already taken, wrong time, etc.)
  | "unknown_flag"    // server replied but flag was unrecognised
  | "unreadable"      // body was empty or couldn't be decrypted
  | "invalid_qr"      // qr_type not in VALID_QR_TYPES
  | "network_error"   // fetch threw
  | "auth_error";     // 401/403 and re-login also failed

export interface ScanQrResult {
    ok: boolean;
    status: ScanStatus;
    message: string;
    courseCode: string | null;
    // The pre-check expiry prediction made before the network call
    expiry: DecodedQr["expiry"] | null;
    // Raw decoded server response body
    serverResponse: string | null;
}

// refreshToken

export interface RefreshTokenResult {
    ok: boolean;
    message: string;
    newSessionId?: string;
    newToken?: string;
    tokenChanged?: boolean;
}

// getAttendance

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
    // Overall attendance % across all courses, null if no data
    overallPercent: number | null;
    message: string;
}