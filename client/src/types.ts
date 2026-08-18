export type Status = 'Waiting'|'Parsing'|'Processing'|'Paused'|'Completed'|'Failed'|'Cancelled'
export type Mode = 'smart'|'blur'|'solid'|'crop'
export interface Region { id:string; x:number; y:number; width:number; height:number }
export interface VideoRange { kind:'all'|'custom'; start:number; end:number }
export interface Media { filename:string; mimeType:string; mediaType:'image'|'video'; size:number; width:number|null; height:number|null; duration:number|null; inputPath:string; previewUrl:string }
export interface Task extends Omit<Media, 'previewUrl'> { id:string; outputPath:string|null; outputSize:number|null; outputDirectory:string; outputFormat:string; quality:number; mode:Mode; regions:Region[]; videoRange:VideoRange; retryCount:number; status:Status; progress:number; step:string; error:string|null; createdAt:string; updatedAt:string }
export interface Settings { concurrency:number; maxFileSizeMb:number; outputDirectory:string; defaultMode:Mode; defaultFormat:string; defaultQuality:number; autoRetryCount:number; requestTimeoutMinutes:number; maxResourcePercent:number; theme:'light'|'dark'|'system' }
