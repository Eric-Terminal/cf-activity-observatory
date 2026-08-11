import { z } from "zod";

export const DATASETS = [
  "httpRequestsAdaptive",
  "httpRequestsAdaptiveGroups",
  "firewallEventsAdaptive",
  "firewallEventsAdaptiveGroups",
] as const;

export const datasetSchema = z.enum(DATASETS);
export type DatasetName = z.infer<typeof datasetSchema>;

export const RAW_DATASETS = ["httpRequestsAdaptive", "firewallEventsAdaptive"] as const;
export const GROUP_DATASETS = ["httpRequestsAdaptiveGroups", "firewallEventsAdaptiveGroups"] as const;

export const collectorJobSchema = z.discriminatedUnion("type", [
  z.object({
    version: z.literal(1),
    type: z.literal("collect"),
    id: z.string().min(1),
    parentId: z.string().optional(),
    zoneId: z.string().min(1),
    dataset: datasetSchema,
    start: z.number().int().nonnegative(),
    end: z.number().int().positive(),
    mode: z.enum(["realtime", "backfill", "repair"]).default("realtime"),
  }),
  z.object({
    version: z.literal(1),
    type: z.literal("maintenance"),
    id: z.string().min(1),
    scheduledAt: z.number().int().nonnegative(),
  }),
]);

export type CollectorJob = z.infer<typeof collectorJobSchema>;

export const zoneConfigSchema = z.object({
  enabled: z.boolean(),
  pollIntervalMinutes: z.number().int().min(1).max(1440),
  detailRetentionDays: z.number().int().min(7).max(3650),
});

export type ZoneConfigInput = z.infer<typeof zoneConfigSchema>;

export const smtpConfigSchema = z
  .object({
    enabled: z.boolean(),
    host: z.string().trim().min(1).max(253),
    port: z.union([z.literal(465), z.literal(587)]),
    tlsMode: z.enum(["implicit", "starttls"]),
    authMethod: z.enum(["plain", "login"]),
    username: z.string().max(320),
    password: z.string().min(1).max(1024).optional(),
    clearPassword: z.boolean().optional().default(false),
    senderName: z.string().max(120).optional().default(""),
    senderAddress: z.email(),
    recipients: z.array(z.email()).min(1).max(20),
    subjectPrefix: z.string().max(80).default("[CF Activity Observatory]"),
  })
  .superRefine((value, context) => {
    if (value.port === 465 && value.tlsMode !== "implicit") {
      context.addIssue({ code: "custom", message: "465 端口必须使用隐式 TLS", path: ["tlsMode"] });
    }
    if (value.port === 587 && value.tlsMode !== "starttls") {
      context.addIssue({ code: "custom", message: "587 端口必须使用 STARTTLS", path: ["tlsMode"] });
    }
  });

export type SmtpConfigInput = z.infer<typeof smtpConfigSchema>;

export const savedViewSchema = z.object({
  name: z.string().trim().min(1).max(80),
  page: z.enum(["overview", "requests", "security"]),
  filters: z.record(z.string(), z.union([z.string(), z.array(z.string())])),
});

export type SavedViewInput = z.infer<typeof savedViewSchema>;

export interface ApiErrorPayload {
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
}

export interface AccessIdentity {
  email: string;
  subject: string;
}

export interface ZoneSummary {
  id: string;
  name: string;
  accountId: string | null;
  enabled: boolean;
  pollIntervalMinutes: number;
  detailRetentionDays: number;
  lastScheduledAt: number | null;
}

export interface DatasetCapability {
  zoneId: string;
  dataset: DatasetName;
  enabled: boolean;
  availableFields: string[];
  maxPageSize: number | null;
  maxNumberOfFields: number | null;
  notOlderThan: number | null;
  maxDuration: number | null;
  checkedAt: number;
}

export interface SampledRequest {
  id: string;
  zoneId: string;
  occurredAt: number;
  rayId: string | null;
  clientIp: string | null;
  country: string | null;
  asn: number | null;
  asnDescription: string | null;
  userAgent: string | null;
  referer: string | null;
  deviceType: string | null;
  host: string | null;
  path: string | null;
  query: string | null;
  method: string | null;
  protocol: string | null;
  requestSource: string | null;
  colo: string | null;
  cacheStatus: string | null;
  originStatus: number | null;
  edgeStatus: number | null;
  securityAction: string | null;
  securitySource: string | null;
  securityRuleId: string | null;
  botScore: number | null;
  botScoreSource: string | null;
  botTags: string[];
  verifiedBotCategory: string | null;
  attackScore: number | null;
  contentScanResult: unknown;
  leakedCredentialResult: string | null;
  sampleInterval: number | null;
  extra: Record<string, unknown>;
}

export interface SecurityEvent {
  id: string;
  zoneId: string;
  occurredAt: number;
  rayId: string | null;
  action: string | null;
  source: string | null;
  ruleId: string | null;
  ruleDescription: string | null;
  rulesetId: string | null;
  kind: string | null;
  clientIp: string | null;
  country: string | null;
  asn: number | null;
  host: string | null;
  path: string | null;
  query: string | null;
  method: string | null;
  userAgent: string | null;
  sampleInterval: number | null;
  extra: Record<string, unknown>;
}

export interface MetricPoint {
  bucketStart: number;
  bucketSeconds: number;
  estimatedCount: number;
  sampleInterval: number | null;
  confidenceEstimate: number | null;
  confidenceLower: number | null;
  confidenceUpper: number | null;
  confidenceSampleSize: number | null;
  edgeResponseBytes: number | null;
  visits: number | null;
  dimensions: Record<string, string | number | null>;
}

export interface MetricSeries {
  kind: string;
  points: MetricPoint[];
}

export interface PaginatedResult<T> {
  items: T[];
  nextCursor: string | null;
}

export interface CollectorHealth {
  status: "healthy" | "degraded" | "unconfigured";
  now: number;
  d1WarningBytes: number;
  usageToday: {
    graphqlQueries: number;
    d1RowsRead: number;
    d1RowsWritten: number;
    d1SizeAfter: number;
    queueMessages: number;
    r2BytesWritten: number;
  };
  cursors: Array<{
    zoneId: string;
    zoneName: string;
    dataset: DatasetName;
    cursorAt: number;
    lastSuccessAt: number | null;
    consecutiveFailures: number;
    lastError: string | null;
  }>;
  gaps: Array<{
    id: string;
    zoneId: string;
    dataset: DatasetName;
    rangeStart: number;
    rangeEnd: number;
    reason: string;
  }>;
}
