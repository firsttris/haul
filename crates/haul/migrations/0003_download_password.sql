-- The password of a protected file or folder (JD: DownloadLink.getDownloadPassword), given when
-- adding the links or entered when the hoster asked for it.
ALTER TABLE downloads ADD COLUMN password TEXT;
