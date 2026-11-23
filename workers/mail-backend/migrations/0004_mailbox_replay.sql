CREATE INDEX deliveries_mailbox_done ON deliveries (
  workspace_id, json_extract(resolved_mailbox_ids, '$[0]'), done_at, id
) WHERE state = 'done';
