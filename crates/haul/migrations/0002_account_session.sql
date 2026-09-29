-- Cookies of the hoster session (encrypted like the secret), so a login survives restarts.
ALTER TABLE accounts ADD COLUMN session TEXT;
