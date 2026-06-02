-- Module 3: add image_prompt to pages (plan.md §3 steps 2-3).
-- Holds the text-to-image prompt produced by the summarize/image-prompt worker
-- and consumed later by the module 4 image worker.
alter table pages add column if not exists image_prompt text;
