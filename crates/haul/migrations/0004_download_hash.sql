-- Checksum the hoster published (`type:value`, see engine/hash.rs) and whether the finished
-- file matched it (1), did not (0), or was not checked (NULL).
ALTER TABLE downloads ADD COLUMN hash TEXT;
ALTER TABLE downloads ADD COLUMN hash_ok INTEGER;
