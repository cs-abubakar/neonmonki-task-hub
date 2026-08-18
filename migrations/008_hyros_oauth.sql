-- NEONMONKI Task Hub — migration 008: Hyros OAuth (MCP) connection
-- Run after 007 in the Supabase SQL Editor (idempotent).
--
-- Adds the OAuth 2.1 (PKCE + dynamic client registration) connection mode for
-- Hyros, mirroring the "Connect" flow from the official Hyros MCP docs
-- (https://mcp.hyros.com/mcp). All token material stays encrypted server-side
-- and is never selected back into browser-facing integration responses.

alter table integration_connections
  add column if not exists auth_method text not null default '',           -- 'oauth' | 'apikey' | ''
  add column if not exists oauth_client_id text not null default '',
  add column if not exists oauth_client_secret_encrypted text not null default '',
  add column if not exists oauth_access_token_encrypted text not null default '',
  add column if not exists oauth_access_expires_at timestamptz,
  add column if not exists oauth_refresh_token_encrypted text not null default '',
  add column if not exists oauth_pending jsonb not null default '{}';      -- in-flight {stateHash, verifier, clientId, redirectUri, createdAt}

-- The connection remains read-only by construction: the application only ever
-- calls Hyros read-only MCP tools (hyros_get_*), regardless of which tokens
-- are stored here. No column in this table can widen that.
