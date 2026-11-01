CREATE INDEX invites_pending_by_workspace_created
  ON invites(workspace_id, created_at DESC)
  WHERE used_at IS NULL AND revoked_at IS NULL;
