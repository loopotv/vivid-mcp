/** Shared between the stdio server (index.ts) and the remote Worker (worker.ts). */
export const VERSION = '0.15.0';

export const INSTRUCTIONS = [
  'VIVID is an AI content studio for e-commerce (vividai.tv). This server drives the account linked to the API key.',
  'Typical flow: vivid_whoami → vivid_list_models → vivid_generate_image / vivid_generate_video → vivid_job_status → vivid_share_asset (or vivid_download_asset on the local server).',
  'Files must be public URLs (vivid_upload_file accepts a URL; the local stdio server also accepts absolute local paths).',
  'Every generation costs credits; the models list shows the price. Check credits with vivid_whoami before large batches.',
].join(' ');

export const LOCAL_INSTRUCTIONS = ' vivid_record_ui screen-records a scripted walkthrough of vividai.tv with a local Chromium (no credits) and uploads it as a video asset for the timeline tools.';
