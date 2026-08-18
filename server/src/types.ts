export type TaskStatus = 'Waiting' | 'Parsing' | 'Processing' | 'Paused' | 'Completed' | 'Failed' | 'Cancelled'
export type RemovalMode = 'smart' | 'blur' | 'solid' | 'crop'
export interface Region { id: string; x: number; y: number; width: number; height: number }
export interface VideoRange { kind: 'all' | 'custom'; start: number; end: number }
export interface Task { id: string; filename: string; mimeType: string; mediaType: 'image' | 'video'; size: number; width: number | null; height: number | null; duration: number | null; inputPath: string; outputPath: string | null; outputSize: number | null; outputDirectory: string; outputFormat: string; quality: number; mode: RemovalMode; regions: Region[]; videoRange: VideoRange; retryCount: number; status: TaskStatus; progress: number; step: string; error: string | null; createdAt: string; updatedAt: string }
export interface Settings { concurrency: number; maxFileSizeMb: number; outputDirectory: string; defaultMode: RemovalMode; defaultFormat: string; defaultQuality: number; autoRetryCount: number; requestTimeoutMinutes: number; maxResourcePercent: number; theme: 'light' | 'dark' | 'system' }
