export const SQUARE_PROFILE = 'square800-v1';
export interface MediaPreparationJob {
  asset_id: number;
  generation: string;
  token: string;
  attempt: number;
  requested_at: string;
  source_s3_uri: string;
  output_bucket: string;
  output_key: string;
  crop_x: number;
  crop_y: number;
  media_profile: typeof SQUARE_PROFILE;
}
export interface MediaPreparationResult {
  output_key: string;
  media_profile: typeof SQUARE_PROFILE;
  width: 800;
  height: 800;
  duration_seconds: number;
}
export interface MediaPreparationQueue {
  claim(): Promise<MediaPreparationJob | null>;
  current(job: MediaPreparationJob): Promise<boolean>;
  complete(job: MediaPreparationJob, result: MediaPreparationResult): Promise<boolean>;
  fail(job: MediaPreparationJob): Promise<void>;
}
